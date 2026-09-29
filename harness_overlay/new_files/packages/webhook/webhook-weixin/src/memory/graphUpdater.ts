/**
 * 用本地 Gemma 从聊天记录里更新知识图谱。
 *
 * ## 为什么要分成"小块 + 多次小调用"，而不是"一次读一大段"
 *
 * 显存只有 8GB（模型+视觉投影器已占约 5GB），**长上下文就是最贵的资源**。
 * 而"之前那个人"这类指代又天然需要上下文——两者直接冲突。
 * 解法不是把上下文变长，而是**把上下文变窄 + 用一份很小的候选名单把指代变成选择题**：
 *
 * 1. **分块**：记录按 ~2.5k 字符切块，每块单独调用，输入永远很短；
 * 2. **滚动指代候选**：每次调用都带上"最近提到过的人 + 图谱已有的人"（几十个 token），
 *    让模型做"`那个人` → 名单里哪一个"的选择，而不是自由回忆；
 * 3. **跨块续接**：上一块末尾几行 + 未解开的指代片段带进下一块（有界），
 *    这样跨块的"之前说的那个人"也能接上；
 * 4. **先抽取、后落库**：模型只输出**中文短协议事实**（一行一条），
 *    由代码解析并写库——模型不直接改图，格式错一行也只丢一行；
 * 5. **逐节点审核**：只对"这批记录里被提到的人"再各调一次，
 *    且只喂**与这个人有关的事实**（几十到几百 token），这就是"递归遍历节点"，
 *    但代价不随图谱规模线性膨胀（可选 `full_scan` 强制全量遍历）。
 *
 * 时间不敏感（都在空闲时跑），所以"多调用、每次很小"是明确更优的取舍。
 *
 * @module dsh-webhook-weixin/graph-updater
 */

import { probe } from '../diagnostics/probe.ts'
import type { KnowledgeGraphStore } from './graphStore.ts'
import {
  is_known_attribute_field,
  map_attribute_field,
  parse_facts,
  render_candidates,
  render_pending,
  type ExtractedFact,
} from './graphProtocol.ts'
import { GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME, type GraphEvidence } from './graphTypes.ts'

/** 一条待更新的聊天记录（来自时间线）。 */
export interface UpdateRecord {
  readonly date: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * 说话人别名 → 图谱里的规范名。
 *
 * 实测教训：模型会把对话里的说话人标签（"用户""助手"）当成人名建节点，
 * 还顺势编出"职业=技术支持"这种属性。所以这里做**代码级兜底**——
 * 不指望提示词能 100% 拦住，落库前统一归一化。
 *
 * 对话记录里的说话人标签直接用图谱里的规范名（`[主人]` 与 `[欣爱]`），
 * 这样模型看到的就是要输出的名字，少一层映射。
 */
const SELF_ALIASES = ['我', '用户', '主人', '本人', '自己']
const ASSISTANT_ALIASES = ['欣爱', '助手', '小爱', '你']

/** 把说话人别名归一到规范名；不是别名就原样返回。 */
export function canonical_person_name(name: string): string {
  const value = name.trim()
  if (SELF_ALIASES.includes(value)) return GRAPH_USER_NAME
  if (ASSISTANT_ALIASES.includes(value)) return GRAPH_ASSISTANT_NAME
  return value
}

/** 构造参数。 */
export interface GraphUpdaterOptions {
  readonly graph: KnowledgeGraphStore
  /** 调用模型：输入完整提示词，返回模型文本。由调用方注入（便于测试）。 */
  readonly complete: (prompt: string) => Promise<string>
  /**
   * 每块最大字符数，默认 8000（≈6k token）。
   *
   * 压力实测（本地 Gemma 4B）：
   * - 容量不是瓶颈：24k 字符≈19k token 只要 7.6s，显存恒定 5.3GB（按 32k 预分配 KV），
   *   硬上限是 32768 token；
   * - **瓶颈是召回率**：同一批测试，2k 字符时 3/3 命中，12k 以上掉到 2/3——
   *   块越大越容易漏事实（漏掉的事实 = 错的长期记忆）。
   * 所以这里取"够大以减少跨块指代碎片、又不至于明显掉召回"的折中值；
   * 时间不敏感（空闲时跑），需要更高准确率就把块调小。
   */
  readonly chunk_chars?: number
  /** 是否遍历**所有**节点（默认 false：只审这批记录里提到的人）。 */
  readonly full_scan?: boolean
  /**
   * 单次提示词字符上限，默认 30000（≈24k token，给 32768 的上下文留输出余量）。
   * 超限时优先丢掉最旧的"前文提要"，绝不冒被服务端截断的风险。
   */
  readonly max_prompt_chars?: number
}

/** 一次更新的结果（用于探针与汇报）。 */
export interface GraphUpdateResult {
  readonly chunks: number
  readonly facts: number
  readonly bad_lines: number
  readonly people_created: readonly string[]
  readonly people_updated: readonly string[]
  readonly relations_created: number
  readonly unresolved: number
  /** 因超限而做"合并压缩"的次数（旧压缩块 + 当前块 → 一个新块）。 */
  readonly merged_blocks: number
  /** 极端兜底：连合并都装不下、被迫丢弃最旧提要的次数（正常应为 0）。 */
  readonly trimmed_prompts: number
}

/**
 * 抽取用提示词（中文短协议）。
 *
 * 格式说明**刻意不写"可照抄的示例行"**：实测写成 `属性|姓名|字段|值` 时，
 * 模型会把这行当成一条数据原样输出（4 次里 2 次），污染事实。
 * 改成"标签 + 竖线 + 字段名"的**散文式描述**后，照抄现象消失（4 次里 0 次），
 * 同一份测试的召回率也从 1.25/3 提升到 2.25/3。
 */
const EXTRACT_RULES = [
  '你在把聊天记录整理成"人物事实"，用于维护一份家人/朋友关系图。',
  '',
  '【输出格式】每行一条，各欄用竖线分隔。行首标签只允许这几种：',
  '第一种是"人物"，后面依次跟：人名、别名（多个用逗号隔开，没有就留空）。',
  '第二种是"属性"，后面依次跟：人名、字段名、值。',
  '第三种是"关系"，后面依次跟：称呼者、被称呼者、称呼。',
  '第四种是"事件"，后面依次跟：人名、日期、描述。',
  '第五种是"未绑定"，后面依次跟：指代词、原文片段。',
  '第六种是"上文"，后面跟一句话，概括这一块里与人物有关的要点（供下一块判断指代用）。',
  '（不要把上面这些说明当成内容抄下来；只输出真实提取到的行。）',
  '没有内容就输出：无',
  '',
  '【字段名只能用这些】姓名/别名/出生日期/年龄/性别/状态/联系方式/所在地/职业/家庭情况/重要日期/备注',
  '',
  '【硬性规则】',
  '0. 这张图以"欣爱"为中心。记录里的两个说话人已经有名字，直接用：',
  '   "[主人]"是主人本人（图谱里的规范名就是"主人"），"[欣爱]"是你自己（规范名"欣爱"）。',
  '   凡是没有指明"谁在称呼"的亲属关系，都是主人的关系，称呼者一律写"主人"。',
  '0.1 "主人"只是**称呼**，不是主人的姓名——**他的姓名还不知道**。',
  '   除非记录里明确说出姓名（"我叫张三"），否则不要写 属性|主人|姓名|…，也不要猜。',
  '   如果记录里说了以后怎么称呼（"以后叫我老板"），写成：关系|欣爱|主人|老板。',
  '1. 只写记录里明确出现的信息。禁止推断、禁止补常识、禁止编造。',
  '1.1 "用户""助手"这类词是说话人标记，**不是人名**，绝不要写成 人物 行，也不要据此编造职业/身份。',
  '2. "关系"的方向是**称呼者怎么称呼被称呼者**：记录里说"我妈王丽"，就写：关系|主人|王丽|妈妈。',
  '3. 指代词（他/她/那个人/之前那个/我同事）**必须换成名单里的具体姓名**才能写成 人物/属性/关系。',
  '   换不出来就写 未绑定|指代词|原文片段，不要猜。',
  '4. 不要把寒暄、情绪、语气词写成事实。',
  '5. 不确定的宁可不写。',
].join('\n')

/**
 * 合并压缩用提示词。
 *
 * 触发场景：已经攒了压缩上下文，再带上当前块就超限了。
 * 这时**不是丢掉旧提要**，而是把"旧压缩块 + 当前块"一起再压成一个新块继续跑——
 * 信息被压缩而不是被丢弃，这是与"直接截断"的本质区别。
 */
const MERGE_RULES = [
  '你在压缩一份"人物事实"的上下文，压缩后会继续用来处理后面的聊天记录。',
  '输入有三部分：旧的上下文提要、旧的事实清单、新的一段聊天记录。',
  '',
  '【输出格式】每行一条，用竖线分隔：',
  '提要行：行首写"上文"，后面跟一句话概括要点（最多 10 行；务必保留还没解开的指代）。',
  '事实行：行首写"属性"或"关系"或"人物"，后面按原来的字段顺序跟内容（去重，最多 60 行）。',
  '',
  '【硬性规则】',
  '1. **事实不能因为压缩而丢**：人名、称呼、关键属性必须保留下来。',
  '2. 新旧冲突时以新记录为准。',
  '3. 只输出上面两种行，不要解释、不要前言后语。',
].join('\n')

/** 逐节点审核用提示词。 */
const REVIEW_RULES = [
  '你在审核一个人物档案要不要更新。',
  '',
  '【输出格式】每行一条，只允许：',
  '更新|字段|值',
  '没有需要更新就输出：无',
  '',
  '【硬性规则】',
  '1. 只能根据下面给出的"本次事实"来更新，不能凭印象补充。',
  '2. 字段名只能用：姓名/别名/出生日期/年龄/性别/状态/联系方式/所在地/职业/家庭情况/重要日期/备注。',
  '3. 事实与现有档案冲突时，以本次事实为准并更新；没有提到的字段不要动。',
  '4. 不确定就不输出。',
].join('\n')

/** 新增人物用提示词。 */
const NEW_PERSON_RULES = [
  '你在决定要不要给关系图添加**新人物**。',
  '',
  '【输出格式】每行一条，只允许：',
  '人物|姓名|别名1,别名2',
  '关系|称呼者|被称呼者|称呼',
  '没有新人物就输出：无',
  '',
  '【硬性规则】',
  '1. 名单里已经有的人**不要**再输出 人物 行。',
  '2. 只添加记录里明确出现、且有名字的人。指代词换不出姓名的不要添加。',
  '3. 关系行的方向是"称呼者怎么称呼被称呼者"。',
  '4. 不确定就不输出。',
].join('\n')

/**
 * 从一段聊天记录更新知识图谱。
 *
 * @param options - 图谱、模型调用、分块参数。
 * @param records - 待处理的记录（按时间升序）。
 * @returns 本次更新的统计。
 */
export async function update_graph_from_records(
  options: GraphUpdaterOptions,
  records: readonly UpdateRecord[],
): Promise<GraphUpdateResult> {
  const graph = options.graph
  const chunk_chars = options.chunk_chars
    ?? Number(process.env.DSH_GRAPH_CHUNK_CHARS ?? '8000')
  // 提示词的硬上限（字符）。按实测的中文比例（约 1.26 字符/token）折算，
  // 30000 字符 ≈ 24k token，给 32768 的上下文留出输出与余量。
  // 超过就裁掉"前文提要"里最旧的部分——**宁可少带旧提要，也不能被服务端截断**。
  const max_prompt_chars = options.max_prompt_chars
    ?? Number(process.env.DSH_GRAPH_MAX_PROMPT_CHARS ?? '30000')
  // 先把中心建好（幂等）：欣爱 + 主人两个节点、两人互相的称呼。
  // 它们让"主人""欣爱"始终出现在指代候选里，也多跳查询永远有一个共同起点。
  graph.ensure_center()

  const chunks = chunk_records(records, chunk_chars)
  const all_facts: Array<{ fact: ExtractedFact; date: string; quote: string }> = []
  let bad_lines = 0
  let unresolved_total = 0
  let unresolved: Array<{ reference: string; quote: string }> = []
  // 滚动压缩上下文：每块产出的"上文提要" + 已提取事实（都是单行，天然有界）
  const gists: string[] = []
  const facts_carried: string[] = []
  let trimmed_prompts = 0
  let merged_count = 0

  for (const [index, chunk] of chunks.entries()) {
    const date = chunk[chunk.length - 1]?.date ?? ''
    // 把"前文提要"按需裁剪：先丢最旧的提要，再丢最旧的事实，直到整段装得下。
    const build = (gist_list: readonly string[], fact_list: readonly string[]): string => [
      EXTRACT_RULES,
      '',
      '【已知人物名单（指代词只能从中选择，或用 未绑定）】',
      render_candidates(candidate_names(graph)),
      ...carry_section(gist_list, fact_list, unresolved),
      ...tail_of(records, chunk, 4) === '' ? [] : ['', '【本块之前的几句（帮助判断指代）】', tail_of(records, chunk, 4)],
      '',
      '【本块聊天记录】',
      chunk.map(item => format_line(item)).join('\n'),
    ].join('\n')

    let prompt = build(gists, facts_carried)

    // 超限时：**把"旧压缩块 + 当前块"合并压缩成一个新块**，而不是丢掉旧提要。
    // 压缩是"信息变短"，丢弃是"信息消失"——前者可接受，后者会让长期记忆缺块。
    if (prompt.length > max_prompt_chars && (gists.length > 0 || facts_carried.length > 0)) {
      const merge_prompt = build_merge(gists, facts_carried, chunk)
      if (merge_prompt.length <= max_prompt_chars) {
        const merged = parse_facts(await options.complete(merge_prompt))
        bad_lines += merged.bad_lines.length
        gists.length = 0
        facts_carried.length = 0
        for (const fact of merged.facts) {
          if (fact.kind === 'unresolved') {
            unresolved.push({ reference: fact.reference, quote: fact.quote })
            unresolved_total += 1
            continue
          }
          if (fact.kind === 'gist') {
            gists.push(fact.text)
            continue
          }
          const canonical = canonicalize_fact(fact)
          all_facts.push({ fact: canonical, date, quote: quote_of(canonical) })
          facts_carried.push(render_fact(canonical))
        }
        merged_count += 1
        probe('graph', 'update.merged', {
          index: index + 1, gists: gists.length, facts: facts_carried.length,
          prompt_chars: merge_prompt.length,
        })
        // 本块已由合并调用处理完，继续下一块。
        continue
      }
      // 极端兜底：连"旧压缩块 + 本块"都装不下，才退回丢最旧的提要。
      let gist_list = [...gists]
      let fact_list = [...facts_carried]
      while (merge_prompt.length > max_prompt_chars && (gist_list.length > 0 || fact_list.length > 0)) {
        if (gist_list.length > 0) gist_list = gist_list.slice(1)
        else fact_list = fact_list.slice(1)
        trimmed_prompts += 1
        break
      }
      gists.length = 0
      gists.push(...gist_list)
      facts_carried.length = 0
      facts_carried.push(...fact_list)
      prompt = build(gists, facts_carried)
    }

    const parsed = parse_facts(await options.complete(prompt))
    bad_lines += parsed.bad_lines.length
    unresolved = []
    for (const fact of parsed.facts) {
      if (fact.kind === 'unresolved') {
        unresolved.push({ reference: fact.reference, quote: fact.quote })
        unresolved_total += 1
        continue
      }
      if (fact.kind === 'gist') {
        gists.push(fact.text)
        continue
      }
      // 落库前统一归一化说话人别名（"我"/"用户"→"主人"、"助手"→"欣爱"），
      // 否则模型会把说话人标记当成新人名建节点。
      const canonical = canonicalize_fact(fact)
      all_facts.push({ fact: canonical, date, quote: quote_of(canonical) })
      facts_carried.push(render_fact(canonical))
    }
    probe('graph', 'update.chunk_done', {
      index: index + 1, chunks: chunks.length, facts: parsed.facts.length,
      bad: parsed.bad_lines.length, prompt_chars: prompt.length, trimmed: trimmed_prompts,
    })
  }

  // ── 落库：先建人物与属性 ──────────────────────────────────────────────
  const created: string[] = []
  // "被提到的人"必须从**所有**事实里收集：只从"人物"行收集会漏掉
  // "只被提到属性/关系、但没单独声明为人物"的人，那样他们就不会被审核（实测踩过）。
  const touched = new Set<string>()
  for (const item of all_facts) {
    switch (item.fact.kind) {
      case 'person': {
        const existed = graph.find(item.fact.name) !== undefined
        graph.upsert_person({
          name: item.fact.name,
          ...item.fact.aliases === undefined ? {} : { aliases: item.fact.aliases },
          evidence: { date: item.date, note: item.quote },
        })
        if (!existed) created.push(item.fact.name)
        touched.add(item.fact.name)
        break
      }
      case 'attribute':
        touched.add(item.fact.name)
        break
      case 'relation':
        touched.add(item.fact.from)
        touched.add(item.fact.to)
        break
      default:
        break
    }
  }

  // ── 逐节点审核（只审这批被提到的人；full_scan 时审全部） ───────────────
  const to_review = options.full_scan === true
    ? graph.nodes().map(node => node.name)
    : [...touched]
  const updated: string[] = []
  for (const name of to_review) {
    const node = graph.find(name)
    if (node === undefined) continue
    const related = all_facts.filter(item =>
      (item.fact.kind === 'attribute' && item.fact.name === name)
      || (item.fact.kind === 'person' && item.fact.name === name))
    if (related.length === 0 && options.full_scan !== true) continue
    const prompt = [
      REVIEW_RULES,
      '',
      `【人物】${node.name}`,
      `【现有档案】${describe_current(node)}`,
      '',
      '【本次事实】',
      related.length === 0 ? '（无）' : related.map(item => render_fact(item.fact)).join('\n'),
    ].join('\n')
    const parsed = parse_facts_review(await options.complete(prompt))
    bad_lines += parsed.bad_lines.length
    if (parsed.updates.length === 0) continue
    const patch = patch_from_updates(parsed.updates)
    if (Object.keys(patch).length === 0) continue
    // 带 id：审核里若给出"姓名"就是**就地改名**（旧名自动变别名），
    // 不带 id 会按新名字匹配不到、凭空多建一个人。
    graph.upsert_person({
      id: node.id, name: node.name, ...patch,
      evidence: { date: all_facts[0]?.date ?? '', note: '逐节点审核' },
    })
    updated.push(node.name)
    probe('graph', 'update.node_reviewed', { name: node.name, fields: Object.keys(patch).length })
  }

  // ── 落库：属性（未被审核覆盖的，直接按事实写入） ────────────────────────
  for (const item of all_facts) {
    if (item.fact.kind !== 'attribute') continue
    const patch = patch_from_updates([{ field: item.fact.field, value: item.fact.value }])
    if (Object.keys(patch).length === 0) continue
    const existing = graph.find(item.fact.name)
    graph.upsert_person({
      name: item.fact.name, ...patch,
      // 只有"要改姓名"时才带 id（改名走就地改名 + 旧名转别名）。
      // 其它字段带 id 会把正名覆盖成别名——"属性|妈妈|职业|医生"不该把"王丽"改名成"妈妈"。
      ...(existing !== undefined && typeof patch.name === 'string' ? { id: existing.id } : {}),
      evidence: { date: item.date, note: item.quote },
    })
    touched.add(item.fact.name)
  }

  // ── 关系 ──────────────────────────────────────────────────────────────
  let relations_created = 0
  for (const item of all_facts) {
    if (item.fact.kind !== 'relation') continue
    const edge = graph.upsert_edge({
      from: item.fact.from, to: item.fact.to, label: item.fact.label,
      // 两个中心人物之间是"当面称呼"（替换语义）：她说的是"以后叫我老板"，
      // 那旧称呼就该让位；别人的亲属称谓仍然允许多个叫法并存。
      ...is_address_pair(item.fact.from, item.fact.to) ? { kind: 'address' as const } : {},
      evidence: { date: item.date, note: item.quote },
    })
    if (edge !== undefined) relations_created += 1
  }

  // ── 最后问：要不要加新人物 ────────────────────────────────────────────
  const known = candidate_names(graph)
  // 这一步也要守上限：它带着"全部事实"，事实多起来同样会超。
  // 超了就从**最旧的事实**开始丢（最新的事实对"要不要加新人"更有参考价值）。
  const fact_lines = all_facts.map(item => render_fact(item.fact))
  const build_new = (lines: readonly string[]): string => [
    NEW_PERSON_RULES,
    '',
    '【已知人物名单】',
    render_candidates(known, 60),
    '',
    '【本次整理出的事实】',
    lines.length === 0 ? '（无）' : lines.join('\n'),
  ].join('\n')
  let kept = fact_lines
  let new_prompt = build_new(kept)
  while (new_prompt.length > max_prompt_chars && kept.length > 0) {
    kept = kept.slice(1)
    new_prompt = build_new(kept)
    trimmed_prompts += 1
  }
  const new_parsed = parse_facts(await options.complete(new_prompt))
  bad_lines += new_parsed.bad_lines.length
  for (const fact of new_parsed.facts) {
    if (fact.kind === 'person' && graph.find(fact.name) === undefined) {
      graph.upsert_person({
        name: fact.name,
        ...fact.aliases === undefined ? {} : { aliases: fact.aliases },
        evidence: { date: all_facts[0]?.date ?? '', note: '新增人物审核' },
      })
      created.push(fact.name)
    }
    if (fact.kind === 'relation') {
      const edge = graph.upsert_edge({
        from: fact.from, to: fact.to, label: fact.label,
        evidence: { date: all_facts[0]?.date ?? '', note: '新增人物审核' },
      })
      if (edge !== undefined) relations_created += 1
    }
  }

  const result: GraphUpdateResult = {
    chunks: chunks.length,
    facts: all_facts.length,
    bad_lines,
    people_created: created,
    people_updated: updated,
    relations_created,
    unresolved: unresolved_total,
    merged_blocks: merged_count,
    trimmed_prompts,
  }
  probe('graph', 'update.done', { ...result })
  return result
}

// ── 内部 ──────────────────────────────────────────────────────────────────

/** 组装"合并压缩"提示词：旧压缩块 + 当前块 → 一个新块。 */
function build_merge(
  gists: readonly string[],
  facts: readonly string[],
  chunk: readonly UpdateRecord[],
): string {
  return [
    MERGE_RULES,
    '',
    '【旧的上下文提要】',
    gists.length === 0 ? '（无）' : gists.map(item => `- ${item}`).join('\n'),
    '',
    '【旧的事实清单】',
    facts.length === 0 ? '（无）' : facts.join('\n'),
    '',
    '【新的一段聊天记录】',
    chunk.map(item => format_line(item)).join('\n'),
  ].join('\n')
}

/**
 * 组装"前文提要"段（滚动压缩上下文）。
 *
 * 这是防上下文丢失的关键：分块后"之前那个人"可能落在上一块，
 * 只带上一块原文会撑爆显存，所以带的是**压缩形式**——
 * 每块一句提要 + 已提取的单行事实 + 未解指代，全部是有界的小文本。
 */
function carry_section(
  gists: readonly string[],
  facts: readonly string[],
  unresolved: readonly { reference: string; quote: string }[],
): string[] {
  const out: string[] = []
  if (gists.length > 0) {
    out.push('', '【前文提要（前面几块的压缩要点，帮助判断指代）】')
    for (const gist of gists.slice(-8)) out.push(`- ${gist}`)
  }
  if (facts.length > 0) {
    out.push('', '【前面已提取的事实（不要重复输出这些）】')
    for (const fact of facts.slice(-40)) out.push(fact)
  }
  if (unresolved.length > 0) {
    out.push('', '【前面未解开的指代】', render_pending(unresolved))
  }
  return out
}

/** 一条关系是不是"当面称呼"（两个中心人物之间）。 */
function is_address_pair(from: string, to: string): boolean {
  const centers = [GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME]
  return from !== to && centers.includes(from) && centers.includes(to)
}

/** 候选人物名单：图谱里的姓名 + 别名（别名也列出来，方便指代匹配）。 */
function candidate_names(graph: KnowledgeGraphStore): string[] {
  const out: string[] = []
  for (const node of graph.nodes()) {
    out.push(node.name)
    for (const alias of node.aliases ?? []) out.push(alias)
  }
  return out
}

/** 按字符预算切块。 */
function chunk_records(records: readonly UpdateRecord[], budget: number): UpdateRecord[][] {
  const chunks: UpdateRecord[][] = []
  let current: UpdateRecord[] = []
  let size = 0
  for (const record of records) {
    const cost = record.text.length + 8
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(record)
    size += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 取本块之前的若干行，作为跨块指代的上下文（有界）。 */
function tail_of(records: readonly UpdateRecord[], chunk: readonly UpdateRecord[], lines: number): string {
  const first = records.indexOf(chunk[0] as UpdateRecord)
  if (first <= 0) return ''
  return records.slice(Math.max(0, first - lines), first)
    .map(item => format_line(item))
    .join('\n')
}

/**
 * 一行聊天记录：说话人标签直接用图谱规范名。
 *
 * 用 `[主人]`/`[欣爱]` 而不是 `[用户]`/`[助手]`，模型看到的就是该输出的名字，
 * 少一层映射就少一类错误（把说话人标记当人名建节点）。
 */
function format_line(item: UpdateRecord): string {
  const speaker = item.role === 'user' ? GRAPH_USER_NAME : GRAPH_ASSISTANT_NAME
  return `[${speaker}] ${item.text}`
}

/** 把事实里的人名归一化（说话人别名 → 规范名）。 */
function canonicalize_fact(fact: ExtractedFact): ExtractedFact {
  switch (fact.kind) {
    case 'person':
      return { ...fact, name: canonical_person_name(fact.name) }
    case 'attribute':
      return { ...fact, name: canonical_person_name(fact.name) }
    case 'relation':
      return { ...fact, from: canonical_person_name(fact.from), to: canonical_person_name(fact.to) }
    case 'event':
      return { ...fact, name: canonical_person_name(fact.name) }
    default:
      return fact
  }
}

/** 事实的一句话表示（既作为证据，也用于后续调用）。 */
function render_fact(fact: ExtractedFact): string {
  switch (fact.kind) {
    case 'person': return `人物|${fact.name}${fact.aliases === undefined ? '' : '|' + fact.aliases.join(',')}`
    case 'attribute': return `属性|${fact.name}|${fact.field}|${fact.value}`
    case 'relation': return `关系|${fact.from}|${fact.to}|${fact.label}`
    case 'event': return `事件|${fact.name}|${fact.date}|${fact.description}`
    case 'unresolved': return `未绑定|${fact.reference}|${fact.quote}`
    case 'gist': return `上文|${fact.text}`
  }
}

/** 证据里的短引用。 */
function quote_of(fact: ExtractedFact): string {
  return render_fact(fact).slice(0, 80)
}

/** 现有档案的可读描述（喂给审核调用）。 */
function describe_current(node: { name: string; aliases?: readonly string[]; birthday?: string; age?: number; gender?: string; status?: string; contacts?: readonly string[]; location?: string; occupation?: string; family_summary?: string; notes?: string }): string {
  const bits: string[] = []
  if (node.aliases !== undefined && node.aliases.length > 0) bits.push(`别名=${node.aliases.join(',')}`)
  if (node.birthday !== undefined) bits.push(`出生日期=${node.birthday}`)
  if (node.age !== undefined) bits.push(`年龄=${node.age}`)
  if (node.gender !== undefined) bits.push(`性别=${node.gender}`)
  if (node.status !== undefined) bits.push(`状态=${node.status}`)
  if (node.contacts !== undefined && node.contacts.length > 0) bits.push(`联系方式=${node.contacts.join(',')}`)
  if (node.location !== undefined) bits.push(`所在地=${node.location}`)
  if (node.occupation !== undefined) bits.push(`职业=${node.occupation}`)
  if (node.family_summary !== undefined) bits.push(`家庭情况=${node.family_summary}`)
  if (node.notes !== undefined) bits.push(`备注=${node.notes}`)
  return bits.length === 0 ? '（空）' : bits.join('；')
}

/** 解析审核输出（`更新|字段|值`）。 */
function parse_facts_review(text: string): {
  updates: Array<{ field: string; value: string }>
  bad_lines: string[]
} {
  const updates: Array<{ field: string; value: string }> = []
  const bad_lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/, '')
    if (line === '' || line === '无' || line.startsWith('#')) continue
    const parts = line.split('|').map(item => item.trim())
    const field = parts[1] ?? ''
    if (parts[0] !== '更新' || field === '' || parts.length < 3) {
      bad_lines.push(line)
      continue
    }
    updates.push({ field, value: parts.slice(2).join('|') })
  }
  return { updates, bad_lines }
}

/** 把 `字段|值` 转成节点补丁；不认识的字段直接忽略（宁可少写也不写错）。 */
function patch_from_updates(updates: readonly { field: string; value: string }[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const { field, value } of updates) {
    if (!is_known_attribute_field(field)) continue
    const key = map_attribute_field(field)
    switch (key) {
      case 'age': {
        const age = Number(value.replace(/[^\d]/g, ''))
        if (Number.isFinite(age) && age > 0 && age < 150) patch.age = age
        break
      }
      case 'contacts':
        patch.contacts = value.split(/[,，、;；]/).map(item => item.trim()).filter(item => item !== '')
        break
      case 'aliases':
        patch.aliases = value.split(/[,，、;；]/).map(item => item.trim()).filter(item => item !== '')
        break
      case 'status':
        patch.status = /已故|去世|过世/.test(value) ? 'deceased'
          : /失联|联系不上/.test(value) ? 'lost_contact'
            : /在世|健在/.test(value) ? 'alive' : 'unknown'
        break
      case 'gender':
        patch.gender = /男/.test(value) ? 'male' : /女/.test(value) ? 'female' : 'unknown'
        break
      case 'important_dates': {
        const match = /^(.+?)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.exec(value.trim())
        if (match !== null) patch.important_dates = [{ label: match[1]!.trim(), date: match[2]! }]
        break
      }
      default:
        if (value.trim() !== '') patch[key] = value.trim()
    }
  }
  return patch
}

/** 让 GraphEvidence 类型在文件内可见（供类型推断）。 */
export type { GraphEvidence }

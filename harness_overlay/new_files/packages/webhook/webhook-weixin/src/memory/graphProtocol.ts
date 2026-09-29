/**
 * 图谱更新用的**中文短协议**（不是 JSON）。
 *
 * 为什么不用 JSON：本地 Gemma 是小模型，让它输出 JSON 时经常出现
 * 引号不配对、尾逗号、字段名漂移；一旦解析失败整批就白跑。
 * 改成"一行一条、竖线分隔"的短协议后：格式约束极弱、容错极高，
 * 坏行可以直接跳过而不影响其它行——这是我们在"中文短协议风格"上的一贯取舍。
 *
 * 协议（每行一个，`|` 分隔，行首是标签）：
 * ```
 * 人物|姓名|别名1,别名2
 * 属性|姓名|字段|值
 * 关系|称呼者|被称呼者|称呼
 * 事件|姓名|日期|描述
 * 未绑定|指代词|原文片段
 * ```
 * 无内容时输出 `无`。除这些之外的内容一律忽略。
 *
 * @module dsh-webhook-weixin/graph-protocol
 */

/** 抽取出来的事实。 */
export type ExtractedFact =
  | { kind: 'person'; name: string; aliases?: readonly string[] }
  | { kind: 'attribute'; name: string; field: string; value: string }
  | { kind: 'relation'; from: string; to: string; label: string }
  | { kind: 'event'; name: string; date: string; description: string }
  | { kind: 'unresolved'; reference: string; quote: string }
  /**
   * 本块的"上文提要"：一句话概括这块里与人物有关的要点。
   *
   * 它的唯一用途是**被带到下一块**——分块最怕的就是跨块上下文丢失
   * （"之前那个人"在上一块），而把整块原文带下去会撑爆显存。
   * 提要 + 已提取事实一起构成"有界的压缩上下文"，既保住信息又不炸上下文。
   */
  | { kind: 'gist'; text: string }

/** 解析结果。 */
export interface ParseResult {
  readonly facts: readonly ExtractedFact[]
  /** 格式不对、被丢弃的行（用于探针观察模型输出质量）。 */
  readonly bad_lines: readonly string[]
}

/** 协议里"属性"字段名 → 节点字段。用中文名是为了让模型不用翻译。 */
const ATTRIBUTE_FIELDS: Record<string, string> = {
  姓名: 'name',
  别名: 'aliases',
  出生日期: 'birthday',
  生日: 'birthday',
  年龄: 'age',
  性别: 'gender',
  状态: 'status',
  联系方式: 'contacts',
  电话: 'contacts',
  所在地: 'location',
  职业: 'occupation',
  家庭情况: 'family_summary',
  重要日期: 'important_dates',
  备注: 'notes',
}

/** 把中文字段名映射成节点字段；不认识就原样返回（由调用方决定是否忽略）。 */
export function map_attribute_field(field: string): string {
  const key = field.trim()
  return ATTRIBUTE_FIELDS[key] ?? key
}

/** 该字段是否是图谱认可的属性字段。 */
export function is_known_attribute_field(field: string): boolean {
  return ATTRIBUTE_FIELDS[field.trim()] !== undefined
}

/**
 * 解析模型输出的短协议文本。
 *
 * 容错优先：只认行首标签，字段数不对或值空白的行进 `bad_lines`，绝不抛错。
 */
export function parse_facts(text: string): ParseResult {
  const facts: ExtractedFact[] = []
  const bad_lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/, '')
    if (line === '' || line === '无' || line.startsWith('#')) continue
    const parts = line.split('|').map(item => item.trim())
    const at = (index: number): string => parts[index] ?? ''
    const tag = at(0)
    switch (tag) {
      case '人物': {
        if (at(1) === '') { bad_lines.push(line); break }
        const aliases = at(2).split(/[,，、]/).map(item => item.trim()).filter(item => item !== '')
        facts.push({ kind: 'person', name: at(1), ...aliases.length === 0 ? {} : { aliases } })
        break
      }
      case '属性': {
        if (at(1) === '' || at(2) === '' || at(3) === '') { bad_lines.push(line); break }
        facts.push({ kind: 'attribute', name: at(1), field: at(2), value: at(3) })
        break
      }
      case '关系': {
        if (at(1) === '' || at(2) === '' || at(3) === '') { bad_lines.push(line); break }
        facts.push({ kind: 'relation', from: at(1), to: at(2), label: at(3) })
        break
      }
      case '事件': {
        if (at(1) === '' || at(3) === '') { bad_lines.push(line); break }
        facts.push({ kind: 'event', name: at(1), date: at(2), description: at(3) })
        break
      }
      case '未绑定': {
        if (at(1) === '') { bad_lines.push(line); break }
        facts.push({ kind: 'unresolved', reference: at(1), quote: at(3) === '' ? at(2) : at(3) })
        break
      }
      case '上文': {
        const text = parts.slice(1).join('|').trim()
        if (text === '') { bad_lines.push(line); break }
        facts.push({ kind: 'gist', text })
        break
      }
      default:
        // 说明性文字（模型有时会先写一句话）不算错，但也别当成事实。
        bad_lines.push(line)
    }
  }
  return { facts, bad_lines }
}

/**
 * 渲染"指代候选"清单——**这是解决"之前那个人"的关键**。
 *
 * 小模型靠长上下文解指代既慢又吃显存；改成给它一份**很小的候选名单**
 * （最近提到过的人 + 图谱里已有的人 + 上一块提到的最后几个人），
 * 让它做"指代词 → 名单里哪一个"的选择题，比自由回忆稳得多。
 *
 * @param people - 候选人物（姓名 + 可选的关系提示，例如"小李（同事）"）。
 * @param limit - 最多列几个，防止名单本身变长。
 */
export function render_candidates(people: readonly string[], limit = 30): string {
  const unique: string[] = []
  for (const item of people) {
    const value = item.trim()
    if (value !== '' && !unique.includes(value)) unique.push(value)
  }
  if (unique.length === 0) return '（暂无已知人物）'
  return unique.slice(-limit).join('、')
}

/** 把待解指代的片段渲染进下一次调用的上下文（有界，避免无限累积）。 */
export function render_pending(pending: readonly { reference: string; quote: string }[], limit = 5): string {
  if (pending.length === 0) return ''
  return pending.slice(-limit).map(item => `- "${item.reference}" → 可能指：${item.quote}`).join('\n')
}

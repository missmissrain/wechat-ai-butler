/**
 * 知识图谱存储（社交网络）：人物节点 + "A 称呼 B 为 X"的有向边。
 *
 * 目录结构与时间线同构（**原始数据权威、视图可重建**）：
 * ```
 * <dir>/
 *   nodes.jsonl    # 权威：一人一行
 *   edges.jsonl    # 权威：一条称呼一行
 *   index.json     # 元数据：id 计数器、更新时间
 *   graph.md       # 人类可读视图（生成，勿手改）
 * ```
 *
 * 关键设计：
 * - **id 与姓名解耦**：改名不会产生新节点；查找支持姓名与别名。
 * - **每条信息带证据**：`sources` 记录"哪天的哪句话"支撑它，便于纠错和取信。
 * - **年龄不硬记**：能从生日算就算，避免模型写错后一直错。
 * - **不删只标**：节点/边不物理删除（人不会因为一次聊天就说错而被抹掉），
 *   需要"失效"时用状态字段（例如 `status: 'unknown'`）。
 *
 * @module dsh-webhook-weixin/graph-store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import { rename_with_retry, with_file_lock } from './fileLock.ts'
import {
  GRAPH_ASSISTANT_NAME,
  GRAPH_USER_NAME,
  type GraphEvidence,
  type GraphPath,
  type GraphSnapshot,
  type KnowledgeGraphOptions,
  type PersonNode,
  type RelationEdge,
} from './graphTypes.ts'

/** 两个人之间最多找多深的链路（超过就没有解释价值了）。 */
const DEFAULT_MAX_DEPTH = 4

/** 知识图谱存储。 */
export class KnowledgeGraphStore {
  private readonly dir: string
  /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
  private tmp_seq = 0

  constructor(options: KnowledgeGraphOptions) {
    this.dir = options.dir
    mkdirSync(this.dir, { recursive: true })
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  /** 全部节点。 */
  nodes(): PersonNode[] {
    return read_jsonl<PersonNode>(this.nodes_path())
  }

  /** 全部边。 */
  edges(): RelationEdge[] {
    return read_jsonl<RelationEdge>(this.edges_path())
  }

  snapshot(): GraphSnapshot {
    return { nodes: this.nodes(), edges: this.edges() }
  }

  /** 按 id 或姓名/别名找人（姓名匹配忽略大小写与空格）。 */
  find(name_or_id: string): PersonNode | undefined {
    const needle = normalize(name_or_id)
    if (needle === '') return undefined
    return this.nodes().find(node => node.id === name_or_id
      || normalize(node.name) === needle
      || (node.aliases ?? []).some(alias => normalize(alias) === needle))
  }

  /** 某人对外（他称呼别人）的边。 */
  edges_from(id: string): RelationEdge[] {
    return this.edges().filter(edge => edge.from === id)
  }

  /** 别人对某人的边（别人怎么称呼他）。 */
  edges_to(id: string): RelationEdge[] {
    return this.edges().filter(edge => edge.to === id)
  }

  /**
   * 查询 A 与 B 之间的链路（**支持"朋友的朋友"这种多跳**）。
   *
   * 从 `from` 出发按有向边广度优先，找出所有到 `to` 的简单路径（不重复经过同一节点），
   * 深度上限默认 4 跳。深度必须限制：再远的关系已经解释不动，而且搜索会爆炸。
   *
   * @returns 按跳数从短到长排序的链路；没有通路返回空数组。
   */
  paths(from_name: string, to_name: string, options?: { max_depth?: number }): GraphPath[] {
    const start = this.find(from_name)
    const end = this.find(to_name)
    if (start === undefined || end === undefined) return []
    const max_depth = Math.max(1, Math.min(8, options?.max_depth ?? DEFAULT_MAX_DEPTH))
    const nodes = new Map(this.nodes().map(node => [node.id, node]))
    const outgoing = new Map<string, RelationEdge[]>()
    for (const edge of this.edges()) {
      const list = outgoing.get(edge.from) ?? []
      list.push(edge)
      outgoing.set(edge.from, list)
    }

    const results: GraphPath[] = []
    // 简单路径搜索：visited 随路径走，避免环。
    const walk = (current: string, visited: Set<string>, hops: RelationEdge[]): void => {
      if (current === end.id && hops.length > 0) {
        results.push(build_path(hops, nodes))
        return
      }
      if (hops.length >= max_depth) return
      for (const edge of outgoing.get(current) ?? []) {
        if (visited.has(edge.to)) continue
        if (edge.to === end.id) {
          results.push(build_path([...hops, edge], nodes))
          continue
        }
        visited.add(edge.to)
        walk(edge.to, visited, [...hops, edge])
        visited.delete(edge.to)
      }
    }
    walk(start.id, new Set([start.id]), [])

    return results.sort((a, b) => a.hops.length - b.hops.length)
  }

  /**
   * 某人的关系网（向外 expand 多少跳），用于"他身边都有谁"这类问题。
   */
  neighborhood(name: string, options?: { max_depth?: number }): Array<{ name: string, label: string, depth: number }> {
    const start = this.find(name)
    if (start === undefined) return []
    const max_depth = Math.max(1, Math.min(6, options?.max_depth ?? 2))
    const nodes = new Map(this.nodes().map(node => [node.id, node]))
    const outgoing = new Map<string, RelationEdge[]>()
    for (const edge of this.edges()) {
      const list = outgoing.get(edge.from) ?? []
      list.push(edge)
      outgoing.set(edge.from, list)
    }
    const seen = new Map<string, { name: string, label: string, depth: number }>()
    let frontier = [start.id]
    for (let depth = 1; depth <= max_depth; depth += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (edge.to === start.id || seen.has(edge.to)) continue
          seen.set(edge.to, {
            name: nodes.get(edge.to)?.name ?? edge.to, label: edge.label, depth,
          })
          next.push(edge.to)
        }
      }
      frontier = next
    }
    return [...seen.values()]
  }

  /** 人物属性（含由生日推算的年龄）。 */
  attributes(name: string): PersonNode | undefined {
    const node = this.find(name)
    if (node === undefined) return undefined
    const age = node.age ?? age_from_birthday(node.birthday)
    return age === undefined ? node : { ...node, age }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────

  /**
   * 建立（或修复）图谱的中心——**欣爱是绝对中心**。
   *
   * 做三件事，全部幂等，所以启动时无脑调用即可：
   * 1. **只建两个中心节点**：`欣爱` 与 `主人`。除姓名外不预设任何属性——
   *    图谱应该是"聊到什么补什么"，凭空写一个"状态：unknown"只会变成噪音。
   * 2. **建立两人互相的称呼**：欣爱→主人 标 `主人`（她这么称呼他），
   *    主人→欣爱 标 `欣爱`。这两条边给了所有多跳查询一个共同起点。
   * 3. **迁移历史数据**：早期版本把用户节点叫"我"（还硬写了 `status: unknown`），
   *    这里就地改名为"主人"，并把"我"保留成别名——于是按"我""用户"仍然查得到，
   *    已有边因为存的是 id，完全不受影响。
   */
  ensure_center(): void {
    const user_exists = this.find(GRAPH_USER_NAME) !== undefined
    let changed = false
    const migrated = this.nodes().map(node => {
      let next = node
      // 旧的"我"→"主人"（仅在还没有"主人"节点时迁移，避免两个节点合并出错）
      if (!user_exists && normalize(node.name) === '我') {
        next = strip_undefined({
          ...next, name: GRAPH_USER_NAME, aliases: merge_list(next.aliases, ['我']),
        }) as PersonNode
        probe('graph', 'center.migrated_self', { id: node.id })
      }
      // 去掉早期创建时硬写的 status（"除姓名外都可缺省"）
      if (next.status === 'unknown') next = strip_undefined({ ...next, status: undefined }) as PersonNode
      if (next !== node) changed = true
      return next
    })
    if (changed) this.write_nodes(migrated)

    for (const name of [GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME]) {
      if (this.find(name) === undefined) {
        this.upsert_person({ name, evidence: { date: today(), note: '图谱中心节点' } })
        probe('graph', 'center.created', { name })
      }
    }
    // 这两条是"当面称呼"→ kind 'address'，所以以后重命名（"以后叫我老板"）是替换而非叠加。
    this.upsert_edge({ from: GRAPH_ASSISTANT_NAME, to: GRAPH_USER_NAME, label: GRAPH_USER_NAME, kind: 'address' })
    this.upsert_edge({ from: GRAPH_USER_NAME, to: GRAPH_ASSISTANT_NAME, label: GRAPH_ASSISTANT_NAME, kind: 'address' })
  }

  // ── 更新 ────────────────────────────────────────────────────────────────

  /**
   * 新增或更新一个人（按姓名/别名匹配已有节点；匹配不到就新建）。
   *
   * **改名只认显式 id**：只有调用方给出 `id`（说明它已经解析出"这是谁"）时，
   * `name` 才会被当成新正名。否则用别名调用（"妈妈"→已存在的"王丽"）会把正名
   * 覆盖成别名，节点从此在"王丽"名下查不到——这个坑实测踩过。
   *
   * @returns 落库后的节点。
   */
  upsert_person(input: {
    name: string
    id?: string
    aliases?: readonly string[]
    birthday?: string
    age?: number
    gender?: PersonNode['gender']
    status?: PersonNode['status']
    contacts?: readonly string[]
    location?: string
    occupation?: string
    family_summary?: string
    important_dates?: readonly { label: string; date: string }[]
    notes?: string
    evidence?: GraphEvidence
  }): PersonNode {
    // 整个"读全图 → 改 → 写回"必须持锁：两个进程同时 upsert 会互相覆盖（实测丢一半）。
    return with_file_lock(this.nodes_path(), () => this.upsert_person_locked(input))
  }

  private upsert_person_locked(input: {
    name: string
    id?: string
    aliases?: readonly string[]
    birthday?: string
    age?: number
    gender?: PersonNode['gender']
    status?: PersonNode['status']
    contacts?: readonly string[]
    location?: string
    occupation?: string
    family_summary?: string
    important_dates?: readonly { label: string; date: string }[]
    notes?: string
    evidence?: GraphEvidence
  }): PersonNode {
    const existing = input.id === undefined ? this.find(input.name) : this.nodes().find(n => n.id === input.id)
    const nodes = this.nodes()
    const now = Date.now()
    if (existing === undefined) {
      // 只写调用方真正给出来的字段：**除姓名外全部可缺省**。
      // （早期版本会给新节点硬写 `status: 'unknown'`，那只是一个没信息量的占位。）
      const node: PersonNode = strip_undefined({
        id: this.next_id(),
        name: input.name.trim(),
        aliases: input.aliases,
        birthday: input.birthday,
        age: input.age,
        gender: input.gender,
        status: input.status,
        contacts: input.contacts,
        location: input.location,
        occupation: input.occupation,
        family_summary: input.family_summary,
        important_dates: input.important_dates,
        notes: input.notes,
        updated_at: now,
        sources: input.evidence === undefined ? undefined : [input.evidence],
      })
      nodes.push(node)
      this.write_nodes(nodes)
      probe('graph', 'person.created', { id: node.id, name: node.name })
      return node
    }

    // 更新：只覆盖显式给出的字段；证据累加去重。
    const requested = input.name.trim()
    const renaming = input.id !== undefined && requested !== ''
      && normalize(requested) !== normalize(existing.name)
    const merged: PersonNode = strip_undefined({
      ...existing,
      name: input.id === undefined || requested === '' ? existing.name : requested,
      // 改名时把旧正名收成别名：改名后按老名字依然找得到这个人
      aliases: merge_list(renaming ? merge_list(existing.aliases, [existing.name]) : existing.aliases, input.aliases),
      birthday: input.birthday ?? existing.birthday,
      age: input.age ?? existing.age,
      gender: input.gender ?? existing.gender,
      status: input.status ?? existing.status,
      contacts: merge_list(existing.contacts, input.contacts),
      location: input.location ?? existing.location,
      occupation: input.occupation ?? existing.occupation,
      family_summary: input.family_summary ?? existing.family_summary,
      important_dates: merge_dates(existing.important_dates, input.important_dates),
      notes: input.notes ?? existing.notes,
      updated_at: now,
      sources: merge_evidence(existing.sources, input.evidence),
    })
    this.write_nodes(nodes.map(node => node.id === existing.id ? merged : node))
    probe('graph', 'person.updated', { id: merged.id, name: merged.name })
    return merged
  }

  /**
   * 新增或更新一条"称呼"边。
   *
   * 同一对人可以有多个称呼（`妈` / `母亲`），所以按 (from,to,label) 去重而不是按 (from,to)。
   */
  upsert_edge(input: {
    from: string
    to: string
    label: string
    kind?: RelationEdge['kind']
    evidence?: GraphEvidence
  }): RelationEdge | undefined {
    // 同上：边的"读全表 → 改 → 写回"也要持锁。
    return with_file_lock(this.edges_path(), () => this.upsert_edge_locked(input))
  }

  private upsert_edge_locked(input: {
    from: string
    to: string
    label: string
    kind?: RelationEdge['kind']
    evidence?: GraphEvidence
  }): RelationEdge | undefined {
    const from = this.find(input.from)
    const to = this.find(input.to)
    if (from === undefined || to === undefined) {
      probe('graph', 'edge.missing_person', { from: input.from, to: input.to })
      return undefined
    }
    if (from.id === to.id) return undefined
    const edges = this.edges()
    const label = input.label.trim()
    if (label === '') return undefined
    const now = Date.now()

    // 「当面称呼」是**替换**语义：一个人对另一个人的当前叫法只有一个。
    // 亲属称谓（妈/母亲/娘）则允许并存，所以这个分支只对 kind==='address' 生效。
    const address = edges.find(edge =>
      edge.from === from.id && edge.to === to.id && edge.kind === 'address')
    if (input.kind === 'address' && address !== undefined && address.label !== label) {
      const merged: RelationEdge = strip_undefined({
        ...address,
        label,
        previous_labels: [address.label, ...address.previous_labels ?? []].slice(0, 8),
        updated_at: now,
        sources: merge_evidence(address.sources, input.evidence),
      })
      this.write_edges(edges.map(edge => edge === address ? merged : edge))
      probe('graph', 'edge.address_updated', {
        from: from.name, to: to.name, before: address.label, after: label,
      })
      return merged
    }

    const existing = edges.find(edge => edge.from === from.id && edge.to === to.id && edge.label === label)
    if (existing === undefined) {
      const edge: RelationEdge = strip_undefined({
        from: from.id, to: to.id, label, kind: input.kind,
        updated_at: now,
        sources: input.evidence === undefined ? undefined : [input.evidence],
      })
      edges.push(edge)
      this.write_edges(edges)
      probe('graph', 'edge.created', { from: from.name, to: to.name, label })
      return edge
    }
    const merged: RelationEdge = strip_undefined({
      ...existing,
      kind: input.kind ?? existing.kind,
      updated_at: now,
      sources: merge_evidence(existing.sources, input.evidence),
    })
    this.write_edges(edges.map(edge => edge === existing ? merged : edge))
    return merged
  }

  /** 人类可读视图（生成）。 */
  to_markdown(): string {
    const nodes = this.nodes()
    const edges = this.edges()
    const by_id = new Map(nodes.map(node => [node.id, node]))
    const lines: string[] = ['# 人物关系图', '', `节点 ${nodes.length} · 称呼 ${edges.length}`, '']
    for (const node of nodes) {
      lines.push(`## ${node.name}（${node.id}）`)
      lines.push('')
      lines.push(`- 别名：${(node.aliases ?? []).join('、') || '—'}`)
      lines.push(`- 生日：${node.birthday ?? '—'}　年龄：${node.age ?? age_from_birthday(node.birthday) ?? '—'}`)
      lines.push(`- 性别：${node.gender ?? '—'}　状态：${node.status ?? 'unknown'}`)
      lines.push(`- 职业：${node.occupation ?? '—'}　所在地：${node.location ?? '—'}`)
      lines.push(`- 联系方式：${(node.contacts ?? []).join('、') || '—'}`)
      lines.push(`- 家庭情况：${node.family_summary ?? '—'}`)
      if ((node.important_dates ?? []).length > 0) {
        lines.push(`- 重要日期：${(node.important_dates ?? []).map(d => `${d.label} ${d.date}`).join('；')}`)
      }
      if (node.notes !== undefined) lines.push(`- 备注：${node.notes}`)
      const out = edges.filter(edge => edge.from === node.id)
      if (out.length > 0) {
        lines.push('')
        lines.push('他/她是这样称呼别人的：')
        for (const edge of out) lines.push(`- → ${by_id.get(edge.to)?.name ?? edge.to}：${edge.label}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /** 重建人类可读视图。 */
  regenerate_view(): void {
    this.write_atomic(join(this.dir, 'graph.md'), `${this.to_markdown()}\n`)
  }

  /** 统计。 */
  stats(): { people: number, relations: number } {
    return { people: this.nodes().length, relations: this.edges().length }
  }

  /** 存储目录（清空图谱时需要，避免调用方另算一遍路径）。 */
  dir_path(): string {
    return this.dir
  }

  /**
   * 把"消化到哪了"的水位清零。
   *
   * 清空图谱后要调它：否则水位还停在被清掉之前的位置，后续更新只会处理**新**记录，
   * 图谱会一直空着。归零之后，下一次空闲更新会把时间线里的历史重新消化一遍，
   * 图谱就能从已有记忆里逐步长回来。
   */
  reset_watermark(): void {
    const index = this.load_index()
    const { last_update_ms, last_update_ids, ...rest } = index
    this.save_index(rest)
    probe('graph', 'watermark.reset', { previous: last_update_ms ?? 0 })
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private nodes_path(): string { return join(this.dir, 'nodes.jsonl') }
  private edges_path(): string { return join(this.dir, 'edges.jsonl') }
  private index_path(): string { return join(this.dir, 'index.json') }

  /**
   * 上次用聊天记录更新图谱的时间（毫秒）。
   *
   * 用它做**增量更新**：每次只处理比它更新的记录，避免重复消化同一批对话
   * （重复处理不仅浪费，还会让模型反复"确认"同一件事，容易把错误固化下来）。
   */
  last_update_ms(): number | undefined {
    return this.load_index().last_update_ms
  }

  /** 本次水位同时刻已处理过的记录 id（用于 (ts, id) 复合游标）。 */
  last_update_ids(): string[] {
    return this.load_index().last_update_ids ?? []
  }

  /**
   * 记录本次更新覆盖到的水位：时间戳 + **该时间戳上已处理的记录 id**。
   *
   * 为什么要带 id：只存毫秒时间戳时，同一毫秒内后来新增的记录会被
   * `ts > since` 永久跳过（审计复现过）。带上 id 就能精确续上。
   */
  set_last_update(ts: number, ids: readonly string[] = []): void {
    const index = this.load_index()
    const previous = index.last_update_ms ?? 0
    if (ts < previous) return
    const same_moment = ts === previous ? [...new Set([...(index.last_update_ids ?? []), ...ids])] : [...new Set(ids)]
    this.save_index({ ...index, last_update_ms: ts, last_update_ids: same_moment.slice(-200) })
  }

  /**
   * 分配下一个节点 id。
   *
   * **不能只信索引**：审计复现过"索引损坏 → 计数器归零 → 新节点又拿到 p1"，
   * 重复 id 会让边指向错误的人。所以这里取"索引计数器"和"实际节点里最大编号"的较大值 + 1。
   * 万一算出已存在的 id，直接抛错（fail closed），绝不写重复 id。
   */
  private next_id(): string {
    const index = this.load_index()
    const from_nodes = this.max_seq_in_nodes()
    const next = Math.max(index.last_person_seq ?? 0, from_nodes) + 1
    if (this.nodes().some(node => node.id === `p${next}`)) {
      throw new Error(`知识图谱 id 冲突：p${next} 已存在。拒绝写入以免边指向错误的人。`)
    }
    this.save_index({ ...index, last_person_seq: next })
    return `p${next}`
  }

  /** 扫节点文件取最大编号（`p12` → 12）；这是 id 分配的**权威兜底**。 */
  private max_seq_in_nodes(): number {
    let max = 0
    for (const node of this.nodes()) {
      const match = /^p(\d+)$/.exec(node.id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    return max
  }

  private load_index(): { last_person_seq?: number, last_update_ms?: number, last_update_ids?: string[] } {
    const path = this.index_path()
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        last_person_seq?: number, last_update_ms?: number, last_update_ids?: string[]
      }
      return parsed
    } catch {
      // 索引损坏：不要静默归零（那会重置 id 分配）。从节点文件恢复计数器。
      const recovered = this.max_seq_in_nodes()
      probe('graph', 'index.corrupt_recovered', { recovered_seq: recovered })
      return { last_person_seq: recovered }
    }
  }

  private save_index(index: {
    last_person_seq?: number, last_update_ms?: number, last_update_ids?: string[]
  }): void {
    this.write_atomic(this.index_path(), `${JSON.stringify({ ...index, updated_at: Date.now() }, null, 2)}\n`)
  }

  private write_nodes(nodes: readonly PersonNode[]): void {
    this.write_atomic(this.nodes_path(), `${nodes.map(node => JSON.stringify(strip_undefined(node))).join('\n')}\n`)
    this.regenerate_view()
  }

  private write_edges(edges: readonly RelationEdge[]): void {
    this.write_atomic(this.edges_path(), `${edges.map(edge => JSON.stringify(strip_undefined(edge))).join('\n')}\n`)
    this.regenerate_view()
  }

  /** 原子写：临时文件（带进程内序号防撞名）+ rename（带重试，Windows 偶发 EPERM）。 */
  private write_atomic(path: string, content: string): void {
    // 目录被外部删掉时自愈（"清空图谱"会删内容；这里兜住"连目录一起没"的情况）
    mkdirSync(this.dir, { recursive: true })
    this.tmp_seq += 1
    const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`
    writeFileSync(tmp, content, 'utf8')
    rename_with_retry(tmp, path)
  }
}

/** 读 jsonl；坏行跳过（不让一行损坏毁掉整张图）。 */
function read_jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      probe('graph', 'jsonl.bad_line', { path })
    }
  }
  return out
}

/** 今天的日期（`YYYY-MM-DD`，本地时区），用作"中心节点"这类自生成证据的日期。 */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 姓名比较用的归一化。 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

/** 由生日推算年龄；只有拿到完整年份时才算。 */
function age_from_birthday(birthday: string | undefined): number | undefined {
  if (birthday === undefined) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday.trim())
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const now = new Date()
  let age = now.getFullYear() - year
  const before_birthday = now.getMonth() + 1 < month
    || (now.getMonth() + 1 === month && now.getDate() < day)
  if (before_birthday) age -= 1
  return age >= 0 && age < 150 ? age : undefined
}

/** 合并列表并去重（保持已有顺序在前）。 */
function merge_list(existing: readonly string[] | undefined, added: readonly string[] | undefined): string[] | undefined {
  const out: string[] = []
  for (const item of [...existing ?? [], ...added ?? []]) {
    const value = item.trim()
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  return out.length === 0 ? undefined : out
}

/** 合并重要日期（按 label 去重，新值覆盖旧值）。 */
function merge_dates(
  existing: readonly { label: string; date: string }[] | undefined,
  added: readonly { label: string; date: string }[] | undefined,
): { label: string; date: string }[] | undefined {
  const map = new Map<string, string>()
  for (const item of existing ?? []) map.set(item.label, item.date)
  for (const item of added ?? []) map.set(item.label, item.date)
  return map.size === 0 ? undefined : [...map].map(([label, date]) => ({ label, date }))
}

/** 追加证据并去重（同一天同一条只留一份）。 */
function merge_evidence(
  existing: readonly GraphEvidence[] | undefined,
  added: GraphEvidence | undefined,
): GraphEvidence[] | undefined {
  if (added === undefined) return existing === undefined ? undefined : [...existing]
  const out = [...existing ?? []]
  if (!out.some(item => item.date === added.date && item.note === added.note)) out.push(added)
  return out.slice(-12)
}

/** 由跳链构造可读路径。 */
function build_path(hops: readonly RelationEdge[], nodes: Map<string, PersonNode>): GraphPath {
  const name = (id: string): string => nodes.get(id)?.name ?? id
  const node_ids = [hops[0]!.from, ...hops.map(edge => edge.to)]
  const readable = hops
    .map(edge => `${name(edge.from)}的${edge.label}是${name(edge.to)}`)
    .join('，')
  return {
    node_ids,
    names: node_ids.map(name),
    hops: hops.map(edge => ({ from: name(edge.from), to: name(edge.to), label: edge.label })),
    readable,
  }
}

/** 去掉 undefined 字段，兼容 exactOptionalPropertyTypes。 */
function strip_undefined<T>(value: object): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as unknown as T
}

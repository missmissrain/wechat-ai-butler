/**
 * 时间线存储（长期记忆）：一天一个 node，node 内 = 摘要 + 切实聊天记录。
 *
 * 目录结构：
 * ```
 * <dir>/
 *   index.json                 # 日期索引：node 元数据，供快速查询/统计
 *   days/
 *     2026-09-20.jsonl         # 权威记录（append-only，每行一条 TimelineEntry）
 *     2026-09-20.summary.md    # 权威摘要（可人工编辑）
 *     2026-09-20.md            # 人类可读视图（由上面两者生成，勿手改）
 * ```
 *
 * 为什么把 jsonl 和 md 分开：
 * - `jsonl` 是**权威**记录，解析稳定、追加安全，适合程序读写；
 * - `md` 是给人（也给人格化 agent）读的视图，可随时从权威数据重建；
 * - 摘要单独放 `summary.md`，这样"重新生成视图"不会覆盖人工编辑过的摘要。
 *
 * 所有写操作都走"临时文件 + rename"的原子替换，避免断电/杀进程留下半个文件。
 *
 * @module dsh-webhook-weixin/timeline-store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import { rename_with_retry, with_file_lock } from './fileLock.ts'
import type {
  TimelineAttachment,
  TimelineDay,
  TimelineDayMeta,
  TimelineEntry,
  TimelineIndex,
  TimelineReadFilter,
  TimelineSearchHit,
  TimelineStoreOptions,
  TimelineSummarizer,
} from './timelineTypes.ts'

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const INDEX_VERSION = 1

/** 时间线存储：读取与更新长期记忆。 */
export class TimelineStore {
  private readonly dir: string
  private readonly days_dir: string
  private readonly timezone: string
  private readonly persist_reasoning: boolean
  private readonly idle_ms: number
  /**
   * 已写入记录 id 的内存缓存（按天）。
   *
   * 用途：append 的幂等校验本来要读整天文件（O(n)），1000 条时是 O(n²)。
   * 用 `文件大小:mtime` 当缓存键——文件没变就直接复用，append 变成 O(1)。
   * 别的进程改了文件，键会变，缓存自动失效（配合 file lock 保证一致）。
   */
  private readonly id_cache = new Map<string, { key: string, ids: Set<string> }>()
  /** 视图（.md）待重建的日期；惰性重建，避免每次 append 都重写 Markdown。 */
  private readonly dirty_views = new Set<string>()
  /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
  private tmp_seq = 0
  /** 正在重建索引：防止 load_index ↔ rebuild_index 互相递归。 */
  private rebuilding_index = false
  /** 每日元数据的内存缓存（追加时增量更新，避免每次重算整天）。 */
  private readonly meta_cache = new Map<string, TimelineDayMeta>()

  constructor(options: TimelineStoreOptions) {
    this.dir = options.dir
    this.days_dir = join(this.dir, 'days')
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE
    // 推理落盘开关：默认关；用 DSH_TIMELINE_PERSIST_REASONING=1 全局打开。
    this.persist_reasoning = options.persist_reasoning
      ?? process.env.DSH_TIMELINE_PERSIST_REASONING === '1'
    this.idle_ms = options.idle_ms
      ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000
    this.ensure_dirs()
  }

  // ── 更新 ────────────────────────────────────────────────────────────────

  /**
   * 追加一条记录（幂等：同一 id 重复追加会被忽略）。
   *
   * @returns `true` 表示真的写入；`false` 表示这条 id 已存在。
   */
  /** 存储目录（清空记忆时需要，避免调用方另算一遍路径）。 */
  dir_path(): string {
    return this.dir
  }

  /**
   * 确保存储目录存在（含 `days/` 子目录）。
   *
   * **清空记忆之后必须调用**：清空会连 `days/` 一起删掉，而 store 实例是长驻的，
   * 不会自己重建——下一次 append 就会 ENOENT（实测 2026-09-21 23:46 那轮就撞上了）。
   * 构造函数与 append 也会调用它，所以外部删目录同样能自愈。
   */
  ensure_dirs(): void {
    mkdirSync(this.days_dir, { recursive: true })
  }

  /**
   * 丢掉全部内存缓存。
   *
   * **外部清空目录之后必须调用**：`meta_cache` 是按天缓存的，文件被删掉了它却还在，
   * 于是 `list_days()` 会继续列出早已不存在的天。id 缓存虽按 `size:mtime` 校验，
   * 但也一并清掉更省心。
   */
  forget_caches(): void {
    this.id_cache.clear()
    this.meta_cache.clear()
    probe('timeline', 'caches.forgotten', {})
  }

  append(entry: TimelineEntry): boolean {
    // 目录被外部删掉（例如"清空记忆"）时自愈：否则这里会直接 ENOENT，整条记忆悄悄丢掉。
    this.ensure_dirs()
    const date = this.day_key(entry.ts)
    const path = this.entries_path(date)
    const record: TimelineEntry = this.persist_reasoning
      ? entry
      : { ...entry, reasoning: undefined } as unknown as TimelineEntry
    const line = JSON.stringify(strip_undefined(record))

    // 整个"查重 + 追加 + 更新索引"必须在锁里完成，否则并发写会互相覆盖。
    const written = with_file_lock(path, () => {
      const ids = this.known_ids(date)
      if (ids.has(entry.id)) {
        probe('timeline', 'append.duplicate', { date, id: entry.id })
        return false
      }
      // 关键：基数必须在**追加之前**取。
      // 否则一旦索引缺失触发了"从磁盘重建"，重建结果里已经包含了这条新记录，
      // 再 +1 就会把条数算重（实测过：第一次 append 后 entries 直接变成 2）。
      const base = this.base_meta(date)
      // 追加快路径：只在文件尾追加一行，不再"读全文→重写全文"。
      appendFileSync(path, `${line}\n`, 'utf8')
      ids.add(entry.id)
      this.set_meta(date, increment_meta(base, entry))
      this.dirty_views.add(date)
      return true
    })

    if (written) {
      // 视图惰性重建：写入路径不做重活，避免阻塞微信主链路。
      this.regenerate_view_if_due(date)
      probe('timeline', 'append.ok', { date, role: entry.role, id: entry.id, chars: entry.text.length })
    }
    return written
  }

  /**
   * 该日期已知的记录 id 集合（带 mtime 缓存）。
   *
   * 文件被别的进程改过（大小/mtime 变化）时会重新读，保证跨进程也准确。
   */
  private known_ids(date: string): Set<string> {
    const path = this.entries_path(date)
    const stat = existsSync(path) ? statSync(path) : undefined
    const key = stat === undefined ? 'missing' : `${stat.size}:${stat.mtimeMs}`
    const cached = this.id_cache.get(date)
    if (cached !== undefined && cached.key === key) return cached.ids
    const ids = new Set(this.read_entries(date).map(item => item.id))
    this.id_cache.set(date, { key, ids })
    return ids
  }

  /**
   * 取某日"当前基数"（追加前）。
   *
   * 优先用内存缓存（热路径 O(1)）；缓存冷时**从记录文件算**，而不是信索引——
   * 索引只是缓存，记录文件才是权威。
   */
  private base_meta(date: string): TimelineDayMeta {
    const cached = this.meta_cache.get(date)
    if (cached !== undefined) return cached
    const entries = this.read_entries(date)
    const meta = this.meta_from_entries(date, entries)
    this.meta_cache.set(date, meta)
    return meta
  }

  /** 写入某日的元数据（覆盖，不累加）。 */
  private set_meta(date: string, meta: TimelineDayMeta): void {
    this.meta_cache.set(date, meta)
    const index = this.load_index()
    this.save_index({ ...index, days: { ...index.days, [date]: meta } })
  }

  /** 由记录列表直接算元数据（不读索引，避免递归/双重计数）。 */
  private meta_from_entries(date: string, entries: readonly TimelineEntry[]): TimelineDayMeta {
    const ts = entries.map(item => item.ts)
    return strip_undefined<TimelineDayMeta>({
      date,
      timezone: this.timezone,
      entries: entries.length,
      user_entries: entries.filter(item => item.role === 'user').length,
      assistant_entries: entries.filter(item => item.role === 'assistant').length,
      first_ts: ts.length === 0 ? undefined : Math.min(...ts),
      last_ts: ts.length === 0 ? undefined : Math.max(...ts),
      updated_at: Date.now(),
    })
  }

  /** 视图惰性重建：同一日期最多每 5 秒重建一次，且文件缺失时必建。 */
  private regenerate_view_if_due(date: string): void {
    if (!this.dirty_views.has(date)) return
    const path = this.view_path(date)
    const stat = existsSync(path) ? statSync(path) : undefined
    if (stat !== undefined && Date.now() - stat.mtimeMs < 5_000) return
    this.regenerate_view(date)
    this.dirty_views.delete(date)
  }

  /** 强制把所有待重建的视图刷出来（调度器空闲时调用）。 */
  flush_views(): void {
    for (const date of [...this.dirty_views]) {
      this.regenerate_view(date)
      this.dirty_views.delete(date)
    }
  }

  /**
   * 批量追加；返回真正写入的条数。用于恢复/回填历史。
   */
  append_many(entries: readonly TimelineEntry[]): number {
    let written = 0
    for (const entry of entries) {
      if (this.append(entry)) written += 1
    }
    return written
  }

  /**
   * 给某条记录补写媒体引用/描述（记录本身是 append-only，这里做定点改写）。
   *
   * 为什么需要它：消息先落盘（拿到事实），媒体要等下载完才拿得到引用、
   * 描述更要等视觉模型跑完；这两件事都比"记下这句话"晚，所以必须能后补。
   * 改写是**整天重写 + 原子替换**（一天记录量很小），失败也不会留下半截文件。
   *
   * @returns 是否命中并改写。
   */
  update_entry(date: string, entry_id: string, patch: {
    attachments?: readonly TimelineAttachment[]
    text?: string
  }): boolean {
    assert_day_key(date)
    const path = this.entries_path(date)
    // 定点改写要"读全文→写全文"，必须持锁，否则会覆盖并发 append 的合法记录。
    return with_file_lock(path, () => {
      const entries = this.read_entries(date)
      const index = entries.findIndex(item => item.id === entry_id)
      if (index < 0) {
        probe('timeline', 'entry.update_miss', { date, id: entry_id })
        return false
      }
      const current = entries[index] as TimelineEntry
      const next: TimelineEntry = strip_undefined({
        ...current,
        ...patch.text === undefined ? {} : { text: patch.text },
        ...patch.attachments === undefined ? {} : { attachments: patch.attachments },
      })
      entries[index] = next
      this.write_atomic(path, `${entries.map(item => JSON.stringify(strip_undefined(item))).join('\n')}\n`)
      this.refresh_meta(date)
      this.regenerate_view(date)
      this.dirty_views.delete(date)
      probe('timeline', 'entry.updated', {
        date, id: entry_id, attachments: patch.attachments?.length,
      })
      return true
    })
  }

  /**
   * 给某条记录里的某个附件补上描述（视觉模型跑完后回填）。
   *
   * @returns 是否命中并写入。
   */
  update_attachment_description(date: string, entry_id: string, attachment_id: string, description: string): boolean {
    const entry = this.read_entries(date).find(item => item.id === entry_id)
    if (entry?.attachments === undefined) return false
    const next = entry.attachments.map(item => item.id === attachment_id
      ? strip_undefined<TimelineAttachment>({ ...item, description })
      : item)
    if (!next.some((item, i) => item.description !== entry.attachments?.[i]?.description)) return false
    return this.update_entry(date, entry_id, { attachments: next })
  }

  /**
   * 更新某一日的摘要（权威来源是 `days/<date>.summary.md`，可人工编辑）。
   *
   * @param date - `YYYY-MM-DD`。
   * @param summary - 摘要正文；空字符串表示清空。
   * @param meta - 可选的生成信息（例如模型名），会写进索引。
   */
  update_summary(date: string, summary: string, meta?: { model?: string }): void {
    assert_day_key(date)
    this.write_atomic(this.summary_path(date), summary.trim() === '' ? '' : `${summary.trim()}\n`)
    const index = this.load_index()
    const current = index.days[date] ?? this.empty_meta(date)
    const next = strip_undefined<TimelineDayMeta>({
      ...current,
      summary_updated_at: Date.now(),
      summary_model: meta?.model ?? current.summary_model,
      updated_at: Date.now(),
    })
    this.save_index({ ...index, days: { ...index.days, [date]: next } })
    this.regenerate_view(date)
    this.dirty_views.delete(date)
    probe('timeline', 'summary.updated', { date, chars: summary.length, model: meta?.model })
  }

  /** 从权威记录重新生成人类可读视图（`<date>.md`）；人工改过视图时用它复原。 */
  regenerate_view(date: string): void {
    assert_day_key(date)
    const entries = this.read_entries(date)
    const meta = this.meta_for(date, entries)
    const summary = this.read_summary(date)
    this.write_atomic(this.view_path(date), render_view(meta, summary, entries))
  }

  /**
   * 重建索引：**直接扫 `days/*.jsonl`**（权威数据），不信任 index.json。
   *
   * 这是索引损坏时的自愈路径——审计复现过"损坏索引后旧日期彻底不可发现"，
   * 而记录文件其实还在。所以读取路径发现索引缺失/损坏时必须自动走这里。
   */
  rebuild_index(): number {
    const dates = existsSync(this.days_dir)
      ? readdirSync(this.days_dir).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -'.jsonl'.length)).sort()
      : []
    const days: Record<string, TimelineDayMeta> = {}
    for (const date of dates) days[date] = this.meta_for(date, this.read_entries(date))
    this.save_index({ version: INDEX_VERSION, timezone: this.timezone, updated_at: Date.now(), days })
    // 重建后内存缓存也一并刷新，避免和磁盘不一致
    this.id_cache.clear()
    this.meta_cache.clear()
    for (const [date, meta] of Object.entries(days)) this.meta_cache.set(date, meta)
    probe('timeline', 'index.rebuilt', { days: dates.length })
    return dates.length
  }

  // ── 摘要触发（按"空闲"而不是按整点）────────────────────────────────────

  /**
   * 找出"该更新摘要"的日期。
   *
   * 判定两条同时成立：
   * 1. **已经空闲**：距该日最后一条记录 ≥ `idle_ms`（默认 3 小时）——
   *    说明这段对话讲完了，现在总结不会再反复重写；
   * 2. **有待总结的内容**：还没有摘要，或上次摘要之后又新增了记录。
   *
   * @param now - 当前时间（便于测试注入）。
   */
  days_needing_summary(now = Date.now()): string[] {
    const index = this.load_index()
    const out: string[] = []
    for (const meta of Object.values(index.days)) {
      if (meta.entries === 0 || meta.last_ts === undefined) continue
      if (now - meta.last_ts < this.idle_ms) continue
      const summarized_at = meta.summary_updated_at ?? 0
      if (summarized_at >= meta.last_ts) continue
      out.push(meta.date)
    }
    return out.sort()
  }

  /**
   * 用注入的摘要器更新指定日期的摘要。
   *
   * @param date - `YYYY-MM-DD`。
   * @param summarize - 摘要实现（本地 Gemma / 云端模型都行）。
   * @returns 摘要文本；该日没有记录时返回 undefined（不写空摘要）。
   */
  async summarize_day(date: string, summarize: TimelineSummarizer): Promise<string | undefined> {
    assert_day_key(date)
    const entries = this.read_entries(date)
    if (entries.length === 0) return undefined
    const previous = this.read_summary(date)
    const result = await summarize({
      date,
      timezone: this.timezone,
      entries,
      ...previous === undefined ? {} : { previous_summary: previous },
    })
    const text = result.text.trim()
    if (text === '') return undefined
    this.update_summary(date, text, {
      ...result.model === undefined ? {} : { model: result.model },
    })
    return text
  }

  /** 扫描并按需更新所有到期摘要；返回更新过的日期。 */
  async summarize_due(summarize: TimelineSummarizer, now = Date.now()): Promise<string[]> {
    const done: string[] = []
    for (const date of this.days_needing_summary(now)) {
      try {
        const text = await this.summarize_day(date, summarize)
        if (text !== undefined) done.push(date)
      } catch (error) {
        // 一天失败不能影响其它天；留痕后继续。
        probe('timeline', 'summary.failed', { date, error: String(error) })
      }
    }
    return done
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  /** 读一天的 node（摘要 + 记录 + 元数据）；可用 filter 按人/会话过滤。 */
  read_day(date: string, filter?: TimelineReadFilter): TimelineDay {
    assert_day_key(date)
    const all = this.read_entries(date)
    const entries = filter === undefined ? all : all.filter(item => match_filter(item, filter))
    const summary = this.read_summary(date)
    return {
      // 元数据按**过滤后**的口径给，避免调用方拿到和 entries 不一致的计数。
      meta: this.meta_for(date, entries),
      ...summary === undefined ? {} : { summary },
      entries,
    }
  }

  /**
   * 读一段日期区间（含两端）。
   *
   * @param from - 起始 `YYYY-MM-DD`。
   * @param to - 结束 `YYYY-MM-DD`；缺省等于 `from`。
   */
  read_range(from: string, to?: string): TimelineDay[] {
    const end = to ?? from
    assert_day_key(from)
    assert_day_key(end)
    return this.list_days()
      .map(meta => meta.date)
      .filter(date => date >= from && date <= end)
      .map(date => this.read_day(date))
  }

  /** 列出所有 node 的元数据（按日期升序）。 */
  list_days(): TimelineDayMeta[] {
    const index = this.load_index()
    return Object.values(index.days).sort((a, b) => a.date.localeCompare(b.date))
  }

  /** 读原始摘要文本；没有则 undefined。 */
  read_summary(date: string): string | undefined {
    const path = this.summary_path(date)
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? undefined : text
  }

  /**
   * 跨天全文搜索（大小写不敏感的朴素子串匹配）。
   *
   * 长期记忆规模有限（一天一个文件），朴素扫描足够；命中按时间倒序返回。
   */
  search(keyword: string, options?: {
    limit?: number
    from?: string
    to?: string
    user_id?: string
    session_id?: string
  }): TimelineSearchHit[] {
    const needle = keyword.trim().toLowerCase()
    if (needle === '') return []
    const limit = options?.limit ?? 50
    const filter: TimelineReadFilter = {
      ...options?.user_id === undefined ? {} : { user_id: options.user_id },
      ...options?.session_id === undefined ? {} : { session_id: options.session_id },
    }
    const hits: TimelineSearchHit[] = []
    const dates = this.list_days().map(meta => meta.date).reverse()
    for (const date of dates) {
      if (options?.from !== undefined && date < options.from) continue
      if (options?.to !== undefined && date > options.to) continue
      for (const entry of this.read_entries(date)) {
        if (!match_filter(entry, filter)) continue
        if (entry.text.toLowerCase().includes(needle)) hits.push({ date, entry })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }

  /** 全局统计。 */
  stats(): TimelineStats {
    const days = this.list_days()
    return strip_undefined<TimelineStats>({
      days: days.length,
      entries: days.reduce((sum, meta) => sum + meta.entries, 0),
      first_date: days[0]?.date,
      last_date: days[days.length - 1]?.date,
    })
  }

  // ── 内部：路径与日期 ────────────────────────────────────────────────────

  /** 时间戳 → 时区内的日期键。 */
  day_key(ts: number): string {
    // en-CA 的日期格式恰好是 YYYY-MM-DD。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts))
  }

  private entries_path(date: string): string { return join(this.days_dir, `${date}.jsonl`) }
  private summary_path(date: string): string { return join(this.days_dir, `${date}.summary.md`) }
  private view_path(date: string): string { return join(this.days_dir, `${date}.md`) }
  private index_path(): string { return join(this.dir, 'index.json') }

  // ── 内部：读写 ──────────────────────────────────────────────────────────

  private read_entries(date: string): TimelineEntry[] {
    const path = this.entries_path(date)
    if (!existsSync(path)) return []
    const out: TimelineEntry[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        out.push(JSON.parse(trimmed) as TimelineEntry)
      } catch {
        // 单行损坏不应让整天不可读：跳过并留痕。
        probe('timeline', 'entries.bad_line', { date })
      }
    }
    return out
  }

  private meta_for(date: string, entries: readonly TimelineEntry[]): TimelineDayMeta {
    const index = this.load_index()
    const stored = index.days[date]
    const ts = entries.map(entry => entry.ts)
    return strip_undefined<TimelineDayMeta>({
      date,
      timezone: this.timezone,
      entries: entries.length,
      user_entries: entries.filter(entry => entry.role === 'user').length,
      assistant_entries: entries.filter(entry => entry.role === 'assistant').length,
      first_ts: ts.length === 0 ? undefined : Math.min(...ts),
      last_ts: ts.length === 0 ? undefined : Math.max(...ts),
      updated_at: stored?.updated_at ?? Date.now(),
      summary_updated_at: stored?.summary_updated_at,
      summary_model: stored?.summary_model,
    })
  }

  private empty_meta(date: string): TimelineDayMeta {
    return {
      date, timezone: this.timezone, entries: 0, user_entries: 0, assistant_entries: 0,
      updated_at: Date.now(),
    }
  }

  private refresh_meta(date: string): void {
    const index = this.load_index()
    const entries = this.read_entries(date)
    // 从文件重算（这条路径用于定点改写，本来就要读全文），同时刷新内存缓存
    const next = strip_undefined<TimelineDayMeta>({
      ...this.meta_from_entries(date, entries),
      summary_updated_at: index.days[date]?.summary_updated_at,
      summary_model: index.days[date]?.summary_model,
    })
    this.meta_cache.set(date, next)
    this.save_index({ ...index, days: { ...index.days, [date]: next } })
  }

  /**
   * 读索引；**缺失或损坏时自动从权威 JSONL 重建**。
   *
   * 审计复现过：索引坏掉后旧日期"数据还在但彻底不可发现"（list_days/search/摘要调度都看不到）。
   * 所以这里不能返回空索引了事——记录文件才是权威，索引只是缓存，坏了就重建。
   */
  private load_index(): TimelineIndex {
    const path = this.index_path()
    if (!existsSync(path)) return this.rebuild_from_disk()
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as TimelineIndex
      if (parsed.version !== INDEX_VERSION || typeof parsed.days !== 'object' || parsed.days === null) {
        probe('timeline', 'index.invalid_shape', { path })
        return this.rebuild_from_disk()
      }
      return parsed
    } catch {
      probe('timeline', 'index.corrupt', { path })
      return this.rebuild_from_disk()
    }
  }

  /** 从磁盘重建索引（带递归保护：重建期间再问索引就返回空表）。 */
  private rebuild_from_disk(): TimelineIndex {
    const empty: TimelineIndex = { version: INDEX_VERSION, timezone: this.timezone, updated_at: Date.now(), days: {} }
    if (this.rebuilding_index) return empty
    this.rebuilding_index = true
    try {
      this.rebuild_index()
    } catch (error) {
      probe('timeline', 'index.rebuild_failed', { error: String(error) })
      return empty
    } finally {
      this.rebuilding_index = false
    }
    try {
      return JSON.parse(readFileSync(this.index_path(), 'utf8')) as TimelineIndex
    } catch {
      return empty
    }
  }

  private save_index(index: TimelineIndex): void {
    this.write_atomic(this.index_path(), `${JSON.stringify({ ...index, updated_at: Date.now() }, null, 2)}\n`)
  }

  /**
   * 原子写：临时文件 + rename。
   *
   * 临时名带**进程内递增序号**：同一进程同一毫秒的两次写不会撞名
   * （只带 pid 会撞，因为 pid 相同）；rename 带重试，Windows 并发时偶发 EPERM。
   */
  private write_atomic(path: string, content: string): void {
    this.tmp_seq += 1
    const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`
    writeFileSync(tmp, content, 'utf8')
    rename_with_retry(tmp, path)
  }
}

/** 在元数据上累加一条记录（追加时的增量更新）。 */
function increment_meta(base: TimelineDayMeta, entry: TimelineEntry): TimelineDayMeta {
  return strip_undefined<TimelineDayMeta>({
    ...base,
    entries: base.entries + 1,
    user_entries: base.user_entries + (entry.role === 'user' ? 1 : 0),
    assistant_entries: base.assistant_entries + (entry.role === 'assistant' ? 1 : 0),
    first_ts: base.first_ts === undefined ? entry.ts : Math.min(base.first_ts, entry.ts),
    last_ts: base.last_ts === undefined ? entry.ts : Math.max(base.last_ts, entry.ts),
    updated_at: Date.now(),
  })
}

/** 记录是否满足过滤条件；未指定的维度不参与过滤。 */
function match_filter(entry: TimelineEntry, filter: TimelineReadFilter): boolean {
  if (filter.user_id !== undefined && entry.user_id !== filter.user_id) return false
  if (filter.session_id !== undefined && entry.session_id !== filter.session_id) return false
  return true
}

/** 校验日期键格式，避免拼出奇怪的路径。 */
function assert_day_key(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法的日期键：${date}（应为 YYYY-MM-DD）`)
}

/** 全局统计结果。 */
export interface TimelineStats {
  readonly days: number
  readonly entries: number
  readonly first_date?: string
  readonly last_date?: string
}

/** 去掉值为 undefined 的键，兼容 exactOptionalPropertyTypes。 */
function strip_undefined<T>(value: object): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as unknown as T
}

/** 渲染人类可读的一天视图。 */
function render_view(meta: TimelineDayMeta, summary: string | undefined, entries: readonly TimelineEntry[]): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`date: ${meta.date}`)
  lines.push(`timezone: ${meta.timezone}`)
  lines.push(`entries: ${meta.entries}`)
  lines.push(`user_entries: ${meta.user_entries}`)
  lines.push(`assistant_entries: ${meta.assistant_entries}`)
  if (meta.first_ts !== undefined) lines.push(`first_at: ${iso(meta.first_ts, meta.timezone)}`)
  if (meta.last_ts !== undefined) lines.push(`last_at: ${iso(meta.last_ts, meta.timezone)}`)
  lines.push(`updated_at: ${iso(meta.updated_at, meta.timezone)}`)
  if (meta.summary_updated_at !== undefined) lines.push(`summary_updated_at: ${iso(meta.summary_updated_at, meta.timezone)}`)
  if (meta.summary_model !== undefined) lines.push(`summary_model: ${meta.summary_model}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${meta.date}`)
  lines.push('')
  lines.push('## 摘要')
  lines.push('')
  lines.push('<!-- 权威来源：同目录 <date>.summary.md；本文件是生成视图，勿手改。 -->')
  lines.push('')
  lines.push(summary ?? '（尚未生成）')
  lines.push('')
  lines.push('## 记录')
  lines.push('')
  lines.push('<!-- 权威来源：同目录 <date>.jsonl；本文件是生成视图，勿手改。 -->')
  lines.push('')
  for (const entry of entries) {
    lines.push(`### ${clock(entry.ts, meta.timezone)} · ${entry.role === 'user' ? '用户' : '欣爱'}`)
    lines.push('')
    if (entry.text.trim() !== '') lines.push(entry.text.trim())
    for (const item of entry.attachments ?? []) {
      const size = item.bytes === undefined ? '' : `（${Math.round(item.bytes / 1024)}KB）`
      const dims = item.width !== undefined && item.height !== undefined ? ` ${item.width}×${item.height}` : ''
      lines.push(`- [${item.media_type}]${dims}${size} 附件 ${item.id}${item.name === undefined ? '' : ` · ${item.name}`}`)
      if (item.description !== undefined) lines.push(`  - 内容：${item.description}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 时区内 HH:mm:ss。 */
function clock(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts))
}

/** 时区内 ISO8601（含偏移）。 */
function iso(ts: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts))
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ts)).find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
  const zone = offset === 'GMT' ? '+00:00' : offset.replace('GMT', '')
  return `${parts.replace(', ', 'T').replace(/\//g, '-')}${zone}`
}

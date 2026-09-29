/**
 * 时间线（长期记忆）的类型定义。
 *
 * 结构约定（用户口径）：**以日期为索引，24 小时为一个 node**。每个 node 里有两部分：
 * 1. 该 24 小时内"用户与系统对话的摘要"（`summary`，可人工编辑）；
 * 2. 该 24 小时内"切实的聊天记录"（`entries`：用户上行 + 系统最终回复；
 *    模型推理是否落盘由 `persist_reasoning` 决定，暂定不存）。
 *
 * 这里的类型只描述**数据结构**，不绑定存储实现：当前是文件后端
 * （`days/<date>.jsonl` + `<date>.summary.md` + 生成的 `<date>.md`），
 * 之后要换 MySQL 只需换掉 TimelineStore 的实现，类型与调用方不变。
 *
 * @module dsh-webhook-weixin/timeline-types
 */

/** 记录角色：只保留"用户上行"和"系统最终回复"两种。 */
export type TimelineRole = 'user' | 'assistant'

/**
 * 时间线里的媒体引用（**只存引用，不复制文件**）。
 *
 * 原图由 harness 的附件服务按内容寻址持久化（`~/.dsh/attachments/<id>`），天然去重；
 * 时间线只记 `id` 等元数据，所以"存原图"是零额外磁盘成本的。
 * `description` 是可检索的派生物（由视觉模型生成）——原图永远是权威，描述错了还能回看原图。
 */
export interface TimelineAttachment {
  /** 附件 id（内容寻址；指向 harness 附件库里的原图）。 */
  readonly id: string
  readonly media_type: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly name?: string
  /** 视觉模型对这个媒体的一句话描述（可后补写入）。 */
  readonly description?: string
}

/** 一条时间线记录。 */
export interface TimelineEntry {
  /**
   * 稳定 id，用于幂等追加。
   *
   * 必须稳定：崩溃恢复/重放时同一条消息可能被再投递一次，靠它去重，
   * 否则长期记忆里会出现重复对话。
   */
  readonly id: string
  /** 事件时间（epoch 毫秒）。它决定这条记录落在哪一天。 */
  readonly ts: number
  readonly role: TimelineRole
  /** 正文：用户原话，或系统的最终回复（不含工具调用等中间产物）。 */
  readonly text: string
  /** 说话的人（多用户场景的维度；也用于按人过滤/分区）。 */
  readonly user_id?: string
  readonly session_id?: string
  /** 所属 turn（可选，便于和 outbox/turn_context 对齐）。 */
  readonly turn?: number
  /** 入站消息 id（用户侧）或 outbound id（系统侧），便于溯源。 */
  readonly delivery_id?: string
  /** 模型的推理文本；默认不落盘（见 TimelineStoreOptions.persist_reasoning）。 */
  readonly reasoning?: string
  /** 这条消息携带的媒体（图片/文件）引用；原图在附件库里，这里只存引用与描述。 */
  readonly attachments?: readonly TimelineAttachment[]
  /** 其它可检索的标量元数据（模型名、渠道等）。 */
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

/** 一天 node 的元数据（索引里存的就是它）。 */
export interface TimelineDayMeta {
  /** 时区内的本地日期 `YYYY-MM-DD`，即 node 的索引键。 */
  readonly date: string
  /** 计算"一天"边界用的 IANA 时区。 */
  readonly timezone: string
  readonly entries: number
  readonly user_entries: number
  readonly assistant_entries: number
  /** 当天第一条/最后一条记录的时间。 */
  readonly first_ts?: number
  readonly last_ts?: number
  /** 记录最后更新时间。 */
  readonly updated_at: number
  /** 摘要最后更新时间；没有摘要时缺省。 */
  readonly summary_updated_at?: number
  /** 生成摘要用的模型（人工编辑时可缺省）。 */
  readonly summary_model?: string
}

/** 读取一天的完整结果。 */
export interface TimelineDay {
  readonly meta: TimelineDayMeta
  readonly summary?: string
  readonly entries: readonly TimelineEntry[]
}

/** 索引文件结构。 */
export interface TimelineIndex {
  readonly version: 1
  readonly timezone: string
  readonly updated_at: number
  /** 日期 → 元数据。 */
  readonly days: Readonly<Record<string, TimelineDayMeta>>
}

/** 构造参数。 */
export interface TimelineStoreOptions {
  /** 时间线根目录。 */
  readonly dir: string
  /** 决定"一天"边界的 IANA 时区，默认 `Asia/Shanghai`。 */
  readonly timezone?: string
  /**
   * 是否把模型推理也写进记录。
   *
   * 默认 false（用户口径"推理是否保存暂定"）；可用环境变量
   * `DSH_TIMELINE_PERSIST_REASONING=1` 全局打开，留个开关以后想存很方便。
   */
  readonly persist_reasoning?: boolean
  /**
   * 摘要触发阈值：**这么久没有新对话**就认为"这一天讲完了"，可以生成/更新摘要。
   *
   * 默认 3 小时（`DSH_TIMELINE_IDLE_HOURS`）。之所以按"空闲"而不是按"整点"，
   * 是因为对话可能跨过午夜，等它真正停下来再总结才不会反复重写。
   */
  readonly idle_ms?: number
}

/** 交给摘要器的一天素材。 */
export interface TimelineSummaryRequest {
  readonly date: string
  readonly timezone: string
  readonly entries: readonly TimelineEntry[]
  /** 上一版摘要（若有），供"增量更新"参考。 */
  readonly previous_summary?: string
}

/** 摘要器：由调用方注入（本地 Gemma 或云端模型）。 */
export type TimelineSummarizer = (request: TimelineSummaryRequest) => Promise<{
  text: string
  model?: string
}>

/** 读取时的过滤条件。 */
export interface TimelineReadFilter {
  /** 只取某个用户相关的记录。 */
  readonly user_id?: string
  readonly session_id?: string
}

/** 搜索命中。 */
export interface TimelineSearchHit {
  readonly date: string
  readonly entry: TimelineEntry
}

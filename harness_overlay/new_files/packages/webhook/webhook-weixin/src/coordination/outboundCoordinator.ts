/**
 * 出站协调器：微信链路唯一的发送队列。
 *
 * 重构设计文档 §7：所有对外消息（正式回复、控制回执、进度、心跳、错误）都进入同一条
 * durable outbox，按 `session_id + sequence` 有序发送；发送失败留下可见状态并可恢复。
 *
 * 心跳策略（按用户要求调整）：**思考摘要本身即心跳**。只有当"距上次输出思考摘要的时间"
 * 超过阈值时，才补发一条心跳；不再固定间隔刷屏。
 * @module dsh-webhook-weixin/outbound-coordinator
 */

import { probe, probe_timer } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'
import type { TurnContextStore } from '../state/turnContextStore.ts'
import type { OutboxRecord } from '../types/domain.ts'
import type { TimelineEntry } from '../memory/timelineTypes.ts'

/**
 * 单条消息的最大字符数；超过就拆成多条依次发。
 *
 * iLink 对超长文本会直接判 `prepare failed`（整条发不出去），
 * 之前链路里还额外做了 300/200 字的截断——用户看到的"截断"就是这个。
 * 现在改为**分段发送**：内容完整送达，且每段都不超限。
 */
const MAX_TEXT_CHARS = Number(process.env.DSH_WEIXIN_MAX_TEXT_CHARS ?? '1000')

/** 发送函数：由连接器注入（真实 iLink 或测试替身）。 */
export type OutboxSender = (input: {
  user_id: string
  text: string
  client_id: string
  context_token?: string
}) => Promise<void>

/** 发送失败是否可重试；由 iLink 错误分类决定。 */
export type RetryClassifier = (error: unknown) => boolean

/** 构造参数。 */
export interface OutboundCoordinatorOptions {
  readonly store: WeixinStateStore
  readonly turn_context: TurnContextStore
  readonly sender: OutboxSender
  readonly classify_retryable: RetryClassifier
  /** 把"最终回复"写进长期记忆（时间线）；不注入则完全不记录。 */
  readonly record_entry?: (entry: TimelineEntry) => void
  /** 无 context_token 的消息被拒后推迟多久再试（毫秒），默认 5 分钟。 */
  readonly no_token_defer_ms?: number
  /**
   * 通知类结果停放多久（毫秒），默认 6 小时。
   *
   * 窗口关闭时结果发不出去，但内容有用（"你让我做的事做完了"），所以停放一段时间
   * 等用户主动询问（由工具返回）；超过就丢，避免无限堆积。
   */
  readonly parked_retention_ms?: number

  /** 最大尝试次数，超过转 failed_terminal。 */
  readonly max_attempts?: number
  /** 重试退避基数（毫秒）。 */
  readonly retry_base_ms?: number
  /**
   * 相邻两次发送的最小间隔（毫秒，同一会话）。
   * iLink 对突发发送会限流（实测连续发第 4 条起全部 `prepare failed`），
   * 所以必须节流，不能把队列一次性泵出去。
   * 可用 DSH_WEIXIN_SEND_MIN_GAP_MS 调整。
   */
  readonly send_min_gap_ms?: number
  /** 每次泵出最多发送多少条（进一步压制突发）。 */
  readonly send_batch_limit?: number
  /** 思考摘要心跳阈值（毫秒）；距上次摘要超过此值才补发心跳。0 = 关闭。 */
  readonly heartbeat_idle_ms?: number
  /** 每个会话一轮内最多补发几条心跳，防止刷屏。 */
  readonly heartbeat_max_per_turn?: number
  /**
   * 触发限流（`ret=-2`）后的整链路冷却基数（毫秒），默认 30 秒，连续限流按 2 倍递增。
   *
   * 关键：限流是**全局**信号，必须整条链路一起退避。若只按"单条重试"处理，
   * 重试本身就会持续制造限流，队列永远排空不了——实测曾因此连续 11 小时发不出任何消息。
   * 可用 DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MS 调整。
   */
  readonly rate_limit_cooldown_ms?: number
  /**
   * 冷却上限（毫秒），默认 10 分钟。
   *
   * 实测证据：把重试间隔压到 ≤2 分钟持续试探时，平台会**连续 40+ 分钟全部拒绝**
   * （1453 拒 / 89 成）；而长时间安静之后再发往往能通过。所以持续试探不但没用，
   * 还很可能在不断"续期"这个限制——退避必须足够长，给对面真正的恢复空间。
   */
  readonly rate_limit_cooldown_max_ms?: number
}

/**
 * 把长文本按上限拆成多段；优先在换行处切，避免把一句话/一行命令拆断。
 * @param text - 原始文本。
 * @param limit - 每段最大字符数。
 */
function split_text(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf(' '))
    const at = cut > limit * 0.5 ? cut + 1 : limit
    parts.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/** 每个会话的运行时进度状态。 */
interface TurnProgress {
  turn: number
  /** 上次"有可见输出"（思考摘要或正文分段）的时间。 */
  last_visible_at: number
  /** 本轮已补发的心跳条数。 */
  heartbeats: number
  /** 本轮是否仍在进行。 */
  active: boolean
  timer?: ReturnType<typeof setInterval>
}

/** 微信出站协调器。 */
export class OutboundCoordinator {
  private readonly store: WeixinStateStore
  private readonly turn_context: TurnContextStore
  private readonly sender: OutboxSender
  private readonly classify_retryable: RetryClassifier
  /** 把"最终回复"记进长期记忆；由连接器注入，失败也不影响发送。 */
  private readonly record_entry: ((entry: TimelineEntry) => void) | undefined
  private readonly max_attempts: number
  private readonly retry_base_ms: number
  private readonly heartbeat_idle_ms: number
  private readonly heartbeat_max_per_turn: number
  private readonly send_min_gap_ms: number
  private readonly send_batch_limit: number
  /** 每个会话上次发送的时间，用于节流。 */
  private readonly last_send_at = new Map<string, number>()
  /** 全局上次发送时间：不同会话也压制一下总速率。 */
  private last_send_any_at = 0
  private readonly progress = new Map<string, TurnProgress>()
  private draining = false
  private stopped = false
  /** 限流熔断：在此时间戳之前整条链路暂停发送（见 options.rate_limit_cooldown_ms）。 */
  private paused_until = 0
  /** 熔断期间唯一的唤醒定时器；避免并发 drain 累积出定时器/日志风暴。 */
  private pause_timer: ReturnType<typeof setTimeout> | undefined
  /** 上次打印 drain.paused 的时间；熔断期间按秒级降噪。 */
  private pause_logged_at = 0
  /** 连续限流次数，用于指数加大冷却；发送成功即清零。 */
  private rate_limit_streak = 0
  private readonly rate_limit_cooldown_ms: number
  private readonly rate_limit_cooldown_max_ms: number
  /** 无 context_token 的消息被拒后，推迟多久再试（默认 5 分钟）。 */
  private readonly no_token_defer_ms: number
  /** 通知类结果停放多久（默认 6 小时）。 */
  private readonly parked_retention_ms: number

  /** 绑定状态库与发送实现。 */
  constructor(options: OutboundCoordinatorOptions) {
    this.store = options.store
    this.turn_context = options.turn_context
    this.sender = options.sender
    this.classify_retryable = options.classify_retryable
    this.record_entry = options.record_entry
    this.max_attempts = options.max_attempts ?? 5
    this.retry_base_ms = options.retry_base_ms ?? 500
    // 距上次可见输出超过这个时间才补一条"还在处理"的心跳。
    // 默认 5 分钟：原来 75 秒太频繁，长任务里会刷出一串心跳，用户觉得吵。
    this.heartbeat_idle_ms = options.heartbeat_idle_ms ?? Number(process.env.DSH_WEIXIN_HEARTBEAT_IDLE_MS ?? '300000')
    this.heartbeat_max_per_turn = options.heartbeat_max_per_turn ?? 6
    // 默认 2.2 秒/条：实测连发第 4 条就会触发限流，必须明显放慢。
    this.send_min_gap_ms = options.send_min_gap_ms ?? Number(process.env.DSH_WEIXIN_SEND_MIN_GAP_MS ?? '2200')
    this.send_batch_limit = options.send_batch_limit ?? Number(process.env.DSH_WEIXIN_SEND_BATCH_LIMIT ?? '3')
    this.rate_limit_cooldown_ms = options.rate_limit_cooldown_ms
      ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MS ?? '60000')
    this.rate_limit_cooldown_max_ms = options.rate_limit_cooldown_max_ms
      ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MAX_MS ?? '600000')
    this.no_token_defer_ms = options.no_token_defer_ms
      ?? Number(process.env.DSH_WEIXIN_NO_TOKEN_DEFER_MS ?? '300000')
    this.parked_retention_ms = options.parked_retention_ms
      ?? Number(process.env.DSH_WEIXIN_PARKED_RETENTION_MS ?? '21600000')
  }

  // ── 入队 API（协调器调用） ─────────────────────────────────────────────

  /** 入队一条正式回复（转级上下文由 turn 决定）。 */
  enqueue_assistant(input: { session_id: string; user_id: string; turn: number; text: string }): void {
    if (!input.text.trim()) return
    const context = this.turn_context.resolve(input.session_id, input.turn)
    const record = this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: context?.user_id ?? input.user_id,
      kind: 'assistant',
      text: input.text,
      turn: input.turn,
      ...context?.context_token === undefined ? {} : { context_token: context.context_token },
    })
    // 长期记忆：只记"对用户的最终回复"（通知类走 enqueue_notice，不算对话回复）。
    this.record_entry?.({
      id: record.outbound_id,
      ts: record.created_at,
      role: 'assistant',
      text: input.text,
      user_id: record.user_id,
      session_id: record.session_id,
      turn: input.turn,
    })
  }

  /** 入队控制回执 / 错误 / 进度。 */
  enqueue_notice(input: {
    session_id: string
    user_id: string
    /** assistant 用于 Codex 远程桥的"由模型执行"的正式输出 */
    kind: 'control_ack' | 'progress' | 'heartbeat' | 'error' | 'assistant'
    text: string
    context_token?: string
    turn?: number
  }): void {
    if (!input.text.trim()) return
    // 通知类（turn 为空）不做无上限堆积：超出上限丢最旧的。
    // 理由：通知时效性强，且会占用平台发送限额、把正式回复挤出窗口。
    // 带 turn 的正式回复不受影响（trim 只删 turn IS NULL 的 pending）。
    if (input.turn === undefined) this.store.trim_pending_notices(input.session_id)
    // 没显式给 token 的通知，退而带上"该会话最近一次**且仍然新鲜**的 token"。
    //
    // 为什么强调新鲜：无 token 的发送在会话窗口关闭后会被拒（→ 延后，不阻塞队列），
    // 而**过期 token 的发送同样被拒**，且更容易被误判成真限流。
    // 所以只在窗口还开着时才带，过期的宁可不带（走"延后"而不是"熔断"）。
    const fallback_token = input.context_token
      ?? this.turn_context.latest_token_if_fresh(input.session_id)
    this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: input.user_id,
      kind: input.kind,
      text: input.text,
      ...input.turn === undefined ? {} : { turn: input.turn },
      ...fallback_token === undefined ? {} : { context_token: fallback_token },
    })
  }

  // ── 发送 ──────────────────────────────────────────────────────────────

  /**
   * 泵出所有会话的可发送消息。
   * - 不同 Session 并发；同一 Session 严格按 sequence。
   * - 单条失败不阻塞其它会话。
   */
  async drain(): Promise<void> {
    if (this.stopped) return
    const wait = this.paused_until - Date.now()
    if (wait > 0) {
      // 熔断中：整条链路暂停，到期自动续跑。绝不能"边被限流边重试"，
      // 否则重试流量会把限流维持成永久状态（实测 11 小时发不出消息）。
      //
      // 注意两点，都是踩过的坑：
      //   1. 降噪：drain 会被很多事件并发触发，每次都打日志会一秒刷出几十条；
      //   2. 只留一个唤醒定时器，否则并发 drain 会累积无限定时器。
      const now = Date.now()
      if (now - this.pause_logged_at > 5_000) {
        this.pause_logged_at = now
        probe('outbound', 'drain.paused', { remaining_ms: wait, streak: this.rate_limit_streak })
      }
      if (this.pause_timer === undefined) {
        this.pause_timer = setTimeout(() => {
          this.pause_timer = undefined
          void this.drain()
        }, wait + 50)
        this.pause_timer.unref?.()
      }
      return
    }
    if (this.draining) return
    this.draining = true
    try {
      const heads = this.store.next_outbox_per_session()
      await Promise.all(heads.map(head => this.send_head(head)))
    } finally {
      this.draining = false
    }
  }

  /**
   * 发送某会话当前队首；成功后继续推进该会话。
   *
   * 关键防护：记录本次已处理过的 outbound_id，禁止在同一次泵出里重复发送同一条。
   * 否则"终态失败 → 入队 error → error 也失败 → 再入队 error"会变成无限循环。
   */
  private async send_head(record: OutboxRecord): Promise<void> {
    const handled = new Set<string>()
    let current: OutboxRecord | undefined = record
    let sent = 0
    while (current !== undefined && !this.stopped) {
      if (handled.has(current.outbound_id)) {
        probe('outbound', 'pump.guard_tripped', { outbound_id: current.outbound_id })
        return
      }
      handled.add(current.outbound_id)
      // 节流：同一会话相邻两条之间至少间隔 send_min_gap_ms；
      // 同时压制跨会话总速率，避免多会话并发把服务端顶到限流。
      await this.throttle(current.session_id)
      const ok = await this.send_one(current)
      if (!ok) return
      sent += 1
      // 限批：一次泵出最多发这么多条，剩下的交给后续 tick / 下一轮消息触发。
      if (sent >= this.send_batch_limit) {
        probe('outbound', 'pump.batch_capped', { session_id: current.session_id, sent })
        return
      }
      current = this.store.next_outbox(current.session_id)
    }
  }

  /** 发送前等待，保证最小间隔（会话级 + 全局级）。 */
  private async throttle(session_id: string): Promise<void> {
    const now = Date.now()
    const last_same = this.last_send_at.get(session_id) ?? 0
    const wait_same = this.send_min_gap_ms - (now - last_same)
    // 跨会话也留一点间隔（半速），避免多会话同时打满。
    const wait_any = Math.floor(this.send_min_gap_ms / 2) - (now - this.last_send_any_at)
    const wait = Math.max(0, wait_same, wait_any)
    if (wait > 0) {
      probe('outbound', 'throttle.wait', { session_id, wait_ms: wait })
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    this.last_send_at.set(session_id, Date.now())
    this.last_send_any_at = Date.now()
  }

  /** 发送单条；返回是否应继续推进该会话队列。 */
  private async send_one(record: OutboxRecord): Promise<boolean> {
    const done = probe_timer('outbound', 'send.attempt', {
      outbound_id: record.outbound_id, session_id: record.session_id, kind: record.kind,
      sequence: record.sequence, attempt: record.attempt,
    })
    this.store.mark_outbox_sending(record.outbound_id)
    try {
      // 发送前**重新解析一次 token**，而不是只用入队时存下的那个。
      //
      // 原因（实测踩到）：token 只有用户发消息时才会带来，而通知入队时窗口常常是关着的，
      // 于是存下的 token 是空的；等用户下次说话、窗口重新打开，这条通知**仍然没有 token**
      // 而发不出去。发送时刻再取一次，积压的通知就能趁着窗口开着补发。
      const send_token = record.context_token ?? this.turn_context.latest_token_if_fresh(record.session_id)
      if (send_token !== undefined && record.context_token === undefined) {
        probe('outbound', 'token.picked_at_send', { outbound_id: record.outbound_id, kind: record.kind })
      }

      // 长文本拆段发送：整段内容完整送达，不再截断。
      const parts = split_text(record.text, MAX_TEXT_CHARS)
      // 断点续传：跳过此前已成功送达的段（否则第 1 段失败重试会把第 0 段重发）。
      const already_sent = new Set(record.sent_parts ?? [])
      let sent_any = already_sent.size > 0
      for (let index = 0; index < parts.length; index += 1) {
        if (already_sent.has(index)) continue
        if (sent_any) await this.throttle(record.session_id)
        await this.sender({
          user_id: record.user_id,
          text: parts[index]!,
          // 同一记录的多段共享 client_id 前缀 + 段号，保证每段唯一且重试可复用。
          client_id: `${record.client_id}#${index}`,
          ...send_token === undefined ? {} : { context_token: send_token },
        })
        // 每段成功即落盘：中途崩溃/失败重启后不会重复投递该段。
        this.store.mark_outbox_part_sent(record.outbound_id, index)
        sent_any = true
      }
      this.store.mark_outbox_sent(record.outbound_id)
      // 发送成功说明限流窗口已过：清空熔断与连击计数。
      this.paused_until = 0
      this.rate_limit_streak = 0
      done({ outcome: 'sent' })
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const retryable = this.classify_retryable(error)
      const rate_limited = (error as { rate_limited?: boolean } | undefined)?.rate_limited === true
      const attempt = record.attempt + 1

      if (rate_limited) {
        // 先分清两种 ret=-2，它们的处理方式完全相反：
        //
        // (a) **没有 context_token** —— 实测这类发送几乎必然被拒（历史统计：
        //     带 token 70/70 成功，不带 token 13 次失败），因为 iLink 需要会话上下文才能投递。
        //     这类消息**不能**占用全局冷却、更不能挡住后面的队列——否则一条无 token 的通知
        //     会把"带 token 的真实回复"堵死（实测就是这样让用户几小时收不到消息的）。
        //     做法：推迟到下次有入站消息（那时才会有新 token）再试，并**继续推进队列**。
        // 通知类（turn 为空：任务完成汇报、进度）**永不阻塞队列、永不触发全局熔断**。
        //
        // 这是踩过的坑：通知类通常没有自己的新鲜 token（要么没有、要么是"最近一次"的旧 token），
        // 而旧 token 必然被拒。若把它当"真限流"就会把 streak 顶到几十，
        // 全局冷却一路冻结——**连带把带新鲜 token 的真实回复也冻住**，
        // 表现为"整晚收不到消息，你一说话积压全涌出来"（实测 streak 24、10 小时零成功）。
        const is_notice = record.turn === undefined
        if (is_notice) {
          // 通知类**停放**，不重试、不丢弃。
          //
          // 依据（四组对照实验全部 ret=-2）：平台只允许在"用户刚发过消息"的窗口内发送；
          // 旧 token / 无 token / 先调 notifystart 都不行——notifystart 也重开不了窗口。
          // 所以窗口关着时反复重试纯属白费（还会拖慢真实回复）。
          // 但结果本身有价值（"你让我做的事做完了"），所以停放在队列里保留一段时间，
          // 由工具 `处理结果日志` 在用户主动询问时返回。
          const park_ms = this.parked_retention_ms
          this.store.mark_outbox_failed(
            record.outbound_id, 'failed_retryable', '会话窗口已关闭：已停放，等用户询问时返回',
            Date.now() + park_ms,
          )
          // 顺手清理超过保留期的停放结果，避免长期堆积
          this.store.prune_parked_results(park_ms)
          done({ outcome: 'notice_parked', error: detail, attempt, park_ms })
          probe('outbound', 'notice.parked', {
            outbound_id: record.outbound_id, park_ms,
            has_token: record.context_token !== undefined,
          })
          return true
        }

        if (record.context_token === undefined) {
          const defer_ms = this.no_token_defer_ms
          this.store.mark_outbox_failed(
            record.outbound_id, 'failed_retryable', detail, Date.now() + defer_ms,
          )
          done({ outcome: 'deferred_no_token', error: detail, attempt, defer_ms })
          probe('outbound', 'send.deferred_no_token', {
            outbound_id: record.outbound_id, kind: record.kind, defer_ms,
          })
          // true = 继续处理该会话的下一条，避免队首阻塞（这是本改动的核心）。
          return true
        }
        // (b) **带 token 仍被拒** —— 这才是真正的整体限流：整条链路冷却退避，
        //     且不消耗 max_attempts（"现在整体不能发"，重试次数没有意义）。
        this.rate_limit_streak += 1
        const cooldown = Math.min(
          this.rate_limit_cooldown_ms * 2 ** (this.rate_limit_streak - 1),
          this.rate_limit_cooldown_max_ms,
        )
        this.paused_until = Date.now() + cooldown
        this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', detail, Date.now() + cooldown)
        done({
          outcome: 'rate_limited', error: detail, attempt,
          cooldown_ms: cooldown, streak: this.rate_limit_streak,
        })
        return false
      }

      if (!retryable || attempt >= this.max_attempts) {
        this.store.mark_outbox_failed(record.outbound_id, 'failed_terminal', detail)
        done({ outcome: 'failed_terminal', error: detail, attempt })
        // 失败只落日志/探针，**绝不再往 outbox 回投"发送失败"通知**：
        // 那条通知本身也要占用发送配额，发送被限流时它会跟着失败，等于把一次
        // 瞬时限流放大成持续拥塞，并把真实回复挤在队尾——实测曾导致连续 11 小时
        // 完全发不出消息（含欣爱对用户的正常回复）。
        probe('outbound', 'send.gave_up', {
          outbound_id: record.outbound_id, kind: record.kind, attempt, error: detail,
        })
        return true
      }
      // 普通可重试错误（网络抖动等）：按指数退避，重试仍计入突发节流。
      const base = this.retry_base_ms
      const next_retry_at = Date.now() + base * 2 ** Math.min(attempt, 6)
      this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', detail, next_retry_at)
      done({
        outcome: 'failed_retryable',
        error: detail, attempt, next_retry_in_ms: next_retry_at - Date.now(),
      })
      return false
    }
  }

  // ── 进度 / 心跳（摘要驱动） ───────────────────────────────────────────

  /** 一轮开始：记录进度状态并启动"摘要超时"检查。 */
  begin_turn(session_id: string, turn: number): void {
    this.clear_progress(session_id)
    const state: TurnProgress = {
      turn,
      last_visible_at: Date.now(),
      heartbeats: 0,
      active: true,
    }
    if (this.heartbeat_idle_ms > 0) {
      state.timer = setInterval(() => { void this.maybe_heartbeat(session_id) }, Math.max(5_000, Math.floor(this.heartbeat_idle_ms / 3)))
      state.timer.unref?.()
    }
    this.progress.set(session_id, state)
    probe('outbound', 'turn.begin', { session_id, turn, heartbeat_idle_ms: this.heartbeat_idle_ms })
  }

  /**
   * 标记"刚有可见输出"。
   *
   * 思考摘要与正文分段都会调用这里——**摘要本身就是心跳**，
   * 所以它同时把 last_visible_at 推后，从而抑制额外的固定心跳。
   */
  note_visible(session_id: string): void {
    const state = this.progress.get(session_id)
    if (state !== undefined) state.last_visible_at = Date.now()
  }

  /** 一轮结束：停止检查。 */
  end_turn(session_id: string): void {
    this.clear_progress(session_id)
    probe('outbound', 'turn.end', { session_id })
  }

  /** 距上次可见输出超过阈值才补发心跳。 */
  private async maybe_heartbeat(session_id: string): Promise<void> {
    const state = this.progress.get(session_id)
    if (state === undefined || !state.active) return
    const idle = Date.now() - state.last_visible_at
    if (idle < this.heartbeat_idle_ms) return
    if (state.heartbeats >= this.heartbeat_max_per_turn) {
      this.clear_progress(session_id)
      return
    }
    const context = this.turn_context.resolve(session_id, state.turn)
    if (context === undefined) return
    state.heartbeats += 1
    state.last_visible_at = Date.now()
    this.store.enqueue_outbox({
      session_id,
      user_id: context.user_id,
      kind: 'heartbeat',
      text: `（还在处理中，已等待约 ${Math.round(idle / 1000)} 秒…）`,
      turn: state.turn,
      ...context.context_token === undefined ? {} : { context_token: context.context_token },
    })
    probe('outbound', 'heartbeat.enqueued', {
      session_id, turn: state.turn, idle_ms: idle, count: state.heartbeats,
    })
    await this.drain()
  }

  /** 入队一条思考摘要（进度）：它既是进度也是心跳。 */
  enqueue_progress(session_id: string, text: string): void {
    const state = this.progress.get(session_id)
    if (state === undefined) return
    const context = this.turn_context.resolve(session_id, state.turn)
    if (context === undefined) return
    this.note_visible(session_id)
    this.store.enqueue_outbox({
      session_id,
      user_id: context.user_id,
      kind: 'progress',
      text,
      turn: state.turn,
      ...context.context_token === undefined ? {} : { context_token: context.context_token },
    })
  }

  /** 清理某会话的进度状态。 */
  private clear_progress(session_id: string): void {
    const state = this.progress.get(session_id)
    if (state?.timer !== undefined) clearInterval(state.timer)
    this.progress.delete(session_id)
  }

  /** 停止出站泵；幂等。 */
  stop(): void {
    this.stopped = true
    if (this.pause_timer !== undefined) {
      clearTimeout(this.pause_timer)
      this.pause_timer = undefined
    }
    for (const session_id of [...this.progress.keys()]) this.clear_progress(session_id)
    probe('outbound', 'stopped')
  }

  /** 启动时恢复 pending outbox（设计文档 §10.3）。 */
  async recover_pending(): Promise<number> {
    const pending = this.store.list_pending_outbox()
    const now = Date.now()
    // 超过 10 分钟的旧回复不再补发：用户早就翻篇了，补发只会变成一次突发，
    // 反而触发服务端限流。标记为终态并留下记录即可。
    const stale_ms = Number(process.env.DSH_WEIXIN_OUTBOX_STALE_MS ?? String(10 * 60_000))
    // **正式回复**（turn 非空）的保留期更长：它们只要拿到一个新鲜 context_token 就能送达，
    // 而通知类过期即无意义。用同一个 10 分钟阈值会把"用户其实很需要的那条回复"删掉
    // （实测发生过：用户提问的回复因重启时已过 10 分钟而被丢弃）。
    const reply_stale_ms = Number(process.env.DSH_WEIXIN_REPLY_STALE_MS ?? String(30 * 60_000))
    let dropped = 0
    for (const record of pending) {
      // 通知类（处理结果）按**停放保留期**算，而不是 10 分钟：
      // 它们本来就是"窗口关闭时先存着，等用户来问"，重启不能把它们当过期删掉。
      const limit = record.turn === undefined
        ? Math.max(stale_ms, this.parked_retention_ms)
        : Math.max(stale_ms, reply_stale_ms)
      if (now - record.created_at > limit) {
        this.store.mark_outbox_failed(record.outbound_id, 'failed_terminal', '重启恢复：超过补发时限，已丢弃')
        dropped += 1
        continue
      }
      // sending 卡住的记录重置为可重试（client_id 不变，服务端幂等）。
      if (record.status === 'sending') {
        this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', '重启恢复：上次发送中断')
      }
    }
    probe('outbound', 'recover.pending', { count: pending.length, dropped_stale: dropped })
    return pending.length
  }
}

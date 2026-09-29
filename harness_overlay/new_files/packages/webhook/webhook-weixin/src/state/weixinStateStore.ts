/**
 * 微信链路唯一状态存储（SQLite）。
 *
 * 重构设计文档 §5.1：不再新增临时 JSON 作为状态源，所有外部协议状态集中在一个库里：
 *   consumer_lease / transport_cursor / route / delivery / outbox / turn_context / meta
 *
 * 关键语义（§5.3）：**任何写失败都必须 reject 调用方**，禁止"记日志后 resolve"。
 * 事务由 SQLite 原生事务保证；跨进程互斥由 lease 表 + 主键冲突保证原子性。
 *
 * 使用 Node 内置 `node:sqlite`（Node 22+），无需第三方依赖。
 * @module dsh-webhook-weixin/state-store
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { probe, probe_timer } from '../diagnostics/probe.ts'
import type {
  DeliveryRecord,
  DeliveryStatus,
  OutboxKind,
  OutboxRecord,
  OutboxStatus,
} from '../types/domain.ts'

/**
 * 状态库 schema 版本；不匹配时 fail closed（禁止自动清空）。
 * v2：delivery 增加 context_token 列（回复需要它，之前没存导致只能无 token 发送）。
 * v3：delivery 增加 payload_json 列（崩溃恢复时据此**重新注入**，而不是误标 injected）；
 *     outbox 增加 sent_parts_json 列（分段发送断点续传，避免重试重复发已成功段）。
 */
export const STATE_SCHEMA_VERSION = 3

/** 构造参数。 */
export interface WeixinStateStoreOptions {
  /** SQLite 文件路径。 */
  readonly path: string
  /** 是否允许在库不存在时创建；默认 true。 */
  readonly create?: boolean
}

/** 一行 outbox 的原始形态（列名 → 字段）。 */
interface OutboxRow {
  outbound_id: string
  session_id: string
  user_id: string
  turn: number | null
  sequence: number
  kind: string
  text: string
  context_token: string | null
  client_id: string
  status: string
  attempt: number
  next_retry_at: number | null
  last_error: string | null
  created_at: number
  sent_at: number | null
  sent_parts_json: string | null
}

/** 一行 delivery 的原始形态。 */
interface DeliveryRow {
  delivery_id: string
  user_id: string
  session_id: string | null
  status: string
  received_at: number
  injected_at: number | null
  last_error: string | null
  attempt: number
  context_token: string | null
  payload_json: string | null
}

/** 微信链路状态库。所有公开写方法失败时抛出，调用方必须处理。 */
export class WeixinStateStore {
  private readonly db: DatabaseSync
  private closed = false

  /** 打开（或创建）状态库并校验 schema。 */
  constructor(options: WeixinStateStoreOptions) {
    const create = options.create ?? true
    if (!create && !existsSync(options.path)) {
      throw new Error(`weixin state store 不存在且不允许创建：${options.path}`)
    }
    mkdirSync(dirname(options.path), { recursive: true })
    const done = probe_timer('state', 'store.open', { path: options.path })
    this.db = new DatabaseSync(options.path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = FULL')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.migrate()
    } catch (error) {
      // 初始化失败必须关闭句柄，否则在 Windows 上会留下占用中的 WAL 文件。
      try {
        this.db.close()
      } catch { /* 保留原始错误 */ }
      this.closed = true
      throw error
    }
    done()
  }

  /** 建表 + schema 校验；不匹配则 fail closed。 */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery (
        delivery_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        injected_at INTEGER,
        last_error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        context_token TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_status_idx ON delivery (status, received_at);
      CREATE TABLE IF NOT EXISTS outbox (
        outbound_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        turn INTEGER,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        context_token TEXT,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        sent_parts_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS outbox_queue_idx ON outbox (status, session_id, sequence);
      CREATE TABLE IF NOT EXISTS turn_context (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        context_token TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn)
      );
      CREATE TABLE IF NOT EXISTS consumer_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `)
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (row === undefined) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(STATE_SCHEMA_VERSION))
      return
    }
    const found = Number(row.value)
    if (found === STATE_SCHEMA_VERSION) return
    // 逐级前向迁移：只加列，不重建表、不丢数据。迁移完统一写回目标版本。
    if (found >= 1 && found < STATE_SCHEMA_VERSION) {
      const delivery_columns = this.column_names('delivery')
      if (!delivery_columns.includes('context_token')) {
        this.db.exec('ALTER TABLE delivery ADD COLUMN context_token TEXT')
      }
      if (!delivery_columns.includes('payload_json')) {
        // 存规范化后的入站消息（不含二进制），崩溃恢复时据此重新注入。
        this.db.exec('ALTER TABLE delivery ADD COLUMN payload_json TEXT')
      }
      const outbox_columns = this.column_names('outbox')
      if (!outbox_columns.includes('sent_parts_json')) {
        // 已成功发送的分段下标；重试时跳过，避免把第 0 段重复发给用户。
        this.db.exec("ALTER TABLE outbox ADD COLUMN sent_parts_json TEXT NOT NULL DEFAULT '[]'")
      }
      this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(STATE_SCHEMA_VERSION), 'schema_version')
      probe('state', 'schema.migrated', { from: found, to: STATE_SCHEMA_VERSION })
      return
    }
    throw new Error(
      `weixin state store schema 版本不匹配：期望 ${STATE_SCHEMA_VERSION}，实际 ${found}。`
      + '拒绝自动迁移或清空，请人工处理后再启动。',
    )
  }

  /** 读取某张表的列名集合；用于幂等的前向迁移。 */
  private column_names(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => column.name)
  }

  /** 关闭数据库；幂等。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ── 事务 ────────────────────────────────────────────────────────────────

  /**
   * 在一个事务里执行；抛错自动回滚并向上传播。
   * 这是"一个事实一个权威写入者"的实现手段：相关状态要么一起成功，要么一起不生效。
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch { /* 回滚失败时保留原始错误 */ }
      probe('state', 'transaction.rollback', { error: String(error) })
      throw error
    }
  }

  // ── transport cursor ────────────────────────────────────────────────────

  /** 读取当前 getUpdates 游标。 */
  get_cursor(): string {
    const row = this.db.prepare('SELECT cursor FROM transport_cursor WHERE id = 1').get() as { cursor: string } | undefined
    return row?.cursor ?? ''
  }

  /** 提交游标；失败抛错（调用方不得把未落盘当作已提交）。 */
  set_cursor(cursor: string): void {
    this.db.prepare(
      'INSERT INTO transport_cursor (id, cursor, updated_at) VALUES (1, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at',
    ).run(cursor, Date.now())
    probe('state', 'cursor.committed', { cursor_len: cursor.length })
  }

  // ── meta（键值，存 Codex thread 等） ─────────────────────────────────────

  /** 读一个 meta 键。 */
  get_meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /** 写一个 meta 键。 */
  set_meta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  // ── route ───────────────────────────────────────────────────────────────

  /** 读取 user → session 路由。 */
  get_session_id(user_id: string): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM route WHERE user_id = ?').get(user_id) as { session_id: string } | undefined
    return row?.session_id
  }

  /**
   * 清空出站队列：删掉所有**未终态**的行（待发 / 发送中 / 停放待问）。
   *
   * 用"删"而不是"标记失败"：队列的用途只是"还没发出去的东西"，
   * 清空之后 `bridge_results` 里也不会再翻出这些旧内容——这才是用户要的"清空队列"。
   * 已发送（sent）与明确失败（failed_terminal）的历史不动，它们只是记录。
   *
   * @returns 删掉的条数。
   */
  clear_queue(): number {
    const result = this.db.prepare(
      "DELETE FROM outbox WHERE status IN ('pending', 'sending', 'failed_retryable')",
    ).run()
    const removed = Number(result.changes ?? 0)
    probe('state', 'outbox.cleared', { removed })
    return removed
  }

  /**
   * 某个用户当前应使用的会话 id（把上下文代次编进去）。
   *
   * 代次 0（从没清空过）就用 `weixin-<user>`，保持历史数据不变；
   * 清空过就用 `weixin-<user>-c<epoch>`——换名字是为了**让新会话不与旧文件重名**，
   * 这样即便旧文件没删掉，也一定会新建一个空上下文的会话。
   */
  session_id_for(user_id: string): string {
    const epoch = this.context_epoch(user_id)
    return epoch <= 0 ? `weixin-${user_id}` : `weixin-${user_id}-c${epoch}`
  }

  /**
   * 删除 user → session 路由（清空上下文用）。
   *
   * 删掉后下一条消息会走"新建会话"分支，于是拿到一个**全新**的会话（空上下文）。
   * 只删路由是不够的——旧会话文件还在原地，所以必须配合"换一个会话 id"（见 epoch），
   * 否则新建时会撞上已存在的同名会话、又恢复回旧上下文。
   */
  clear_session_id(user_id: string): void {
    this.db.prepare('DELETE FROM route WHERE user_id = ?').run(user_id)
    probe('state', 'route.cleared', { user_id })
  }

  /**
   * 上下文代次（epoch）：同一用户名下第几段会话。
   *
   * 每次"清空上下文"就 +1，于是新会话 id 变成 `weixin-<user>` 之外的另一个名字，
   * 不会与旧会话文件重名。**这样即使旧文件删不掉（路径推导失败/被占用），
   * 上下文也一定是干净的**——文件删除只是顺手回收磁盘。
   */
  context_epoch(user_id: string): number {
    const raw = this.get_meta(`context_epoch:${user_id}`)
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  /** 上下文代次 +1，返回新值。 */
  bump_context_epoch(user_id: string): number {
    const next = this.context_epoch(user_id) + 1
    this.set_meta(`context_epoch:${user_id}`, String(next))
    probe('state', 'context.epoch_bumped', { user_id, epoch: next })
    return next
  }

  /** 写入 user → session 路由。 */
  set_session_id(user_id: string, session_id: string): void {
    this.db.prepare(
      'INSERT INTO route (user_id, session_id, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at',
    ).run(user_id, session_id, Date.now())
    probe('state', 'route.bound', { user_id, session_id })
  }

  /** 列出所有有路由的微信用户（主动推送时要知道推给谁）。 */
  list_users(): string[] {
    const rows = this.db.prepare('SELECT user_id FROM route ORDER BY updated_at DESC').all() as Array<{ user_id: string }>
    return rows.map(row => row.user_id)
  }

  /** 统计路由条数与会话数（装配检查/诊断用）。 */
  route_summary(): { users: number; sessions: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS users, COUNT(DISTINCT session_id) AS sessions FROM route').get() as
      | { users: number; sessions: number }
      | undefined
    return { users: row?.users ?? 0, sessions: row?.sessions ?? 0 }
  }

  // ── delivery ────────────────────────────────────────────────────────────

  /**
   * 幂等登记一条 delivery。
   * @returns `true` 表示首次登记（应继续处理）；`false` 表示此前已登记（重复投递）。
   * 注意：这里只登记接收事实，**不代表已注入会话**；cursor 提交仍取决于后续状态。
   */
  put_delivery_if_absent(record: {
    delivery_id: string
    user_id: string
    received_at: number
    context_token?: string
    /** 规范化后的入站消息（不含二进制），用于崩溃后重新注入。 */
    payload_json?: string
  }): boolean {
    const existing = this.db.prepare('SELECT delivery_id FROM delivery WHERE delivery_id = ?').get(record.delivery_id)
    if (existing !== undefined) {
      probe('state', 'delivery.duplicate', { delivery_id: record.delivery_id, user_id: record.user_id })
      return false
    }
    this.db.prepare(
      'INSERT INTO delivery (delivery_id, user_id, status, received_at, attempt, context_token, payload_json) '
      + 'VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).run(record.delivery_id, record.user_id, 'received', record.received_at,
      record.context_token ?? null, record.payload_json ?? null)
    probe('state', 'delivery.received', {
      delivery_id: record.delivery_id,
      user_id: record.user_id,
      has_context_token: record.context_token !== undefined,
    })
    return true
  }

  /** 最近一条入站消息的用户；调试注入口在未指定 user_id 时用它作为默认收件人。 */
  latest_user_id(): string | undefined {
    const row = this.db.prepare(
      'SELECT user_id FROM delivery ORDER BY received_at DESC LIMIT 1',
    ).get() as { user_id: string } | undefined
    return row?.user_id
  }

  /** 读取某条 delivery 的 context_token（回复时必须用它）。 */
  delivery_context_token(delivery_id: string): string | undefined {
    const row = this.db.prepare('SELECT context_token FROM delivery WHERE delivery_id = ?').get(delivery_id) as
      | { context_token: string | null }
      | undefined
    return row?.context_token ?? undefined
  }

  /** 读取一条 delivery。 */
  get_delivery(delivery_id: string): DeliveryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(delivery_id) as DeliveryRow | undefined
    return row === undefined ? undefined : to_delivery(row)
  }

  /**
   * 更新 delivery 状态（CAS：可指定期望的当前状态）。
   *
   * attempt 只统计**实际处理失败**的次数，不由状态迁移本身消耗：
   * `received → routing → injected` 是正常流转，不应该吃掉重试预算；
   * 只有重试与终态失败才传 `increment_attempt: true`。
   */
  update_delivery(
    delivery_id: string,
    status: DeliveryStatus,
    fields?: {
      session_id?: string
      injected_at?: number
      last_error?: string
      expect?: DeliveryStatus
      /** 是否消耗一次重试计数；默认 false（普通状态迁移不计次）。 */
      increment_attempt?: boolean
    },
  ): void {
    const current = this.get_delivery(delivery_id)
    if (current === undefined) throw new Error(`delivery 不存在：${delivery_id}`)
    if (fields?.expect !== undefined && current.status !== fields.expect) {
      probe('state', 'delivery.cas_miss', {
        delivery_id, expected: fields.expect, actual: current.status,
      })
      return
    }
    this.db.prepare(
      'UPDATE delivery SET status = ?, session_id = COALESCE(?, session_id), injected_at = COALESCE(?, injected_at), '
      + 'last_error = ?, attempt = attempt + ? WHERE delivery_id = ?',
    ).run(status, fields?.session_id ?? null, fields?.injected_at ?? null, fields?.last_error ?? null,
      fields?.increment_attempt === true ? 1 : 0, delivery_id)
    probe('state', 'delivery.status', {
      delivery_id, from: current.status, to: status,
      attempt: current.attempt + (fields?.increment_attempt === true ? 1 : 0),
    })
  }

  /** 列出未完成（需要恢复）的 delivery。 */
  list_unfinished_deliveries(limit = 200): DeliveryRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM delivery WHERE status IN ('received','routing','failed_retryable') ORDER BY received_at LIMIT ?",
    ).all(limit) as unknown as DeliveryRow[]
    return rows.map(to_delivery)
  }

  /** 批次内 delivery 是否都达到可提交 cursor 的状态。 */
  batch_committable(delivery_ids: readonly string[]): boolean {
    if (delivery_ids.length === 0) return true
    const placeholders = delivery_ids.map(() => '?').join(',')
    const row = this.db.prepare(
      `SELECT COUNT(*) AS pending FROM delivery WHERE delivery_id IN (${placeholders}) `
      + "AND status NOT IN ('injected','control_applied','failed_terminal')",
    ).get(...delivery_ids) as { pending: number } | undefined
    return (row?.pending ?? 0) === 0
  }

  // ── outbox ──────────────────────────────────────────────────────────────

  /**
   * 入队一条出站消息；sequence 在同一 Session 内单调递增（由本方法分配）。
   * @returns 落库后的完整记录（含分配的 sequence）。
   */
  enqueue_outbox(input: {
    session_id: string
    user_id: string
    kind: OutboxKind
    text: string
    turn?: number
    context_token?: string
    client_id?: string
  }): OutboxRecord {
    return this.transaction(() => {
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS last FROM outbox WHERE session_id = ?',
      ).get(input.session_id) as { last: number } | undefined
      const sequence = (row?.last ?? 0) + 1
      const outbound_id = `${input.session_id}:${sequence}`
      const client_id = input.client_id ?? `dsh-${input.session_id}-${sequence}-${Date.now().toString(36)}`
      const created_at = Date.now()
      this.db.prepare(
        'INSERT INTO outbox (outbound_id, session_id, user_id, turn, sequence, kind, text, context_token, client_id, '
        + 'status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      ).run(outbound_id, input.session_id, input.user_id, input.turn ?? null, sequence, input.kind,
        input.text, input.context_token ?? null, client_id, 'pending', created_at)
      probe('state', 'outbox.enqueued', {
        outbound_id, session_id: input.session_id, kind: input.kind, sequence, text_len: input.text.length,
      })
      return {
        outbound_id, session_id: input.session_id, user_id: input.user_id,
        ...input.turn === undefined ? {} : { turn: input.turn },
        sequence, kind: input.kind, text: input.text,
        ...input.context_token === undefined ? {} : { context_token: input.context_token },
        client_id, status: 'pending' as const, attempt: 0, created_at,
      }
    })
  }

  /**
   * 取出某 Session 中下一条可发送记录（pending 或到时间的 failed_retryable）。
   *
   * **优先级**：`turn` 非空的是"针对某一轮的正式回复"，`turn` 为空的是通知类
   * （codex/opencode 完成汇报、进度、心跳）。平台对短时发送条数有限额，通知量一大
   * 就会把正式回复挤到窗口外，所以回复一律排在通知前面。
   */
  next_outbox(session_id: string, now = Date.now()): OutboxRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM outbox WHERE session_id = ? AND (status = 'pending' OR (status = 'failed_retryable' AND "
      + '(next_retry_at IS NULL OR next_retry_at <= ?))) ORDER BY (turn IS NULL), sequence LIMIT 1',
    ).get(session_id, now) as OutboxRow | undefined
    return row === undefined ? undefined : to_outbox(row)
  }

  /** 列出所有会话中待处理的下一条（用于跨会话并发发送）。 */
  next_outbox_per_session(now = Date.now()): OutboxRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM outbox WHERE status = 'pending' OR (status = 'failed_retryable' AND "
      + '(next_retry_at IS NULL OR next_retry_at <= ?)) ORDER BY session_id, (turn IS NULL), sequence',
    ).all(now) as unknown as OutboxRow[]
    const seen = new Set<string>()
    const result: OutboxRecord[] = []
    for (const row of rows) {
      if (seen.has(row.session_id)) continue
      seen.add(row.session_id)
      result.push(to_outbox(row))
    }
    return result
  }

  /** 标记发送中；失败抛错。 */
  mark_outbox_sending(outbound_id: string): void {
    this.db.prepare("UPDATE outbox SET status = 'sending', attempt = attempt + 1 WHERE outbound_id = ?").run(outbound_id)
    probe('state', 'outbox.sending', { outbound_id })
  }

  /**
   * 列出"已停放、尚未送达"的处理结果（通知类），供工具按需取回。
   *
   * 场景：codex/opencode 任务做完了，但用户此时不在微信里（会话窗口关闭），
   * 平台不允许推送。这些结果**停放在队列里保留一段时间**，等用户主动问起时由工具返回，
   * 而不是反复重试（重试必然失败，还会拖慢真实回复）。
   */
  parked_results(limit = 20): Array<{ outbound_id: string, sequence: number, text: string, created_at: number }> {
    return this.db.prepare(
      "SELECT outbound_id, sequence, text, created_at FROM outbox "
      + "WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') "
      + 'ORDER BY sequence LIMIT ?',
    ).all(limit) as unknown as Array<{ outbound_id: string, sequence: number, text: string, created_at: number }>
  }

  /** 丢弃超过保留期的停放结果（默认 6 小时），避免长期堆积。 */
  prune_parked_results(max_age_ms: number, now = Date.now()): number {
    const removed = this.db.prepare(
      "DELETE FROM outbox WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') "
      + 'AND created_at < ?',
    ).run(now - max_age_ms).changes
    if (removed > 0) probe('state', 'parked.pruned', { removed, max_age_ms })
    return Number(removed)
  }

  /**
   * 每个会话最多保留多少条**待发通知**（turn 为空）。
   *
   * 通知类消息（任务完成汇报、进度）时效性很强，积压后往往已经没意义，
   * 而且会占用平台的发送限额、把正式回复挤掉——所以超出上限时**丢最旧的**。
   */
  trim_pending_notices(session_id: string, keep = 3): number {
    const removed = this.db.prepare(
      "DELETE FROM outbox WHERE outbound_id IN ("
      + "  SELECT outbound_id FROM outbox WHERE session_id = ? AND status = 'pending' AND turn IS NULL "
      + '  ORDER BY sequence DESC LIMIT -1 OFFSET ?)',
    ).run(session_id, keep).changes
    if (removed > 0) probe('state', 'outbox.notices_trimmed', { session_id, removed, keep })
    return Number(removed)
  }

  /**
   * 记录某一分段已成功送达（立即落盘）。
   *
   * 必须在每段发送成功后马上写，而不是整条发完再写：否则进程在中间崩溃，
   * 重启后会从头重发，用户收到重复内容。
   */
  mark_outbox_part_sent(outbound_id: string, index: number): void {
    const row = this.db.prepare('SELECT sent_parts_json FROM outbox WHERE outbound_id = ?')
      .get(outbound_id) as { sent_parts_json: string | null } | undefined
    if (row === undefined) return
    const parts = parse_sent_parts(row.sent_parts_json)
    if (parts.includes(index)) return
    parts.push(index)
    parts.sort((a, b) => a - b)
    this.db.prepare('UPDATE outbox SET sent_parts_json = ? WHERE outbound_id = ?')
      .run(JSON.stringify(parts), outbound_id)
    probe('state', 'outbox.part_sent', { outbound_id, index, parts: parts.length })
  }

  /** 标记已发送。 */
  mark_outbox_sent(outbound_id: string): void {
    this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE outbound_id = ?")
      .run(Date.now(), outbound_id)
    probe('state', 'outbox.sent', { outbound_id })
  }

  /** 标记失败（可重试/终态），并给出下次重试时间。 */
  mark_outbox_failed(outbound_id: string, status: 'failed_retryable' | 'failed_terminal', error: string, next_retry_at?: number): void {
    this.db.prepare('UPDATE outbox SET status = ?, last_error = ?, next_retry_at = ? WHERE outbound_id = ?')
      .run(status, error, next_retry_at ?? null, outbound_id)
    probe('state', 'outbox.failed', { outbound_id, status, error })
  }

  /** 读取一条 outbox 记录。 */
  get_outbox(outbound_id: string): OutboxRecord | undefined {
    const row = this.db.prepare('SELECT * FROM outbox WHERE outbound_id = ?').get(outbound_id) as OutboxRow | undefined
    return row === undefined ? undefined : to_outbox(row)
  }

  /** 列出未发送完成的记录（恢复用）。 */
  list_pending_outbox(limit = 500): OutboxRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM outbox WHERE status IN ('pending','sending','failed_retryable') ORDER BY session_id, sequence LIMIT ?",
    ).all(limit) as unknown as OutboxRow[]
    return rows.map(to_outbox)
  }

  // ── turn context ────────────────────────────────────────────────────────

  /** 绑定 `session_id + turn` → delivery/context_token（设计文档 §7.1）。 */
  bind_turn_context(input: { session_id: string; turn: number; delivery_id: string; user_id: string; context_token?: string }): void {
    this.db.prepare(
      'INSERT INTO turn_context (session_id, turn, delivery_id, user_id, context_token, created_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(session_id, turn) DO UPDATE SET delivery_id = excluded.delivery_id, '
      + 'user_id = excluded.user_id, context_token = excluded.context_token',
    ).run(input.session_id, input.turn, input.delivery_id, input.user_id, input.context_token ?? null, Date.now())
    probe('state', 'turn_context.bound', {
      session_id: input.session_id, turn: input.turn, delivery_id: input.delivery_id,
      has_token: input.context_token !== undefined,
    })
  }

  /** 读取某 turn 的上下文绑定。 */
  get_turn_context(session_id: string, turn: number): { delivery_id: string; user_id: string; context_token?: string } | undefined {
    const row = this.db.prepare('SELECT * FROM turn_context WHERE session_id = ? AND turn = ?').get(session_id, turn) as
      | { delivery_id: string; user_id: string; context_token: string | null }
      | undefined
    if (row === undefined) return undefined
    return {
      delivery_id: row.delivery_id,
      user_id: row.user_id,
      ...row.context_token === null ? {} : { context_token: row.context_token },
    }
  }

  /** 最近一条 delivery → session 绑定（重启后补 turn context 用）。 */
  latest_delivery_for_session(session_id: string): DeliveryRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM delivery WHERE session_id = ? AND status IN ('injected','control_applied') ORDER BY received_at DESC LIMIT 1",
    ).get(session_id) as DeliveryRow | undefined
    return row === undefined ? undefined : to_delivery(row)
  }

  /** 清理过期的 turn_context（保留最近 N 个 turn）。 */
  prune_turn_context(session_id: string, keep = 20): void {
    this.db.prepare(
      'DELETE FROM turn_context WHERE session_id = ? AND turn NOT IN '
      + '(SELECT turn FROM turn_context WHERE session_id = ? ORDER BY turn DESC LIMIT ?)',
    ).run(session_id, session_id, keep)
  }

  // ── lease ───────────────────────────────────────────────────────────────

  /** 读取当前 lease（若有）。 */
  get_lease(): { owner_id: string; pid: number; heartbeat_at: number; account_id: string } | undefined {
    const row = this.db.prepare('SELECT owner_id, pid, heartbeat_at, account_id FROM consumer_lease WHERE id = 1').get() as
      | { owner_id: string; pid: number; heartbeat_at: number; account_id: string }
      | undefined
    return row
  }

  /**
   * 原子获取 lease：主键唯一 + UPDATE ... WHERE 条件保证只有一个进程成功。
   * @returns true 表示获取成功。
   */
  try_acquire_lease(input: {
    owner_id: string; pid: number; process_started_at: number; account_id: string; stale_ms: number
  }): boolean {
    const now = Date.now()
    return this.transaction(() => {
      const existing = this.get_lease()
      if (existing !== undefined) {
        // 判定顺序很重要：**持有者进程已死**时立即视为可抢占，
        // 否则被强杀（SIGKILL/任务管理器）的进程会把 lease 占到 stale 超时，
        // 造成"重启后拒绝启动"的假故障。
        const alive = is_pid_alive(existing.pid)
        const fresh = now - existing.heartbeat_at < input.stale_ms
        if (alive && fresh) {
          probe('state', 'lease.busy', { held_by: existing.owner_id, pid: existing.pid, age_ms: now - existing.heartbeat_at })
          return false
        }
        probe('state', 'lease.takeover', {
          held_by: existing.owner_id, pid: existing.pid, pid_alive: alive,
          age_ms: now - existing.heartbeat_at, reason: alive ? 'stale' : 'holder_dead',
        })
      }
      this.db.prepare(
        'INSERT INTO consumer_lease (id, owner_id, pid, process_started_at, account_id, acquired_at, heartbeat_at) '
        + 'VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, '
        + 'process_started_at = excluded.process_started_at, account_id = excluded.account_id, '
        + 'acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at',
      ).run(input.owner_id, input.pid, input.process_started_at, input.account_id, now, now)
      probe('state', 'lease.acquired', { owner_id: input.owner_id, pid: input.pid, account_id: input.account_id })
      return true
    })
  }

  /** 续租；只有持有者能续。 */
  heartbeat_lease(owner_id: string): boolean {
    const row = this.db.prepare('SELECT owner_id FROM consumer_lease WHERE id = 1').get() as { owner_id: string } | undefined
    if (row === undefined || row.owner_id !== owner_id) return false
    this.db.prepare('UPDATE consumer_lease SET heartbeat_at = ? WHERE id = 1').run(Date.now())
    return true
  }

  /** 释放 lease；只有持有者能释放。 */
  release_lease(owner_id: string): void {
    this.db.prepare('DELETE FROM consumer_lease WHERE id = 1 AND owner_id = ?').run(owner_id)
    probe('state', 'lease.released', { owner_id })
  }

  /** 诊断快照：各状态计数，供启动日志与探针使用。 */
  snapshot(): Record<string, unknown> {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined
      return row?.n ?? 0
    }
    return {
      cursor_len: this.get_cursor().length,
      routes: this.route_summary(),
      delivery: {
        received: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'received'"),
        injected: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'injected'"),
        control_applied: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'control_applied'"),
        failed_retryable: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_retryable'"),
        failed_terminal: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_terminal'"),
      },
      outbox: {
        pending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
        sending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sending'"),
        sent: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'"),
        failed_retryable: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_retryable'"),
        failed_terminal: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_terminal'"),
      },
      lease: this.get_lease() ?? null,
    }
  }
}

/**
 * 判断 pid 是否仍存活。
 * EPERM 表示进程存在但无权限，同样算存活；其余错误（ESRCH 等）视为已退出。
 */
function is_pid_alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** 行 → DeliveryRecord。 */
function to_delivery(row: DeliveryRow): DeliveryRecord {
  return {
    delivery_id: row.delivery_id,
    user_id: row.user_id,
    ...row.session_id === null ? {} : { session_id: row.session_id },
    status: row.status as DeliveryStatus,
    received_at: row.received_at,
    ...row.injected_at === null ? {} : { injected_at: row.injected_at },
    ...row.last_error === null ? {} : { last_error: row.last_error },
    attempt: row.attempt,
    ...row.context_token === null ? {} : { context_token: row.context_token },
    ...row.payload_json === null ? {} : { payload_json: row.payload_json },
  }
}

/** 行 → OutboxRecord。 */
function to_outbox(row: OutboxRow): OutboxRecord {
  return {
    outbound_id: row.outbound_id,
    session_id: row.session_id,
    user_id: row.user_id,
    ...row.turn === null ? {} : { turn: row.turn },
    sequence: row.sequence,
    kind: row.kind as OutboxKind,
    text: row.text,
    ...row.context_token === null ? {} : { context_token: row.context_token },
    client_id: row.client_id,
    status: row.status as OutboxStatus,
    attempt: row.attempt,
    ...row.next_retry_at === null ? {} : { next_retry_at: row.next_retry_at },
    ...row.last_error === null ? {} : { last_error: row.last_error },
    created_at: row.created_at,
    ...row.sent_at === null ? {} : { sent_at: row.sent_at },
    sent_parts: parse_sent_parts(row.sent_parts_json),
  }
}

/** 解析 outbox 的已发送分段下标；任何异常都按"没有已发送段"处理（最坏只是重发）。 */
function parse_sent_parts(raw: string | null): number[] {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is number => typeof item === 'number')
  } catch {
    return []
  }
}

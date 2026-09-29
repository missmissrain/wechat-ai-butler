/**
 * opencode 完成监视器：盯着本机 opencode，任务结束就把结果推到微信。
 *
 * **与微信桥的分工（防止重复汇报）**：
 * - 通过微信 `/opencode` 发起的任务 → 由 OpencodeBridge 自己的闭环汇报（含实时输出与完成通知）；
 * - 这个监视器只负责**外部发起**的任务（opencode 桌面/CLI 里自己跑的）。
 * 为区分二者，OpencodeBridge 每次运行都会把时间窗写进 meta（`oc_bridge_window`），
 * 监视器跳过落在窗口内的会话，避免同一任务被报两次。
 *
 * 数据来源：`~/.local/share/opencode/opencode.db`（只读）
 *   - `session`：id / directory / title / time_created / time_updated / model
 *   - `message`：session_id + data(JSON, role)
 *   - `part`：message_id + data(JSON, type=text/tool/step-finish)
 * @module dsh-webhook-weixin/opencode-watcher
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'

/** 推送回调。 */
export type WatchPush = (user_id: string, text: string) => void

/** 构造参数。 */
export interface OpencodeWatcherOptions {
  readonly store: WeixinStateStore
  readonly push: WatchPush
  /** 轮询间隔（毫秒）；默认 10 秒。 */
  readonly poll_ms?: number
  /** opencode 数据目录；默认 ~/.local/share/opencode。 */
  readonly data_dir?: string
  /** 结果文本上限。 */
  readonly summary_limit?: number
  /** 会话"静默"多久算完成（毫秒）；默认 8 秒。 */
  readonly idle_ms?: number
}

/** 一条会话摘要。 */
interface SessionRow {
  id: string
  directory: string
  title: string
  time_created: number
  time_updated: number
}

/** opencode 完成监视器。 */
export class OpencodeWatcher {
  private readonly store: WeixinStateStore
  private readonly push: WatchPush
  private readonly poll_ms: number
  private readonly data_dir: string
  private readonly summary_limit: number
  private readonly idle_ms: number
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false
  private seeded = false

  /** 绑定状态库与推送实现。 */
  constructor(options: OpencodeWatcherOptions) {
    this.store = options.store
    this.push = options.push
    this.poll_ms = options.poll_ms ?? Number(process.env.DSH_OPENCODE_WATCH_MS ?? '10000')
    this.data_dir = options.data_dir
      ?? process.env.OPENCODE_DATA_DIR
      ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.local', 'share', 'opencode')
    this.summary_limit = options.summary_limit ?? Number(process.env.DSH_OPENCODE_SUMMARY_LIMIT ?? '1800')
    this.idle_ms = options.idle_ms ?? Number(process.env.DSH_OPENCODE_IDLE_MS ?? '8000')
  }

  /** 开始监视；幂等。 */
  start(): void {
    if (this.timer !== undefined) return
    const timer = setInterval(() => { void this.sweep() }, this.poll_ms)
    timer.unref?.()
    this.timer = timer
    probe('opencode-watch', 'start', { poll_ms: this.poll_ms, data_dir: this.data_dir })
    void this.sweep()
  }

  /** 停止监视；幂等。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    probe('opencode-watch', 'stop')
  }

  /** 手动扫一轮（供测试与诊断直接调用）。 */
  async sweep_once(): Promise<void> {
    await this.sweep()
  }

  /** 扫一轮：找出"刚完成"的外部 opencode 会话并推送。 */
  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const db_path = join(this.data_dir, 'opencode.db')
      if (!existsSync(db_path)) return
      const sessions = this.read_recent_sessions(db_path)
      for (const session of sessions) {
        // 刚更新不久 → 可能还在跑，等静默期过后再判。
        if (Date.now() - session.time_updated < this.idle_ms) continue
        // 微信发起的任务由桥自己汇报，这里跳过（防重复）。
        if (this.within_bridge_window(session.time_created)) {
          probe('opencode-watch', 'skip_bridge_session', { session_id: session.id })
          continue
        }
        // **完成指纹**：用"最后一条助手消息 id"作为去重键，而不是 time_updated。
        // 旧实现用 time_updated，会话只要再产生任何新输出就会重报一次
        // （日志里同一会话 14:06 与 14:09 被通知了两次）。
        const last = this.last_assistant_message(db_path, session.id)
        if (last === undefined) continue
        const key = 'oc_done:' + session.id
        if (this.store.get_meta(key) === last.message_id) continue
        this.store.set_meta(key, last.message_id)
        if (!this.seeded) continue
        const text = last.text
        if (text.trim() === '') continue
        const task = this.last_user_text(db_path, session.id) || session.title
        const name = session.directory.split(/[\\/]/).filter(Boolean).pop() ?? session.directory
        const body = [
          'opencode 任务完成',
          `项目：${name}`,
          `任务：${task.slice(0, 80)}`,
          '',
          '结果：',
          text.slice(0, this.summary_limit),
        ].join('\n')
        probe('opencode-watch', 'notify', { session_id: session.id })
        for (const user_id of this.store.list_users()) this.push(user_id, body)
      }
      this.seeded = true
    } catch (error) {
      probe('opencode-watch', 'sweep_failed', { error: String(error) })
    } finally {
      this.sweeping = false
    }
  }

  /** 该会话是否落在微信桥的运行窗口内（防重复汇报）。 */
  private within_bridge_window(created_at: number): boolean {
    const raw = this.store.get_meta('oc_bridge_window')
    if (raw === undefined || raw === '') return false
    try {
      const window = JSON.parse(raw) as { start?: number, end?: number }
      const start = window.start ?? 0
      const end = window.end ?? 0
      // 会话创建时间在窗口内（带 2 秒容差）即认为是微信发起的。
      return created_at >= start - 2_000 && (end === 0 || created_at <= end + 15_000)
    } catch {
      return false
    }
  }

  /** 读取最近更新的会话。 */
  private read_recent_sessions(db_path: string, limit = 10): SessionRow[] {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(db_path, { readOnly: true })
      const rows = db.prepare(
        'SELECT id, directory, title, time_created, time_updated FROM session '
        + 'WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?',
      ).all(limit) as unknown as SessionRow[]
      return rows
    } catch (error) {
      probe('opencode-watch', 'db_failed', { error: String(error) })
      return []
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
  }

  /**
   * 取会话**最后一条助手消息**的 id 与其文本。
   *
   * 先定位最后一条 assistant message（按 message.rowid 倒序），再取该消息的 text 分片——
   * 这样得到的 message_id 就是稳定的"完成指纹"，同一轮完成不会被重复汇报。
   */
  private last_assistant_message(db_path: string, session_id: string): { message_id: string, text: string } | undefined {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(db_path, { readOnly: true })
      const message = db.prepare(
        'SELECT id FROM message WHERE session_id = ? AND data LIKE \'%"role":"assistant"%\' '
        + 'ORDER BY rowid DESC LIMIT 1',
      ).get(session_id) as { id: string } | undefined
      if (message === undefined) return undefined
      const rows = db.prepare(
        'SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC',
      ).all(message.id) as Array<{ data: string }>
      const texts: string[] = []
      for (const row of rows) {
        try {
          const part = JSON.parse(row.data) as { type?: string, text?: string }
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
            texts.push(part.text.trim())
            if (texts.join('\n').length > this.summary_limit) break
          }
        } catch { /* 跳过坏行 */ }
      }
      if (texts.length === 0) return undefined
      return { message_id: message.id, text: texts.join('\n') }
    } catch (error) {
      probe('opencode-watch', 'assistant_read_failed', { error: String(error) })
      return undefined
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
  }

  /** 取会话最后一条用户消息文本（作为任务标题）。 */
  private last_user_text(db_path: string, session_id: string): string {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(db_path, { readOnly: true })
      const rows = db.prepare(
        'SELECT p.data FROM part p JOIN message m ON p.message_id = m.id '
        + 'WHERE p.session_id = ? AND m.data LIKE \'%"role":"user"%\' '
        + 'ORDER BY p.rowid DESC LIMIT 20',
      ).all(session_id) as Array<{ data: string }>
      for (const row of rows) {
        try {
          const part = JSON.parse(row.data) as { type?: string, text?: string }
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
            return part.text.trim()
          }
        } catch { /* 跳过坏行 */ }
      }
    } catch {
      return ''
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
    return ''
  }
}

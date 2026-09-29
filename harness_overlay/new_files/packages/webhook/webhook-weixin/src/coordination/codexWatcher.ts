/**
 * Codex 任务完成监视器：被动盯着本机 Codex，任务一结束就主动把结果推到微信。
 *
 * 一个容易走错的思路是"用 Codex 的 `notify` 钩子让独立进程直接推送"。
 * 微信链路里不能那么做：独立进程直接调 iLink 会变成**第二个消费者**，
 * 与 harness 抢同一个微信账号（我们为此吃过亏）。所以这里在 harness 内部做轮询式监视，
 * 推送复用同一条 durable outbox —— 不新增消费者、不新增发送路径。
 *
 * 数据来源（与 Telegram 版一致，已验证可行）：
 *   - `~/.codex/state_5.sqlite` 的 `threads` 表 → 最近的会话及其 rollout 路径/工作区/标题；
 *   - rollout JSONL 尾部 → 生命周期事件 `task_started` / `task_complete` / `turn_aborted`；
 *   - rollout 里的 `response_item(role=assistant)` → 最终回答文本。
 *
 * 关键行为：**首次扫描只记录基线、不通知**（否则重启会把历史任务全推一遍）。
 * @module dsh-webhook-weixin/codex-watcher
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'

/** 推送回调（由连接器注入，走 outbox）。 */
export type WatchPush = (user_id: string, text: string) => void

/** 构造参数。 */
export interface CodexWatcherOptions {
  readonly store: WeixinStateStore
  /** 有任务完成时调用；user_id 由连接器决定。 */
  readonly push: WatchPush
  /** 轮询间隔（毫秒）；默认 8 秒。 */
  readonly poll_ms?: number
  /** Codex home；默认 ~/.codex。 */
  readonly codex_home?: string
  /** 通知里附带的结果文本上限。 */
  readonly summary_limit?: number
}

/** 一个 Codex 会话的观察结果。 */
interface ThreadStatus {
  thread_id: string
  rollout_path: string
  workspace: string
  title: string
  /** 运行中 / 已完成 / 已中止 / 等待首次运行 */
  status: string
  /** 生命周期事件时间戳（原始 ISO 字符串）。 */
  event_at?: string
}

/** Codex 任务完成监视器。 */
export class CodexWatcher {
  private readonly store: WeixinStateStore
  private readonly push: WatchPush
  private readonly poll_ms: number
  private readonly codex_home: string
  private readonly summary_limit: number
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false
  /** 是否已完成首轮基线扫描（首轮不通知）。 */
  private seeded = false

  /** 绑定状态库与推送实现。 */
  constructor(options: CodexWatcherOptions) {
    this.store = options.store
    this.push = options.push
    this.poll_ms = options.poll_ms ?? Number(process.env.DSH_CODEX_WATCH_MS ?? '8000')
    this.codex_home = options.codex_home
      ?? process.env.CODEX_HOME
      ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.codex')
    this.summary_limit = options.summary_limit ?? Number(process.env.DSH_CODEX_SUMMARY_LIMIT ?? '1800')
  }

  /** 开始监视；幂等。 */
  start(): void {
    if (this.timer !== undefined) return
    const timer = setInterval(() => { void this.sweep() }, this.poll_ms)
    timer.unref?.()
    this.timer = timer
    probe('codex-watch', 'start', { poll_ms: this.poll_ms, codex_home: this.codex_home })
    // 立刻跑一次：建立基线（不通知），并把"监视起点之前"的任务排除掉。
    void this.sweep()
  }

  /** 停止监视；幂等。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    probe('codex-watch', 'stop')
  }

  /** 扫一轮：读取最近的 Codex 会话状态，检测"刚完成"并推送。 */
  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const statuses = this.read_statuses()
      if (statuses.length === 0) return
      for (const item of statuses) {
        const key = 'codex_watch:' + item.thread_id
        const signature = `${item.status}|${item.event_at ?? ''}`
        const previous = this.store.get_meta(key)
        if (previous === signature) continue
        this.store.set_meta(key, signature)
        // 首轮只建基线：不通知，避免重启后把历史任务全部推给用户。
        if (!this.seeded) continue
        if (item.status !== '已完成' && item.status !== '已中止') continue
        const text = this.compose(item)
        probe('codex-watch', 'notify', {
          thread_id: item.thread_id, status: item.status, event_at: item.event_at,
        })
        for (const user_id of this.store.list_users()) this.push(user_id, text)
      }
      this.seeded = true
    } catch (error) {
      probe('codex-watch', 'sweep_failed', { error: String(error) })
    } finally {
      this.sweeping = false
    }
  }

  /** 组装通知文本。 */
  private compose(item: ThreadStatus): string {
    const summary = item.status === '已中止'
      ? '（任务被中止）'
      : this.latest_assistant_text(item.rollout_path).slice(0, this.summary_limit)
    const name = item.workspace.split(/[\\/]/).filter(Boolean).pop() ?? item.workspace
    return [
      `Codex 任务${item.status}`,
      `项目：${name}`,
      `任务：${item.title.slice(0, 80)}`,
      '',
      '结果：',
      summary || '（没有取到结果文本）',
    ].join('\n')
  }

  /** 读取最近的非归档 Codex 会话状态（只读，不打扰 Codex）。 */
  private read_statuses(limit = 8): ThreadStatus[] {
    const state_path = join(this.codex_home, 'state_5.sqlite')
    if (!existsSync(state_path)) return []
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(state_path, { readOnly: true })
      const rows = db.prepare(
        "SELECT id, rollout_path, cwd, title, updated_at FROM threads "
        + "WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?",
      ).all(limit) as Array<{
        id: string
        rollout_path: string
        cwd: string
        title: string | null
        updated_at: number
      }>
      return rows.map(row => {
        const rollout = String(row.rollout_path ?? '')
        const { status, event_at } = this.read_lifecycle(rollout)
        return {
          thread_id: String(row.id),
          rollout_path: rollout,
          workspace: normalize_path(String(row.cwd ?? '')),
          title: this.latest_user_message(rollout) || String(row.title ?? '未命名任务'),
          status,
          ...event_at === undefined ? {} : { event_at },
        }
      })
    } catch (error) {
      probe('codex-watch', 'state_db_failed', { error: String(error) })
      return []
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
  }

  /** 从 rollout 尾部找最近的生命周期事件（倒序扫描，避免读整个大文件）。 */
  private read_lifecycle(rollout_path: string): { status: string; event_at?: string } {
    if (!rollout_path || !existsSync(rollout_path)) return { status: '记录缺失' }
    const patterns: Array<[string, string]> = [
      ['"type":"task_complete"', '已完成'],
      ['"type":"turn_aborted"', '已中止'],
      ['"type":"task_started"', '运行中'],
    ]
    try {
      const size = statSync(rollout_path).size
      const block = 512 * 1024
      const handle = readFileSync(rollout_path)
      const tail = handle.subarray(Math.max(0, size - block)).toString('utf8')
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!
        for (const [marker, status] of patterns) {
          if (!line.includes(marker)) continue
          const at = line.match(/"timestamp":"([^"]+)"/)
          return { status, ...at === null ? {} : { event_at: at[1]! } }
        }
      }
    } catch (error) {
      probe('codex-watch', 'rollout_read_failed', { error: String(error), rollout_path })
    }
    return { status: '等待首次运行' }
  }

  /** 取最近一条真实用户消息作为任务标题。 */
  private latest_user_message(rollout_path: string): string {
    return this.scan_tail(rollout_path, line => {
      if (!line.includes('"type":"user_message"')) return undefined
      try {
        const parsed = JSON.parse(line) as { payload?: { message?: string } }
        const message = String(parsed.payload?.message ?? '').trim()
        return clean_user_message(message) || undefined
      } catch {
        return undefined
      }
    }) ?? ''
  }

  /** 取最近一条助手回答文本。 */
  private latest_assistant_text(rollout_path: string): string {
    let latest = ''
    try {
      const text = readFileSync(rollout_path, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.includes('"role":"assistant"')) continue
        try {
          const parsed = JSON.parse(line) as {
            type?: string
            payload?: { type?: string; role?: string; content?: Array<{ text?: string, output_text?: string }> }
          }
          const payload = parsed.payload
          if (parsed.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'assistant') continue
          const parts = (payload.content ?? [])
            .map(part => part.text ?? part.output_text ?? '')
            .filter(item => item.length > 0)
          if (parts.length > 0) latest = parts.join('\n').trim()
        } catch {
          continue
        }
      }
    } catch (error) {
      probe('codex-watch', 'assistant_read_failed', { error: String(error) })
    }
    return latest
  }

  /** 从文件尾部往前找第一个满足条件的行（避免全文件解析）。 */
  private scan_tail(rollout_path: string, pick: (line: string) => string | undefined): string | undefined {
    if (!existsSync(rollout_path)) return undefined
    try {
      const size = statSync(rollout_path).size
      const block = 1024 * 1024
      const data = readFileSync(rollout_path)
      const tail = data.subarray(Math.max(0, size - block)).toString('utf8')
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const value = pick(lines[i]!)
        if (value !== undefined) return value
      }
    } catch {
      return undefined
    }
    return undefined
  }
}

/** 去掉 Codex 包装、只留用户真实请求。 */
function clean_user_message(message: string): string {
  const marker = '## My request for Codex:'
  let text = message
  // 这里原来写的是 `split(marker, 1)[1]`：limit=1 时结果数组只有"标记之前"那一段，
  // `[1]` 恒为 undefined，于是 `?? text` 把整个包装（环境上下文、权限说明）当成任务标题。
  if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length)
  text = text.trim()
  if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>')) return ''
  return text
}

/** 去掉 Windows 长路径前缀。 */
function normalize_path(path: string): string {
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}

/** 列出最近修改过的 rollout 文件（诊断用；正常流程走 state_5.sqlite）。 */
export function list_recent_rollouts(codex_home: string, limit = 5): string[] {
  const root = join(codex_home, 'sessions')
  if (!existsSync(root)) return []
  const found: Array<{ path: string; mtime: number }> = []
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.jsonl')) found.push({ path: full, mtime: statSync(full).mtimeMs })
    }
  }
  walk(root)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(item => item.path)
}

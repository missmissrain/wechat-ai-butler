/**
 * Codex 远程桥：让用户用微信直接遥控本机 Codex，并把 Codex 的输出主动推回微信。
 *
 * 思路沿用作者早前的 Telegram 版本桥接实践（本仓库不含那份实现）。
 * 本模块把它搬到微信链路上，并复用我们已有的 durable outbox 做推送：
 *   - 入站：以 `/codex` 开头的消息不走大模型，直接交给 Codex 执行；
 *   - 出站：Codex 的每一步事件（思考/命令/结果）都作为消息推进 outbox，按节流发出；
 *   - 会话：记住 thread_id，后续 `/codex` 默认续用同一线程（可用 `/codex new` 强制新开）；
 *   - 控制：`/codex stop` 终止当前任务、`/codex status` 查看状态。
 *
 * 用 `codex exec --json`：它按行输出结构化事件（thread.started / item.completed / turn.completed），
 * 比 app-server 的 JSON-RPC 简单得多，足够做"边跑边推"。
 * @module dsh-webhook-weixin/codex-bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'

/** 默认工作区（欣爱的专属工作区）。 */
/** Codex 远程任务的默认工作目录：环境变量优先，否则当前工作目录（不写死本机路径）。 */
const DEFAULT_WORKSPACE = process.env.DSH_CODEX_WORKSPACE?.trim() || process.cwd()

/** 单次 Codex 任务超时（毫秒）。 */
const RUN_TIMEOUT_MS = Number(process.env.DSH_CODEX_TIMEOUT_MS ?? String(30 * 60_000))

/** 解析 Codex 可执行文件。 */
function resolve_codex_bin(): string {
  const configured = process.env.CODEX_BIN
  if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim()
  const fallback = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe')
  if (existsSync(fallback)) return fallback
  return 'codex'
}

/** 推送回调：把一条消息推给用户（走 outbox）。 */
export type CodexPush = (text: string, kind: 'progress' | 'assistant' | 'error') => void

/** 运行中的一个 Codex 任务。 */
interface RunningTask {
  child: ChildProcess
  turn: number
  started_at: number
  thread_id?: string
}

/** 解析出来的命令。 */
export interface CodexCommand {
  readonly action: 'run' | 'stop' | 'status' | 'help' | 'new'
  readonly text: string
}

/** 识别 `/codex` 指令；不是则返回 undefined。 */
export function parse_codex_command(text: string): CodexCommand | undefined {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('/codex')) return undefined
  const rest = trimmed.slice(6).trim()
  if (rest === '') return { action: 'help', text: '' }
  const [head, ...tail] = rest.split(/\s+/)
  const keyword = (head ?? '').toLowerCase()
  const body = tail.join(' ').trim()
  if (keyword === 'stop' || keyword === '停止') return { action: 'stop', text: body }
  if (keyword === 'status' || keyword === '状态') return { action: 'status', text: body }
  if (keyword === 'new' || keyword === '新开') return { action: 'new', text: body }
  if (keyword === 'help' || keyword === '帮助') return { action: 'help', text: body }
  return { action: 'run', text: rest }
}

/** 微信远程 Codex 桥。 */
export class CodexBridge {
  private readonly tasks = new Map<string, RunningTask>()
  private readonly seq = new Map<string, number>()

  /** 绑定状态库与推送实现。 */
  constructor(
    private readonly store: WeixinStateStore,
    private readonly push: (user_id: string, session_id: string, text: string, kind: 'progress' | 'assistant' | 'error', context_token?: string) => void,
    private readonly workspace: string = DEFAULT_WORKSPACE,
  ) {}

  /** 处理一条 `/codex` 指令。 */
  async handle(user_id: string, session_id: string, command: CodexCommand, context_token?: string): Promise<void> {
    if (command.action === 'help') {
      this.push(user_id, session_id, [
        '这里是 Codex 远程控制，用法：',
        '- /codex <任务>     交给 Codex 执行（默认续用上次线程）',
        '- /codex new <任务> 新开一个 Codex 线程',
        '- /codex status     查看当前状态',
        '- /codex stop       终止当前任务',
        `默认工作区：${this.workspace}`,
      ].join('\n'), 'assistant', context_token)
      return
    }
    if (command.action === 'status') {
      const task = this.tasks.get(user_id)
      const thread = this.thread_for(user_id)
      const text = task === undefined
        ? `（当前没有正在运行的 Codex 任务${thread === undefined ? '' : `；上次线程 ${thread.slice(0, 8)}`}）`
        : `（Codex 正在运行：第 ${task.turn} 轮，已 ${Math.round((Date.now() - task.started_at) / 1000)} 秒，线程 ${task.thread_id?.slice(0, 8) ?? '初始化中'}）`
      this.push(user_id, session_id, text, 'assistant', context_token)
      return
    }
    if (command.action === 'stop') {
      const stopped = this.stop(user_id)
      this.push(user_id, session_id, stopped ? '（已终止当前的 Codex 任务）' : '（当前没有正在运行的 Codex 任务）', 'assistant', context_token)
      return
    }
    if (command.action === 'new') {
      this.store.set_meta('codex_thread:' + user_id, '')
    }
    if (this.tasks.has(user_id)) {
      this.push(user_id, session_id, '（已经有一个 Codex 任务在跑，等它结束或先发 /codex stop）', 'error', context_token)
      return
    }
    if (!command.text.trim()) {
      this.push(user_id, session_id, '（/codex 后面要跟具体任务）', 'error', context_token)
      return
    }
    await this.run(user_id, session_id, command.text.trim(), context_token)
  }

  /** 终止某用户当前任务；返回是否真的终止了。 */
  stop(user_id: string): boolean {
    const task = this.tasks.get(user_id)
    if (task === undefined) return false
    probe('codex', 'stop', { user_id, pid: task.child.pid })
    task.child.kill()
    this.tasks.delete(user_id)
    return true
  }

  /** 当前用户是否有任务在跑。 */
  is_running(user_id: string): boolean {
    return this.tasks.has(user_id)
  }

  /** 读取该用户记住的 Codex 线程 id。 */
  thread_for(user_id: string): string | undefined {
    const value = this.store.get_meta('codex_thread:' + user_id)
    return value !== undefined && value.length > 0 ? value : undefined
  }

  /** 执行一次 Codex 任务，边跑边把事件推给用户，结束后发最终结果。 */
  private async run(user_id: string, session_id: string, task: string, context_token?: string): Promise<void> {
    const thread = this.thread_for(user_id)
    const bin = resolve_codex_bin()
    const args = thread === undefined
      ? ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
         '--color', 'never', '-C', this.workspace, task]
      : ['exec', 'resume', thread, '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
         '--color', 'never', task]
    const turn = (this.seq.get(user_id) ?? 0) + 1
    this.seq.set(user_id, turn)
    probe('codex', 'run.start', { user_id, turn, resume: thread !== undefined, workspace: this.workspace, task_len: task.length })
    // 刻意**不发"开始做了"**：用户要求只推最终总结，过程（含开始/命令/改文件）一律不推。

    const child = spawn(bin, args, {
      cwd: this.workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running: RunningTask = { child, turn, started_at: Date.now(), ...thread === undefined ? {} : { thread_id: thread } }
    this.tasks.set(user_id, running)

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', data => { stdout += String(data) })
    child.stderr?.on('data', data => { stderr += String(data) })
    const timer = setTimeout(() => {
      probe('codex', 'run.timeout', { user_id, turn })
      child.kill()
    }, RUN_TIMEOUT_MS)

    // 已推送过的 item id，避免重复；同时节流（Codex 事件可能很密）。
    const pushed = new Set<string>()
    let last_push_at = 0
    const interval = child.stdout
    void interval

    await new Promise<void>(resolve => {
      let buffer = ''
      const flush_lines = (): void => {
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const text = line.trim()
          if (!text.startsWith('{')) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(text) as Record<string, unknown>
          } catch {
            continue
          }
          this.consume_event(user_id, session_id, event, pushed, () => last_push_at, at => { last_push_at = at }, context_token)
        }
      }
      child.stdout?.on('data', flush_lines)
      child.on('close', code => {
        flush_lines()
        clearTimeout(timer)
        this.tasks.delete(user_id)
        const ok = code === 0
        probe('codex', 'run.close', { user_id, turn, code, pushed: pushed.size })
        if (!ok) {
          const detail = stderr.split('\n').filter(Boolean).slice(-6).join(' ')
          this.push(user_id, session_id, `（Codex 退出码 ${code}${detail ? '：' + detail : ''}）`, 'error', context_token)
        }
        resolve()
      })
    })
  }

  /** 解析单个 Codex JSON 事件并（必要时）推送给用户。 */
  private consume_event(
    user_id: string,
    session_id: string,
    event: Record<string, unknown>,
    pushed: Set<string>,
    _get_last: () => number,
    set_last: (at: number) => void,
    context_token?: string,
  ): void {
    const type = String(event.type ?? '')
    if (type === 'thread.started') {
      const thread_id = String(event.thread_id ?? '')
      if (thread_id) {
        this.store.set_meta('codex_thread:' + user_id, thread_id)
        const running = this.tasks.get(user_id)
        if (running !== undefined) running.thread_id = thread_id
      }
      return
    }
    if (type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined
      probe('codex', 'turn.completed', { user_id, usage })
      return
    }
    if (type === 'item.completed' || type === 'item.started' || type === 'item.updated') {
      const item = event.item as Record<string, unknown> | undefined
      if (item === undefined) return
      const item_id = String(item.id ?? '')
      const item_type = String(item.type ?? '')
      const key = `${type}:${item_id}:${item_type}`
      if (pushed.has(key)) return
      // **只推最终答复**（agent_message），不推中间过程。
      //
      // Codex 的 item 事件里，命令执行与文件修改都属于"过程"：一条任务可能产生几十条，
      // 既不是用户想看的结论，也是触发平台限流的典型突发形态。所以这里只保留
      // agent_message（Codex 给出的最终答复），过程一律不推。
      let text: string | undefined
      if (item_type === 'agent_message' && typeof item.text === 'string' && type === 'item.completed') {
        text = item.text
      }
      if (text === undefined || text.trim() === '') return
      pushed.add(key)
      set_last(Date.now())
      this.push(user_id, session_id, text.trim(), item_type === 'agent_message' ? 'assistant' : 'progress', context_token)
    }
  }
}

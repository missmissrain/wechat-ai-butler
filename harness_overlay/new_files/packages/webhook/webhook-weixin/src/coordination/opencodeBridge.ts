/**
 * opencode 远程桥：用微信遥控本机 opencode，并把它的输出主动推回微信。
 *
 * 与 codexBridge 同构（`/opencode` 指令），但驱动的是 opencode CLI。
 * 关键工程点（都是踩过来的坑）：
 * - 必须 `--attach <server>`：脱离 server 续会话会无限阻塞；服务器由启动器保证在跑。
 * - 必须关掉 stdin：opencode 会读管道 stdin，开着就永不返回。
 * - **必须有硬超时并杀掉**：opencode 的 provider 可能长时间 stream error 重试
 *   （实测 `opencode-go` 报 stream error 时 run 会卡住十几分钟），不能让它拖死微信链路。
 * - 可用 `DSH_OPENCODE_MODEL` 覆盖模型，绕开出故障的默认 provider。
 * @module dsh-webhook-weixin/opencode-bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'

/** 默认工作区（欣爱的专属工作区）。 */
/** opencode 远程任务的默认工作目录：环境变量优先，否则当前工作目录（不写死本机路径）。 */
const DEFAULT_WORKSPACE = process.env.DSH_OPENCODE_WORKSPACE?.trim() || process.cwd()

/** 单次任务硬超时（毫秒）；默认 10 分钟。 */
/**
 * 单次 opencode 任务的硬超时。
 *
 * 默认 30 分钟（与 codex 对齐）。原来给 10 分钟，实测"排查整条消息链路并修复"
 * 这类任务会连续两次超时被终止——超时后任务其实没完成，用户还得重来一遍，
 * 反而更浪费。宁可给足时间；真要中断用户可以发 `/opencode stop`。
 * 可用 DSH_OPENCODE_TIMEOUT_MS 调整。
 */
const RUN_TIMEOUT_MS = Number(process.env.DSH_OPENCODE_TIMEOUT_MS ?? String(30 * 60_000))

/** 推送时的最小间隔（毫秒），避免把一堆行刷成很多条微信。 */

/**
 * 终止进程树。
 *
 * Windows 上 opencode 会拉起子进程（server / 工具进程），只 kill 父进程会留孤儿，
 * 所以统一用 `taskkill /T /F`；非 Windows 回退到普通 kill。
 */
function kill_tree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGKILL')
}

/** 解析 opencode 可执行文件。 */
function resolve_bin(): string {
  const configured = process.env.OPENCODE_BIN
  if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim()
  // 兜底直接交给 PATH 解析（不写死本机安装路径）；需要时用 OPENCODE_BIN 指定
  const fallback = 'opencode'
  return existsSync(fallback) ? fallback : 'opencode'
}

/** 去掉 ANSI 控制序列。 */
function strip_ansi(text: string): string {
  // eslint-disable-next-line no-control-regex -- 这里就是要匹配 ESC 控制序列
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/**
 * 模型优先级链：opencode-go → 大黄蜂 → 火山。
 *
 * 降级规则（用户明确要求）：
 * - 前两级可以**自动**降级（都在允许范围内）；
 * - 到第三级（火山）**不能自动跳**，必须先向用户报告并征得同意；
 *   用户回复 `/opencode no` 就停下，什么都不做。
 */
const DEFAULT_MODEL_CHAIN = [
  'opencode-go/deepseek-v4.1-flash',
  'dahuangfen/gpt-5.6-sol',
  'volcengine/deepseek-v4-flash-ga-260731',
]

/** 连通性故障的特征（决定是否降级；任务本身的失败不降级）。 */
const CONNECTIVITY_FAILURE = /Cannot connect|ProviderHeaderTimeoutError|AI_APICallError|not supported by any configured account|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|connect timeout|socket hang up|socket connection unexpectedly closed|stream error|ProviderError/i

/** 用户同意切换到火山的有效期（毫秒）。 */
const APPROVAL_TTL_MS = Number(process.env.DSH_OPENCODE_APPROVAL_TTL_MS ?? String(30 * 60_000))

/** `/opencode` 指令。 */
export interface OpencodeCommand {
  readonly action: 'run' | 'stop' | 'status' | 'help' | 'new' | 'yes' | 'no'
  readonly text: string
}

/** 识别 `/opencode`（或 `/oc`）指令。 */
export function parse_opencode_command(text: string): OpencodeCommand | undefined {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  let rest: string | undefined
  if (lower.startsWith('/opencode')) rest = trimmed.slice(9).trim()
  else if (lower.startsWith('/oc ')) rest = trimmed.slice(3).trim()
  else if (lower === '/oc') rest = ''
  if (rest === undefined) return undefined
  if (rest === '') return { action: 'help', text: '' }
  const [head, ...tail] = rest.split(/\s+/)
  const keyword = (head ?? '').toLowerCase()
  const body = tail.join(' ').trim()
  if (keyword === 'stop' || keyword === '停止') return { action: 'stop', text: body }
  if (keyword === 'status' || keyword === '状态') return { action: 'status', text: body }
  if (keyword === 'new' || keyword === '新开') return { action: 'new', text: body }
  if (keyword === 'help' || keyword === '帮助') return { action: 'help', text: body }
  // 火山降级的确认/拒绝（见模型优先级链说明）。
  if (keyword === 'yes' || keyword === '同意' || keyword === 'ok') return { action: 'yes', text: body }
  if (keyword === 'no' || keyword === '不同意' || keyword === '不用' || keyword === '取消') return { action: 'no', text: body }
  return { action: 'run', text: rest }
}

/** 运行中的任务。 */
interface RunningTask {
  child: ChildProcess
  started_at: number
  model: string
}

/** 等待用户确认"是否切到火山"的挂起任务。 */
interface PendingTask {
  text: string
  context_token?: string
  asked_at: number
}

/** 微信遥控 opencode 的桥。 */
export class OpencodeBridge {
  private readonly tasks = new Map<string, RunningTask>()
  /** 等用户确认"切火山"的挂起任务。 */
  private readonly pending = new Map<string, PendingTask>()
  /** 用户已同意切火山；在 TTL 内有效。 */
  private readonly approvals = new Map<string, number>()
  private readonly chain: string[]

  /** 绑定状态库、推送回调、server 地址与工作区。 */
  constructor(
    private readonly store: WeixinStateStore,
    private readonly push: (user_id: string, session_id: string, text: string, kind: 'progress' | 'assistant' | 'error', context_token?: string) => void,
    private readonly server_url: string = process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096',
    private readonly workspace: string = process.env.DSH_OPENCODE_WORKSPACE ?? DEFAULT_WORKSPACE,
  ) {
    const configured = process.env.DSH_OPENCODE_MODEL_CHAIN
    this.chain = configured !== undefined && configured.trim() !== ''
      ? configured.split(',').map(item => item.trim()).filter(Boolean)
      : DEFAULT_MODEL_CHAIN
  }

  /** 当前是否在有效期内的"已同意切火山"。 */
  private has_volcengine_approval(user_id: string): boolean {
    const at = this.approvals.get(user_id)
    if (at === undefined) return false
    if (Date.now() - at > APPROVAL_TTL_MS) {
      this.approvals.delete(user_id)
      return false
    }
    return true
  }

  /** 处理一条 `/opencode` 指令。 */
  async handle(user_id: string, session_id: string, command: OpencodeCommand, context_token?: string): Promise<void> {
    if (command.action === 'help') {
      this.push(user_id, session_id, [
        '这里是 opencode 远程控制，用法：',
        '- /opencode <任务>     交给 opencode 执行',
        '- /opencode status     查看状态',
        '- /opencode stop       终止当前任务',
        '- /opencode yes|no     确认/拒绝"切到火山模型"',
        `默认工作区：${this.workspace}`,
        `模型优先级：${this.chain.join(' → ')}`,
      ].join('\n'), 'assistant', context_token)
      return
    }
    if (command.action === 'yes') {
      const waiting = this.pending.get(user_id)
      if (waiting === undefined) {
        this.push(user_id, session_id, '（当前没有待确认的切换请求）', 'error', context_token)
        return
      }
      this.pending.delete(user_id)
      this.approvals.set(user_id, Date.now())
      const volcanic = this.chain[2] ?? this.chain[this.chain.length - 1]!
      this.push(user_id, session_id, `（好，这次用火山模型 ${volcanic} 继续）`, 'progress', context_token)
      await this.run(user_id, session_id, waiting.text, context_token, volcanic)
      return
    }
    if (command.action === 'no') {
      const waiting = this.pending.get(user_id)
      if (waiting === undefined) {
        this.push(user_id, session_id, '（当前没有待确认的切换请求）', 'error', context_token)
        return
      }
      this.pending.delete(user_id)
      this.approvals.delete(user_id)
      this.push(user_id, session_id, '（好，那我停下了；opencode 和大黄蜂都不通，等你处理网络或用别的办法）', 'assistant', context_token)
      return
    }
    if (command.action === 'status') {
      const task = this.tasks.get(user_id)
      this.push(user_id, session_id, task === undefined
        ? '（当前没有正在运行的 opencode 任务）'
        : `（opencode 正在运行：已 ${Math.round((Date.now() - task.started_at) / 1000)} 秒）`,
        'assistant', context_token)
      return
    }
    if (command.action === 'stop') {
      const stopped = this.stop(user_id)
      this.push(user_id, session_id, stopped ? '（已终止当前的 opencode 任务）' : '（当前没有正在运行的 opencode 任务）', 'assistant', context_token)
      return
    }
    if (this.tasks.has(user_id)) {
      this.push(user_id, session_id, '（已经有一个 opencode 任务在跑，等它结束或先发 /opencode stop）', 'error', context_token)
      return
    }
    if (!command.text.trim()) {
      this.push(user_id, session_id, '（/opencode 后面要跟具体任务）', 'error', context_token)
      return
    }
    const task = command.text.trim()
    // 已同意过切火山（TTL 内）→ 直接用第三级。
    if (this.has_volcengine_approval(user_id) && this.chain.length >= 3) {
      await this.run(user_id, session_id, task, context_token, this.chain[2]!)
      return
    }
    // 否则按链自动尝试前两级；都因连通性失败才把第三级拿出来问用户。
    const outcome = await this.try_chain(user_id, session_id, task, context_token, this.chain.slice(0, 2))
    if (outcome === 'connectivity_failed') {
      const volcanic = this.chain[2]
      if (volcanic === undefined) {
        this.push(user_id, session_id, '（opencode 和大黄蜂都连不上，且没有配置第三级模型）', 'error', context_token)
        return
      }
      this.pending.set(user_id, {
        text: task,
        ...context_token === undefined ? {} : { context_token },
        asked_at: Date.now(),
      })
      this.push(user_id, session_id, [
        'opencode（首选）和大黄蜂（次选）都连不通。',
        `现在只剩火山可用：${volcanic}`,
        '要我切到火山继续做这个任务吗？',
        '回复 `/opencode yes` 同意，或 `/opencode no` 取消（我就停在这里，不会自己跳过去）。',
      ].join('\n'), 'assistant', context_token)
    }
  }

  /**
   * 依次用给定模型尝试任务。
   * @returns 'ok' 表示成功；'connectivity_failed' 表示全部因连通性失败；'failed' 表示任务本身失败。
   */
  private async try_chain(
    user_id: string,
    session_id: string,
    task: string,
    context_token: string | undefined,
    models: readonly string[],
  ): Promise<'ok' | 'connectivity_failed' | 'failed'> {
    for (const model of models) {
      const result = await this.run(user_id, session_id, task, context_token, model)
      if (result.ok) return 'ok'
      if (!result.connectivity) return 'failed'
      probe('opencode-bridge', 'chain.fallback', { user_id, failed_model: model })
    }
    return 'connectivity_failed'
  }

  /** 终止当前任务；返回是否真的终止。 */
  stop(user_id: string): boolean {
    const task = this.tasks.get(user_id)
    if (task === undefined) return false
    probe('opencode-bridge', 'stop', { user_id, pid: task.child.pid })
    kill_tree(task.child)
    this.tasks.delete(user_id)
    return true
  }

  /**
   * 执行一次任务：边跑边把有意义的输出行推给用户，结束后给结论。
   * @returns ok=成功；connectivity=连通性失败（调用方据此降级）；否则是任务本身失败。
   */
  private async run(
    user_id: string,
    session_id: string,
    task_text: string,
    context_token?: string,
    model_override?: string,
  ): Promise<{ ok: boolean; connectivity: boolean }> {
    const bin = resolve_bin()
    const model = model_override ?? process.env.DSH_OPENCODE_MODEL?.trim()
    const args = [
      'run', '--auto',
      '--attach', this.server_url,
      '--dir', this.workspace,
      ...model === undefined || model === '' ? [] : ['-m', model],
      task_text,
    ]
    probe('opencode-bridge', 'run.start', {
      user_id, workspace: this.workspace, model: model ?? '(default)', attach: this.server_url, task_len: task_text.length,
    })
    // 记录运行窗口：OpencodeWatcher 据此跳过"微信发起的任务"，避免同一任务被报两次。
    // 结束时把 end 补上（保留 start），窗口即为 [start, end]。
    const window_start = Date.now()
    this.store.set_meta('oc_bridge_window', JSON.stringify({ start: window_start, end: 0 }))
    this.push(user_id, session_id, `（好呀，我让 opencode 开始做了～${model === undefined ? '' : '模型 ' + model}）`, 'progress', context_token)

    const child = spawn(bin, args, { cwd: this.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.tasks.set(user_id, { child, started_at: Date.now(), model: model ?? '(default)' })
    const timer = setTimeout(() => {
      probe('opencode-bridge', 'run.timeout', { user_id, timeout_ms: RUN_TIMEOUT_MS })
      kill_tree(child)
    }, RUN_TIMEOUT_MS)

    let stderr = ''
    let buffer = ''
    // **不推中间过程**：只把输出尾部攒起来，结束时一次性推"最终总结"。
    // 原因：用户明确要求过程不推（只推结论），而且少发消息能显著减轻平台限流压力
    //（中间过程往往是几十条短消息，正是触发限流的形态）。
    const tail: string[] = []
    const pushed = 0
    const handle_lines = (raw: string): void => {
      buffer += raw
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const raw_line of lines) {
        const line = strip_ansi(raw_line).trim()
        if (line === '' || line.length < 2) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }
    child.stdout?.on('data', data => handle_lines(String(data)))
    child.stderr?.on('data', data => { stderr += String(data) })

    return await new Promise<{ ok: boolean; connectivity: boolean }>(resolve => {
      let settled = false
      const finish = (result: { ok: boolean; connectivity: boolean }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.tasks.delete(user_id)
        resolve(result)
      }
      child.on('close', code => {
        handle_lines(buffer)
        // 关闭运行窗口（保留 start）：窗口内的会话被认为由微信发起，监视器不再重复汇报。
        this.store.set_meta('oc_bridge_window', JSON.stringify({ start: window_start, end: Date.now() }))
        const detail = strip_ansi(stderr).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)
        const connectivity = CONNECTIVITY_FAILURE.test(detail)
        probe('opencode-bridge', 'run.close', { user_id, code, model, pushed_lines: pushed, connectivity })
        // 只推这一条：最终结果（输出尾部）。
        const summary = tail.slice(-15).join('\n').trim()
        if (code === 0) {
          this.push(user_id, session_id,
            summary === '' ? '（opencode 任务完成，没有输出内容）' : summary,
            'assistant', context_token)
          finish({ ok: true, connectivity: false })
          return
        }
        // 连通性故障先不打扰用户：由调用方决定自动降级还是来问用户。
        if (!connectivity) {
          this.push(user_id, session_id,
            `（opencode 退出码 ${code}${detail ? '：' + detail : ''}）`
              + (summary === '' ? '' : `\n最近输出：\n${summary}`),
            'error', context_token)
        }
        finish({ ok: false, connectivity })
      })
      child.on('error', error => {
        probe('opencode-bridge', 'run.error', { user_id, error: error.message })
        this.push(user_id, session_id, `（opencode 进程启动失败：${error.message}）`, 'error', context_token)
        finish({ ok: false, connectivity: false })
      })
    })
  }
}

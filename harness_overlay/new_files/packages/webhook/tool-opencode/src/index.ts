/**
 * opencode CLI 工具：把本机 opencode 命令行暴露给模型，支持查看会话、在指定会话继续运行、导出会话与用量统计。
 * 运行前要求模型明确给出工作区目录与会话 id；缺少时返回候选与询问文本，由模型转述给用户，不自行猜测。
 * @module @deepseek-ai/dsh-tool-opencode
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
export const name = 'tool-opencode'

/** 本插件只依赖工具注册表。 */
export const inject = ['tools']

/**
 * 单次 opencode 调用的超时（毫秒）。
 * 真实 agent 任务（建文件、起窗口、跑验证）实测超过 4 分钟，240s 会把活杀死在半路，
 * 因此放宽到 15 分钟；超时后不再重试，改为向用户汇报"任务太长"。
 */
const RUN_TIMEOUT_MS = 900_000

/** 回传给模型的最大字符数，避免长输出淹没上下文。 */
const MAX_OUTPUT_CHARS = 8_000

/** 支持的动作。 */
const ACTIONS = ['list_sessions', 'run', 'export', 'stats'] as const

/** 单个命令的执行结果。 */
interface CommandResult {
  ok: boolean
  text: string
}

/** 默认的 opencode 可执行文件（直接指向 exe，绕开 .cmd 垫片与 cmd 参数解析）；可用 OPENCODE_BIN 覆盖。 */
/**
 * opencode 可执行文件：环境变量优先，否则交给 PATH 解析。
 *
 * 不写死本机安装路径：换台机器/换包管理器都会变，写死了别人就跑不起来。
 * 需要时用 `OPENCODE_BIN` 指向自己的 opencode。
 */
const DEFAULT_OPENCODE_BIN = process.env.OPENCODE_BIN?.trim() || 'opencode'

/**
 * 展示给模型的默认工作区：环境变量优先，否则当前工作目录。
 * 运行期仍要求模型显式给绝对路径（历史教训：猜工作区容易落到错误目录）。
 */
const DEFAULT_WORKSPACE = process.env.DSH_OPENCODE_WORKSPACE?.trim() || process.cwd()

/** 常驻 opencode server 地址。续用已有会话必须经 server，否则 CLI 会无限阻塞（实测 >300s）；可用 OPENCODE_SERVER_URL 覆盖。 */
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096'

/** 解析 opencode 可执行文件：优先 OPENCODE_BIN，其次已知绝对路径，最后交给 PATH。 */
function resolve_bin(): string {
  const configured = process.env.OPENCODE_BIN
  if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim()
  if (existsSync(DEFAULT_OPENCODE_BIN)) return DEFAULT_OPENCODE_BIN
  return 'opencode'
}

/** 解析 opencode server 地址：优先 OPENCODE_SERVER_URL，其次默认本地 4096。 */
function resolve_server_url(): string {
  const configured = process.env.OPENCODE_SERVER_URL
  if (configured !== undefined && configured.trim()) return configured.trim()
  return DEFAULT_SERVER_URL
}

/**
 * 去掉 ANSI 控制序列与回车，得到干净的可读输出。
 * @param text - 原始进程输出。
 * @returns 剥掉转义码、统一换行后的文本。
 */
function strip_ansi(text: string): string {
  // eslint-disable-next-line no-control-regex -- 这里就是要匹配 ESC 控制序列
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/**
 * 以指定工作目录执行 opencode；返回脱敏后的文本结果。
 *
 * 必须用 spawn 而不是 execFile：opencode 会去读 stdin，
 * execFile 留下的 stdin 管道永不关闭，opencode 就会一直等输入、永不退出
 * （实测卡死 300 秒以上；把 stdin 关掉后同一条命令 9~15 秒返回）。
 */
function run_opencode(args: string[], cwd: string | undefined): Promise<CommandResult> {
  return new Promise((resolve) => {
    // .exe 直接执行（Node 会正确引用含空格的参数）；只有落到 .cmd 时才经 cmd.exe。
    const bin = resolve_bin()
    const command = bin.toLowerCase().endsWith('.exe') ? bin : 'cmd.exe'
    const command_args = command === 'cmd.exe' ? ['/c', bin, ...args] : args
    const child = spawn(command, command_args, {
      cwd,
      windowsHide: true,
      // stdin = ignore 是这里的关键：喂给 opencode 一个已关闭的 stdin。
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let timed_out = false
    const timer = setTimeout(() => {
      timed_out = true
      child.kill()
    }, RUN_TIMEOUT_MS)
    const collect = (data: Buffer): void => {
      bytes += data.length
      // 超过上限就停止累积，避免长输出撑爆内存。
      if (bytes <= 4 * 1024 * 1024) chunks.push(data)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, text: 'ERROR: ' + (error.message || 'opencode 启动失败') })
    })
    child.on('close', code => {
      clearTimeout(timer)
      // 剥掉 ANSI 转义序列：opencode 的彩色输出会塞满 \u001b[0m 之类的控制码，
      // 小模型（如 Gemma4 E4B）解析这些噪声后会误判"任务没完成"而反复重试。
      const combined = strip_ansi(Buffer.concat(chunks).toString('utf8')).trim()
      const text = combined.length > MAX_OUTPUT_CHARS
        ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n…（输出过长，已截断，共 ${combined.length} 字符）`
        : combined
      if (timed_out) {
        resolve({
          ok: false,
          text: (text ? text + '\n' : '')
            + `ERROR: opencode 超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已终止本次调用。`
            + '这说明任务本身很重。不要改参数重试、不要自己写脚本顶替，'
            + '直接把"这个任务耗时超过预期、需要更长等待"告诉用户。',
        })
        return
      }
      if (code !== 0) {
        resolve({ ok: false, text: (text ? text + '\n' : '') + `ERROR: opencode 退出码 ${code}。` })
        return
      }
      resolve({ ok: true, text: text || '(opencode 无输出)' })
    })
  })
}

/**
 * 会话 id 是否出现在 `session list` 的输出里。
 *
 * 要求**整段匹配**（前后是空白或行首行尾）：`…Ic` 是 `…IcL` 的前缀，如果只做
 * `includes` 判断，写错的短 id 会被当成"存在"，于是又去起长任务——那正是要避免的。
 *
 * @param list_text - `session list` 的原始输出。
 * @param session - 待核对的会话 id。
 */
function session_listed(list_text: string, session: string): boolean {
  const escaped = session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(list_text)
}

/** 缺少工作区/会话时的询问文本：列出候选，要求用户明确选择。 */
function ask_text(missing: string): string {
  return [
    `需要你先确认${missing}，我不能替你猜。`,
    '请告诉我要用哪个**工作区目录**和哪个**会话 id**；',
    '如果不知道有哪些，我可以先执行 action="list_sessions" 列出会话，或你直接告诉我项目目录我去看。',
  ].join('')
}

/** 需要拦截的 shell 工具名。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** 检测命令是否为"opencode 续会话但缺 --fork"的高危写法。 */
function lacks_fork(command: string): boolean {
  if (!/opencode/i.test(command)) return false
  if (/--fork/.test(command)) return false
  return /(^|\s)(-s|--session)(\s|=)/.test(command)
}

/** 注册 opencode 工具，并拦截会卡死的 shell 写法。 */
export function apply(ctx: Context): void {
  // 拦截：shell 里用 opencode 续会话但没加 --fork 会阻塞 120s。
  // 这里立即拒绝并给出正确写法，把"超时死循环"变成"快速明确失败 + 修复指引"。
  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (SHELL_TOOLS.has(exec.name)) {
      const args = exec.arguments as { command?: unknown } | undefined
      const command = typeof args?.command === 'string' ? args.command : ''
      if (lacks_fork(command)) {
        return Promise.resolve({
          kind: 'deny',
          reason: '不要用 shell 调 opencode（脱离 server 会无限阻塞）。请直接调用 opencode 工具'
            + '（action=run，session=<会话id>，prompt=<内容>）；'
            + '若必须用 shell，须带 --attach 与 --fork：'
            + 'opencode run --auto --attach ' + resolve_server_url() + ' --fork -s <会话id> "<内容>"。',
        })
      }
    }
    return next()
  })

  ctx.tools.register(defineTool({
    name: 'opencode',
    description: [
      '把任务交给本机的 opencode —— 一个独立的通用编程/自动化 agent（和你一样会自己读写文件、执行命令、查资料、写代码、跑测试、调试，直到把任务做完）。',
      '你不知道怎么做的复杂任务，可以整包交给它；它会在指定工作区里自主完成，并把过程与结果返回给你。',
      '',
      '能力举例：写/改代码、创建项目与脚本、批量改文件、运行并调试命令、安装依赖、跑测试、修构建错误、整理目录、抓取/处理数据等。',
      '',
      '动作：',
      '- run：执行任务。省略 session = 新开一个会话跑这个任务（推荐，除非用户点名要接着某个会话）；给了 session 就在该会话上 fork 继续。',
      '- list_sessions：列出已有会话（不确定用哪个会话时先列出来给用户挑，不要猜 id）。',
      '- export：导出某个会话内容。stats：查看用量。',
      '',
      '使用要求：',
      `1) 默认工作区：${DEFAULT_WORKSPACE}`,
      '   （部署时用 DSH_OPENCODE_WORKSPACE 指定；脚本/文档/数据都放这里）。',
      '   只有用户明确指定别的目录时，才改用他给的那个绝对路径；不要用 "." 或相对路径。',
      '2) prompt 要写成一个自包含的完整任务：目标、要求的产物、约束条件一次说清（它的模型看不到你和用户的对话）。',
      '3) 这个调用会真的执行，可能跑几十秒到十几分钟，请耐心等返回。',
      '4) 返回后先判断"成功还是失败"，然后给结论收尾；同一个任务不要反复调用，失败最多改一次就如实汇报。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '要执行的动作：run（交任务） | list_sessions（列会话） | export（导出会话） | stats（看用量）',
      },
      workspace: {
        type: 'string',
        description: `opencode 的工作区目录（绝对路径）。默认：${DEFAULT_WORKSPACE}`,
      },
      session: {
        type: 'string',
        description: '会话 id。run 时省略 = 新建会话（推荐）；给了就在该会话上 fork 继续（export 必填）',
      },
      prompt: {
        type: 'string',
        description: 'run 时发给 opencode 的完整任务描述：目标、要产出什么、有什么约束。要自包含，它看不到你和用户的对话。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    async execute(args): Promise<{ ok: boolean, text: string }> {
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (!ACTIONS.includes(action as typeof ACTIONS[number])) {
        return { ok: false, text: `未知动作 "${action}"；可用：${ACTIONS.join(' | ')}` }
      }
      const workspace = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined
      const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : undefined
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''

      if (action === 'list_sessions') {
        return run_opencode(['session', 'list'], workspace)
      }
      if (action === 'stats') {
        return run_opencode(['stats'], workspace)
      }
      if (action === 'export') {
        if (session === undefined) return { ok: false, text: ask_text('会话 id') }
        return run_opencode(['export', session], workspace)
      }
      // action === 'run'
      // 只要工作区；session 可省略——省略时 opencode 会新建一个会话（用户说"重新开一个会话"就走这条路）。
      if (workspace === undefined) return { ok: false, text: ask_text('工作区目录') }
      if (!prompt.trim()) return { ok: false, text: 'run 需要一个非空的 prompt（要发给 opencode 的内容）。' }

      // **先核对会话真的存在，再起长任务**。
      //
      // 实测教训：模型会凭记忆写会话 id（把 `…Ic` 写成 `…IcL`），而 `opencode run` 一旦跑起来
      // 就是个真子进程，可能卡十几分钟才失败——那一轮对话就彻底僵在那里（用户只看到"还在处理中"）。
      // 这里先用 `session list` 快速核对（几秒），不存在就直接把候选会话摆出来。
      if (session !== undefined) {
        const listed = await run_opencode(['session', 'list'], workspace)
        if (listed.ok && !session_listed(listed.text, session)) {
          return {
            ok: false,
            text: `会话 "${session}" 在这个工作区里不存在（opencode 的会话**按工作区隔离**，`
              + '换个 --dir 就找不到同一个会话）。\n\n'
              + '该工作区已有的会话（id 请**整串照抄**，不要凭记忆写、不要加字符）：\n'
              + listed.text.slice(0, MAX_OUTPUT_CHARS)
              + '\n要接着某个会话就照抄它的 id；要新开一个就省略 session 参数。',
          }
        }
      }
      // 必须经常驻 server（--attach）执行：脱离 server 时续用已有会话会无限阻塞（实测 >300s）；
      // 经 server 时 fork 续会话约 15s 返回。--fork 避免污染原会话。
      const attach = ['--attach', resolve_server_url()]
      const dir_args = workspace === undefined ? [] : ['--dir', workspace]
      const run_args = session === undefined
        ? ['run', '--auto', ...attach, ...dir_args, prompt]
        : ['run', '--auto', ...attach, ...dir_args, '--fork', '-s', session, prompt]
      return run_opencode(run_args, workspace)
    },
  }))
}

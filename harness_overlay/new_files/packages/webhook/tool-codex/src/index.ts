/**
 * Codex CLI 工具：把本机 Codex（OpenAI 的编码 agent CLI）暴露给模型。
 *
 * 与 tool-opencode 同构：run 执行任务、resume 续会话、list_sessions 列会话。
 * 设计要点（都是踩过的坑）：
 * - 必须用 spawn + `stdio: ['ignore','pipe','pipe']`：Codex 会读 stdin，
 *   管道一直开着就会一直等输入（表现为"卡死"）。
 * - 必须剥掉 ANSI 转义：彩色输出会让小模型误判任务未完成。
 * - workspace 用绝对路径：相对路径会让它落到进程工作目录。
 * - 超时给足：真实任务可能跑几分钟。
 * @module @deepseek-ai/dsh-tool-codex
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
export const name = 'tool-codex'

/** 本插件只依赖工具注册表。 */
export const inject = ['tools']

/** 单次 Codex 调用的超时（毫秒）。 */
const RUN_TIMEOUT_MS = 900_000

/** 回传给模型的最大字符数。 */
const MAX_OUTPUT_CHARS = 8_000

/** 支持的动作。 */
const ACTIONS = ['list_sessions', 'run', 'resume'] as const

/**
 * 默认工作区：环境变量优先，否则用**当前工作目录**。
 *
 * 刻意不写死某个本机绝对路径——那会把个人目录结构带进仓库，换台机器就失效。
 * 部署时设 `DSH_CODEX_WORKSPACE` 指向自己的助手工作区即可。
 */
const DEFAULT_WORKSPACE = process.env.DSH_CODEX_WORKSPACE?.trim() || process.cwd()

/** 默认的 Codex 可执行文件；可用 CODEX_BIN 覆盖。 */
const DEFAULT_CODEX_BIN = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe')

/** 解析 Codex 可执行文件。 */
function resolve_bin(): string {
  const configured = process.env.CODEX_BIN
  if (configured !== undefined && configured.trim() && existsSync(configured.trim())) return configured.trim()
  if (existsSync(DEFAULT_CODEX_BIN)) return DEFAULT_CODEX_BIN
  return 'codex'
}

/** 去掉 ANSI 控制序列与回车。 */
function strip_ansi(text: string): string {
  // eslint-disable-next-line no-control-regex -- 这里就是要匹配 ESC 控制序列
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/** 单个命令的执行结果。 */
interface CommandResult {
  ok: boolean
  text: string
}

/** 以指定工作目录执行 Codex。 */
function run_codex(args: string[], cwd: string | undefined): Promise<CommandResult> {
  return new Promise((resolve) => {
    const bin = resolve_bin()
    const command = bin.toLowerCase().endsWith('.exe') ? bin : 'cmd.exe'
    const command_args = command === 'cmd.exe' ? ['/c', bin, ...args] : args
    const child = spawn(command, command_args, {
      cwd,
      windowsHide: true,
      // stdin 必须关掉：Codex 会读取管道 stdin，一直开着就永不返回。
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
      if (bytes <= 4 * 1024 * 1024) chunks.push(data)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, text: 'ERROR: ' + (error.message || 'codex 启动失败') })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const combined = strip_ansi(Buffer.concat(chunks).toString('utf8')).trim()
      const text = combined.length > MAX_OUTPUT_CHARS
        ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n…（输出过长，已截断，共 ${combined.length} 字符）`
        : combined
      if (timed_out) {
        resolve({
          ok: false,
          text: (text ? text + '\n' : '')
            + `ERROR: Codex 超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已终止。`
            + '任务本身很重；不要原样重试，把"耗时超预期"如实告诉用户。',
        })
        return
      }
      if (code !== 0) {
        resolve({ ok: false, text: (text ? text + '\n' : '') + `ERROR: Codex 退出码 ${code}。` })
        return
      }
      resolve({ ok: true, text: text || '(codex 无输出)' })
    })
  })
}

/** 列出最近的 Codex 会话（读 ~/.codex/sessions 的 rollout 文件）。 */
function list_sessions(limit = 10): CommandResult {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  if (!existsSync(root)) return { ok: true, text: '(没有找到 Codex 会话目录)' }
  const files: Array<{ path: string; mtime: number; size: number }> = []
  const walk = (dir: string, depth = 0): void => {
    if (depth > 5) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const stat = statSync(full)
        files.push({ path: full, mtime: stat.mtimeMs, size: stat.size })
      }
    }
  }
  try {
    walk(root)
  } catch (error) {
    return { ok: false, text: 'ERROR: 读取会话目录失败：' + String(error) }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const lines = files.slice(0, limit).map(item => {
    // 文件名形如 rollout-<时间>-<session uuid>.jsonl（可能带第二段 uuid）
    const base = item.path.split(/[\\/]/).pop() ?? ''
    const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    const when = new Date(item.mtime).toLocaleString('zh-CN')
    return `- ${match?.[1] ?? base}   ${when}   ${Math.round(item.size / 1024)}KB`
  })
  return { ok: true, text: lines.length > 0 ? lines.join('\n') : '(没有会话记录)' }
}

/** 注册 Codex 工具。 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'codex',
    description: [
      '把任务交给本机的 Codex —— 一个独立的通用编程/自动化 agent（OpenAI 官方 CLI，稳定可靠）。',
      '它会自己读写文件、执行命令、查资料、写代码、跑测试、调试，直到把任务做完，并把过程与结果返回给你。',
      '不知道怎么做、或需要多步动手的复杂任务，可以整包交给它。',
      '',
      '能力举例：写/改代码、创建项目与脚本、批量改文件、运行并调试命令、安装依赖、跑测试、修构建错误、整理目录、数据分析等。',
      '',
      '动作：',
      '- run：执行任务。用新的 Codex 会话跑这个任务（推荐）。',
      '- resume：在已有会话上继续（session 给会话 id，或填 "last" 表示最近一个）。',
      '- list_sessions：列出最近的 Codex 会话（需要接着某个会话时先看这个，不要猜 id）。',
      '',
      '使用要求：',
      `1) 默认工作区：${DEFAULT_WORKSPACE}`,
      '   （部署时用 DSH_CODEX_WORKSPACE 指定；脚本/文档/数据都放这里）。只有用户明确指定别的目录时才改用他给的绝对路径。',
      '2) prompt 必须是自包含的完整任务：目标、要产出什么、约束条件一次说清（它看不到你和用户的对话）。',
      '3) 这个调用会真的执行，可能跑几十秒到十几分钟，请耐心等返回。',
      '4) 返回后先判断"成功还是失败"，然后给结论收尾；同一个任务不要反复调用，失败最多改一次就如实汇报。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '要执行的动作：run（交任务） | resume（续会话） | list_sessions（列会话）',
      },
      workspace: {
        type: 'string',
        description: 'Codex 的工作目录（绝对路径）。默认：' + DEFAULT_WORKSPACE,
      },
      session: {
        type: 'string',
        description: 'resume 时的会话 id；也可以填 "last" 表示最近一个会话',
      },
      prompt: {
        type: 'string',
        description: 'run/resume 时发给 Codex 的完整任务描述：目标、要产出什么、有什么约束。要自包含。',
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
      const workspace = typeof args.workspace === 'string' && args.workspace.trim()
        ? args.workspace.trim()
        : DEFAULT_WORKSPACE
      const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : undefined
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''

      if (action === 'list_sessions') return list_sessions()

      // 公共标志：跳过 git 仓库检查（工作区通常不是 repo）+ 全自动免审批 + 关闭彩色输出。
      const common = ['--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never']
      if (!prompt.trim()) return { ok: false, text: `${action} 需要一个非空的 prompt（任务内容）。` }

      if (action === 'resume') {
        if (session === undefined) {
          return { ok: false, text: 'resume 需要 session（会话 id，或填 "last" 表示最近一个会话）；可先用 action=list_sessions 查看。' }
        }
        const target = session === 'last' ? ['--last'] : [session]
        // 注意：`exec resume` 没有 -C，靠 spawn 的 cwd 决定工作目录。
        return run_codex(['exec', 'resume', ...target, ...common, prompt], workspace)
      }

      return run_codex(['exec', '-C', workspace, ...common, prompt], workspace)
    },
  }))
}

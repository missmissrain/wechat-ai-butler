/**
 * 中断外部 agent 的**在跑进程**（opencode / codex）。
 *
 * ## 为什么需要
 *
 * 实测踩过：用户说"停止任务"，我们只 `agent.cancel()` 取消了模型那一轮，
 * 但模型之前用 `opencode` 工具起的 `opencode run --auto` 子进程**继续跑了 22 分钟**——
 * 工具调用因此一直不返回，那一轮永远收不了尾，用户只看到每 5 分钟一条"还在处理中"。
 *
 * 所以取消必须**连外部进程一起杀**：模型的 turn 是它的一部分，外部进程是另一部分。
 *
 * ## 为什么按进程名+命令行匹配，而不是记子进程句柄
 *
 * 子进程有两种来源：我们的桥（`/opencode` 聊天命令）和 harness 的 `opencode`/`codex`
 * 工具包（模型自己调的）。后者不归我们管、也没把句柄交给我们，所以只能按
 * "可执行文件名 + 命令行特征"去找。匹配规则刻意保守：
 * - 必须有 `run` 子命令（`opencode run …` / `codex exec …`）；
 * - **排除 `serve`**（那是常驻的 opencode server，杀了会把链路弄断）。
 *
 * @module dsh-webhook-weixin/external-runs
 */

import { execFileSync } from 'node:child_process'
import { probe } from '../diagnostics/probe.ts'

/** 一次中断的结果。 */
export interface KillExternalRunsResult {
  /** 被杀掉的进程数。 */
  readonly killed: number
  /** 被杀掉的进程 id（便于日志与回执）。 */
  readonly pids: readonly number[]
  /** 出错时的原因（不抛错——取消失败不该让控制命令本身失败）。 */
  readonly error?: string
}

/** 命令行特征：opencode/codex 的"跑一次任务"，排除常驻 server。 */
const RUN_PATTERN = '(opencode|codex).*(run|exec)\\b'

/**
 * 中断所有正在跑的外部 agent 任务。
 *
 * @returns 杀掉的进程数与 pid；任何失败都只记在 `error` 里，不抛。
 */
export function kill_external_runs(): KillExternalRunsResult {
  if (process.platform !== 'win32') {
    // 其它平台本项目不部署；返回 0 而不是假装成功。
    return { killed: 0, pids: [], error: '非 Windows 平台未实现外部进程中断' }
  }
  try {
    const list = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${RUN_PATTERN}' -and `
      + "$_.Name -notmatch 'powershell|pwsh' } | "
      + 'ForEach-Object { $_.ProcessId }',
    ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })

    const pids = list.split('\n').map(line => Number(line.trim())).filter(value => Number.isInteger(value) && value > 0)
    if (pids.length === 0) {
      probe('external-runs', 'kill.none', {})
      return { killed: 0, pids: [] }
    }
    for (const pid of pids) {
      try {
        // /T 连子进程一起杀：opencode 会自己再拉起工具进程，只杀父进程会留孤儿。
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 20_000 })
      } catch {
        // 进程可能已经自己退了：忽略
      }
    }
    probe('external-runs', 'kill.done', { pids })
    return { killed: pids.length, pids }
  } catch (error) {
    probe('external-runs', 'kill.failed', { error: String(error).slice(0, 160) })
    return { killed: 0, pids: [], error: String(error).slice(0, 160) }
  }
}

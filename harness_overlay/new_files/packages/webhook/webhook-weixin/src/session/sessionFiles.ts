/**
 * 会话历史的落盘位置，以及"清空上下文"时的**尽力回收**。
 *
 * ## 为什么要自己推导路径
 *
 * harness 的 `sessionPersistence` 能力只有 `create/open/flush/stat/list`——
 * **没有 delete/clear**（见 `packages/session/session-persistence/src/index.ts:135`）。
 * 所以"清空某个用户的对话上下文"只能由两件事配合完成：
 *
 * 1. **换会话 id（epoch）** ← 真正保证上下文干净的一步（见 `weixinStateStore.context_epoch`）；
 * 2. **顺手删掉旧会话目录** ← 回收磁盘，纯尽力而为。
 *
 * 第 2 步的路径规则照抄 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `format.ts`
 * （`encodeSegment` / `projectKey` / `sessionDir`）。因为只是"尽力回收"，
 * 推导不出、文件不存在、名字对不上时**一律跳过**——绝不能因为路径算错就删到别的会话。
 *
 * ## 顺序要求（实测踩过的坑）
 *
 * 必须**先 `dispose` 掉 agent**（关掉会话日志的写句柄）再删文件。否则残留句柄会在
 * 下一次 append 时用 `open(path,'a')` 新建一个**只有事件、没有 header** 的文件，
 * 那个会话下次恢复直接报 corrupt。
 *
 * @module dsh-webhook-weixin/session-files
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 会话格式代次对应的文件名前缀（写死成 v3 之外还要兼容将来）。 */
const LOG_FILE_PATTERN = /^session\.v\d+\.jsonl(\..+)?$/

/**
 * 把一个任意字符串编码成**单个安全路径段**（与 harness 的 `encodeSegment` 等价）。
 *
 * 安全字符 `[A-Za-z0-9._-]` 原样保留，其余（含 `~`）编码成 `~XXXX`（大写十六进制）。
 * 微信 user_id 里的 `@` 就是这样变成 `~0040` 的。
 */
export function encode_segment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** 工程目录名（与 harness 的 `projectKey` 等价）：分隔符压成 `-`，外裹 `--…--`。 */
export function project_key(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separator_run = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separator_run) readable += '-'
      separator_run = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separator_run = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separator_run = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 会话根目录（`DSH_HOME/sessions`，默认 `~/.dsh/sessions`）。 */
export function sessions_root(dsh_home?: string): string {
  const home = dsh_home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 某个会话独占的目录：`<root>/<projectKey(cwd)>/<encodeSegment(id)>`。 */
export function session_dir_path(root: string, cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? '_no-cwd' : project_key(cwd)
  return join(root, project, encode_segment(id))
}

/** 清目录内容的结果（目录本身保留，供存储层继续用）。 */
export interface ClearDirectoryResult {
  readonly files: number
  readonly bytes: number
  readonly dir: string
}

/**
 * 清空一个目录的**内容**（保留目录本身）。
 *
 * 用于"清空时间记忆库 / 知识图谱"：目录是存储层的工作目录，删掉再建反而多一次竞态，
 * 所以只清内容。全部是尽力而为——单个文件删不掉就跳过并计数，不抛错。
 */
export function clear_directory_contents(dir: string): ClearDirectoryResult {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return { files: 0, bytes: 0, dir }
  }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isFile()) {
        bytes += stat.size
        files += 1
      } else {
        bytes += directory_bytes(path)
        files += 1
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* 被占用/并发删除：跳过这一项 */ }
  }
  return { files, bytes, dir }
}

/** 递归求目录体积（只为汇报，best effort）。 */
export function directory_bytes(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0                                   // 目录不存在/读不了：按 0 算，别让统计把页面搞崩
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      total += stat.isDirectory() ? directory_bytes(path) : stat.size
    } catch { /* 忽略 */ }
  }
  return total
}

/** 一个会话落盘日志的体量。 */
export interface SessionLogStats {
  readonly bytes: number
  readonly modified_at: number
  readonly files: number
}

/**
 * 读某个会话目录里日志文件的体量（不存在返回 undefined）。
 *
 * 用"目录 + 文件名模式"而不是写死 `session.v3.jsonl.zstd`：格式代次或压缩方式
 * 变了这里也能跟上（`v4`、`.jsonl.gz` 都认）。
 */
export function session_log_stats(dir: string): SessionLogStats | undefined {
  if (!existsSync(dir)) return undefined
  let bytes = 0
  let modified_at = 0
  let files = 0
  for (const name of readdirSync(dir)) {
    if (!LOG_FILE_PATTERN.test(name)) continue
    try {
      const stat = statSync(join(dir, name))
      bytes += stat.size
      modified_at = Math.max(modified_at, stat.mtimeMs)
      files += 1
    } catch { /* 并发删除：忽略 */ }
  }
  return files === 0 ? undefined : { bytes, modified_at, files }
}

/** 删除结果（用于汇报，删不掉不算失败）。 */
export interface DeleteSessionResult {
  readonly deleted: boolean
  readonly dir: string
  readonly reason?: string
}

/**
 * 尽力删除一个会话的落盘目录。
 *
 * 三重防误删：目录必须存在、必须是"会话目录"（含 `session.vN.jsonl*` 文件）、
 * 且路径由 `root + cwd + id` 完整推导而来（不接外部传入的路径）。
 * 任何一步不符就跳过并说明原因。
 */
export function delete_session_artifacts(input: {
  root: string
  cwd: string | undefined
  id: string
}): DeleteSessionResult {
  let dir = ''
  try {
    dir = session_dir_path(input.root, input.cwd, input.id)
  } catch (error) {
    return { deleted: false, dir: '', reason: `路径推导失败：${String(error)}` }
  }
  if (!existsSync(dir)) return { deleted: false, dir, reason: '目录不存在（可能还没落盘）' }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    return { deleted: false, dir, reason: `读目录失败：${String(error)}` }
  }
  if (!entries.some(name => LOG_FILE_PATTERN.test(name))) {
    return { deleted: false, dir, reason: '目录里没有会话日志文件，不像会话目录，已跳过' }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return { deleted: true, dir }
  } catch (error) {
    return { deleted: false, dir, reason: `删除失败：${String(error)}` }
  }
}

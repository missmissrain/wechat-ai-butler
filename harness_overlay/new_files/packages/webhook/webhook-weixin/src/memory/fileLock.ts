/**
 * 跨进程文件锁（时间线 / 知识图谱的写保护）。
 *
 * 为什么需要它：这两个存储都是"读完整文件 → 改 → 整体替换"的写法。
 * 两个进程同时写同一天时，后写的会覆盖先写的（实测 40 条只留下 20 条），
 * 而且 Windows 上并发 rename 还会直接报 `EPERM`。
 *
 * 实现：用 `openSync(path, 'wx')`（CREATE_NEW，**原子**）抢占一个 `.lock` 文件。
 * - 抢不到就小睡重试，直到超时；
 * - 持锁进程崩了会留下锁文件，所以带**陈旧锁接管**：看 mtime 是否超时，并检查 pid 是否还活着；
 * - 释放时先 close 再 unlink（Windows 上持有句柄时删不掉）。
 *
 * 只保护**同机多进程**；跨机器共享目录不在范围内（我们也不做）。
 *
 * @module dsh-webhook-weixin/file-lock
 */

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { probe } from '../diagnostics/probe.ts'

/** 加锁选项。 */
export interface FileLockOptions {
  /** 最多等多久（毫秒），默认 10 秒。 */
  readonly timeout_ms?: number
  /** 多久没动静就认为锁是陈旧的（毫秒），默认 30 秒。 */
  readonly stale_ms?: number
  /** 重试间隔（毫秒），默认 20。 */
  readonly retry_ms?: number
}

/** 锁文件里记的内容（便于诊断是谁持着锁）。 */
interface LockInfo {
  pid: number
  at: number
}

/** 进程是否还活着（同机）。 */
function pid_alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限（仍然算活着）；ESRCH = 不存在
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** 同步小睡（这些存储都是同步 API，锁也必须同步等）。 */
function sleep_ms(ms: number): void {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/**
 * 在锁保护下执行一段同步逻辑。
 *
 * @param target_path - 被保护的文件路径（锁文件是它 + `.lock`）。
 * @param fn - 临界区逻辑。
 * @param options - 超时与陈旧判定。
 * @returns `fn` 的返回值。
 * @throws 等不到锁时抛错——**宁可失败也不能覆盖别人的合法数据**。
 */
export function with_file_lock<T>(target_path: string, fn: () => T, options?: FileLockOptions): T {
  const timeout_ms = options?.timeout_ms ?? 10_000
  const stale_ms = options?.stale_ms ?? 30_000
  const retry_ms = options?.retry_ms ?? 20
  const lock_path = `${target_path}.lock`
  const deadline = Date.now() + timeout_ms
  let handle: number | undefined

  while (handle === undefined) {
    try {
      handle = openSync(lock_path, 'wx')
      writeSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo))
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      // 已被占用：判断是不是陈旧锁（持锁进程已死，或太久没更新）
      let stale = false
      try {
        const info = JSON.parse(readFileSync(lock_path, 'utf8')) as LockInfo
        const age = Date.now() - (info.at ?? 0)
        stale = age > stale_ms || !pid_alive(info.pid)
      } catch {
        // 锁文件读不出（可能正在被创建/删除）→ 按 mtime 判断
        try {
          stale = Date.now() - statSync(lock_path).mtimeMs > stale_ms
        } catch {
          stale = true // 文件已经没了，直接重试
        }
      }
      if (stale) {
        probe('lock', 'stale_taken_over', { lock_path })
        try {
          unlinkSync(lock_path)
        } catch { /* 别人抢先删了也无所谓 */ }
        continue
      }
      if (Date.now() > deadline) {
        probe('lock', 'timeout', { lock_path, timeout_ms })
        throw new Error(`等锁超时（${timeout_ms}ms）：${lock_path}。为避免覆盖其它进程的合法写入，本次写入放弃。`)
      }
      sleep_ms(retry_ms)
    }
  }

  try {
    return fn()
  } finally {
    try {
      closeSync(handle)
    } catch { /* 已关闭 */ }
    try {
      unlinkSync(lock_path)
    } catch { /* 已被接管 */ }
  }
}

/** 带重试的原子替换：Windows 上并发 rename 偶发 EPERM，重试几次即可。 */
export function rename_with_retry(from: string, to: string, attempts = 5): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (attempt >= attempts - 1 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      sleep_ms(15 * (attempt + 1))
    }
  }
}

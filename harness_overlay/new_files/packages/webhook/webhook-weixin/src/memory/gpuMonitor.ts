/**
 * 显存监视：Gemma 行动前先确认显卡是空闲的。
 *
 * 为什么需要：本地 Gemma（Q4_K_M + 视觉投影器 + 32k 上下文）醒来后要占约 5.3GB，
 * 而这张卡只有 8GB。如果用户正好在跑游戏/训练/另一个模型，硬启动会把两边都拖垮
 * （甚至 OOM）。后台任务**不急**（摘要在空闲时才跑），所以正确做法是
 * **等显存空出来再启动**，而不是抢。
 *
 * 判定用 `nvidia-smi`；查不到就直接放行（不能因为探测失败就永远不跑模型）。
 *
 * @module dsh-webhook-weixin/gpu-monitor
 */

import { execFileSync } from 'node:child_process'
import { probe } from '../diagnostics/probe.ts'

/** 显存快照。 */
export interface GpuMemory {
  readonly used_mb: number
  readonly total_mb: number
  readonly free_mb: number
}

/**
 * 读一次显存占用。
 *
 * @returns 快照；没有 nvidia-smi 或查询失败时返回 undefined（调用方应据此放行）。
 */
export function gpu_memory(): GpuMemory | undefined {
  try {
    const output = execFileSync('nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    const first = output.trim().split('\n')[0] ?? ''
    const parts = first.split(',').map(item => Number(item.trim()))
    const used = parts[0]
    const total = parts[1]
    if (used === undefined || total === undefined) return undefined
    if (!Number.isFinite(used) || !Number.isFinite(total)) return undefined
    return { used_mb: used, total_mb: total, free_mb: total - used }
  } catch {
    return undefined
  }
}

/** 等待显存空闲的选项。 */
export interface WaitForVramOptions {
  /** 至少要有这么多空闲显存才认为"可以启动"（MB）。 */
  readonly min_free_mb?: number
  /** 最多等多久（毫秒），默认 10 分钟。 */
  readonly timeout_ms?: number
  /** 轮询间隔（毫秒），默认 30 秒。 */
  readonly poll_ms?: number
  /** 探针用标签。 */
  readonly label?: string
}

/**
 * 等到显存足够空闲；超时返回 false（调用方应放弃本轮，而不是硬上）。
 *
 * 探测不到显存信息时返回 true（放行）。
 */
export async function wait_for_free_vram(options?: WaitForVramOptions): Promise<boolean> {
  const min_free_mb = options?.min_free_mb ?? 5_200
  const timeout_ms = options?.timeout_ms ?? 600_000
  const poll_ms = options?.poll_ms ?? 30_000
  const label = options?.label ?? 'gemma'

  if (min_free_mb <= 0) return true
  const deadline = Date.now() + timeout_ms
  let waited = false

  for (;;) {
    const memory = gpu_memory()
    if (memory === undefined) {
      // 没有可用的显存信息（非 N 卡/无驱动）：不能因此永远不跑模型，直接放行。
      if (waited) probe('gpu', 'vram.wait_skipped', { label, reason: 'no_nvidia_smi' })
      return true
    }
    if (memory.free_mb >= min_free_mb) {
      if (waited) probe('gpu', 'vram.free_now', { label, free_mb: memory.free_mb })
      return true
    }
    if (Date.now() >= deadline) {
      probe('gpu', 'vram.wait_timeout', {
        label, free_mb: memory.free_mb, need_mb: min_free_mb, timeout_ms,
      })
      return false
    }
    if (!waited) {
      waited = true
      probe('gpu', 'vram.busy_wait', {
        label, free_mb: memory.free_mb, need_mb: min_free_mb, total_mb: memory.total_mb,
      })
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(poll_ms, Math.max(0, deadline - Date.now()))))
  }
}

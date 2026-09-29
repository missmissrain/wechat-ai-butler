/**
 * 本地 Gemma 的**全局并发闸门**。
 *
 * 为什么需要：时间线摘要、图谱抽取、图片描述是三条独立的后台链路，
 * 各自维护 busy 标志——它们可以**同时**唤醒模型（审计实测并发峰值 2）。
 * 本地 llama-server 只有一份 8GB 显存：并发调用会争显存、触发重复冷启动、
 * 让本可以串行完成的活互相拖慢。
 *
 * 所以把"调用模型"这件事收敛到一个有界闸门里：默认**并发 1**，
 * 排队超过上限就直接拒绝（后台任务宁可这一轮跳过，也不要无限堆积把内存吃满）。
 *
 * @module dsh-webhook-weixin/gemma-gate
 */

import { probe } from '../diagnostics/probe.ts'
import { wait_for_free_vram } from './gpuMonitor.ts'

/** 闸门选项。 */
export interface GemmaGateOptions {
  /** 同时允许多少个模型调用，默认 1。 */
  readonly concurrency?: number
  /** 最多排队多少个，默认 20；超过直接拒绝。 */
  readonly max_queue?: number
  /** 单次等待超时（毫秒），默认 10 分钟；超时抛错，避免永久挂住。 */
  readonly wait_timeout_ms?: number
  /**
   * 启动前至少要有这么多空闲显存（MB），默认 5200；设为 0 关闭检查。
   *
   * 本地 Gemma 醒来后要占约 5.3GB（Q4 模型 + 视觉投影器 + 32k 上下文），
   * 卡只有 8GB。用户如果在跑游戏/训练，硬启动会把两边一起拖垮——所以先等它空出来。
   */
  readonly min_free_vram_mb?: number
  /** 等显存最多等多久（毫秒），默认 10 分钟，超时就放弃本轮。 */
  readonly vram_wait_ms?: number
  /** 显存轮询间隔（毫秒），默认 30 秒。 */
  readonly vram_poll_ms?: number
  /**
   * 可选的"确保模型服务在跑"钩子：显存空出来之后、真正调用之前执行。
   *
   * 用途：启动器因为当时显存忙而没拉起 llama-server 时，这里可以补拉。
   */
  readonly ensure_ready?: () => Promise<void>
}

/** 闸门句柄。 */
export interface GemmaGate {
  /** 在闸门里执行一次模型调用。 */
  run<T>(label: string, fn: () => Promise<T>): Promise<T>
  /** 当前状态（诊断用）。 */
  stats(): { active: number, queued: number }
}

/**
 * 创建闸门。
 *
 * @param options - 并发与排队上限。
 */
export function create_gemma_gate(options?: GemmaGateOptions): GemmaGate {
  const concurrency = Math.max(1, options?.concurrency ?? 1)
  const max_queue = Math.max(0, options?.max_queue ?? 20)
  const wait_timeout_ms = options?.wait_timeout_ms ?? 600_000
  let active = 0
  const queue: Array<() => void> = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next !== undefined) next()
  }

  return {
    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      // 先等显存空出来（**在拿并发槽之前**等：等显存不该占着槽位）。
      // 超时说明显卡一直被别的东西占着，本轮就放弃——后台任务晚一轮做没有损失，
      // 硬启动却可能把用户正在跑的东西一起拖垮。
      const vram_ok = await wait_for_free_vram({
        min_free_mb: options?.min_free_vram_mb ?? 5_200,
        timeout_ms: options?.vram_wait_ms ?? 600_000,
        poll_ms: options?.vram_poll_ms ?? 30_000,
        label,
      })
      if (!vram_ok) {
        throw new Error(`显存一直被占用，暂缓「${label}」（等不到至少 ${options?.min_free_vram_mb ?? 5_200}MB 空闲）。稍后会自动重试。`)
      }
      // 显存够了再确保服务在跑（启动器当时可能因为显存忙而没拉起）
      if (options?.ensure_ready !== undefined) await options.ensure_ready()

      if (active >= concurrency) {
        if (queue.length >= max_queue) {
          probe('gemma', 'gate.rejected', { label, active, queued: queue.length })
          throw new Error(`Gemma 调用排队已满（${max_queue}），本次「${label}」跳过。`)
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            // 超时后把占位从队列里摘掉，避免它稍后又被唤醒
            const at = queue.indexOf(entry)
            if (at >= 0) queue.splice(at, 1)
            reject(new Error(`等待 Gemma 闸门超时（${wait_timeout_ms}ms）：${label}`))
          }, wait_timeout_ms)
          const entry = (): void => { clearTimeout(timer); resolve() }
          queue.push(entry)
        })
      }
      active += 1
      probe('gemma', 'gate.enter', { label, active, queued: queue.length })
      try {
        return await fn()
      } finally {
        release()
        probe('gemma', 'gate.leave', { label, active, queued: queue.length })
      }
    },
    stats: () => ({ active, queued: queue.length }),
  }
}

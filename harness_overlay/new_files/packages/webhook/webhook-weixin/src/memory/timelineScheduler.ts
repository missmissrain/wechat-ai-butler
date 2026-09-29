/**
 * 时间线摘要的**低频**定时器。
 *
 * 刻意独立于 iLink 轮询：
 * - 轮询（~15s）是**接收**通道，属于微信协议的一部分；
 * - 这里的检查是**纯本地**操作（读索引/记录文件），一个微信接口都不调。
 * 两者解耦后，"摘要调度"再怎么改也不会影响微信链路。
 *
 * 频率也不需要高：触发条件是"某个日期已空闲 ≥3 小时"，所以每 5 分钟看一眼，
 * 最多只会让摘要晚 5 分钟，完全够用。
 *
 * @module dsh-webhook-weixin/timeline-scheduler
 */

import { probe } from '../diagnostics/probe.ts'
import type { TimelineStore } from './timelineStore.ts'
import type { TimelineSummarizer } from './timelineTypes.ts'

/** 构造参数。 */
export interface TimelineSchedulerOptions {
  readonly store: TimelineStore
  readonly summarizer: TimelineSummarizer
  /** 检查间隔（毫秒），默认 5 分钟（`DSH_TIMELINE_CHECK_MINUTES`）。 */
  readonly interval_ms?: number
  /** 每次实际更新了摘要时回调（便于探针/日志）。 */
  readonly on_update?: (dates: readonly string[]) => void
}

/** 调度器句柄。 */
export interface TimelineScheduler {
  /** 立即检查一次；返回被更新摘要的日期。 */
  run_once(now?: number): Promise<string[]>
  /** 停止定时器（幂等）。 */
  stop(): void
}

/**
 * 启动摘要调度器。
 *
 * @param options - 存储与摘要器。
 * @returns 句柄；调用方负责在卸载时 `stop()`。
 */
export function start_timeline_scheduler(options: TimelineSchedulerOptions): TimelineScheduler {
  const interval_ms = options.interval_ms
    ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? '5')) * 60_000
  let busy = false
  let stopped = false

  const run_once = async (now = Date.now()): Promise<string[]> => {
    // 上一轮还没跑完就跳过本轮：摘要可能要花十几秒（含 Gemma 唤醒），不该并发堆叠。
    if (busy) {
      probe('timeline', 'check.skipped_busy')
      return []
    }
    busy = true
    try {
      const due = options.store.days_needing_summary(now)
      if (due.length === 0) return []
      probe('timeline', 'check.due', { dates: due })
      const updated = await options.store.summarize_due(options.summarizer, now)
      if (updated.length > 0) options.on_update?.(updated)
      return updated
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void run_once() }, interval_ms)
  timer.unref?.()
  probe('timeline', 'scheduler.started', { interval_ms })

  return {
    run_once,
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      probe('timeline', 'scheduler.stopped')
    },
  }
}

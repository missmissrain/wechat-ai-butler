/**
 * 知识图谱的**空闲增量更新**调度器。
 *
 * 触发条件与时间线摘要一致：**距最后一条对话已空闲 N 小时**（默认 3 小时）。
 * 空闲才更新有两个好处：不打扰正在进行的对话；且这时模型会在被打断后
 * 被再次唤醒（Gemma 是懒加载 + 空闲自动卸显存的）。
 *
 * 与时间线的分工：
 * - 时间线 = 逐句事实（权威，按天存）；
 * - 图谱 = 从时间线里**抽取出来的人物与称呼**（可被查询、可递归多跳）。
 * 所以图谱更新**读的是时间线**，天然与时间线同步，不需要各写一份。
 *
 * 增量：只处理"比上次图谱更新更新的记录"，避免反复消化同一批对话。
 *
 * @module dsh-webhook-weixin/graph-scheduler
 */

import { probe } from '../diagnostics/probe.ts'
import type { KnowledgeGraphStore } from './graphStore.ts'
import { update_graph_from_records, type GraphUpdateResult } from './graphUpdater.ts'
import type { TimelineStore } from './timelineStore.ts'

/** 构造参数。 */
export interface GraphSchedulerOptions {
  readonly graph: KnowledgeGraphStore
  readonly timeline: TimelineStore
  /** 调用模型（Gemma）的入口。 */
  readonly complete: (prompt: string) => Promise<string>
  /** 空闲阈值，默认复用 DSH_TIMELINE_IDLE_HOURS（3 小时）。 */
  readonly idle_ms?: number
  /** 检查间隔，默认复用 DSH_TIMELINE_CHECK_MINUTES（5 分钟）。 */
  readonly interval_ms?: number
  /** 最多回看多少天的记录，默认 7（防止首次运行时把一个月的历史全灌进去）。 */
  readonly max_days?: number
  /** 每次真正更新完成后回调（便于探针/汇报）。 */
  readonly on_update?: (result: GraphUpdateResult) => void
}

/** 调度器句柄。 */
export interface GraphScheduler {
  /** 立即检查一次；返回本次更新结果（未到期/无新记录时为 undefined）。 */
  run_once(now?: number): Promise<GraphUpdateResult | undefined>
  stop(): void
}

/**
 * 启动图谱空闲更新调度器。
 *
 * @param options - 图谱、时间线、模型入口与阈值。
 * @returns 句柄；调用方负责 `stop()`。
 */
export function start_graph_scheduler(options: GraphSchedulerOptions): GraphScheduler {
  const idle_ms = options.idle_ms
    ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000
  const interval_ms = options.interval_ms
    ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? '5')) * 60_000
  const max_days = options.max_days ?? 7
  let busy = false
  let stopped = false

  const run_once = async (now = Date.now()): Promise<GraphUpdateResult | undefined> => {
    if (busy) {
      probe('graph', 'scheduler.skipped_busy')
      return undefined
    }
    busy = true
    try {
      const since = options.graph.last_update_ms() ?? 0
      const done_ids = new Set(options.graph.last_update_ids())
      const days = options.timeline.list_days().slice(-max_days)
      const all = days.flatMap(day => options.timeline.read_day(day.date).entries)
      // **复合水位**：比 since 新，或者"同一毫秒但还没处理过"。
      // 只比时间戳会永久跳过同毫秒新增的记录（审计复现过）。
      const fresh = all
        .filter(item => item.ts > since || (item.ts === since && !done_ids.has(item.id)))
        .sort((a, b) => a.ts - b.ts)
      const records = fresh
        .map(item => ({ date: new Date(item.ts).toISOString().slice(0, 10), role: item.role, text: item.text }))

      if (records.length === 0) return undefined
      const last_ts = Math.max(...all.map(item => item.ts), since)
      const ids_at_watermark = all.filter(item => item.ts === last_ts).map(item => item.id)
      // 还没空闲够久：等对话真正停下来再更新（避免边聊边改图）。
      if (now - last_ts < idle_ms) return undefined

      probe('graph', 'scheduler.started_update', { records: records.length, since })
      const result = await update_graph_from_records(
        { graph: options.graph, complete: options.complete },
        records,
      )
      options.graph.set_last_update(last_ts, ids_at_watermark)
      options.on_update?.(result)
      return result
    } catch (error) {
      probe('graph', 'scheduler.failed', { error: String(error) })
      return undefined
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void run_once() }, interval_ms)
  timer.unref?.()
  probe('graph', 'scheduler.started', { interval_ms, idle_ms, max_days })

  return {
    run_once,
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      probe('graph', 'scheduler.stopped')
    },
  }
}

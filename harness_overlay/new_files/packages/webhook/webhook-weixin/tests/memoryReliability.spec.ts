/**
 * 记忆存储的可靠性回归（对应冒烟审计复现的 P0）：
 * 1. 跨进程并发写不丢数据、不报 EPERM；
 * 2. 时间线索引损坏时自动重建（数据不会"存在但不可发现"）；
 * 3. 图谱索引损坏时 id 不重置（不会产生重复人物 id）；
 * 4. 图谱水位不丢同一毫秒的记录。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeGraphStore } from '../src/memory/graphStore.ts'
import { TimelineStore } from '../src/memory/timelineStore.ts'

let dirs: string[] = []

function fresh_dir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mem-${tag}-`))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 句柄未释放 */ }
  }
  dirs = []
})

describe('记忆存储可靠性', () => {
  it('两个独立进程并发写同一天：一条都不丢，也不报 EPERM', () => {
    const dir = fresh_dir('concurrent')
    // 正斜杠：这里会拼进下面生成的源码模板串，反斜杠会被当转义吃掉
    const harness = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..').replaceAll('\\', '/')
    const writer = join(dir, 'writer.ts')
    writeFileSync(writer, `
import { TimelineStore } from '${harness}/packages/webhook/webhook-weixin/src/memory/timelineStore.ts'
const [dir, tag] = process.argv.slice(2)
const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
const base = Date.parse('2026-09-21T02:00:00Z')
for (let i = 0; i < 20; i += 1) {
  store.append({ id: tag + '-' + i, ts: base + i * 1000, role: 'user', text: tag + ' 第' + i + '条' })
}
`, 'utf8')

    // 两个进程同时跑，各写 20 条（id 不重叠）
    const run = (tag: string): Promise<string> => new Promise(resolve => {
      try {
        const out = execFileSync(process.execPath,
          ['--import', 'tsx/esm', writer, dir, tag],
          { cwd: harness, encoding: 'utf8', timeout: 120_000 })
        resolve(out)
      } catch (error) {
        resolve(`EXC ${String(error)}`)
      }
    })
    return Promise.all([run('a'), run('b')]).then(results => {
      expect(results.join('\n')).not.toContain('EPERM')
      const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
      const ids = store.read_day('2026-09-21').entries.map(item => item.id)
      // 关键：40 条一条都不能少（修复前实测只留下 20 条）
      expect(ids).toHaveLength(40)
      expect(new Set(ids).size).toBe(40)
    })
  })

  it('图谱索引损坏后 id 不重置（不会出现重复人物 id）', () => {
    const dir = fresh_dir('graph-index')
    const graph = new KnowledgeGraphStore({ dir })
    const first = graph.upsert_person({ name: '甲' })
    const second = graph.upsert_person({ name: '乙' })
    expect([first.id, second.id]).toEqual(['p1', 'p2'])

    // 索引写坏
    writeFileSync(join(dir, 'index.json'), '{坏索引', 'utf8')
    const third = graph.upsert_person({ name: '丙' })
    expect(third.id).toBe('p3')                       // 修复前会重新拿到 p1
    const ids = graph.nodes().map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)        // 没有重复 id
  })

  it('时间线索引损坏后，旧日期仍然可被发现（自动重建）', () => {
    const dir = fresh_dir('tl-index')
    const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
    store.append({ id: 'a', ts: Date.parse('2026-09-20T02:00:00Z'), role: 'user', text: '昨天的事' })
    store.append({ id: 'b', ts: Date.parse('2026-09-21T02:00:00Z'), role: 'user', text: '今天的事' })

    writeFileSync(join(dir, 'index.json'), '不是 JSON', 'utf8')
    expect(store.list_days().map(meta => meta.date)).toEqual(['2026-09-20', '2026-09-21'])
    // 记录文件必须原封不动
    expect(readFileSync(join(dir, 'days', '2026-09-20.jsonl'), 'utf8')).toContain('昨天的事')
    expect(store.stats().entries).toBe(2)
  })

  it('入站背压：同一用户堆太多时明确拒绝并回执，不会无限堆积', async () => {
    const { InboundCoordinator } = await import('../src/coordination/inboundCoordinator.ts')
    const { TurnContextStore } = await import('../src/state/turnContextStore.ts')
    const { WeixinStateStore } = await import('../src/state/weixinStateStore.ts')
    const dir = fresh_dir('backpressure')
    const store = new WeixinStateStore({ path: join(dir, 'state.db') })
    const notices: string[] = []

    const inbound = new InboundCoordinator({
      store,
      turn_context: new TurnContextStore(store),
      // 宿主故意"慢"：让分片链一直有积压
      host: {
        get_agent: () => undefined,
        resume_agent: () => new Promise(resolve => setTimeout(resolve, 300)),
      } as never,
      enqueue_outbound: input => { notices.push(input.text) },
    })

    // 一次塞 40 条（阈值默认 30）
    const messages = Array.from({ length: 40 }, (_, index) => ({
      delivery_id: `d${index}`, user_id: 'u1', text: `第${index}条`, media: [], received_at: Date.now(),
    }))
    await inbound.handle_batch(messages, undefined).catch(() => undefined)

    // 有消息被拒绝，并且给了用户回执
    const rejected = messages.filter(item => store.get_delivery(item.delivery_id)?.status === 'failed_terminal')
    expect(rejected.length).toBeGreaterThan(0)
    expect(store.get_delivery(rejected[0]!.delivery_id)?.last_error).toContain('队列过深')
    expect(notices.some(text => text.includes('队列已满'))).toBe(true)
    store.close()
  })

  it('停止任务：既取消模型那一轮，也中断外部 agent 进程，且回执如实', async () => {
    const { InboundCoordinator } = await import('../src/coordination/inboundCoordinator.ts')
    const { TurnContextStore } = await import('../src/state/turnContextStore.ts')
    const { WeixinStateStore } = await import('../src/state/weixinStateStore.ts')
    const dir = fresh_dir('cancel')
    const store = new WeixinStateStore({ path: join(dir, 'state.db') })
    const notices: string[] = []
    const cancels: string[] = []
    const on_cancel_calls: string[] = []

    // 造一个"正在跑"的 agent：状态不是 idle，才走取消分支
    const agent = { id: 's1', status: 'running', cancel: (reason: unknown) => { cancels.push(String(reason)) } }
    const inbound = new InboundCoordinator({
      store,
      turn_context: new TurnContextStore(store),
      host: { get_agent: () => agent, resume_agent: async () => agent, create_agent: async () => agent } as never,
      enqueue_outbound: input => { notices.push(input.text) },
      on_cancel: async user_id => { on_cancel_calls.push(user_id); return { killed: 2, pids: [11, 22] } },
    })
    store.set_session_id('u1', 's1')

    await inbound.handle_batch([
      { delivery_id: 'd1', user_id: 'u1', text: '停止任务', media: [], received_at: Date.now() },
    ], undefined)

    expect(cancels).toHaveLength(1)                 // 模型那一轮被取消
    expect(on_cancel_calls).toEqual(['u1'])         // 外部进程中断被调用
    const ack = notices.find(text => text.includes('取消当前这一轮'))
    expect(ack).toBeDefined()
    expect(ack).toContain('中断了 2 个外部任务')      // 如实报告，而不是笼统说"已停止"
    store.close()
  })

  it('Gemma 闸门：并发被压到 1，排队超限直接拒绝', async () => {
    const { create_gemma_gate } = await import('../src/memory/gemmaGate.ts')
    const gate = create_gemma_gate({ concurrency: 1, max_queue: 2 })

    let peak = 0
    let running = 0
    const job = async (): Promise<void> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 20))
      running -= 1
    }

    // 5 个并发请求：默认只放 1 个执行、2 个排队，其余拒绝
    const results = await Promise.allSettled([
      gate.run('a', job), gate.run('b', job), gate.run('c', job),
      gate.run('d', job), gate.run('e', job),
    ])
    expect(peak).toBe(1)                                    // 关键：并发峰值就是 1
    expect(results.filter(item => item.status === 'rejected').length).toBeGreaterThan(0)
    expect(gate.stats().active).toBe(0)                     // 全部跑完后没有泄漏
  })

  it('图谱水位用 (ts, id) 复合游标：同一毫秒的新记录不会被永久跳过', async () => {
    const dir = fresh_dir('watermark')
    const timeline_dir = fresh_dir('watermark-tl')
    const { start_graph_scheduler } = await import('../src/memory/graphScheduler.ts')
    const graph = new KnowledgeGraphStore({ dir })
    const timeline = new TimelineStore({ dir: timeline_dir, timezone: 'Asia/Shanghai' })
    const HOUR = 3_600_000
    const now = Date.now()
    const same_ts = now - 10 * HOUR

    timeline.append({ id: 'm1', ts: same_ts, role: 'user', text: '第一条：同事小李要去上海' })

    let calls = 0
    const scheduler = start_graph_scheduler({
      graph, timeline, interval_ms: HOUR, idle_ms: 3 * HOUR,
      complete: async () => { calls += 1; return '属性|小李|所在地|上海' },
    })
    try {
      await scheduler.run_once(now)
      const after_first = calls
      expect(after_first).toBeGreaterThan(0)

      // 关键：**同一毫秒**再追加一条（修复前会被 `ts > since` 永久跳过）
      timeline.append({ id: 'm2', ts: same_ts, role: 'user', text: '第二条：老王是爸爸的战友' })
      await scheduler.run_once(now)
      expect(calls).toBeGreaterThan(after_first)      // 第二轮必须重新处理
    } finally {
      scheduler.stop()
    }
  })
})

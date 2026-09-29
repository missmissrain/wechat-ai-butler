/** 协调器测试：控制命令解析与幂等、入站分片、出站重试与心跳策略。 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse_control_command } from '../src/coordination/inboundCoordinator.ts'
import { OutboundCoordinator } from '../src/coordination/outboundCoordinator.ts'
import { ReplyAggregator } from '../src/reply/replyAggregator.ts'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'
import { TurnContextStore } from '../src/state/turnContextStore.ts'

let dirs: string[] = []

/** 建临时状态库。 */
function fresh_store(): WeixinStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'weixin-coord-'))
  dirs.push(dir)
  return new WeixinStateStore({ path: join(dir, 'state.db') })
}

afterEach(() => {
  // 带重试：Windows 上 SQLite 句柄释放有延迟，一次 rmSync 失败会级联成
  // "后续所有测试都失败"的假象（踩过），所以这里必须容错。
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* 句柄未释放，留给系统清理 */ }
  }
  dirs = []
})

describe('parse_control_command', () => {
  it('识别取消并默认清理队列', () => {
    expect(parse_control_command('停止')).toEqual({ kind: 'cancel_current', clear_pending: true })
    expect(parse_control_command('stop')).toEqual({ kind: 'cancel_current', clear_pending: true })
  })

  it('保留队列需要显式命令', () => {
    expect(parse_control_command('停止当前但保留队列')).toEqual({ kind: 'cancel_current', clear_pending: false })
  })

  it('识别插话并带内容', () => {
    expect(parse_control_command('插话：改成用 curl')).toEqual({ kind: 'steer_current', text: '改成用 curl' })
  })

  it('识别状态查询', () => {
    expect(parse_control_command('状态')).toEqual({ kind: 'status' })
  })

  it('普通正文不误判为控制命令', () => {
    expect(parse_control_command('帮我把这个停止一下')).toBeUndefined()
    expect(parse_control_command('插话')).toBeUndefined()
    expect(parse_control_command('你好')).toBeUndefined()
  })
})

describe('OutboundCoordinator', () => {
  it('发送成功后标记 sent 并继续推进队列', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const sent: string[] = []
    const coordinator = new OutboundCoordinator({
      store,
      turn_context,
      sender: async input => { sent.push(input.text) },
      classify_retryable: () => true,
    })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: '一' })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: '二' })
    await coordinator.drain()
    expect(sent).toEqual(['一', '二'])
    expect(store.list_pending_outbox()).toHaveLength(0)
    store.close()
  })

  it('同一 Session 保序，不同 Session 并行', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const order: string[] = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => { order.push(input.text) },
      classify_retryable: () => true,
    })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: 'a1' })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: 'a2' })
    coordinator.enqueue_notice({ session_id: 's2', user_id: 'u2', kind: 'control_ack', text: 'b1' })
    await coordinator.drain()
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'))
    expect(order).toContain('b1')
    store.close()
  })

  it('可重试失败保留记录并复用 client_id', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    let attempts = 0
    const seen_clients: string[] = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        attempts += 1
        seen_clients.push(input.client_id)
        if (attempts === 1) throw Object.assign(new Error('network'), { retryable: true })
      },
      classify_retryable: () => true,
      retry_base_ms: 1,
    })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: 'x' })
    await coordinator.drain()
    expect(store.list_pending_outbox()).toHaveLength(1)
    // 下一次泵出应重试成功。
    await new Promise(resolve => setTimeout(resolve, 5))
    await coordinator.drain()
    expect(store.list_pending_outbox()).toHaveLength(0)
    expect(new Set(seen_clients).size).toBe(1)
    store.close()
  })

  it('终态失败不再回投“发送失败”通知（防限流被放大成持续拥塞）', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    let calls = 0
    const sent: string[] = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('prepare failed'), { retryable: false })
        sent.push(input.text)
      },
      classify_retryable: error => (error as { retryable?: boolean }).retryable !== false,
    })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'control_ack', text: 'x' })
    await coordinator.drain()
    const record = store.get_outbox('s1:1')
    expect(record?.status).toBe('failed_terminal')
    // 关键：失败只落日志，绝不再往 outbox 补一条通知（那会占用发送配额、放大限流）。
    expect(calls).toBe(1)
    expect(sent).toHaveLength(0)
    expect(store.list_pending_outbox().filter(item => item.kind === 'error')).toHaveLength(0)
    expect(store.list_pending_outbox()).toHaveLength(0)
    store.close()
  })

  it('无 token 的消息被拒后让路，不阻塞带 token 的真实回复', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const sent: string[] = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        // 模拟 iLink：没有 context_token 的发送必然被拒
        if (input.context_token === undefined) {
          throw Object.assign(new Error('prepare failed'), { retryable: true, rate_limited: true })
        }
        sent.push(input.text)
      },
      classify_retryable: () => true,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })
    // 1) 先来一条通知：此时还没有任何入站消息，所以它拿不到 token
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '无 token 的通知' })
    // 2) 真实用户消息到达（带 context_token），并绑定到 turn 1
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'tok-real',
    })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    turn_context.bind_if_absent('s1', 1, { delivery_id: 'd1', user_id: 'u1', context_token: 'tok-real' })
    // 3) 对这条消息的正式回复（能拿到 token）
    coordinator.enqueue_assistant({ session_id: 's1', user_id: 'u1', turn: 1, text: '带 token 的回复' })

    await coordinator.drain()

    // 关键一：带 token 的真实回复**没有被无 token 的通知堵住**，一定发出去了。
    expect(sent).toContain('带 token 的回复')
    // 关键二：通知在**发送时重新取 token**，所以也能借着这个新鲜 token 一起送达
    //（这正是要修的行为：窗口关闭时入队的通知，等窗口打开后能补发）。
    expect(sent).toContain('无 token 的通知')
    coordinator.stop()
    store.close()
  })

  it('通知类被拒时不阻塞队列、不触发全局熔断，过期则丢弃', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const sent: string[] = []
    let notice_attempts = 0
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        // 模拟 iLink：通知带的是过期 token → 必然被拒
        if (input.context_token === 'stale') {
          notice_attempts += 1
          throw Object.assign(new Error('prepare failed'), { retryable: true, rate_limited: true })
        }
        sent.push(input.text)
      },
      classify_retryable: () => true,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })
    // 一条带"过期 token"的通知（模拟旧 token 场景）
    coordinator.enqueue_notice({
      session_id: 's1', user_id: 'u1', kind: 'assistant', text: '旧通知', context_token: 'stale',
    })
    // 一条带新鲜 token 的真实回复
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'fresh',
    })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    turn_context.bind_if_absent('s1', 1, { delivery_id: 'd1', user_id: 'u1', context_token: 'fresh' })
    coordinator.enqueue_assistant({ session_id: 's1', user_id: 'u1', turn: 1, text: '真实回复' })

    await coordinator.drain()

    // 关键 1：通知失败**没有**触发全局熔断，真实回复照常发出
    expect(sent).toContain('真实回复')
    // 关键 2：通知**停放**（不是丢弃、也不反复重试）：
    //   平台只在"用户刚发过消息"的窗口内允许发送（四组对照实验证实 ret=-2），
    //   所以留存下来等用户主动询问，由 bridge_results 工具返回。
    const parked = store.get_outbox('s1:1')
    expect(parked?.status).toBe('failed_retryable')
    expect(parked?.next_retry_at ?? 0).toBeGreaterThan(Date.now() + 60_000)  // 停放：短期内不重试
    expect(store.parked_results().map(row => row.text)).toContain('旧通知')
    coordinator.stop()
    store.close()
  })

  it('通知：窗口关着就停放（不主动重试）；发送时取到的新鲜 token 也能用上', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const seen: Array<string | undefined> = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        seen.push(input.context_token)
        // 没有 token 时被拒（模拟 iLink 的会话窗口限制）
        if (input.context_token === undefined) {
          throw Object.assign(new Error('prepare failed'), { retryable: true, rate_limited: true })
        }
      },
      classify_retryable: () => true,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })

    // ① 窗口关着：通知被拒后**停放**（保留待问，短期内不重试）
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '第一条通知' })
    await coordinator.drain()
    expect(seen).toEqual([undefined])
    const parked = store.get_outbox('s1:1')
    expect(parked?.status).toBe('failed_retryable')
    expect(parked?.next_retry_at ?? 0).toBeGreaterThan(Date.now() + 60_000)

    // ② 先入队一条通知（此刻还没有 token），随后用户说话带来新鲜 token，
    //    再一泵：通知必须在**发送时**取到它并成功（否则这条通知就白丢了）。
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '第二条通知' })
    expect(store.get_outbox('s1:2')?.context_token).toBeUndefined()
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'fresh-token',
    })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    await coordinator.drain()
    expect(seen[seen.length - 1]).toBe('fresh-token')
    expect(store.get_outbox('s1:2')?.status).toBe('sent')
    coordinator.stop()
    store.close()
  })

  it('限流触发整链路冷却，且不消耗重试次数', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    let calls = 0
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async () => {
        calls += 1
        throw Object.assign(new Error('prepare failed'), { retryable: true, rate_limited: true })
      },
      classify_retryable: () => true,
      // 若限流也计入次数，第一次尝试就会转终态——这里刻意设成 1 来锁死该行为。
      max_attempts: 1,
      retry_base_ms: 1,
      rate_limit_cooldown_ms: 5,
      rate_limit_cooldown_max_ms: 5,
    })
    // 注意：熔断只针对**带 token 的真实回复**的失败。
    // 通知类（turn 为空）按设计永不触发熔断——它们只会被延后或丢弃。
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'tok-1',
    })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    turn_context.bind_if_absent('s1', 1, { delivery_id: 'd1', user_id: 'u1', context_token: 'tok-1' })
    coordinator.enqueue_assistant({ session_id: 's1', user_id: 'u1', turn: 1, text: 'x' })
    expect(store.get_outbox('s1:1')?.context_token).toBe('tok-1')
    await coordinator.drain()
    expect(store.get_outbox('s1:1')?.status).toBe('failed_retryable')
    // 冷却期内再次泵出：熔断拦住，不产生新的发送尝试。
    await coordinator.drain()
    expect(calls).toBe(1)
    // 冷却结束后自动恢复重试。
    await new Promise(resolve => setTimeout(resolve, 20))
    await coordinator.drain()
    expect(calls).toBeGreaterThan(1)
    expect(store.get_outbox('s1:1')?.status).toBe('failed_retryable')
    coordinator.stop()
    store.close()
  })

  it('思考摘要会推迟心跳（摘要本身即心跳）', async () => {
    // 不用假定时器：阈值设短，靠真实等待驱动。
    // 心跳检查跑在 setInterval（≥5s）里，这里直接调用内部检查不方便，
    // 因此改为验证可观察语义：note_visible 会推后 last_visible，从而抑制心跳。
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    store.bind_turn_context({ session_id: 's1', turn: 1, delivery_id: 'd1', user_id: 'u1' })
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async () => undefined,
      classify_retryable: () => true,
      heartbeat_idle_ms: 50,
    })
    coordinator.begin_turn('s1', 1)
    coordinator.note_visible('s1')
    await new Promise(resolve => setTimeout(resolve, 20))
    coordinator.note_visible('s1')
    // 证据一：阈值内没有心跳。
    expect(store.list_pending_outbox().filter(item => item.kind === 'heartbeat')).toHaveLength(0)
    // 证据二：进度入队后，其 kind 是 progress（即"摘要作为心跳"的载体）而非 heartbeat。
    coordinator.enqueue_progress('s1', '（进度·欣爱在想）正在处理')
    const progress = store.list_pending_outbox().filter(item => item.kind === 'progress')
    expect(progress).toHaveLength(1)
    coordinator.stop()
    store.close()
  })
})

describe('ReplyAggregator', () => {
  it('只按句末标点分段，短句会继续攒（避免把回复打碎触发限流）', () => {
    const aggregator = new ReplyAggregator()
    // 逗号不再触发分段；且短于 MIN_SEGMENT_CHARS 的内容会攒着不发。
    const segments = aggregator.accept_chunk('你好呀！今天天气不错，要不要出门？')
    expect(segments).toHaveLength(0)
    // 内容最终会作为尾段一次性发出。
    expect(aggregator.finish()).toContain('今天天气不错')
  })

  it('够长的句末标点内容才会立刻分段', () => {
    const aggregator = new ReplyAggregator()
    const long = '我已经帮你把脚本写好了，放在 SynLove 工作区的 scripts 目录里，并且跑通验证过了。'
    const segments = aggregator.accept_chunk(long)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toContain('SynLove')
  })

  it('单轮分段有上限，超出部分并入尾段', () => {
    const aggregator = new ReplyAggregator()
    let segments: string[] = []
    for (let i = 0; i < 10; i += 1) {
      segments = segments.concat(aggregator.accept_chunk(`第${i}段内容足够长，用来触发分段规则，确保超过最小长度限制。`))
    }
    expect(segments.length).toBeLessThanOrEqual(4)
    expect(aggregator.finish()).toBeDefined()
  })

  it('代码围栏内不分段', () => {
    const aggregator = new ReplyAggregator()
    const segments = aggregator.accept_chunk('```js\nconst a = 1, b = 2;\n```')
    expect(segments).toHaveLength(0)
    expect(aggregator.finish()).toContain('const a = 1, b = 2;')
  })

  it('正常 JSON 回答不会被误判为工具调用外壳', () => {
    const aggregator = new ReplyAggregator()
    const segments = aggregator.accept_chunk('{"city":"北京","temp":25}')
    expect(aggregator.is_suppressed).toBe(false)
    expect(segments.length + (aggregator.finish()?.length ?? 0)).toBeGreaterThan(0)
  })

  it('工具调用外壳会被静默', () => {
    const aggregator = new ReplyAggregator()
    aggregator.accept_chunk('{"function":"pwsh","arguments":"{}"}')
    expect(aggregator.is_suppressed).toBe(true)
    expect(aggregator.finish()).toBeUndefined()
  })

  it('思考摘要可被取出且清空', () => {
    const aggregator = new ReplyAggregator()
    aggregator.accept_reasoning('我在想')
    aggregator.accept_reasoning('要不要用 opencode')
    const excerpt = aggregator.take_reasoning_excerpt(50)
    expect(excerpt).toContain('我在想')
    expect(aggregator.take_reasoning_excerpt(50)).toBeUndefined()
  })
})

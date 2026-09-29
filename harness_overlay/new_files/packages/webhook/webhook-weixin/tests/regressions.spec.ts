/**
 * 长任务相关回归测试（对应两份审查报告指出的缺口）：
 * 1. 同一 turn 的回复上下文不被后续消息覆盖（bind_if_absent 语义）；
 * 2. opencode 完成汇报使用"完成指纹"去重，同一轮不会被报两次；
 * 3. 长文本不会被截断，而是分段发送。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeWatcher } from '../src/coordination/opencodeWatcher.ts'
import { OutboundCoordinator } from '../src/coordination/outboundCoordinator.ts'
import { TurnContextStore } from '../src/state/turnContextStore.ts'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'

let dirs: string[] = []

/** 建一个临时状态库。 */
function fresh_store(): WeixinStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'weixin-reg-'))
  dirs.push(dir)
  return new WeixinStateStore({ path: join(dir, 'state.db') })
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 上可能有句柄未释放 */ }
  }
  dirs = []
})

describe('长任务：turn 上下文不被覆盖', () => {
  it('同一 turn 首次绑定后，后续消息的 delivery 不会改写它', () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)

    // 第一条消息（长任务开始）：绑定 turn 26
    expect(turn_context.bind_if_absent('s1', 26, { delivery_id: 'd-old', user_id: 'u1', context_token: 'tok-old' })).toBe(true)
    // 长任务进行中，用户又发来一条消息 → 仍然属于同一个 turn 26 的回复上下文，必须保持原值
    expect(turn_context.bind_if_absent('s1', 26, { delivery_id: 'd-new', user_id: 'u1', context_token: 'tok-new' })).toBe(false)

    const bound = turn_context.get('s1', 26)
    expect(bound?.delivery_id).toBe('d-old')
    expect(bound?.context_token).toBe('tok-old')
    store.close()
  })

  it('不同 turn 各自独立绑定（互不影响）', () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    turn_context.bind_if_absent('s1', 26, { delivery_id: 'd1', user_id: 'u1', context_token: 't1' })
    turn_context.bind_if_absent('s1', 27, { delivery_id: 'd2', user_id: 'u1', context_token: 't2' })
    expect(turn_context.get('s1', 26)?.context_token).toBe('t1')
    expect(turn_context.get('s1', 27)?.context_token).toBe('t2')
    store.close()
  })

  it('多个 attempt（step）属于同一 turn 时不会重复建 turn 状态', () => {
    // 模拟 connector 的判定：step>1 且 turn 未变化 → 不重新初始化 turn
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const current = new Map<string, number>()
    const begin_turn_once = (session_id: string, turn: number): boolean => {
      const already = turn_context.get(session_id, turn)
      current.set(session_id, turn)
      if (already !== undefined) return false
      turn_context.bind_if_absent(session_id, turn, { delivery_id: 'd1', user_id: 'u1' })
      return true
    }
    expect(begin_turn_once('s1', 1)).toBe(true)   // step 1
    expect(begin_turn_once('s1', 1)).toBe(false)  // step 2（同 turn 的第二个 attempt）
    expect(begin_turn_once('s1', 1)).toBe(false)  // step 3
    expect(begin_turn_once('s1', 2)).toBe(true)   // 新 turn
    store.close()
  })
})

/** 建一个最小可用的 opencode 数据库（session/message/part 三张表）。 */
function make_opencode_db(dir: string): string {
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `)
  db.close()
  return path
}

describe('opencode 完成汇报：完成指纹去重', () => {
  it('同一轮完成只汇报一次；产生新助手消息后才再汇报', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-watch-'))
    dirs.push(dir)
    const store = fresh_store()
    const db_path = make_opencode_db(dir)

    const db = new DatabaseSync(db_path)
    const insert_assistant = (message_id: string): void => {
      db.prepare('INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run(message_id, 'ses_a', 1, 1, '{"role":"assistant"}')
      db.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
        .run('prt_' + message_id, message_id, 'ses_a', 1, 1, '{"type":"text","text":"完成了"}')
    }
    // 会话已"静默"：time_updated 设成很久以前
    db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,NULL)')
      .run('ses_a', 'SynLove', 'task', 1, 1)
    insert_assistant('msg_1')
    db.close()

    const pushed: string[] = []
    const watcher = new OpencodeWatcher({
      store,
      push: (_user_id, text) => { pushed.push(text) },
      data_dir: dir,
      poll_ms: 3_600_000,
      idle_ms: 0,
    })
    // 让监视器认为"有用户可推送"
    store.set_session_id('u1', 'weixin-u1')

    await watcher.sweep_once()   // 首轮：只建基线
    expect(pushed).toHaveLength(0)
    await watcher.sweep_once()   // 无新内容：不应重复汇报
    expect(pushed).toHaveLength(0)

    // 产生新的一轮助手消息 → 应汇报一次
    const db2 = new DatabaseSync(db_path)
    db2.prepare('INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
      .run('msg_2', 'ses_a', 2, 2, '{"role":"assistant"}')
    db2.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run('prt_msg_2', 'msg_2', 'ses_a', 2, 2, '{"type":"text","text":"第二次完成"}')
    db2.close()

    await watcher.sweep_once()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toContain('第二次完成')

    // 再扫一次：指纹没变 → 不重复汇报
    await watcher.sweep_once()
    expect(pushed).toHaveLength(1)
    watcher.stop()
    store.close()
  })
})

describe('持久化事实与恢复边界（v3 补丁）', () => {
  it('delivery 落库后能读回 context_token（fallback 不再丢 token）', () => {
    const store = fresh_store()
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'tok-abc',
    })
    expect(store.get_delivery('d1')?.context_token).toBe('tok-abc')
    expect(store.latest_delivery_for_session('s1')).toBeUndefined()
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    expect(store.latest_delivery_for_session('s1')?.context_token).toBe('tok-abc')
    store.close()
  })

  it('TurnContextStore 兜底时带上 context_token', () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    store.put_delivery_if_absent({
      delivery_id: 'd1', user_id: 'u1', received_at: Date.now(), context_token: 'tok-abc',
    })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    // 本轮没有精确绑定（例如重启后）→ 必须走兜底并带上 token
    const resolved = turn_context.resolve('s1', 99)
    expect(resolved?.delivery_id).toBe('d1')
    expect(resolved?.context_token).toBe('tok-abc')
    store.close()
  })

  it('普通状态迁移不消耗 attempt，只有失败才计次', () => {
    const store = fresh_store()
    store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: Date.now() })
    store.update_delivery('d1', 'routing', { expect: 'received' })
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: Date.now() })
    expect(store.get_delivery('d1')?.attempt).toBe(0)
    // 真正的失败才 +1
    store.update_delivery('d1', 'failed_retryable', { last_error: 'boom', increment_attempt: true })
    expect(store.get_delivery('d1')?.attempt).toBe(1)
    store.close()
  })

  it('分段发送：第 1 段失败后重试不会重发第 0 段', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const sent: string[] = []
    let calls = 0
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => {
        calls += 1
        // 第 1 段（段号 #1）第一次失败，之后放行
        if (input.client_id.endsWith('#1') && calls <= 3) {
          throw Object.assign(new Error('network'), { retryable: true })
        }
        sent.push(input.text)
      },
      classify_retryable: () => true,
      retry_base_ms: 1,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })
    // 各段内容不同，便于识别"是否重发了同一段"
    const p0 = 'A'.repeat(1_000)
    const p1 = 'B'.repeat(1_000)
    const p2 = 'C'.repeat(500)
    const long = p0 + p1 + p2
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: long })
    await coordinator.drain()
    await new Promise(resolve => setTimeout(resolve, 10))
    await coordinator.drain()
    await new Promise(resolve => setTimeout(resolve, 10))
    await coordinator.drain()

    // 第 0 段只应出现一次：重试时跳过已送达的段（断点续传）
    expect(sent.filter(text => text === p0)).toHaveLength(1)
    expect(sent.join('')).toBe(long)
    store.close()
  })

  it('拥塞时正式回复优先于通知类（turn 非空排前面）', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const order: string[] = []
    const coordinator = new OutboundCoordinator({
      store, turn_context,
      sender: async input => { order.push(input.text) },
      classify_retryable: () => true,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })
    // 先入队两条通知（turn 为空），后入队一条正式回复（带 turn）
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '通知1' })
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '通知2' })
    coordinator.enqueue_assistant({ session_id: 's1', user_id: 'u1', turn: 7, text: '正式回复' })
    await coordinator.drain()
    // 回复必须最先发出，尽管它的 sequence 最大
    expect(order[0]).toBe('正式回复')
    store.close()
  })

  it('待发通知超上限时丢最旧的，且不影响正式回复', () => {
    const store = fresh_store()
    for (let i = 0; i < 6; i += 1) {
      store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: `通知${i}` })
      store.trim_pending_notices('s1', 3)
    }
    store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: '正式回复', turn: 9 })
    store.trim_pending_notices('s1', 3)
    const pending = store.list_pending_outbox().map(item => item.text)
    expect(pending).toContain('正式回复')
    // 通知最多保留 3 条，且是最新的
    const notices = pending.filter(text => text.startsWith('通知'))
    expect(notices).toHaveLength(3)
    expect(notices).toContain('通知5')
    expect(notices).not.toContain('通知0')
    store.close()
  })

  it('outbox 分段进度会落盘（崩溃后可跳过已发段）', () => {
    const store = fresh_store()
    store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'x' })
    store.mark_outbox_part_sent('s1:1', 0)
    store.mark_outbox_part_sent('s1:1', 1)
    store.mark_outbox_part_sent('s1:1', 0)
    expect(store.get_outbox('s1:1')?.sent_parts).toEqual([0, 1])
    store.close()
  })
})

describe('长文本：不截断，改为分段发送', () => {
  it('超过上限的文本会拆成多条依次发送，且内容完整', async () => {
    const store = fresh_store()
    const turn_context = new TurnContextStore(store)
    const sent: string[] = []
    const coordinator = new OutboundCoordinator({
      store,
      turn_context,
      sender: async input => { sent.push(input.text) },
      classify_retryable: () => true,
      send_min_gap_ms: 0,
      send_batch_limit: 10,
    })
    const long = 'A'.repeat(2_500)
    coordinator.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: long })
    await coordinator.drain()

    expect(sent.length).toBeGreaterThan(1)
    // 拼接后与原文一致（没有被截断/丢字）
    expect(sent.join('')).toBe(long)
    store.close()
  })
})

/** 状态库测试：事务、幂等、cursor 提交语义、outbox 顺序与 client_id 复用、lease 互斥。 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'

let dirs: string[] = []

/** 建一个临时状态库。 */
function fresh_store(): WeixinStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'weixin-state-'))
  dirs.push(dir)
  return new WeixinStateStore({ path: join(dir, 'state.db') })
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上 SQLite WAL 文件可能仍被句柄占用；清理失败不影响测试结论。
    }
  }
  dirs = []
})

describe('WeixinStateStore', () => {
  it('delivery 幂等登记：重复投递只认第一次', () => {
    const store = fresh_store()
    expect(store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: 1 })).toBe(true)
    expect(store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: 1 })).toBe(false)
    store.close()
  })

  it('清空队列：待发/发送中/停放都被清掉，已发送的历史保留', () => {
    const store = fresh_store()
    const enqueue = (text: string): string => store.enqueue_outbox({
      session_id: 's1', user_id: 'u1', kind: 'assistant', text, context_token: 't',
    }).outbound_id
    const first = enqueue('o1')
    enqueue('o2')
    enqueue('o3')
    // 把其中一条推到终态：发送成功的历史不该被清掉
    store.mark_outbox_sent(first)

    expect(store.clear_queue()).toBe(2)
    expect(store.list_pending_outbox()).toEqual([])
    expect(store.get_outbox(first)?.status).toBe('sent')
    expect(store.clear_queue()).toBe(0)          // 幂等
    store.close()
  })

  it('cursor 只在批次内 delivery 达到终态时可提交', () => {
    const store = fresh_store()
    store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: 1 })
    expect(store.batch_committable(['d1'])).toBe(false)
    store.update_delivery('d1', 'injected', { session_id: 's1', injected_at: 2 })
    expect(store.batch_committable(['d1'])).toBe(true)
    store.close()
  })

  it('failed_terminal 也允许提交（已产生用户可见错误）', () => {
    const store = fresh_store()
    store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: 1 })
    store.update_delivery('d1', 'failed_terminal', { last_error: 'boom' })
    expect(store.batch_committable(['d1'])).toBe(true)
    store.close()
  })

  it('failed_retryable 不允许提交 cursor', () => {
    const store = fresh_store()
    store.put_delivery_if_absent({ delivery_id: 'd1', user_id: 'u1', received_at: 1 })
    store.update_delivery('d1', 'failed_retryable', { last_error: 'net' })
    expect(store.batch_committable(['d1'])).toBe(false)
    store.close()
  })

  it('outbox sequence 在同一 Session 单调递增', () => {
    const store = fresh_store()
    const a = store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'a' })
    const b = store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'b' })
    expect(a.sequence).toBe(1)
    expect(b.sequence).toBe(2)
    expect(store.next_outbox('s1')?.outbound_id).toBe(a.outbound_id)
    store.close()
  })

  it('不同 Session 的 outbox 互不影响', () => {
    const store = fresh_store()
    store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'a' })
    const other = store.enqueue_outbox({ session_id: 's2', user_id: 'u2', kind: 'assistant', text: 'b' })
    expect(other.sequence).toBe(1)
    expect(store.next_outbox_per_session().length).toBe(2)
    store.close()
  })

  it('client_id 在同一记录上稳定（重试必须复用）', () => {
    const store = fresh_store()
    const record = store.enqueue_outbox({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'a' })
    store.mark_outbox_sending(record.outbound_id)
    store.mark_outbox_failed(record.outbound_id, 'failed_retryable', 'net')
    const again = store.get_outbox(record.outbound_id)
    expect(again?.client_id).toBe(record.client_id)
    store.close()
  })

  it('turn_context 按 session+turn 绑定，互不覆盖', () => {
    const store = fresh_store()
    store.bind_turn_context({ session_id: 's1', turn: 1, delivery_id: 'd1', user_id: 'u1', context_token: 't1' })
    store.bind_turn_context({ session_id: 's1', turn: 2, delivery_id: 'd2', user_id: 'u1', context_token: 't2' })
    expect(store.get_turn_context('s1', 1)?.context_token).toBe('t1')
    expect(store.get_turn_context('s1', 2)?.context_token).toBe('t2')
    store.close()
  })

  it('lease 是互斥的：持有者进程存活时第二个被拒绝', () => {
    const store = fresh_store()
    // 用当前进程 pid：保证"持有者存活"这一判定成立。
    const first = store.try_acquire_lease({ owner_id: 'a', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 60_000 })
    const second = store.try_acquire_lease({ owner_id: 'b', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 60_000 })
    expect(first).toBe(true)
    expect(second).toBe(false)
    store.close()
  })

  it('持有者进程已死时可以立即抢占（无需等 stale）', () => {
    const store = fresh_store()
    // 一个几乎不可能存在的 pid，模拟被强杀的旧进程。
    const dead_pid = 999_999
    store.try_acquire_lease({ owner_id: 'dead', pid: dead_pid, process_started_at: 0, account_id: 'acct', stale_ms: 600_000 })
    expect(store.try_acquire_lease({ owner_id: 'b', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 600_000 })).toBe(true)
    expect(store.get_lease()?.owner_id).toBe('b')
    store.close()
  })

  it('持有者存活但心跳过期（stale）时可以抢占', () => {
    const store = fresh_store()
    store.try_acquire_lease({ owner_id: 'a', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 0 })
    expect(store.try_acquire_lease({ owner_id: 'b', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 0 })).toBe(true)
    store.close()
  })

  it('只有持有者能释放 lease', () => {
    const store = fresh_store()
    store.try_acquire_lease({ owner_id: 'a', pid: process.pid, process_started_at: 0, account_id: 'acct', stale_ms: 60_000 })
    store.release_lease('b')
    expect(store.get_lease()?.owner_id).toBe('a')
    store.release_lease('a')
    expect(store.get_lease()).toBeUndefined()
    store.close()
  })

  it('事务失败会回滚并抛出（写失败必须被感知）', () => {
    const store = fresh_store()
    expect(() => {
      store.transaction(() => {
        store.set_session_id('u1', 's1')
        throw new Error('boom')
      })
    }).toThrow('boom')
    expect(store.get_session_id('u1')).toBeUndefined()
    store.close()
  })

  it('schema 版本不匹配时 fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weixin-state-'))
    dirs.push(dir)
    const path = join(dir, 'state.db')
    const first = new WeixinStateStore({ path })
    // 手动改动 schema 版本，模拟旧/新库不兼容。
    first.release_lease('none')
    first.close()
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', 'schema_version')
    raw.close()
    let failed_store: WeixinStateStore | undefined
    expect(() => { failed_store = new WeixinStateStore({ path }) }).toThrow(/schema 版本不匹配/)
    failed_store?.close()
  })
})

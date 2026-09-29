/**
 * 连续消息合并测试。
 *
 * 为什么重要：人是断续打字的（"在吗" → "帮我看下" → "那个文件"）。
 * 逐条喂模型会得到三次回答、又慢又吵；合并窗口失效就会退回那个体验。
 * 反过来，合并窗口若漏标 delivery，那些消息会永远停在 routing，批次游标提交不了
 * → 服务端反复重投同一批消息。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NormalizedWeixinMessage } from '../src/message/messageNormalizer.ts'

let dirs: string[] = []

beforeAll(() => {
  // 测试里把窗口压到 120ms（模块加载时读环境变量，所以必须在 import 之前设）
  process.env.DSH_WEIXIN_COALESCE_MS = '120'
})

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 可能仍被占用 */ }
  }
  dirs = []
})

/** 造一条消息。 */
function message(id: string, text: string, token?: string): NormalizedWeixinMessage {
  return {
    delivery_id: id,
    user_id: 'u1',
    text,
    media: [],
    received_at: Date.now(),
    ...token === undefined ? {} : { context_token: token },
  } as NormalizedWeixinMessage
}

describe('合并规则（纯函数）', () => {
  it('文本按顺序换行相连；媒体拼接；token 用最后一条；delivery 用第一条', async () => {
    const { merge_messages } = await import('../src/coordination/inboundCoordinator.ts')
    const merged = merge_messages([
      message('d1', '在吗', 'token-1'),
      message('d2', '帮我看下那个文件', 'token-2'),
      message('d3', '  ', 'token-3'),
    ])
    expect(merged.text).toBe('在吗\n帮我看下那个文件')
    expect(merged.delivery_id).toBe('d1')
    expect(merged.context_token).toBe('token-3')       // 回复窗口是最后一条开的
    expect(merged.media).toEqual([])
  })
})

describe('合并窗口', () => {
  /** 造一个"记录被注入内容"的假 agent。 */
  function fake_host(injections: string[]): unknown {
    const agent = {
      id: 'session-1',
      followup: (payload: { content: Array<{ text?: string }> }) => {
        injections.push(payload.content.map(block => block.text ?? '').join(''))
      },
    }
    return {
      get_agent: () => agent,
      resume_agent: async () => agent,
      create_agent: async () => agent,
    }
  }

  async function make_coordinator(): Promise<{
    inbound: { handle_batch: (messages: readonly NormalizedWeixinMessage[], cursor?: string) => Promise<boolean> },
    store: { get_delivery: (id: string) => { status: string } | undefined },
    injections: string[],
    close: () => void,
  }> {
    const { InboundCoordinator } = await import('../src/coordination/inboundCoordinator.ts')
    const { TurnContextStore } = await import('../src/state/turnContextStore.ts')
    const { WeixinStateStore } = await import('../src/state/weixinStateStore.ts')
    const dir = mkdtempSync(join(tmpdir(), 'coalesce-'))
    dirs.push(dir)
    const store = new WeixinStateStore({ path: join(dir, 'state.db') })
    const injections: string[] = []
    const inbound = new InboundCoordinator({
      store,
      turn_context: new TurnContextStore(store),
      host: fake_host(injections) as never,
      enqueue_outbound: () => {},
    })
    return {
      inbound: inbound as never,
      store: store as never,
      injections,
      close: () => store.close(),
    }
  }

  it('窗口内的连续消息只注入一次，且每条 delivery 都到达终态', async () => {
    const { inbound, store, injections, close } = await make_coordinator()
    await inbound.handle_batch([
      message('d1', '在吗', 't1'),
      message('d2', '帮我看下那个文件', 't2'),
      message('d3', '就是昨天说的那个', 't3'),
    ], undefined)

    // 窗口还没到：一条都不该注入
    expect(injections).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(injections).toHaveLength(1)
    expect(injections[0]).toContain('在吗')
    expect(injections[0]).toContain('帮我看下那个文件')
    expect(injections[0]).toContain('就是昨天说的那个')
    for (const id of ['d1', 'd2', 'd3']) {
      expect(store.get_delivery(id)?.status).toBe('injected')
    }
    close()
  })

  it('窗口会被新消息刷新：断续发三条也仍然只注入一次', async () => {
    const { inbound, injections, close } = await make_coordinator()
    // 先发两条，等一小会儿再发第三条 → 窗口重置，仍然只注入一次、包含三条
    await inbound.handle_batch([message('d1', '一', 't1')], undefined)
    await new Promise(resolve => setTimeout(resolve, 60))
    await inbound.handle_batch([message('d2', '二', 't2')], undefined)
    await new Promise(resolve => setTimeout(resolve, 60))
    await inbound.handle_batch([message('d3', '三', 't3')], undefined)
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(injections).toHaveLength(1)
    expect(injections[0]).toBe('一\n二\n三')
    close()
  })
})

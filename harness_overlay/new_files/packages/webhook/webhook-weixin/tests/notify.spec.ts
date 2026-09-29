/**
 * 通知开关测试：默认开启、可分别开关、重启后仍生效（存在状态库 meta 里）、
 * 以及工具的两个动作（status / set）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { create_notify_settings } from '../src/coordination/notifySettings.ts'
import { register_notify_tools } from '../src/coordination/notifyTools.ts'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'

let dirs: string[] = []

function fresh_store(): WeixinStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  dirs.push(dir)
  return new WeixinStateStore({ path: join(dir, 'state.db') })
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 句柄可能未释放 */ }
  }
  dirs = []
})

describe('通知开关', () => {
  it('默认都开启；可以分别关掉；重开后仍是关着的（持久化）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-'))
    dirs.push(dir)
    const path = join(dir, 'state.db')

    const store = fresh_store0(path)
    const settings = create_notify_settings(store)
    expect(settings.snapshot()).toEqual({ codex: true, opencode: true })

    settings.set_enabled('codex', false)
    expect(settings.is_enabled('codex')).toBe(false)
    expect(settings.is_enabled('opencode')).toBe(true)   // 互不影响
    store.close()

    // 重新打开同一个库：开关必须还在（存在 meta 表里）
    const reopened = fresh_store0(path)
    const again = create_notify_settings(reopened)
    expect(again.snapshot()).toEqual({ codex: false, opencode: true })
    reopened.close()
  })

  it('工具：status 查状态，set 开关，非法参数不生效', async () => {
    const store = fresh_store()
    const settings = create_notify_settings(store)
    const registered: Array<{ name: string, execute: (a: never) => Promise<{ ok: boolean, text: string }> }> = []
    register_notify_tools(
      { tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[number]) } } } as unknown as Context,
      settings,
    )
    expect(registered.map(tool => tool.name)).toEqual(['notify_control'])
    const tool = registered[0]!

    // 查
    const status = await tool.execute({ action: 'status' } as never)
    expect(status.ok).toBe(true)
    expect(status.text).toContain('已开启')

    // 关（两个都关）
    const off = await tool.execute({ action: 'set', target: 'all', enabled: false } as never)
    expect(off.ok).toBe(true)
    expect(settings.snapshot()).toEqual({ codex: false, opencode: false })

    // 只开 codex
    const on = await tool.execute({ action: 'set', target: 'codex', enabled: true } as never)
    expect(on.ok).toBe(true)
    expect(settings.snapshot()).toEqual({ codex: true, opencode: false })

    // 非法参数：目标不认识 / 缺 enabled / 动作不认识
    expect((await tool.execute({ action: 'set', target: 'wechat', enabled: true } as never)).ok).toBe(false)
    expect((await tool.execute({ action: 'set', target: 'codex' } as never)).ok).toBe(false)
    expect((await tool.execute({ action: '乱写' } as never)).ok).toBe(false)
    // 非法调用不应改变状态
    expect(settings.snapshot()).toEqual({ codex: true, opencode: false })
    store.close()
  })
})

/** 按指定路径打开状态库（用于验证"重开后仍在"）。 */
function fresh_store0(path: string): WeixinStateStore {
  return new WeixinStateStore({ path })
}

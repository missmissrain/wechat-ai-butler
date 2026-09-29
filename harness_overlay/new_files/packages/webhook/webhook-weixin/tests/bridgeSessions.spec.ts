/**
 * `bridge_sessions` 测试：会话清单与聊天记录的读取（用临时 SQLite/JSONL 造数据）。
 *
 * 为什么值得测：这个工具直接读**别人的数据库**（codex / opencode 自己的库），
 * 表名、字段名、JSON 形状一变就会静默返回空——界面上看不出错，只有用户发现"查不到会话"。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  list_codex_sessions,
  list_opencode_sessions,
  read_codex_messages,
  read_opencode_messages,
  register_bridge_session_tools,
} from '../src/coordination/bridgeSessionTools.ts'

let dirs: string[] = []
let saved: Record<string, string | undefined> = {}

function fresh_dir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  saved = { CODEX_HOME: process.env.CODEX_HOME, OPENCODE_DATA_DIR: process.env.OPENCODE_DATA_DIR }
})

afterEach(() => {
  process.env.CODEX_HOME = saved.CODEX_HOME
  process.env.OPENCODE_DATA_DIR = saved.OPENCODE_DATA_DIR
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 可能仍被占用 */ }
  }
  dirs = []
})

/**
 * 造一个 opencode 库（session / message / part 三张表，字段名照抄真实库）。
 * @returns 数据目录（不是文件路径——环境变量指的是目录）。
 */
function make_opencode_db(dir: string): string {
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, '
    + 'time_updated INTEGER, time_archived INTEGER)')
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)')
  db.exec('CREATE TABLE part (message_id TEXT, session_id TEXT, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL)')
    .run('ses_1', 'G:\\desktop\\proj\\alpha', '修一下登录页', 1000, 5000)
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL)')
    .run('ses_2', 'G:\\desktop\\proj\\beta', '写个脚本', 2000, 4000)
  db.prepare('INSERT INTO message VALUES (?, ?, ?)')
    .run('m1', 'ses_1', JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO message VALUES (?, ?, ?)')
    .run('m2', 'ses_1', JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)')
    .run('m1', 'ses_1', JSON.stringify({ type: 'text', text: '登录页点了没反应' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)')
    .run('m2', 'ses_1', JSON.stringify({ type: 'text', text: '我看下，应该是事件没绑上' }))
  // 末尾再挂两条"只有工具调用、没有文本"的消息：读记录时应该继续往前找，而不是返回空
  db.prepare('INSERT INTO message VALUES (?, ?, ?)')
    .run('m3', 'ses_1', JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)')
    .run('m3', 'ses_1', JSON.stringify({ type: 'tool', tool: 'bash' }))
  db.prepare('INSERT INTO message VALUES (?, ?, ?)')
    .run('m4', 'ses_1', JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)')
    .run('m4', 'ses_1', JSON.stringify({ type: 'reasoning', text: '（思考）' }))
  db.close()
  return dir
}

/** 造一个 codex home（state_5.sqlite + 一个 rollout JSONL）。 */
function make_codex_home(dir: string): string {
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const rollout = join(sessions, 'rollout-1.jsonl')
  writeFileSync(rollout, [
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-21T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ text: '## My request for Codex:\n把 README 补一下' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-21T10:01:00Z', payload: { type: 'message', role: 'assistant', content: [{ text: '补好了，加了安装说明。' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'), 'utf8')

  const db = new DatabaseSync(join(dir, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, '
    + 'updated_at INTEGER, archived INTEGER)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)')
    .run('thread-1', rollout, 'G:\\desktop\\proj\\gamma', '补 README', 9000)
  db.close()
  return dir
}

describe('bridge_sessions 数据读取', () => {
  it('opencode：列会话（带项目名/标题）并按 id 读聊天记录', () => {
    process.env.OPENCODE_DATA_DIR = make_opencode_db(fresh_dir('oc-'))
    const sessions = list_opencode_sessions(5)
    expect(sessions.map(item => item.id)).toEqual(['ses_1', 'ses_2'])   // 按更新时间倒序
    expect(sessions[0]?.title).toBe('修一下登录页')
    expect(sessions[0]?.workspace).toContain('alpha')

    const messages = read_opencode_messages('ses_1', 10)
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.text).toContain('登录页点了没反应')
    expect(messages[1]?.text).toContain('事件没绑上')
  })

  it('codex：列会话（带生命周期状态）并读聊天记录（剥掉 Codex 包装）', () => {
    process.env.CODEX_HOME = make_codex_home(fresh_dir('cx-'))
    const sessions = list_codex_sessions(5)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe('thread-1')
    expect(sessions[0]?.status).toBe('已完成')                 // rollout 尾部是 task_complete
    expect(sessions[0]?.title).toBe('把 README 补一下')          // 取最近一条用户消息

    const messages = read_codex_messages(sessions[0]!.rollout_path!, 10)
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.text).toBe('把 README 补一下')          // "## My request for Codex:" 已剥掉
    expect(messages[1]?.text).toContain('补好了')
  })

  it('目录不存在时返回空数组，不抛错', () => {
    process.env.OPENCODE_DATA_DIR = join(fresh_dir('empty-'), 'nope')
    process.env.CODEX_HOME = join(fresh_dir('empty2-'), 'nope')
    expect(list_opencode_sessions()).toEqual([])
    expect(list_codex_sessions()).toEqual([])
    expect(read_opencode_messages('x')).toEqual([])
  })
})

describe('bridge_sessions 工具', () => {
  it('注册一个工具，能在列表/读记录之间切换，找不到会话时如实说', async () => {
    process.env.OPENCODE_DATA_DIR = make_opencode_db(fresh_dir('oc2-'))
    process.env.CODEX_HOME = make_codex_home(fresh_dir('cx2-'))

    const registered: Array<{ name: string, execute: (args: never) => Promise<{ ok: boolean, text: string }> }> = []
    register_bridge_session_tools(
      { tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[number]) } } } as unknown as Context,
    )
    expect(registered.map(tool => tool.name)).toEqual(['bridge_sessions'])
    const tool = registered[0]!

    const list = await tool.execute({} as never)
    expect(list.ok).toBe(true)
    expect(list.text).toContain('codex 会话')
    expect(list.text).toContain('opencode 会话')
    expect(list.text).toContain('thread-1')
    expect(list.text).toContain('ses_1')

    const read = await tool.execute({ session_id: 'ses_1' } as never)
    expect(read.text).toContain('登录页点了没反应')

    const missing = await tool.execute({ session_id: '不存在' } as never)
    expect(missing.text).toContain('没有找到会话')
  })
})

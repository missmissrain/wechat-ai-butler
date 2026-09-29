/**
 * 清空上下文测试：会话 id 的代次、会话文件路径推导、以及"只删会话目录"的防误删。
 *
 * 上下文属于"这次聊天记得什么"，与长期记忆（时间线/图谱）分开，所以单独一组用例。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeGraphStore } from '../src/memory/graphStore.ts'
import { TimelineStore } from '../src/memory/timelineStore.ts'
import {
  clear_directory_contents,
  delete_session_artifacts,
  directory_bytes,
  encode_segment,
  project_key,
  session_dir_path,
} from '../src/session/sessionFiles.ts'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'

let dirs: string[] = []

function fresh_dir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 上可能仍被占用 */ }
  }
  dirs = []
})

describe('会话 id 的代次（epoch）', () => {
  it('没清空过用原名；清空一次后代次 +1 并换新会话 id', () => {
    const store = new WeixinStateStore({ path: join(fresh_dir('epoch-'), 'state.db') })
    const user = 'u1@im.wechat'

    expect(store.context_epoch(user)).toBe(0)
    expect(store.session_id_for(user)).toBe(`weixin-${user}`)

    // 清空上下文：清路由 + 代次 +1
    store.set_session_id(user, store.session_id_for(user))
    store.clear_session_id(user)
    expect(store.bump_context_epoch(user)).toBe(1)

    // 关键：下一条消息拿到的是**新会话 id**（否则会恢复回旧上下文）
    expect(store.session_id_for(user)).toBe(`weixin-${user}-c1`)
    expect(store.get_session_id(user)).toBeUndefined()
    expect(store.bump_context_epoch(user)).toBe(2)
    store.close()
  })
})

describe('会话文件路径与回收', () => {
  it('路径规则与 harness 一致：@ 被编码成 ~0040，工程目录外裹 --…--', () => {
    expect(encode_segment('weixin-u@im.wechat')).toBe('weixin-u~0040im.wechat')
    expect(encode_segment('..')).toBe('~002E~002E')
    expect(project_key('G:\\desktop\\项目')).toBe('--G-desktop-~9879~76EE--')
    const dir = session_dir_path('C:\\root', 'G:\\ws', 'weixin-u@im.wechat')
    expect(dir).toBe(join('C:\\root', '--G-ws--', 'weixin-u~0040im.wechat'))
  })

  it('删除会话目录：删掉指定的那一个；不像会话目录就跳过', () => {
    const root = fresh_dir('sessions-')
    const cwd = 'G:\\ws'
    const id = 'weixin-u@im.wechat'
    const other = 'weixin-other@im.wechat'

    // 造两个会话目录（其中一个不是会话目录，用来验证防误删）
    const target = session_dir_path(root, cwd, id)
    const stranger = session_dir_path(root, cwd, other)
    mkdirSync(target, { recursive: true })
    mkdirSync(stranger, { recursive: true })
    writeFileSync(join(target, 'session.v3.jsonl.zstd'), 'x')
    writeFileSync(join(stranger, 'notes.txt'), 'x')

    expect(delete_session_artifacts({ root, cwd, id }).deleted).toBe(true)
    expect(existsSync(target)).toBe(false)
    // 别人的目录一个字节都没动
    expect(existsSync(join(stranger, 'notes.txt'))).toBe(true)

    // 不像会话目录 → 拒绝删除并说明原因
    const refused = delete_session_artifacts({ root, cwd, id: other })
    expect(refused.deleted).toBe(false)
    expect(refused.reason).toContain('不像会话目录')
    expect(existsSync(stranger)).toBe(true)

    // 不存在 → 跳过，不报错（还没落盘的会话就是这样）
    const missing = delete_session_artifacts({ root, cwd, id: 'weixin-never@im.wechat' })
    expect(missing.deleted).toBe(false)
    expect(missing.reason).toContain('不存在')
  })
})

describe('长期记忆的清空', () => {
  it('清目录内容：连子目录一起清掉，目录本身保留', () => {
    const dir = fresh_dir('clear-')
    mkdirSync(join(dir, 'days'), { recursive: true })
    writeFileSync(join(dir, 'index.json'), '{}')
    writeFileSync(join(dir, 'days', '2026-09-20.jsonl'), 'x'.repeat(100))

    const result = clear_directory_contents(dir)
    expect(result.files).toBe(2)
    expect(result.bytes).toBeGreaterThan(100)
    expect(existsSync(join(dir, 'index.json'))).toBe(false)
    expect(existsSync(join(dir, 'days'))).toBe(false)
    expect(existsSync(dir)).toBe(true)                       // 目录本身还在，存储层能继续用
  })

  it('时间线：清空后必须忘记缓存，否则还会列出已经不存在的天', () => {
    const dir = fresh_dir('timeline-')
    const timeline = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
    timeline.append({ id: 'm1', ts: Date.now(), role: 'user', text: '今天聊了小李搬家' })
    expect(timeline.list_days()).toHaveLength(1)

    clear_directory_contents(dir)
    timeline.forget_caches()
    // 缓存没清的话这里还会返回那一天（元数据是按天缓存的）
    expect(timeline.list_days()).toEqual([])
    expect(timeline.stats().entries).toBe(0)
  })

  it('图谱：清空后重建中心，并把水位归零（否则再也消化不了旧记录）', () => {
    const dir = fresh_dir('graph-')
    const graph = new KnowledgeGraphStore({ dir })
    graph.ensure_center()
    graph.set_last_update(123456, ['weixin-u:1'])
    graph.upsert_person({ name: '王丽' })
    expect(graph.stats().people).toBe(3)

    const removed = clear_directory_contents(dir)
    expect(removed.files).toBeGreaterThan(0)
    expect(graph.stats()).toEqual({ people: 0, relations: 0 })

    graph.ensure_center()
    graph.reset_watermark()
    expect(graph.stats()).toEqual({ people: 2, relations: 2 })   // 中心回来了
    expect(graph.last_update_ms()).toBeUndefined()               // 水位归零
    // 归零后旧记录会被重新消化（原来会被 `ts > since` 永久跳过）
    expect(graph.last_update_ids()).toEqual([])
  })
})

describe('目录体量统计', () => {
  it('递归统计，用于控制台展示真实占用', () => {
    const dir = fresh_dir('bytes-')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(10))
    writeFileSync(join(dir, 'sub', 'b.bin'), Buffer.alloc(20))
    expect(directory_bytes(dir)).toBe(30)
    expect(directory_bytes(join(dir, '不存在'))).toBe(0)
  })
})

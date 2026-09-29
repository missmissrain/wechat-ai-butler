/**
 * 时间线（长期记忆）存储测试：一天一个 node、摘要可更新、记录可检索、追加幂等。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { InboundCoordinator } from '../src/coordination/inboundCoordinator.ts'
import { OutboundCoordinator } from '../src/coordination/outboundCoordinator.ts'
import { create_gemma_image_describer, create_gemma_summarizer } from '../src/memory/gemmaSummarizer.ts'
import { start_timeline_scheduler } from '../src/memory/timelineScheduler.ts'
import { register_timeline_tools } from '../src/memory/timelineTools.ts'
import { TimelineStore } from '../src/memory/timelineStore.ts'
import type { TimelineEntry } from '../src/memory/timelineTypes.ts'
import { TurnContextStore } from '../src/state/turnContextStore.ts'
import { WeixinStateStore } from '../src/state/weixinStateStore.ts'
import type { WeixinSessionHost } from '../src/session/weixinSessionHost.ts'

let dirs: string[] = []

function fresh_store(options?: { persist_reasoning?: boolean }): TimelineStore {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-'))
  dirs.push(dir)
  return new TimelineStore({
    dir,
    timezone: 'Asia/Shanghai',
    ...options,
  })
}

/** 造一条记录。 */
function entry(partial: Partial<TimelineEntry> & { ts: number; role: TimelineEntry['role']; text: string }): TimelineEntry {
  return { id: partial.id ?? `id-${partial.ts}-${partial.role}`, ...partial }
}

/** 最近一次建出来的临时目录（TS 里索引访问可能为 undefined，这里集中收口）。 */
function last_dir(): string {
  return dirs[dirs.length - 1] as string
}

/** 建一个临时状态库（时间线之外的 weixin 状态）。 */
function fresh_state_store(): WeixinStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-state-'))
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

describe('TimelineStore', () => {
  it('把记录写进对应日期的 node，并生成索引与人类可读视图', () => {
    const store = fresh_store()
    // 2026-09-20T15:00Z = 本地 23:00（Asia/Shanghai）
    const ts = Date.parse('2026-09-20T15:00:00Z')
    expect(store.append(entry({ ts, role: 'user', text: '帮我记一下明天要交电费' }))).toBe(true)
    expect(store.append(entry({ ts: ts + 60_000, role: 'assistant', text: '好呀，我记下啦' }))).toBe(true)

    const day = store.read_day('2026-09-20')
    expect(day.meta.entries).toBe(2)
    expect(day.meta.user_entries).toBe(1)
    expect(day.meta.assistant_entries).toBe(1)
    expect(day.entries.map(item => item.role)).toEqual(['user', 'assistant'])

    expect(store.list_days().map(meta => meta.date)).toEqual(['2026-09-20'])
    expect(store.stats()).toEqual({
      days: 1, entries: 2, first_date: '2026-09-20', last_date: '2026-09-20',
    })

    // 视图（.md）是**惰性重建**的：写入路径不做重活（否则会阻塞微信主链路）。
    // 需要立刻看到最新视图时，显式 flush（调度器/停止流程也会调）。
    store.flush_views()
    const view = readFileSync(join(last_dir(), 'days', '2026-09-20.md'), 'utf8')
    expect(view).toContain('# 2026-09-20')
    expect(view).toContain('帮我记一下明天要交电费')
    expect(view).toContain('好呀，我记下啦')
  })

  it('同一 id 重复追加会被忽略（崩溃重放不会留下重复对话）', () => {
    const store = fresh_store()
    const ts = Date.parse('2026-09-20T02:00:00Z')
    const item = entry({ id: 'delivery-abc', ts, role: 'user', text: '在吗' })
    expect(store.append(item)).toBe(true)
    expect(store.append(item)).toBe(false)
    expect(store.read_day('2026-09-20').entries).toHaveLength(1)
  })

  it('跨午夜会落到两个不同的 day node', () => {
    const store = fresh_store()
    // 本地 23:59 → 次日 00:01
    store.append(entry({ ts: Date.parse('2026-09-20T15:59:00Z'), role: 'user', text: '晚安' }))
    store.append(entry({ ts: Date.parse('2026-09-20T16:01:00Z'), role: 'user', text: '早安' }))
    expect(store.list_days().map(meta => meta.date)).toEqual(['2026-09-20', '2026-09-21'])
    expect(store.read_day('2026-09-20').entries[0]?.text).toBe('晚安')
    expect(store.read_day('2026-09-21').entries[0]?.text).toBe('早安')
  })

  it('摘要可更新、可读取，且重新生成视图不会覆盖它', () => {
    const store = fresh_store()
    store.append(entry({ ts: Date.parse('2026-09-20T02:00:00Z'), role: 'user', text: '讨论时间线设计' }))
    store.update_summary('2026-09-20', '今天定了时间线的数据结构：一天一个 node。', { model: 'test-model' })

    expect(store.read_summary('2026-09-20')).toContain('一天一个 node')
    const day = store.read_day('2026-09-20')
    expect(day.summary).toContain('一天一个 node')
    expect(day.meta.summary_model).toBe('test-model')
    expect(day.meta.summary_updated_at).toBeGreaterThan(0)

    // 重新生成视图（模拟人工改坏了 md）后，摘要仍来自权威 summary.md
    const dir = last_dir()
    writeFileSync(join(dir, 'days', '2026-09-20.md'), '被改坏了', 'utf8')
    store.regenerate_view('2026-09-20')
    expect(readFileSync(join(dir, 'days', '2026-09-20.md'), 'utf8')).toContain('一天一个 node')
  })

  it('区间读取与关键词搜索', () => {
    const store = fresh_store()
    store.append(entry({ ts: Date.parse('2026-09-19T02:00:00Z'), role: 'user', text: '周末去爬山' }))
    store.append(entry({ ts: Date.parse('2026-09-20T02:00:00Z'), role: 'assistant', text: '爬山记得带水' }))
    store.append(entry({ ts: Date.parse('2026-09-21T02:00:00Z'), role: 'user', text: '今天下雨' }))

    expect(store.read_range('2026-09-19', '2026-09-20').map(day => day.meta.date))
      .toEqual(['2026-09-19', '2026-09-20'])

    const hits = store.search('爬山')
    expect(hits).toHaveLength(2)
    // 倒序：新的在前
    expect(hits[0]?.date).toBe('2026-09-20')
    expect(store.search('爬山', { from: '2026-09-19', to: '2026-09-19' })).toHaveLength(1)
    expect(store.search('')).toEqual([])
  })

  it('模型推理默认不落盘；显式开启后才写入', () => {
    const off = fresh_store()
    off.append(entry({
      ts: Date.parse('2026-09-20T02:00:00Z'), role: 'assistant', text: '答复',
      reasoning: '这是内部推理',
    }))
    expect(off.read_day('2026-09-20').entries[0]?.reasoning).toBeUndefined()

    const on = fresh_store({ persist_reasoning: true })
    on.append(entry({
      ts: Date.parse('2026-09-20T02:00:00Z'), role: 'assistant', text: '答复',
      reasoning: '这是内部推理',
    }))
    expect(on.read_day('2026-09-20').entries[0]?.reasoning).toBe('这是内部推理')
  })

  it('索引丢失/损坏时自动从记录文件重建（数据不会"存在但不可发现"）', () => {
    const store = fresh_store()
    store.append(entry({ ts: Date.parse('2026-09-20T02:00:00Z'), role: 'user', text: '一' }))
    store.append(entry({ ts: Date.parse('2026-09-21T02:00:00Z'), role: 'user', text: '二' }))
    const dir = last_dir()

    // 索引直接删掉：读取时必须自动重建，而不是返回空表
    rmSync(join(dir, 'index.json'))
    expect(store.list_days().map(meta => meta.date)).toEqual(['2026-09-20', '2026-09-21'])
    expect(store.stats().entries).toBe(2)

    // 索引写坏（不是合法 JSON）：同样要自愈
    writeFileSync(join(dir, 'index.json'), '{坏掉的索引', 'utf8')
    expect(store.list_days().map(meta => meta.date)).toEqual(['2026-09-20', '2026-09-21'])

    // 显式重建也仍然可用
    expect(store.rebuild_index()).toBe(2)
    expect(store.stats().entries).toBe(2)
  })

  it('索引损坏后继续追加，条数不会算重', () => {
    const store = fresh_store()
    const ts = Date.parse('2026-09-20T02:00:00Z')
    store.append(entry({ id: 'a', ts, role: 'user', text: '一' }))
    const dir = last_dir()
    rmSync(join(dir, 'index.json'))
    // 索引没了再追加：基数必须取自记录文件，而不是"重建结果 + 1"
    store.append(entry({ id: 'b', ts: ts + 1000, role: 'assistant', text: '二' }))
    const meta = store.read_day('2026-09-20').meta
    expect(meta.entries).toBe(2)
    expect(meta.user_entries).toBe(1)
    expect(meta.assistant_entries).toBe(1)
    expect(store.stats().entries).toBe(2)
  })

  it('单行损坏不会让整天不可读', () => {
    const store = fresh_store()
    store.append(entry({ ts: Date.parse('2026-09-20T02:00:00Z'), role: 'user', text: '正常一条' }))
    const dir = last_dir()
    const path = join(dir, 'days', '2026-09-20.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf8')}{坏行\n`, 'utf8')
    const day = store.read_day('2026-09-20')
    expect(day.entries).toHaveLength(1)
    expect(day.entries[0]?.text).toBe('正常一条')
  })

  it('按"空闲 N 小时"决定是否更新摘要', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-'))
    dirs.push(dir)
    const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai', idle_ms: 3 * 3_600_000 })
    const HOUR = 3_600_000
    // 用"相对当前"的时间，避免与真实 now 打架
    const now = Date.now()
    const last_message_at = now - 10 * HOUR
    const date = store.day_key(last_message_at)
    store.append(entry({ ts: last_message_at, role: 'user', text: '帮我订明天的会议室' }))

    // 才空闲 2 小时：不该总结
    expect(store.days_needing_summary(now - 8 * HOUR)).toEqual([])
    // 空闲已 10 小时：该总结
    expect(store.days_needing_summary(now)).toEqual([date])

    const calls: string[] = []
    const done = await store.summarize_due(async request => {
      calls.push(request.date)
      return { text: `- 用户要订会议室\n- 日期：${request.date}`, model: 'fake' }
    }, now)
    expect(calls).toEqual([date])
    expect(done).toEqual([date])
    expect(store.read_summary(date)).toContain('用户要订会议室')

    // 摘要已覆盖最后一条记录：不再重复总结
    expect(store.days_needing_summary(now)).toEqual([])

    // 来了新对话 → 该日重新变"待总结"。
    // 注意：这里不能用"相对当前时间"的固定偏移去断言日期键——跨午夜时会落到第二天，
    // 测试就随运行时刻时好时坏（踩过）。用 day_key 现算，才与运行时刻无关。
    store.append(entry({ ts: now + HOUR, role: 'user', text: '再帮我订一杯咖啡' }))
    const new_date = store.day_key(now + HOUR)
    expect(store.days_needing_summary(now + 5 * HOUR)).toContain(new_date)
  })

  it('摘要器抛错不会影响其它日期', async () => {
    const store = fresh_store()
    store.append(entry({ ts: Date.parse('2026-09-19T02:00:00Z'), role: 'user', text: '一' }))
    store.append(entry({ ts: Date.parse('2026-09-20T02:00:00Z'), role: 'user', text: '二' }))
    const done = await store.summarize_due(async request => {
      if (request.date === '2026-09-19') throw new Error('boom')
      return { text: '- ok' }
    }, Date.parse('2026-09-25T00:00:00Z'))
    expect(done).toEqual(['2026-09-20'])
    expect(store.read_summary('2026-09-19')).toBeUndefined()
  })

  it('可按用户/会话维度过滤读取与搜索', () => {
    const store = fresh_store()
    const ts = Date.parse('2026-09-20T02:00:00Z')
    store.append(entry({ ts, role: 'user', text: '妈妈：买牛奶', user_id: 'u1', session_id: 's1' }))
    store.append(entry({ ts: ts + 1000, role: 'user', text: '爸爸：修水管', user_id: 'u2', session_id: 's2' }))

    expect(store.read_day('2026-09-20').entries).toHaveLength(2)
    expect(store.read_day('2026-09-20', { user_id: 'u1' }).entries).toHaveLength(1)
    expect(store.read_day('2026-09-20', { user_id: 'u1' }).meta.entries).toBe(1)
    expect(store.search('爸爸')).toHaveLength(1)
    expect(store.search('爸爸', { user_id: 'u2' })).toHaveLength(1)
    expect(store.search('爸爸', { user_id: 'u1' })).toHaveLength(0)
    expect(store.search('爸爸', { session_id: 's1' })).toHaveLength(0)
  })

  it('推理落盘开关可由环境变量打开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-'))
    dirs.push(dir)
    const previous = process.env.DSH_TIMELINE_PERSIST_REASONING
    process.env.DSH_TIMELINE_PERSIST_REASONING = '1'
    try {
      const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
      store.append(entry({
        ts: Date.parse('2026-09-20T02:00:00Z'), role: 'assistant', text: '答复',
        reasoning: '环境变量打开的推理',
      }))
      expect(store.read_day('2026-09-20').entries[0]?.reasoning).toBe('环境变量打开的推理')
    } finally {
      if (previous === undefined) delete process.env.DSH_TIMELINE_PERSIST_REASONING
      else process.env.DSH_TIMELINE_PERSIST_REASONING = previous
    }
  })

  it('非法日期键会被拒绝，避免拼出奇怪路径（保留）', () => {
    const store = fresh_store()
    expect(() => store.read_day('../etc/passwd')).toThrow()
    expect(() => store.update_summary('2026/09/20', 'x')).toThrow()
    expect(existsSync(join(last_dir(), 'days'))).toBe(true)
  })
})

describe('时间线接入：写入与摘要调度', () => {
  it('用户上行在登记时即写入长期记忆（即使后续注入失败）', async () => {
    const timeline = fresh_store()
    const state = fresh_state_store()
    const recorded: TimelineEntry[] = []
    const inbound = new InboundCoordinator({
      store: state,
      turn_context: new TurnContextStore(state),
      // 宿主故意不可用：验证"记录"不依赖注入是否成功
      host: {
        get_agent: () => undefined,
        resume_agent: () => { throw new Error('no host') },
      } as unknown as WeixinSessionHost,
      enqueue_outbound: () => { /* 不关心 */ },
      record_entry: item => { recorded.push(item) },
    })
    await inbound.handle_batch([{
      delivery_id: 'd-1', user_id: 'u1', text: '帮我记一下周五交房租', media: [], received_at: Date.now(),
    }], undefined)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ id: 'd-1', role: 'user', text: '帮我记一下周五交房租', user_id: 'u1' })
    // 真的写进了时间线，而不只是回调被调用
    timeline.append(recorded[0]!)
    expect(timeline.read_day(timeline.day_key(recorded[0]!.ts)).entries[0]?.text).toBe('帮我记一下周五交房租')

    // 同一条 delivery 再投递一次：不重复记录
    await inbound.handle_batch([{
      delivery_id: 'd-1', user_id: 'u1', text: '帮我记一下周五交房租', media: [], received_at: Date.now(),
    }], undefined)
    expect(recorded).toHaveLength(1)
    state.close()
  })

  it('最终回复在入队时写入；通知类不写', () => {
    const state = fresh_state_store()
    const recorded: TimelineEntry[] = []
    const outbound = new OutboundCoordinator({
      store: state,
      turn_context: new TurnContextStore(state),
      sender: async () => undefined,
      classify_retryable: () => true,
      record_entry: item => { recorded.push(item) },
    })
    outbound.enqueue_assistant({ session_id: 's1', user_id: 'u1', turn: 7, text: '好呀，我记下了' })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ role: 'assistant', text: '好呀，我记下了', turn: 7, session_id: 's1' })

    // 进度/完成通知属于系统噪声，不进长期记忆
    outbound.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'progress', text: '（进度·欣爱在想）…' })
    outbound.enqueue_notice({ session_id: 's1', user_id: 'u1', kind: 'assistant', text: 'Codex 任务已完成…' })
    expect(recorded).toHaveLength(1)
    outbound.stop()
    state.close()
  })

  it('Gemma 摘要器：短输入单次调用，长输入自动分块 map-reduce', async () => {
    const calls: string[] = []
    const fake_fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      calls.push(body.messages[0]!.content)
      return new Response(JSON.stringify({
        choices: [{ message: { content: '- 用户交代了若干事项' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const summarize = create_gemma_summarizer({ fetch_impl: fake_fetch, chunk_chars: 200 })
    const short = await summarize({
      date: '2026-09-20', timezone: 'Asia/Shanghai',
      entries: [{ id: 'a', ts: 1, role: 'user', text: '短' }],
    })
    expect(short.text).toBe('- 用户交代了若干事项')
    expect(short.model).toBe('gemma-4-E4B-it-Q4_K_M')
    expect(calls).toHaveLength(1)

    calls.length = 0
    const many: TimelineEntry[] = Array.from({ length: 20 }, (_, index) => ({
      id: `e${index}`, ts: index, role: 'user' as const, text: 'x'.repeat(50),
    }))
    const long = await summarize({ date: '2026-09-20', timezone: 'Asia/Shanghai', entries: many })
    // 分块小结 N 次 + 合并 1 次
    expect(calls.length).toBeGreaterThan(2)
    expect(calls[calls.length - 1]).toContain('合并')
    expect(long.text).toBe('- 用户交代了若干事项')
  })

  it('不把上一版摘要喂回模型（否则旧错误会自我延续）', async () => {
    const prompts: string[] = []
    const fake_fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      prompts.push(body.messages[0]!.content)
      return new Response(JSON.stringify({ choices: [{ message: { content: '- 事实：ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const summarize = create_gemma_summarizer({ fetch_impl: fake_fetch })
    // 用唯一标记代表"上一版摘要里的错误内容"，便于精确断言它没被送进提示词
    const poisoned = '- 事实：用户明天要去医院复查（已完成）POISON_MARKER'
    await summarize({
      date: '2026-09-20', timezone: 'Asia/Shanghai',
      entries: [{ id: 'a', ts: 1, role: 'user', text: '明天去医院复查' }],
      previous_summary: poisoned,
    })
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]!
    // 实测教训：把旧摘要当参考会让模型照抄错误，所以旧摘要绝不进提示词。
    expect(prompt).not.toContain('POISON_MARKER')
    expect(prompt).not.toContain('上一版摘要')
    // 但当天原始记录必须照常送进去（规则里提到"（已完成）"是合法的）
    expect(prompt).toContain('明天去医院复查')
  })

  it('摘要器请求失败会向上抛，交给按天兜底', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const summarize = create_gemma_summarizer({ fetch_impl: failing })
    await expect(summarize({
      date: '2026-09-20', timezone: 'Asia/Shanghai',
      entries: [{ id: 'a', ts: 1, role: 'user', text: 'x' }],
    })).rejects.toThrow(/500/)
  })

  it('媒体只存引用：可后补到已有记录上，并把描述写进视图', () => {
    const store = fresh_store()
    const now = Date.now()
    store.append(entry({ id: 'msg-1', ts: now, role: 'user', text: '看我拍的照片' }))

    const ok = store.update_entry(store.day_key(now), 'msg-1', {
      attachments: [{ id: 'att-abc', media_type: 'image/jpeg', bytes: 304_000, width: 1280, height: 960 }],
    })
    expect(ok).toBe(true)
    const saved = store.read_day(store.day_key(now)).entries[0]
    expect(saved?.attachments).toHaveLength(1)
    // 只存引用，不复制文件内容
    expect(saved?.attachments?.[0]).toEqual({
      id: 'att-abc', media_type: 'image/jpeg', bytes: 304_000, width: 1280, height: 960,
    })

    // 视觉模型跑完后回填描述
    expect(store.update_attachment_description(store.day_key(now), 'msg-1', 'att-abc', '一张蓝天白云下的草地照片')).toBe(true)
    expect(store.read_day(store.day_key(now)).entries[0]?.attachments?.[0]?.description)
      .toBe('一张蓝天白云下的草地照片')

    // 视图里能看到引用与描述
    const view = readFileSync(join(last_dir(), 'days', `${store.day_key(now)}.md`), 'utf8')
    expect(view).toContain('att-abc')
    expect(view).toContain('一张蓝天白云下的草地照片')

    // 不存在的记录/附件不会瞎写
    expect(store.update_entry(store.day_key(now), 'no-such-id', { attachments: [] })).toBe(false)
    expect(store.update_attachment_description(store.day_key(now), 'no-such-id', 'att-abc', 'x')).toBe(false)
  })

  it('图片描述会随当天摘要一起进模型输入', async () => {
    const prompts: string[] = []
    const fake_fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      prompts.push(body.messages[0]!.content)
      return new Response(JSON.stringify({ choices: [{ message: { content: '- 事实：用户发来一张照片' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const summarize = create_gemma_summarizer({ fetch_impl: fake_fetch })
    await summarize({
      date: '2026-09-20', timezone: 'Asia/Shanghai',
      entries: [{
        id: 'msg-1', ts: 1, role: 'user', text: '看我拍的照片',
        attachments: [{ id: 'att-abc', media_type: 'image/jpeg', description: '蓝天白云下的草地' }],
      }],
    })
    expect(prompts[0]).toContain('蓝天白云下的草地')
  })

  it('图片描述器：走视觉通道，把图片以 data URL 发给模型', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fake_fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张猫咪趴在窗台上' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const describe = create_gemma_image_describer({ fetch_impl: fake_fetch })
    const text = await describe({ data: new Uint8Array([1, 2, 3, 4]), media_type: 'image/jpeg' })
    expect(text).toBe('一张猫咪趴在窗台上')

    const content = (bodies[0]?.messages as Array<{ content: unknown }>)[0]?.content as Array<Record<string, unknown>>
    const image = content.find(part => part.type === 'image_url') as { image_url: { url: string } }
    expect(image.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    // 4 字节 [1,2,3,4] 的 base64 是 AQIDBA==
    expect(image.image_url.url.endsWith('AQIDBA==')).toBe(true)
  })

  it('三层工具：注册名称正确，且各层行为符合约定', async () => {
    const store = fresh_store()
    const ts = Date.parse('2026-09-20T02:00:00Z')
    store.append(entry({ ts, role: 'user', text: '提醒我周五交房租' }))
    store.append(entry({ ts: ts + 1000, role: 'assistant', text: '记好啦～周五早上9点提醒你' }))
    store.update_summary('2026-09-20', '- 待办：交房租（周五早上9点）', { model: 'test' })

    // 用一个最小的假 ctx 捕获注册进来的工具
    const registered: Array<{ name: string, execute: (args: never) => Promise<{ ok: boolean, text: string }> }> = []
    register_timeline_tools(
      { tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[number]) } } } as unknown as Context,
      store,
    )
    expect(registered.map(tool => tool.name)).toEqual(['timeline_days', 'timeline_search', 'timeline_read'])

    const [days, search, read] = registered as [typeof registered[0], typeof registered[0], typeof registered[0]]

    // L1：只给日期/条数/摘要
    const days_out = await days!.execute({ limit: 5 } as never)
    expect(days_out.ok).toBe(true)
    expect(days_out.text).toContain('2026-09-20')
    expect(days_out.text).toContain('交房租')

    // L2：关键词命中，返回日期+片段
    const hit = await search!.execute({ keyword: '房租' } as never)
    expect(hit.text).toContain('2026-09-20')
    expect(hit.text).toContain('交房租')
    // 没命中时明确说"没找到"，不要含糊（防模型编造）
    const miss = await search!.execute({ keyword: '不存在的词XYZ' } as never)
    expect(miss.text).toContain('没有找到')

    // L3：摘要 + 原文
    const one = await read!.execute({ date: '2026-09-20' } as never)
    expect(one.text).toContain('摘要：')
    expect(one.text).toContain('[用户] 提醒我周五交房租')
    expect(one.text).toContain('[我] 记好啦')
    // 只看摘要时不带原文
    const summary_only = await read!.execute({ date: '2026-09-20', include_entries: false } as never)
    expect(summary_only.text).not.toContain('[用户]')
    // 非法日期要报错，不能猜
    expect((await read!.execute({ date: '2026/09/20' } as never)).ok).toBe(false)
    // 空日期如实说明
    expect((await read!.execute({ date: '2020-01-01' } as never)).text).toContain('没有对话记录')
  })

  it('调度器只在日期真正到期时才调用摘要器', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-'))
    dirs.push(dir)
    const HOUR = 3_600_000
    const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai', idle_ms: 3 * HOUR })
    const now = Date.now()
    store.append(entry({ ts: now - 10 * HOUR, role: 'user', text: '一天前说的话' }))
    const date = store.day_key(now - 10 * HOUR)

    const seen: string[] = []
    const scheduler = start_timeline_scheduler({
      store,
      summarizer: async request => {
        seen.push(request.date)
        return { text: '- 记住了' }
      },
      interval_ms: 3_600_000,
    })
    try {
      expect(await scheduler.run_once(now - 8 * HOUR)).toEqual([])
      expect(await scheduler.run_once(now)).toEqual([date])
      expect(seen).toEqual([date])
      // 已总结且无新记录：不再触发
      expect(await scheduler.run_once(now)).toEqual([])
    } finally {
      scheduler.stop()
    }
  })
})

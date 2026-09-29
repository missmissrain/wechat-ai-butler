/**
 * 图谱更新测试：中文短协议解析容错 + 分块抽取 + 指代候选 + 逐节点审核 + 新增人物。
 *
 * 用假的 complete() 注入"模型输出"，所以测的是**管线与协议**，不依赖 Gemma 在线。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeGraphStore } from '../src/memory/graphStore.ts'
import { parse_facts, render_candidates } from '../src/memory/graphProtocol.ts'
import { update_graph_from_records } from '../src/memory/graphUpdater.ts'

let dirs: string[] = []

function fresh_graph(): KnowledgeGraphStore {
  const dir = mkdtempSync(join(tmpdir(), 'graphup-'))
  dirs.push(dir)
  return new KnowledgeGraphStore({ dir })
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 句柄可能未释放 */ }
  }
  dirs = []
})

describe('中文短协议解析', () => {
  it('只认行首标签，坏行跳过而不影响其它行', () => {
    const parsed = parse_facts([
      '人物|小李|小李小李',
      '属性|小李|职业|工程师',
      '这行是模型多写的一句话，应当被忽略',
      '关系|主人|小李|同事',
      '属性|小李|',            // 值缺失 → 坏行
      '更新|职业|医生',         // 这是审核协议的标签，抽取阶段不认识 → 坏行
      '无',
      '',
      '关系|主人|小李|同事',
    ].join('\n'))

    expect(parsed.facts).toEqual([
      { kind: 'person', name: '小李', aliases: ['小李小李'] },
      { kind: 'attribute', name: '小李', field: '职业', value: '工程师' },
      { kind: 'relation', from: '主人', to: '小李', label: '同事' },
      { kind: 'relation', from: '主人', to: '小李', label: '同事' },
    ])
    expect(parsed.bad_lines).toHaveLength(3)
  })

  it('指代候选会把别名一起列出（别名也是可被指代的名字）', () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '王丽', aliases: ['妈妈', '妈'] })
    graph.upsert_person({ name: '张伟' })
    const rendered = render_candidates(['王丽', '妈妈', '妈', '张伟', '王丽'])
    expect(rendered).toBe('王丽、妈妈、妈、张伟')
  })
})

describe('图谱更新管线', () => {
  /** 造一个"按提示词内容返回不同协议输出"的假模型。 */
  function fake_model(handlers: {
    extract?: (prompt: string) => string
    review?: (prompt: string) => string
    newPerson?: (prompt: string) => string
  }): { complete: (prompt: string) => Promise<string>, prompts: string[] } {
    const prompts: string[] = []
    return {
      prompts,
      complete: async (prompt: string) => {
        prompts.push(prompt)
        if (prompt.includes('决定要不要给关系图添加')) return handlers.newPerson?.(prompt) ?? '无'
        if (prompt.includes('审核一个人物档案')) return handlers.review?.(prompt) ?? '无'
        return handlers.extract?.(prompt) ?? '无'
      },
    }
  }

  it('从记录里抽出人物/属性/关系并落库，指代换不出姓名时走未绑定', async () => {
    const graph = fresh_graph()
    const model = fake_model({
      extract: () => [
        '人物|小李',
        '属性|小李|职业|工程师',
        '属性|小李|所在地|杭州',
        '关系|我|小李|同事',
        '未绑定|那个人|之前那个人还说要请我吃饭',
      ].join('\n'),
    })

    const result = await update_graph_from_records(
      { graph, complete: model.complete },
      [
        { date: '2026-09-20', role: 'user', text: '我同事小李最近搬家了' },
        { date: '2026-09-20', role: 'user', text: '之前那个人还说要请我吃饭' },
      ],
    )

    expect(result.people_created).toContain('小李')
    expect(result.relations_created).toBe(1)
    // 换不出姓名的指代被如实记录，而不是硬猜
    expect(result.unresolved).toBe(1)

    const li = graph.find('小李')
    expect(li?.occupation).toBe('工程师')
    expect(li?.location).toBe('杭州')
    // 记录里的"我"被归一化到图谱规范名"主人"，不会凭空建一个"我"节点
    expect(graph.find('我')).toBeUndefined()
    expect(graph.edges_from(graph.find('主人')!.id).map(edge => edge.label)).toContain('同事')
    // 证据可追溯
    expect(li?.sources?.[0]?.date).toBe('2026-09-20')
  })

  it('每次抽取调用都带上"指代候选"名单，让指代变成选择题', async () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '王丽', aliases: ['妈妈'] })
    graph.upsert_person({ name: '小李' })
    const model = fake_model({ extract: () => '无' })

    await update_graph_from_records(
      { graph, complete: model.complete },
      [{ date: '2026-09-20', role: 'user', text: '随便说点什么' }],
    )

    const extract_prompt = model.prompts[0]!
    expect(extract_prompt).toContain('已知人物名单')
    expect(extract_prompt).toContain('王丽')
    expect(extract_prompt).toContain('妈妈')      // 别名也在候选里
    expect(extract_prompt).toContain('小李')
    expect(extract_prompt).toContain('未绑定')    // 换不出姓名时的出口
  })

  it('长记录会分块，且每块的输入都很短（为省显存）', async () => {
    const graph = fresh_graph()
    const model = fake_model({ extract: () => '无' })
    const records = Array.from({ length: 30 }, (_, index) => ({
      date: '2026-09-20', role: 'user' as const, text: `第${index}句：${'内容'.repeat(40)}`,
    }))

    const result = await update_graph_from_records(
      { graph, complete: model.complete, chunk_chars: 800 },
      records,
    )

    expect(result.chunks).toBeGreaterThan(3)
    // 每个抽取提示词都不超过"块预算 + 固定说明"太多，说明没有把整段塞进去
    for (const prompt of model.prompts.filter(item => item.includes('本块聊天记录'))) {
      expect(prompt.length).toBeLessThan(3_000)
    }
  })

  it('跨块不丢上下文：上一块的"上文提要"与已提取事实会带进下一块', async () => {
    const graph = fresh_graph()
    const prompts: string[] = []
    const model = {
      complete: async (prompt: string) => {
        prompts.push(prompt)
        // 第一块：给出提要与事实；第二块起：模拟"用上一块的提要把指代解开"
        const is_first_chunk = prompts.filter(item => item.includes('本块聊天记录')).length === 1
        if (is_first_chunk) {
          return ['上文|这一块提到同事小李要去上海', '属性|小李|所在地|上海'].join('\n')
        }
        return '属性|小李|职业|工程师'
      },
    }

    const records = [
      { date: '2026-09-20', role: 'user' as const, text: `我同事小李要去上海了${'内容'.repeat(300)}` },
      { date: '2026-09-20', role: 'user' as const, text: `之前那个人说他会写代码${'内容'.repeat(300)}` },
    ]
    await update_graph_from_records(
      { graph, complete: model.complete, chunk_chars: 600 },
      records,
    )

    const chunk_prompts = prompts.filter(item => item.includes('本块聊天记录'))
    expect(chunk_prompts.length).toBeGreaterThanOrEqual(2)
    const second = chunk_prompts[1]!
    // 关键：第二块必须能看到第一块的压缩上下文
    expect(second).toContain('前文提要')
    expect(second).toContain('同事小李要去上海')
    expect(second).toContain('前面已提取的事实')
    expect(second).toContain('属性|小李|所在地|上海')
  })

  it('超限时把"旧压缩块 + 当前块"合并压缩成一个新块，而不是丢弃旧提要', async () => {
    const graph = fresh_graph()
    const prompts: string[] = []
    let merge_calls = 0
    const model = {
      complete: async (prompt: string) => {
        prompts.push(prompt)
        // 合并压缩调用：返回压缩后的提要 + 事实（把新旧都保住）
        if (prompt.includes('你在压缩一份')) {
          merge_calls += 1
          return [
            '上文|旧提要与新记录已合并：小李要去上海',
            '属性|小李|所在地|上海',
            '属性|小李|职业|工程师',
          ].join('\n')
        }
        // 普通抽取：返回很长的提要，逼出下一轮超限
        return [`上文|${'很长的提要'.repeat(60)}`, '属性|老王|所在地|绍兴'].join('\n')
      },
    }
    const records = Array.from({ length: 10 }, (_, index) => ({
      date: '2026-09-20', role: 'user' as const, text: `第${index}句${'内容'.repeat(150)}`,
    }))

    const result = await update_graph_from_records(
      { graph, complete: model.complete, chunk_chars: 600, max_prompt_chars: 2_500 },
      records,
    )

    // 必须真的走了"合并压缩"这条路，而不是靠丢弃旧信息过关
    expect(merge_calls).toBeGreaterThan(0)
    expect(result.merged_blocks).toBe(merge_calls)
    // 压缩保住的事实仍然落库（小李没被压没）
    expect(graph.find('小李')?.location).toBe('上海')
    // 所有调用都没超过上限
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(2_500)
  })

  it('极端情况下仍有兜底：绝不超上限', async () => {
    const graph = fresh_graph()
    const prompts: string[] = []
    const model = {
      complete: async (prompt: string) => {
        prompts.push(prompt)
        // 每块都产出很长的提要与事实，逼出裁剪
        return [
          `上文|${'提要内容'.repeat(200)}`,
          `属性|某人${prompts.length}|备注|${'值'.repeat(300)}`,
        ].join('\n')
      },
    }
    const records = Array.from({ length: 12 }, (_, index) => ({
      date: '2026-09-20', role: 'user' as const, text: `第${index}句${'内容'.repeat(200)}`,
    }))

    await update_graph_from_records(
      { graph, complete: model.complete, chunk_chars: 400, max_prompt_chars: 3_000 },
      records,
    )

    // 处理记录的调用有两类：普通抽取（本块聊天记录）与合并压缩（新的一段聊天记录）
    const data_prompts = prompts.filter(item =>
      item.includes('本块聊天记录') || item.includes('新的一段聊天记录'))
    expect(data_prompts.length).toBeGreaterThan(2)
    // 没有任何一次调用超过上限——这是"防上下文截断"的底线
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(3_000)
    }
  })

  it('逐节点审核只喂该节点相关的事实，并把更新写回', async () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '小李', occupation: '工程师' })
    graph.upsert_person({ name: '老王' })
    const model = fake_model({
      extract: () => [
        '属性|小李|职业|医生',
        '属性|老王|所在地|绍兴',
      ].join('\n'),
      review: prompt => {
        // 审核小李时，提示词里只能有"小李"的事实
        if (prompt.includes('【人物】小李')) {
          expect(prompt).not.toContain('绍兴')
          return '更新|职业|医生'
        }
        return '无'
      },
    })

    const result = await update_graph_from_records(
      { graph, complete: model.complete },
      [{ date: '2026-09-20', role: 'user', text: '小李现在是医生了' }],
    )

    expect(result.people_updated).toContain('小李')
    expect(graph.find('小李')?.occupation).toBe('医生')
    // 未被审核覆盖的属性仍然按事实落库
    expect(graph.find('老王')?.location).toBe('绍兴')
  })

  it('全部遍历完之后，还会问一次"要不要加新人物"', async () => {
    const graph = fresh_graph()
    const model = fake_model({
      extract: () => '关系|我|小红|朋友',
      newPerson: () => ['人物|小红|红姐', '关系|我|小红|朋友'].join('\n'),
    })

    const result = await update_graph_from_records(
      { graph, complete: model.complete },
      [{ date: '2026-09-20', role: 'user', text: '我和小红是朋友' }],
    )

    // 最后那次调用确实是"新增人物"那一步
    expect(model.prompts[model.prompts.length - 1]).toContain('决定要不要给关系图添加')
    expect(result.people_created).toContain('小红')
    expect(graph.find('红姐')?.id).toBe(graph.find('小红')?.id)
  })

  it('空闲调度：只处理比上次更新更新的记录，且要等真正空闲', async () => {
    const graph = fresh_graph()
    const timeline_dir = mkdtempSync(join(tmpdir(), 'graphup-tl-'))
    dirs.push(timeline_dir)
    const { TimelineStore } = await import('../src/memory/timelineStore.ts')
    const { start_graph_scheduler } = await import('../src/memory/graphScheduler.ts')
    const timeline = new TimelineStore({ dir: timeline_dir, timezone: 'Asia/Shanghai' })
    const HOUR = 3_600_000
    const now = Date.now()
    const old_ts = now - 10 * HOUR

    timeline.append({ id: 'm1', ts: old_ts, role: 'user', text: '我同事小李下个月要去上海' })

    const seen: string[] = []
    const scheduler = start_graph_scheduler({
      graph, timeline, interval_ms: 3_600_000, idle_ms: 3 * HOUR,
      complete: async prompt => {
        seen.push(prompt)
        return '属性|小李|所在地|上海'
      },
    })
    try {
      // 还没空闲够久 → 不动
      expect(await scheduler.run_once(now - 9 * HOUR)).toBeUndefined()
      // 空闲够了 → 更新一次
      const first = await scheduler.run_once(now)
      expect(first?.facts).toBeGreaterThan(0)
      expect(graph.find('小李')?.location).toBe('上海')

      // 再跑一次：没有更新的记录，不重复消化
      const calls_before = seen.length
      expect(await scheduler.run_once(now)).toBeUndefined()
      expect(seen.length).toBe(calls_before)
    } finally {
      scheduler.stop()
    }
  })

  it('模型输出全是废话时不写坏数据', async () => {
    const graph = fresh_graph()
    const model = fake_model({
      extract: () => '好的，我来帮你整理一下：\n我认为这些信息都很有价值。',
      newPerson: () => '好的，没有新人物。',
    })

    const result = await update_graph_from_records(
      { graph, complete: model.complete },
      [{ date: '2026-09-20', role: 'user', text: '随便聊聊' }],
    )

    expect(result.facts).toBe(0)
    expect(result.people_created).toEqual([])
    expect(result.relations_created).toBe(0)
    // 只有两个中心节点（"主人"与"欣爱"），没有从废话里编出任何人
    expect(graph.nodes().map(node => node.name).sort()).toEqual(['主人', '欣爱'])
    expect(result.bad_lines).toBeGreaterThan(0)
  })
})

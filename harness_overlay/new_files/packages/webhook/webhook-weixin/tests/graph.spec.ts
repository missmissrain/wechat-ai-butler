/**
 * 知识图谱（社交网络）测试：有向称呼边、人名匹配、多跳链路、属性与证据。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { register_graph_tools } from '../src/memory/graphTools.ts'
import { KnowledgeGraphStore } from '../src/memory/graphStore.ts'

let dirs: string[] = []

function fresh_graph(): KnowledgeGraphStore {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  dirs.push(dir)
  return new KnowledgeGraphStore({ dir })
}

function last_dir(): string {
  return dirs[dirs.length - 1] as string
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 句柄可能未释放 */ }
  }
  dirs = []
})

describe('KnowledgeGraphStore', () => {
  it('节点按姓名匹配，改名不换 id，别名也能找到', () => {
    const graph = fresh_graph()
    const mom = graph.upsert_person({ name: '王丽', aliases: ['妈妈', '妈'] })
    const again = graph.upsert_person({ name: '王丽', occupation: '老师' })
    expect(again.id).toBe(mom.id)                       // 同一个人，不重复建节点
    expect(graph.nodes()).toHaveLength(1)
    expect(graph.find('妈妈')?.id).toBe(mom.id)          // 别名可命中
    expect(graph.find('王丽')?.occupation).toBe('老师')
    expect(graph.stats()).toEqual({ people: 1, relations: 0 })
  })

  it('有向边表达"谁称呼谁为什么"，方向不同可以并存', () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '小明' })
    graph.upsert_person({ name: '王丽' })
    graph.upsert_edge({ from: '小明', to: '王丽', label: '母亲', kind: 'kinship' })
    graph.upsert_edge({ from: '王丽', to: '小明', label: '儿子', kind: 'kinship' })

    const xiaoming = graph.find('小明')!
    const wangli = graph.find('王丽')!
    expect(graph.edges_from(xiaoming.id).map(edge => edge.label)).toEqual(['母亲'])
    expect(graph.edges_from(wangli.id).map(edge => edge.label)).toEqual(['儿子'])
    // 同一对人可以有多个称呼（妈 / 母亲）
    graph.upsert_edge({ from: '小明', to: '王丽', label: '妈' })
    expect(graph.edges().filter(edge => edge.from === xiaoming.id)).toHaveLength(2)
    // 自己连自己无意义，直接忽略
    expect(graph.upsert_edge({ from: '小明', to: '小明', label: '自己' })).toBeUndefined()
  })

  it('查询两人之间的链路，支持"朋友的朋友"这种多跳', () => {
    const graph = fresh_graph()
    for (const name of ['小明', '小红', '老王', '大壮']) graph.upsert_person({ name })
    graph.upsert_edge({ from: '小明', to: '小红', label: '朋友', kind: 'friend' })
    graph.upsert_edge({ from: '小红', to: '老王', label: '朋友', kind: 'friend' })
    graph.upsert_edge({ from: '老王', to: '大壮', label: '朋友', kind: 'friend' })

    // 一跳
    const one = graph.paths('小明', '小红')
    expect(one).toHaveLength(1)
    expect(one[0]?.hops).toHaveLength(1)
    expect(one[0]?.readable).toContain('小红')

    // 两跳（朋友的朋友）
    const two = graph.paths('小明', '老王')
    expect(two[0]?.hops.map(hop => hop.label)).toEqual(['朋友', '朋友'])
    expect(two[0]?.names).toEqual(['小明', '小红', '老王'])
    expect(two[0]?.readable).toBe('小明的朋友是小红，小红的朋友是老王')

    // 三跳；把深度限到 2 就找不到
    expect(graph.paths('小明', '大壮')[0]?.hops).toHaveLength(3)
    expect(graph.paths('小明', '大壮', { max_depth: 2 })).toEqual([])

    // 不连通 / 人不认识，返回空而不是瞎猜
    graph.upsert_person({ name: '孤岛' })
    expect(graph.paths('小明', '孤岛')).toEqual([])
    expect(graph.paths('小明', '不存在的人')).toEqual([])
  })

  it('多跳存在多条链路时按跳数从短到长返回', () => {
    const graph = fresh_graph()
    for (const name of ['A', 'B', 'C', 'D']) graph.upsert_person({ name })
    graph.upsert_edge({ from: 'A', to: 'B', label: '朋友' })
    graph.upsert_edge({ from: 'B', to: 'D', label: '朋友' })
    graph.upsert_edge({ from: 'A', to: 'C', label: '朋友' })
    graph.upsert_edge({ from: 'C', to: 'B', label: '同事' })
    const paths = graph.paths('A', 'D')
    expect(paths.length).toBeGreaterThanOrEqual(2)
    expect(paths[0]?.hops.map(hop => hop.label)).toEqual(['朋友', '朋友'])
  })

  it('关系网向外展开，且不会绕回起点', () => {
    const graph = fresh_graph()
    for (const name of ['A', 'B', 'C']) graph.upsert_person({ name })
    graph.upsert_edge({ from: 'A', to: 'B', label: '朋友' })
    graph.upsert_edge({ from: 'B', to: 'A', label: '朋友' })   // 反向边
    graph.upsert_edge({ from: 'B', to: 'C', label: '同事' })

    const ring = graph.neighborhood('A', { max_depth: 2 })
    expect(ring.map(item => item.name).sort()).toEqual(['B', 'C'])
    expect(ring.find(item => item.name === 'C')?.depth).toBe(2)
  })

  it('属性：年龄由生日推算，不靠模型记；证据会累加去重', () => {
    const graph = fresh_graph()
    const this_year = new Date()
    // 用"今年已过生日"的日期，保证年龄可预期
    const birthday = `${this_year.getFullYear() - 30}-01-01`
    graph.upsert_person({
      name: '王丽', birthday, gender: 'female', status: 'alive',
      occupation: '老师', location: '杭州', contacts: ['13800000000'],
      important_dates: [{ label: '生日', date: birthday }],
      family_summary: '与儿子同住',
      evidence: { date: '2026-09-20', note: '我妈是老师，在杭州' },
    })
    graph.upsert_person({ name: '王丽', evidence: { date: '2026-09-20', note: '我妈是老师，在杭州' } })
    graph.upsert_person({ name: '王丽', evidence: { date: '2026-09-21', note: '我妈生日是元旦' } })

    const node = graph.attributes('王丽')!
    expect(node.age).toBe(30)
    expect(node.occupation).toBe('老师')
    expect(node.contacts).toEqual(['13800000000'])
    expect(node.important_dates).toEqual([{ label: '生日', date: birthday }])
    // 同一天同一条只留一份，不同天保留
    expect(node.sources).toHaveLength(2)
  })

  it('只记年份未知的生日时不算年龄（不猜）', () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '小明', birthday: '06-15' })
    expect(graph.attributes('小明')?.age).toBeUndefined()
  })

  it('查询工具：AB 人名给链路，单人给属性与关系网，找不到人如实说', async () => {
    const graph = fresh_graph()
    for (const name of ['小明', '王丽', '小红', '老王']) graph.upsert_person({ name })
    graph.upsert_person({ name: '王丽', occupation: '老师', location: '杭州' })
    graph.upsert_edge({ from: '小明', to: '王丽', label: '母亲', kind: 'kinship' })
    graph.upsert_edge({ from: '小明', to: '小红', label: '朋友', kind: 'friend' })
    graph.upsert_edge({ from: '小红', to: '老王', label: '朋友', kind: 'friend' })

    const registered: Array<{ name: string, execute: (args: never) => Promise<{ ok: boolean, text: string }> }> = []
    register_graph_tools(
      { tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[number]) } } } as unknown as Context,
      graph,
    )
    expect(registered.map(tool => tool.name)).toEqual(['relation_query'])
    const query = registered[0]!

    // AB：多跳链路 + 两端属性
    const two = await query.execute({ from: '小明', to: '老王' } as never)
    expect(two.ok).toBe(true)
    expect(two.text).toContain('小明的朋友是小红，小红的朋友是老王')
    // 两端各自的直接称呼也会列出
    expect(two.text).toContain('王丽为「母亲」')
    // 端点的属性：把终点换成王丽就能看到她的职业
    const with_mom = await query.execute({ from: '小明', to: '王丽' } as never)
    expect(with_mom.text).toContain('老师')
    expect(with_mom.text).toContain('杭州')

    // 单人：属性 + 关系网
    const one = await query.execute({ from: '小明' } as never)
    expect(one.text).toContain('【小明】')
    expect(one.text).toContain('母亲')
    expect(one.text).toContain('朋友')

    // 没有通路 / 没这个人：如实说明，并给出在册名单帮模型纠正
    const none = await query.execute({ from: '王丽', to: '老王' } as never)
    expect(none.text).toContain('没有从')
    const unknown = await query.execute({ from: '张三' } as never)
    expect(unknown.text).toContain('没有找到')
    expect(unknown.text).toContain('小明')
  })

  it('中心初始化：欣爱为绝对中心，主人与欣爱互相称呼，且除姓名外不预设属性', () => {
    const graph = fresh_graph()
    graph.ensure_center()

    // 只有两个节点，且都只写了姓名（没有硬塞 status 等占位属性）
    expect(graph.nodes().map(node => node.name).sort()).toEqual(['主人', '欣爱'])
    const self = graph.find('欣爱')!
    const user = graph.find('主人')!
    expect(self.status).toBeUndefined()
    expect(user.status).toBeUndefined()
    expect(user.aliases).toBeUndefined()

    // 两条互相称呼的边：欣爱称呼主人为"主人"，主人称呼欣爱为"欣爱"
    expect(graph.edges_from(self.id).map(edge => edge.label)).toEqual(['主人'])
    expect(graph.edges_from(user.id).map(edge => edge.label)).toEqual(['欣爱'])

    // 幂等：重复调用不会多出节点或边
    graph.ensure_center()
    expect(graph.stats()).toEqual({ people: 2, relations: 2 })
  })

  it('中心初始化会迁移历史数据：旧的"我"就地改名成"主人"', () => {
    const graph = fresh_graph()
    // 造出早期版本的样子：用户节点叫"我"，还硬写了 status
    const legacy = graph.upsert_person({ name: '我', status: 'unknown' })
    graph.upsert_person({ name: '王丽' })
    graph.upsert_edge({ from: '我', to: '王丽', label: '妈妈' })

    graph.ensure_center()

    // id 不变（所以已有的边仍然指向他），正名变成"主人"，旧叫法保留为别名
    expect(graph.find('主人')?.id).toBe(legacy.id)
    expect(graph.find('我')?.id).toBe(legacy.id)
    expect(graph.find('主人')?.aliases).toContain('我')
    expect(graph.find('王丽')?.id).toBeDefined()              // 其它人不受影响
    // 早期硬写的占位状态被清掉（"除姓名外都可缺省"）
    expect(graph.find('主人')?.status).toBeUndefined()
    // 他之前的关系边完全保留
    expect(graph.edges_from(legacy.id).map(edge => edge.label)).toContain('妈妈')
  })

  it('改名只认显式 id：给 id 才就地改名并保留旧名，用别名调用不会覆盖正名', () => {
    const graph = fresh_graph()
    const wangli = graph.upsert_person({ name: '王丽', aliases: ['妈妈'] })

    // 用别名调用（不带 id）：不能把正名覆盖成"妈妈"
    graph.upsert_person({ name: '妈妈', occupation: '老师' })
    expect(graph.find('王丽')?.occupation).toBe('老师')
    expect(graph.find('妈妈')?.id).toBe(wangli.id)

    // 显式 id + 新名字：就地改名，旧正名转为别名，两个叫法都还查得到
    graph.upsert_person({ id: wangli.id, name: '王丽丽' })
    expect(graph.find('王丽丽')?.id).toBe(wangli.id)
    expect(graph.find('王丽')?.id).toBe(wangli.id)
    expect(graph.find('王丽丽')?.aliases).toContain('王丽')
    expect(graph.nodes()).toHaveLength(1)
  })

  it('当面称呼是替换语义：改称呼不叠加，旧称呼进历史；亲属称谓仍可并存', () => {
    const graph = fresh_graph()
    graph.ensure_center()
    const self = graph.find('欣爱')!
    expect(graph.edges_from(self.id).map(edge => edge.label)).toEqual(['主人'])

    // "以后叫我老板" → 替换，而不是再多一条
    const updated = graph.upsert_edge({
      from: '欣爱', to: '主人', label: '老板', kind: 'address',
      evidence: { date: '2026-09-21', note: '关系|欣爱|主人|老板' },
    })
    expect(updated?.label).toBe('老板')
    expect(updated?.previous_labels).toEqual(['主人'])
    expect(graph.edges_from(self.id).map(edge => edge.label)).toEqual(['老板'])
    expect(graph.edges()).toHaveLength(2)                 // 中心那两条边没变成三条

    // 但亲属称谓（妈/母亲）本来就允许并存，不受替换语义影响
    graph.upsert_person({ name: '王丽' })
    graph.upsert_edge({ from: '主人', to: '王丽', label: '妈' })
    graph.upsert_edge({ from: '主人', to: '王丽', label: '母亲' })
    const to_wangli = graph.edges_from(graph.find('主人')!.id)
      .filter(edge => edge.to === graph.find('王丽')!.id)
    expect(to_wangli.map(edge => edge.label).sort()).toEqual(['妈', '母亲'].sort())
  })

  it('查询工具以欣爱为中心：不填 from 也能从「主人」问到别人', async () => {
    const graph = fresh_graph()
    graph.ensure_center()
    graph.upsert_person({ name: '王丽', aliases: ['妈妈'], occupation: '老师' })
    graph.upsert_edge({ from: '主人', to: '王丽', label: '妈妈', kind: 'kinship' })

    const registered: Array<{ name: string, execute: (args: never) => Promise<{ ok: boolean, text: string }> }> = []
    register_graph_tools(
      { tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[number]) } } } as unknown as Context,
      graph,
    )
    const query = registered[0]!

    // 只给 to：默认起点是欣爱 → 欣爱 → 主人 → 王丽
    const via_center = await query.execute({ to: '王丽' } as never)
    expect(via_center.ok).toBe(true)
    expect(via_center.text).toContain('找到 1 条关系链路')
    expect(via_center.text).toContain('主人的妈妈是王丽')
    // 两端资料都在
    expect(via_center.text).toContain('【欣爱】')
    expect(via_center.text).toContain('老师')

    // 一个参数都不给：明确报错，而不是瞎猜一个人
    const empty = await query.execute({} as never)
    expect(empty.ok).toBe(false)
  })

  it('生成可读视图，且视图可重建', () => {
    const graph = fresh_graph()
    graph.upsert_person({ name: '小明', occupation: '工程师' })
    graph.upsert_person({ name: '王丽', occupation: '老师' })
    graph.upsert_edge({ from: '小明', to: '王丽', label: '母亲' })

    const view = readFileSync(join(last_dir(), 'graph.md'), 'utf8')
    expect(view).toContain('## 小明')
    expect(view).toContain('## 王丽')
    expect(view).toContain('→ 王丽：母亲')
    expect(view).toContain('老师')
  })
})

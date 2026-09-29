/**
 * 知识图谱（社交网络）的查询工具。
 *
 * 只提供**一个**工具 `relation_query`，两种用法：
 * - 给两个人名 → 查他们之间的称呼链路（**递归多跳**，能回答"朋友的朋友"这种关系）；
 * - 只给一个人名 → 查这个人的属性 + 向外的关系网。
 *
 * 为什么合成一个工具：模型（尤其中小参数）在工具变多时容易选错。
 * 一个入口 + 可选参数，比"person_info / relation_path"两个工具更不容易用错。
 *
 * 写入不开放给模型：图谱由链路在空闲时用 Gemma 分批更新，避免模型凭印象改事实。
 *
 * @module dsh-webhook-weixin/graph-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KnowledgeGraphStore } from './graphStore.ts'
import { GRAPH_ASSISTANT_NAME, type PersonNode } from './graphTypes.ts'

/** 单次返回给模型的最大字符数。 */
const MAX_CHARS = 5_000

function clip(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n…（已截断，请缩小范围）`
}

/** 人物属性的可读片段。 */
function describe_person(node: PersonNode): string {
  const bits: string[] = []
  if (node.aliases !== undefined && node.aliases.length > 0) bits.push(`别名 ${node.aliases.join('、')}`)
  if (node.gender !== undefined && node.gender !== 'unknown') {
    bits.push(`性别 ${({ male: '男', female: '女', other: '其他' } as Record<string, string>)[node.gender] ?? node.gender}`)
  }
  if (node.birthday !== undefined) bits.push(`生日 ${node.birthday}`)
  if (node.age !== undefined) bits.push(`年龄 ${node.age}`)
  if (node.status !== undefined && node.status !== 'unknown') {
    bits.push(`状态 ${({ alive: '在世', deceased: '已故', lost_contact: '失联' } as Record<string, string>)[node.status] ?? node.status}`)
  }
  if (node.occupation !== undefined) bits.push(`职业 ${node.occupation}`)
  if (node.location !== undefined) bits.push(`所在地 ${node.location}`)
  if (node.contacts !== undefined && node.contacts.length > 0) bits.push(`联系方式 ${node.contacts.join('、')}`)
  if (node.family_summary !== undefined) bits.push(`家庭情况 ${node.family_summary}`)
  if (node.important_dates !== undefined && node.important_dates.length > 0) {
    bits.push(`重要日期 ${node.important_dates.map(item => `${item.label} ${item.date}`).join('；')}`)
  }
  if (node.notes !== undefined) bits.push(`备注 ${node.notes}`)
  return bits.length === 0 ? '（暂无属性）' : bits.join('；')
}

/** 某人对外一层的称呼（"称呼 X 为 Y"），作为属性之外的补充。 */
function relation_lines(graph: KnowledgeGraphStore, id: string): string[] {
  const out = graph.edges_from(id)
  if (out.length === 0) return []
  const by_id = new Map(graph.nodes().map(node => [node.id, node.name]))
  return [`　他/她称呼：${out.map(edge => `${by_id.get(edge.to) ?? edge.to}为「${edge.label}」`).join('；')}`]
}

/**
 * 在 agent 作用域注册图谱查询工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param graph - 知识图谱存储。
 */
export function register_graph_tools(agent_ctx: Context, graph: KnowledgeGraphStore): void {
  agent_ctx.tools.register(defineTool({
    name: 'relation_query',
    description: [
      '查询家人/朋友关系（知识图谱）。这张图**以「欣爱」（你自己）为中心**：',
      '不填 from 就默认从欣爱出发，所以"主人和 XX 是什么关系"直接给 to 即可。',
      '图谱里的两个固定节点：`欣爱`（你）与 `主人`（用户本人，真名可能在他的别名里）。',
      '',
      '两种用法：',
      '- 只给 to：查"欣爱 → to"的链路，也就是这个人和这个家是什么关系；',
      '- 只给 from：查这个人的资料 + 他身边都有谁（向外 2 层）；',
      '- 同时给 from 和 to：查两人的关系链路，**会自动递归多跳**，',
      '  例如"小红是小明的朋友，小红的朋友是老王"。',
      '',
      '什么时候该用：',
      '- 用户问"XX 是谁/XX 的电话/XX 在哪/XX 是我什么人"（"我"就是 `主人`）；',
      '- 用户提到一个你不认识的人名，需要先查一下再回答；',
      '- 需要理清"谁的谁"这种链路（亲戚、朋友的朋友）。',
      '',
      '什么时候不该用：',
      '- 当前对话里已经说清楚的信息，不要为了确认再查；',
      '- 用户只是闲聊、不涉及具体人物时不要调用。',
      '',
      '返回的是图谱里**已记录**的内容；如果没这个人或没有通路，会如实告诉你，',
      '不要据此编造关系或属性。',
    ].join('\n'),
    parameters: {
      from: { type: 'string', description: '起点人物姓名（或已知别名）；不填默认「欣爱」。' },
      to: { type: 'string', description: '终点人物姓名；给了就查两人之间的关系链路。' },
      max_depth: { type: 'number', description: '链路最多几跳，默认 4。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    async execute(args: { from?: string, to?: string, max_depth?: number }) {
      // 不填 from 就从中心（欣爱）出发：这才是"这张图以欣爱为中心"的实际含义，
      // 也让模型问"主人和 XX 什么关系"时少填一个参数、少错一次。
      const from = typeof args.from === 'string' ? args.from.trim() : ''
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      if (from === '' && to === '') {
        return { ok: false, text: '至少要给 from 或 to 一个人名。' }
      }
      const origin = from === '' ? GRAPH_ASSISTANT_NAME : from
      const start = graph.find(origin)
      if (start === undefined) {
        const known = graph.nodes().map(node => node.name).slice(0, 30)
        return {
          ok: true,
          text: known.length === 0
            ? '知识图谱里还没有任何人物记录。'
            : `没有找到"${origin}"。目前记录在册的人有：${known.join('、')}。请确认名字，或如实告诉用户你还不认识这个人。`,
        }
      }

      const max_depth = Number(args.max_depth) || 4

      // 只给 from：资料 + 关系网
      if (to === '') {
        const attributes = graph.attributes(start.name)
        const ring = graph.neighborhood(start.name, { max_depth: 2 })
        const lines = [
          `【${start.name}】${describe_person(attributes ?? start)}`,
        ]
        if (ring.length > 0) {
          lines.push('')
          lines.push('关系网（他/她怎么称呼别人）：')
          for (const item of ring) {
            lines.push(`- ${item.label}：${item.name}${item.depth > 1 ? `（${item.depth} 层关系）` : ''}`)
          }
        } else {
          lines.push('', '（图谱里还没有这个人的关系记录）')
        }
        return { ok: true, text: clip(lines.join('\n')) }
      }

      // 给了 to：查链路
      const end = graph.find(to)
      if (end === undefined) {
        const known = graph.nodes().map(node => node.name).slice(0, 30)
        return { ok: true, text: `没有找到"${to}"。目前记录在册的人有：${known.join('、')}。` }
      }
      const paths = graph.paths(start.name, end.name, { max_depth })
      if (paths.length === 0) {
        return {
          ok: true,
          text: `图谱里没有从"${start.name}"到"${end.name}"的关系链路（最多找了 ${max_depth} 跳）。`
            + '不要据此编造关系；如果用户说了他们的关系，可以在回复里请用户确认。',
        }
      }
      const lines = [
        `【${start.name}】${describe_person(graph.attributes(start.name) ?? start)}`,
        ...relation_lines(graph, start.id),
        `【${end.name}】${describe_person(graph.attributes(end.name) ?? end)}`,
        ...relation_lines(graph, end.id),
        '',
        `找到 ${paths.length} 条关系链路：`,
      ]
      for (const path of paths.slice(0, 5)) {
        lines.push(`- ${path.readable}（${path.hops.length} 跳）`)
      }
      return { ok: true, text: clip(lines.join('\n')) }
    },
  }))
}

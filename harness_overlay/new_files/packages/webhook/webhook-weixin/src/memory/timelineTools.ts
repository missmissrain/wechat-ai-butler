/**
 * 长期记忆（时间线）的三层工具接口。
 *
 * ## 三层架构（按"代价"从便宜到贵，检索顺序就是从 1 到 3）
 *
 * | 层 | 工具 | 数据 | 代价 |
 * |---|---|---|---|
 * | L1 索引 | `timeline_days` | 有哪些天、各多少条、那天摘要 | 最低：只读索引 |
 * | L2 检索 | `timeline_search` | 关键词命中在**哪天**、谁说的 | 中：跨天扫记录 |
 * | L3 明细 | `timeline_read` | 某天的摘要 + **逐句原文** | 最高：整段进上下文 |
 *
 * 设计意图：**先便宜地缩小范围，再决定要不要读原文**。
 * 模型最容易犯的错是"一上来就读一整天的原文"，既浪费上下文又慢；
 * 所以 L1/L2 的返回里都故意只给"日期 + 片段"，逼它先定位。
 *
 * 写入**不开放给模型**：记录由链路的连接器自动落盘（用户上行 + 最终回复），
 * 避免模型把"自己以为发生过的事"写进长期记忆。
 *
 * @module dsh-webhook-weixin/timeline-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TimelineStore } from './timelineStore.ts'

/** 单次返回给模型的最大字符数，避免一次把上下文顶爆。 */
const MAX_CHARS = 6_000

/** 截断并标注。 */
function clip(text: string): string {
  return text.length <= MAX_CHARS
    ? text
    : `${text.slice(0, MAX_CHARS)}\n…（已截断，共 ${text.length} 字符；请缩小范围重查）`
}

/** 校验 `YYYY-MM-DD`；不合法就返回 undefined。 */
function as_date(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : undefined
}

/**
 * 在某个 agent 作用域上注册三个时间线工具。
 *
 * @param agent_ctx - agent 自己的 ctx（用 `agent.ctx.effect` 保证卸载时自动清理）。
 * @param store - 时间线存储。
 */
export function register_timeline_tools(agent_ctx: Context, store: TimelineStore): void {
  agent_ctx.tools.register(defineTool({
    name: 'timeline_days',
    description: [
      '查看"长期记忆里有哪些天"，以及每天的对话条数和当天摘要。这是最便宜的一层。',
      '',
      '什么时候该用：',
      '- 用户提到"前几天/上次/最近"这类模糊时间，你不确定具体是哪天；',
      '- 用户问"这几天都聊了什么/最近怎么样"；',
      '- 你想先看看记忆里有没有相关内容，再决定要不要细查。',
      '',
      '什么时候不该用：',
      '- 当前对话里已经有的信息，不要为了"确认"再查一遍；',
      '- 与用户当前请求无关时，不要为了"更了解他"而主动翻记忆。',
      '',
      '用法建议：先调用它拿到日期，再用 timeline_read 读某一天的细节。',
    ].join('\n'),
    parameters: {
      limit: {
        type: 'number',
        description: '最多列出最近多少天，默认 14。',
      },
      include_summary: {
        type: 'boolean',
        description: '是否一并返回每天的摘要（默认 true；关掉只返回日期与条数，更省）。',
      },
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
    async execute(args: { limit?: number, include_summary?: boolean }) {
      const days = store.list_days()
      if (days.length === 0) return { ok: true, text: '长期记忆里还没有任何记录。' }
      const limit = Math.max(1, Math.min(120, Number(args.limit) || 14))
      const picked = days.slice(-limit).reverse()
      const with_summary = args.include_summary !== false
      const lines = picked.map(meta => {
        const head = `- ${meta.date}（${meta.entries} 条：用户 ${meta.user_entries} / 我 ${meta.assistant_entries}）`
        if (!with_summary) return head
        const summary = store.read_summary(meta.date)
        return summary === undefined
          ? `${head}\n  摘要：（尚未生成）`
          : `${head}\n  摘要：${summary.replace(/\n/g, ' / ')}`
      })
      const stats = store.stats()
      return {
        ok: true,
        text: clip(`共 ${stats.days} 天记忆（${stats.first_date ?? '?'} ~ ${stats.last_date ?? '?'}），最近 ${picked.length} 天：\n\n`
          + lines.join('\n')),
      }
    },
  }))

  agent_ctx.tools.register(defineTool({
    name: 'timeline_search',
    description: [
      '在长期记忆里按关键词搜索，返回**命中的日期 + 谁说的 + 片段**。中间层。',
      '',
      '什么时候该用：',
      '- 用户说"我之前不是说过…/你还记得…吗"，你要先确认有没有、在哪天；',
      '- 要回忆某个人名、地点、事项、偏好（例如"房租""复查""妈妈"）；',
      '- 想找某个话题最早/最近一次出现。',
      '',
      '什么时候不该用：',
      '- 别用它来"遍历所有记忆"：一次只搜一个具体关键词，不要拿"的""了"这类常见字去搜；',
      '- 已知具体日期时直接用 timeline_read，不必搜。',
      '',
      '返回的只是片段；要看上下文，再用 timeline_read 读那一天。',
    ].join('\n'),
    parameters: {
      keyword: {
        type: 'string',
        required: true,
        description: '要搜索的关键词（例如"房租"、"医院"）。一次一个，尽量具体。',
      },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）。' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）。' },
      limit: { type: 'number', description: '最多返回多少条命中，默认 20。' },
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
    async execute(args: { keyword?: string, from?: string, to?: string, limit?: number }) {
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
      if (keyword === '') return { ok: false, text: '需要一个非空 keyword。' }
      const from = as_date(args.from)
      const to = as_date(args.to)
      const hits = store.search(keyword, {
        limit: Math.max(1, Math.min(100, Number(args.limit) || 20)),
        ...from === undefined ? {} : { from },
        ...to === undefined ? {} : { to },
      })
      if (hits.length === 0) return { ok: true, text: `没有找到包含"${keyword}"的记录。不要猜内容，如实告诉用户没找到。` }
      const lines = hits.map(hit =>
        `- ${hit.date} ${hit.entry.role === 'user' ? '用户' : '我'}：${hit.entry.text.replace(/\n/g, ' ')}`)
      return {
        ok: true,
        text: clip(`包含"${keyword}"的记录（${hits.length} 条，新的在前）：\n\n${lines.join('\n')}\n\n要看完整上下文，用 timeline_read 读对应日期。`),
      }
    },
  }))

  agent_ctx.tools.register(defineTool({
    name: 'timeline_read',
    description: [
      '读某一天（或一段日期）的长期记忆：**当天的摘要 + 逐句原文**。最贵的一层，请最后用。',
      '',
      '什么时候该用：',
      '- 已经用 timeline_search / timeline_days 定位到某天，现在需要看当时到底说了什么；',
      '- 用户明确问"X 月 X 日那天我们聊了什么"；',
      '- 要恢复某个事项的完整背景（时间、数字、承诺）。',
      '',
      '什么时候不该用：',
      '- **不要**为了回答普通问题而一次读很多天；单次最多读 3 天，且优先只读摘要确认真有需要再看原文；',
      '- 不要凭记忆里的"大概日期"反复试错；不确定日期就先 timeline_days。',
      '',
      '注意：这些是用户说过的原话与你的历史回复，属于隐私内容，只用于回答用户本人。',
    ].join('\n'),
    parameters: {
      date: {
        type: 'string',
        required: true,
        description: '要读取的日期 YYYY-MM-DD。',
      },
      to: {
        type: 'string',
        description: '结束日期 YYYY-MM-DD（可选）。给区间时会读多天，单次最多 3 天。',
      },
      include_entries: {
        type: 'boolean',
        description: '是否包含逐句原文（默认 true）。只想看摘要时设 false，更省。',
      },
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
    async execute(args: { date?: string, to?: string, include_entries?: boolean }) {
      const date = as_date(args.date)
      if (date === undefined) return { ok: false, text: 'date 必须是 YYYY-MM-DD 格式。' }
      const to = as_date(args.to) ?? date
      const days = store.read_range(date, to)
      const non_empty = days.filter(day => day.entries.length > 0)
      if (non_empty.length === 0) {
        return { ok: true, text: `${date}${to === date ? '' : ' ~ ' + to} 没有对话记录。不要编造内容。` }
      }
      const with_entries = args.include_entries !== false
      const blocks = non_empty.map(day => {
        const head = `## ${day.meta.date}（${day.meta.entries} 条）`
        const summary = `摘要：${day.summary ?? '（尚未生成）'}`
        if (!with_entries) return `${head}\n${summary}`
        const entries = day.entries.map(item =>
          `[${item.role === 'user' ? '用户' : '我'}] ${item.text}`)
        return `${head}\n${summary}\n\n${entries.join('\n')}`
      })
      return { ok: true, text: clip(blocks.join('\n\n')) }
    },
  }))
}

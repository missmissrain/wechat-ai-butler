/**
 * codex-opencode 处理结果日志：按需取回"任务做完了但当时没能推给你"的结果。
 *
 * 为什么需要它：平台只允许在"用户刚发过消息"的窗口内发送（实测：旧 token / 无 token /
 * 先调 notifystart 全都会 ret=-2）。所以当任务在用户不在微信时完成，结果推不出去；
 * 与其反复重试或直接丢弃，不如**停放在队列里保留一段时间**，等用户主动问起再返回。
 *
 * 工具名用英文标识符（协议要求），但**说明里写明中文名**，界面与模型都能看懂。
 *
 * @module dsh-webhook-weixin/bridge-result-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'
import { probe } from '../diagnostics/probe.ts'

/** 单次返回给模型的最大字符数。 */
const MAX_CHARS = 6_000

function clip(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n…（已截断，还有更多条，可再查）`
}

/** 把时间戳转成"几分钟前"这种好读的说法。 */
function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}

/**
 * 注册"处理结果日志"工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param store - 微信状态库（停放结果就在 outbox 里）。
 * @param retention_ms - 停放保留期，用于告诉模型结果会保留多久。
 */
export function register_bridge_result_tools(
  agent_ctx: Context,
  store: WeixinStateStore,
  retention_ms = 6 * 3600_000,
): void {
  agent_ctx.tools.register(defineTool({
    name: 'bridge_results',
    description: [
      'codex-opencode 处理结果日志：查看"任务已完成、但当时没能发给你"的处理结果。',
      '',
      '背景：微信只允许在你刚发过消息的那一小段时间内发送。所以你在忙别的事时，',
      `由 codex / opencode 跑完的任务结果会**停放在这里**（保留 ${Math.round(retention_ms / 3600_000)} 小时），不会主动推给你。`,
      '',
      '什么时候该用：',
      '- 用户问"刚才那个任务做完了吗 / 有什么结果 / 有没有什么要告诉我的"；',
      '- 用户提到之前让 codex 或 opencode 做的事，而你不确定结果。',
      '',
      '什么时候不该用：',
      '- 用户没问、也没有相关话题时，不要主动去翻这个日志；',
      '- 这里只有"结果"，没有中间过程——中间过程不会推也不在这里。',
    ].join('\n'),
    parameters: {
      limit: { type: 'number', description: '最多返回多少条，默认 10。' },
      keyword: { type: 'string', description: '可选：只返回包含该关键词的结果。' },
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
    async execute(args: { limit?: number, keyword?: string }) {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
      let rows = store.parked_results(limit * 3)
      if (keyword !== '') rows = rows.filter(row => row.text.includes(keyword))
      rows = rows.slice(0, limit)
      probe('bridge-results', 'queried', { count: rows.length, keyword })
      if (rows.length === 0) {
        return {
          ok: true,
          text: keyword === ''
            ? '处理结果日志里没有待取回的结果（说明该推的都已经发出去了）。'
            : `没有包含"${keyword}"的处理结果。`,
        }
      }
      const blocks = rows.map(row => `### ${ago(row.created_at)}\n${row.text.trim()}`)
      return { ok: true, text: clip(`有 ${rows.length} 条待取回的处理结果：\n\n${blocks.join('\n\n')}`) }
    },
  }))
}

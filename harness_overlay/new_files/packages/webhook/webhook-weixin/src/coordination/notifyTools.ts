/**
 * 通知开关工具：让欣爱自己查/改 codex 与 opencode 的完成汇报是否推送。
 *
 * 一个工具两个动作（而不是两个工具）：模型在工具变多时更容易选错，
 * 而"查状态"和"改开关"本来就是一回事的两面，合成一个入口更不容易用错。
 *
 * 只影响**被动通知**（外部发起的任务完成汇报）；真实对话回复不受影响。
 *
 * @module dsh-webhook-weixin/notify-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { NotifySettings, NotifyTarget } from './notifySettings.ts'

const TARGETS: NotifyTarget[] = ['codex', 'opencode']

/** 解析目标；'all'/'both' 表示两个都算。 */
function parse_targets(raw: unknown): NotifyTarget[] | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === '' || value === 'all' || value === 'both' || value === '全部') return [...TARGETS]
  const matched = TARGETS.filter(target => value === target || value.includes(target))
  return matched.length === 0 ? undefined : matched
}

/**
 * 在 agent 作用域注册通知开关工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param settings - 通知开关（读写状态库 meta）。
 */
export function register_notify_tools(agent_ctx: Context, settings: NotifySettings): void {
  agent_ctx.tools.register(defineTool({
    name: 'notify_control',
    description: [
      '查看或设置"任务完成汇报"的推送开关（codex 与 opencode 各自独立）。',
      '',
      '动作：',
      '- status：查看当前两个开关是开还是关。',
      '- set：设置开关，需要同时给 target（codex / opencode / all）和 enabled（true/false）。',
      '',
      '什么时候该用：',
      '- 用户说"别老是汇报了/关掉那个通知/太吵了" → action=set, target=all, enabled=false；',
      '- 用户说"把通知打开/汇报恢复一下" → action=set, target=all, enabled=true；',
      '- 用户问"通知开着吗" → action=status。',
      '',
      '什么时候不该用：',
      '- 不要因为"觉得吵"就自己关掉通知——必须用户明确要求才改；',
      '- 这个开关只影响"外部任务的完成汇报"，不影响你正常的对话回复。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status（查看）或 set（设置）。',
      },
      target: {
        type: 'string',
        description: 'set 时必填：codex / opencode / all。',
      },
      enabled: {
        type: 'boolean',
        description: 'set 时必填：true 打开、false 关闭。',
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
    async execute(args: { action?: string, target?: string, enabled?: boolean }) {
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
      const render = (state: Record<NotifyTarget, boolean>): string =>
        `codex 完成汇报：${state.codex ? '已开启' : '已关闭'}\nopencode 完成汇报：${state.opencode ? '已开启' : '已关闭'}`

      if (action === 'status' || action === '') {
        return { ok: true, text: `当前通知开关：\n${render(settings.snapshot())}` }
      }
      if (action !== 'set') {
        return { ok: false, text: `未知动作"${action}"；可用：status | set` }
      }
      const targets = parse_targets(args.target)
      if (targets === undefined) {
        return { ok: false, text: 'target 必须是 codex / opencode / all 之一。' }
      }
      if (typeof args.enabled !== 'boolean') {
        return { ok: false, text: 'set 需要 enabled（true 打开、false 关闭）。' }
      }
      for (const target of targets) settings.set_enabled(target, args.enabled)
      return {
        ok: true,
        text: `已${args.enabled ? '开启' : '关闭'}：${targets.join('、')}。\n${render(settings.snapshot())}`,
      }
    },
  }))
}

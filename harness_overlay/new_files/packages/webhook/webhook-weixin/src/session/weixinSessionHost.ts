/**
 * Harness Agent 宿主接口 + 单一所有权实现。
 *
 * 重构设计文档 §8.1：必须选定一种所有权模型，禁止"连接器 handles"与"Harness owner effect"
 * 同时认为自己是最终 owner。此处采用 **gateway 统一持有** 模型：
 * - 本类是唯一保存 `AgentHandle` 的地方；
 * - Cordis teardown 只调用本类的 `dispose_agents()` 一次；
 * - `dispose` 在 stop / 插件卸载 / 重复 stop / 创建中止四种情况下都幂等。
 *
 * 同时 §8.2 要求：preset / agent-loop / sessionPersistence 缺失必须在**连接器启动时**失败，
 * 而不是第一条消息到达时才失败（由 `assert_capabilities()` 完成）。
 * @module dsh-webhook-weixin/session-host
 */

import { appendFile, type FileHandle } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { probe } from '../diagnostics/probe.ts'

/** 附件保存能力（由 harness attachments 服务提供）。 */
export interface WeixinAttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; name?: string }): Promise<ImageAttachmentRef>
  saveFile?(input: { data: Uint8Array; name?: string }): Promise<FileAttachmentRef>
}

/** 宿主必须提供的能力。 */
export interface WeixinSessionHost {
  get_agent(session_id: SessionId): Agent | undefined
  create_agent(session_id: SessionId): Promise<Agent>
  resume_agent(session_id: SessionId): Promise<Agent>
}

/** preset 组合结果。 */
interface Composition {
  agentPreset?: string
  setup?: (agentCtx: unknown) => Promise<void>
}

/** agentPresets 服务的最小面。 */
interface AgentPresetsLike {
  resolve(id: string | undefined): Promise<{ id: string }>
  mount(agentCtx: unknown, id: string): Promise<void>
}

/** 构造参数。 */
export interface HarnessSessionHostOptions {
  /** preset id；缺省用部署默认。 */
  readonly agent_preset?: string
  /** 工作目录。 */
  readonly workspace_path: string
  /** 模型 provider。必须传给 Agent，否则 preset 的 `{{model}}` 等提示变量无值。 */
  readonly provider?: string
  /** 模型 id。必须传给 Agent，否则 preset 的 `{{model}}` 等提示变量无值。 */
  readonly model?: string
  /** 推理强度（可选）。 */
  readonly reasoning_effort?: string
}



/** 唯一的 Agent 所有权实现。 */
export class HarnessSessionHost implements WeixinSessionHost {
  private readonly handles = new Map<string, { dispose(): Promise<void>; agent: Agent }>()
  private disposed = false
  private composition: Composition | undefined

  /** 绑定 Cordis 上下文与组合参数。 */
  constructor(private readonly ctx: Context, private readonly options: HarnessSessionHostOptions) {}

  /**
   * 启动时装配检查（设计文档 §8.2 / §9.3）：缺任何一个必需服务都立即失败。
   * @throws 缺少 agents / agent-loop / agentPresets / sessionPersistence 时抛出。
   */
  assert_capabilities(): void {
    const get = (name: string): unknown => (this.ctx as unknown as { get(n: string): unknown }).get(name)
    const missing: string[] = []
    if (get('agents') === undefined) missing.push('agents')
    if (get('agentPresets') === undefined) missing.push('agentPresets')
    if (get('sessionPersistence') === undefined) missing.push('sessionPersistence')
    // 模型路由：没有 llm 服务就根本跑不了回合，必须 fail closed。
    // 注意：agent-loop **不注册**名为 `agentLoop` 的服务（它随 agents 一起工作），
    // 旧实现探测该名字只会误报 `capability.agent_loop_missing`——已删除。
    if (get('llm') === undefined) missing.push('llm')
    if (this.options.agent_preset !== undefined && get('agentPresets') !== undefined) {
      // preset 解析失败会在 compose 阶段抛错；这里只确认服务存在。
      probe('lifecycle', 'capability.preset_requested', { preset: this.options.agent_preset })
    }
    if (missing.length > 0) {
      throw new Error(
        `webhook-weixin: 装配检查失败，缺少服务 ${missing.join(', ')}。`
        + '连接器拒绝启动（避免出现"能启动但发消息才发现没有工具/没有持久化"的假成功）。',
      )
    }
    probe('lifecycle', 'capability.ok', {
      preset: this.options.agent_preset ?? '(default)', provider: this.options.provider, model: this.options.model,
    })
  }

  /**
   * 忘掉已解析的 preset 组合（挂载/卸载工具后调用）。
   *
   * `compose()` 是**按宿主实例记忆**的：不重置的话，改完 preset 之后
   * 新会话仍然拿到旧工具集，用户会以为"勾选了没生效"。
   * 重置后下一次创建 Agent 会重新解析 preset（已有 Agent 不受影响，
   * 需要新会话或清空上下文才会换上新工具）。
   */
  reset_composition(): void {
    this.composition = undefined
    probe('lifecycle', 'composition.reset')
  }

  /** 查找在线 Agent。 */
  get_agent(session_id: SessionId): Agent | undefined {
    return this.ctx.agents.get(session_id)
  }

  /** 创建 Agent；Session 已存在时自动恢复。 */
  async create_agent(session_id: SessionId): Promise<Agent> {
    this.assert_not_disposed()
    const composition = await this.compose()
    try {
      const handle = await this.ctx.agents.create({
        sessionId: session_id,
        meta: {
          cwd: this.options.workspace_path,
          ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
          ...this.options.provider === undefined ? {} : { provider: this.options.provider },
          ...this.options.model === undefined ? {} : { model: this.options.model },
        },
        ...this.agent_options() === undefined ? {} : { agentOptions: this.agent_options()! },
        ...composition.setup === undefined ? {} : { setup: composition.setup },
      })
      this.handles.set(String(handle.agent.id), handle)
      probe('lifecycle', 'agent.created', { session_id: String(handle.agent.id) })
      return handle.agent
    } catch (error) {
      if (!is_session_already_exists(error)) throw error
      probe('lifecycle', 'agent.create_conflict_resume', { session_id: String(session_id) })
      return this.resume_agent(session_id)
    }
  }

  /** 恢复持久化 Session。 */
  async resume_agent(session_id: SessionId): Promise<Agent> {
    this.assert_not_disposed()
    const composition = await this.compose()
    const handle = await this.ctx.agents.resume({
      resumeSessionId: session_id,
      ...this.agent_options() === undefined ? {} : { agentOptions: this.agent_options()! },
      ...composition.setup === undefined ? {} : { setup: composition.setup },
    })
    this.handles.set(String(handle.agent.id), handle)
    probe('lifecycle', 'agent.resumed', { session_id: String(handle.agent.id) })
    return handle.agent
  }

  /**
   * 释放**单个** Agent（清空某个用户的上下文用），返回是否真的释放了。
   *
   * 必须是 owner 来释放：只有 dispose 才会关掉会话日志的写句柄。
   * 否则外部删掉 session 文件后，进程内残留的句柄会在下次 append 时
   * **新建一个没有 header 的坏文件**（实测的坑），那个会话就再也恢复不起来了。
   */
  async dispose_agent(session_id: string): Promise<boolean> {
    const key = String(session_id)
    const handle = this.handles.get(key)
    if (handle === undefined) return false
    this.handles.delete(key)
    try {
      await handle.dispose()
      probe('lifecycle', 'agent.disposed_one', { session_id: key })
      return true
    } catch (error) {
      probe('lifecycle', 'agent.dispose_failed', { session_id: key, error: String(error) })
      return false
    }
  }

  /**
   * 释放本宿主创建的全部 Agent；**幂等**（重复调用、卸载后调用都安全）。
   * 这是唯一的 owner 释放点。
   */
  async dispose_agents(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const entries = [...this.handles.values()]
    this.handles.clear()
    for (const handle of entries) {
      try {
        await handle.dispose()
      } catch (error) {
        probe('lifecycle', 'agent.dispose_failed', { error: String(error) })
      }
    }
    probe('lifecycle', 'agents.disposed', { count: entries.length })
  }

  /** 组装 preset（解析失败必须抛错，禁止静默降级成"无工具 Agent"）。 */
  private async compose(): Promise<Composition> {
    if (this.composition !== undefined) return this.composition
    const presets = (this.ctx as unknown as { get(name: string): AgentPresetsLike | undefined }).get('agentPresets')
    if (presets === undefined) {
      throw new Error('webhook-weixin: agentPresets 服务缺失，无法挂载 Agent preset（会导致 Agent 没有任何工具）。')
    }
    try {
      const resolvedId = (await presets.resolve(this.options.agent_preset)).id
      const composition: Composition = {
        agentPreset: resolvedId,
        setup: async (agentCtx: unknown) => {
          await presets.mount(agentCtx, resolvedId)
        },
      }
      this.composition = composition
      probe('lifecycle', 'preset.resolved', { requested: this.options.agent_preset ?? '(default)', resolved: resolvedId })
      return composition
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `webhook-weixin: 无法解析 Agent preset "${this.options.agent_preset ?? '(default)'}"，`
        + `拒绝以"无工具 Agent"继续运行：${detail}`,
      )
    }
  }

  /**
   * 组装 Agent 运行选项。
   *
   * provider/model 必须传给 `ctx.agents.create/resume`：preset 的 persona 前缀里有
   * `{{model}}` 这类提示变量，不传会导致 Agent 启动即报
   * `prompt variable "{{model}}" has no value for this assembly`，
   * 表现为"消息已注入但永远没有回复"（探针里能看到 agent.error）。
   */
  private agent_options(): AgentOptions | undefined {
    // provider/model 缺失没有可用的回退：此时 Agent 无法解析提示变量，直接暴露问题。
    const provider = this.options.provider
    const model = this.options.model
    if (provider === undefined || model === undefined) {
      probe('lifecycle', 'agent_options.missing_model', { provider, model })
      return undefined
    }
    const level = this.options.reasoning_effort
    if (level === undefined) return { provider, model }
    return { provider, model, reasoningEffort: level as NonNullable<AgentOptions['reasoningEffort']> }
  }

  /** 卸载后禁止再创建。 */
  private assert_not_disposed(): void {
    if (this.disposed) throw new Error('webhook-weixin: 宿主已释放，不能再创建 Agent')
  }
}

/** 判断错误是否为"Session 已存在"。 */
function is_session_already_exists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already exists|duplicate|EEXIST|session_exists/i.test(message)
}

/** 可选的调试日志写入器；仅在设置 DSH_WEIXIN_DEBUG_LOG 时生效。 */
export async function trace_to_file(line: string): Promise<void> {
  const path = process.env.DSH_WEIXIN_DEBUG_LOG
  if (!path) return
  try {
    await appendFile(path, `${new Date().toISOString()} [weixin] ${line}\n`, 'utf8')
  } catch { /* 调试日志失败不影响主流程 */ }
}

export type { FileHandle }

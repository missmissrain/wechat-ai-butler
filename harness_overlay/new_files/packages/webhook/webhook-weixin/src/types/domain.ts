/**
 * 微信链路的统一领域模型：入站信封、控制命令、delivery 状态、outbox 记录。
 *
 * 设计原则（对应重构设计文档 §3.2）：一个事实只能有一个权威写入者。
 * - 执行状态（inbox/turn/step/cancel/steer/transcript）由 Harness Agent/Session 唯一持有；
 * - 本文件只描述微信协议侧必需的幂等键、路由、游标与发送状态。
 * @module dsh-webhook-weixin/domain
 */

import type { NormalizedMedia } from '../message/messageNormalizer.ts'

// ── 入站 ──────────────────────────────────────────────────────────────────

/** 控制命令：与普通正文分开建模，保证语义可判、可去重、可回执。 */
export type ControlCommand =
  | { readonly kind: 'cancel_current'; readonly clear_pending: boolean }
  | { readonly kind: 'steer_current'; readonly text: string }
  | { readonly kind: 'status' }

/** 入站消息的规范化信封；context_token 只绑定本条 delivery。 */
export interface InboundEnvelope {
  readonly delivery_id: string
  readonly user_id: string
  readonly received_at: number
  readonly cursor_after_batch?: string
  readonly context_token?: string
  readonly kind: 'text' | 'media' | 'control'
  readonly text: string
  readonly media: readonly NormalizedMedia[]
  readonly control?: ControlCommand
}

// ── delivery 状态机 ───────────────────────────────────────────────────────

/** delivery 的生命周期状态；终态才允许提交批次 cursor。 */
export type DeliveryStatus =
  | 'received'
  | 'routing'
  | 'injected'
  | 'control_applied'
  | 'failed_retryable'
  | 'failed_terminal'

/** 一条入站消息的持久记录。 */
export interface DeliveryRecord {
  readonly delivery_id: string
  readonly user_id: string
  readonly session_id?: string
  readonly status: DeliveryStatus
  readonly received_at: number
  readonly injected_at?: number
  readonly last_error?: string
  readonly attempt: number
  /**
   * 该次入站携带的 context_token。
   *
   * 必须能读回来：TurnContextStore 在"本轮 turn 没有绑定时"靠它兜底发送，
   * 之前库里存了但读取链路没有透传，导致兜底路径永远拿不到 token。
   */
  readonly context_token?: string
  /**
   * 规范化后的入站消息（JSON，不含二进制）。
   *
   * 崩溃恢复的**唯一依据**：只要它存在且状态未达终态，就应重新走一遍注入，
   * 而不是因为 `session_id` 已存在就假定"已经喂给模型了"。
   */
  readonly payload_json?: string
}

/** 该状态是否允许提交其所在批次的 cursor（设计文档 §5.2）。 */
export function is_cursor_committable(status: DeliveryStatus): boolean {
  return status === 'injected' || status === 'control_applied' || status === 'failed_terminal'
}

// ── 出站 outbox ──────────────────────────────────────────────────────────

/** outbox 记录状态。 */
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed_retryable' | 'failed_terminal'

/** 出站消息类别；顺序由同一 Session 的 sequence 决定。 */
export type OutboxKind = 'assistant' | 'control_ack' | 'progress' | 'heartbeat' | 'error'

/** 一条待发送/已发送消息。client_id 首次生成后持久化，重试必须复用。 */
export interface OutboxRecord {
  readonly outbound_id: string
  readonly session_id: string
  readonly user_id: string
  readonly turn?: number
  readonly sequence: number
  readonly kind: OutboxKind
  readonly text: string
  readonly context_token?: string
  readonly client_id: string
  readonly status: OutboxStatus
  readonly attempt: number
  readonly next_retry_at?: number
  readonly last_error?: string
  readonly created_at: number
  readonly sent_at?: number
  /**
   * 已成功发送的分段下标（长文本会被拆成多段）。
   *
   * 重试时据此跳过已送达的段：否则"第 0 段成功、第 1 段失败、整条重试"会让用户
   * 收到重复的第 0 段。不依赖服务端按 client_id 去重（iLink 幂等行为未经验证）。
   */
  readonly sent_parts?: readonly number[]
}

/** 出站发送结果：区分"可重试"与"不可重试"。 */
export interface SendOutcome {
  readonly ok: boolean
  readonly retryable?: boolean
  readonly error?: string
}

// ── 传输层 ────────────────────────────────────────────────────────────────

/** 传输层健康状态；auth_required 需要人工扫码。 */
export type TransportStatus = 'starting' | 'running' | 'backoff' | 'auth_required' | 'stopped'

/** 批次处理结果；只有 true 才允许 cursor 前进。 */
export interface BatchOutcome {
  readonly committed: boolean
  readonly reason: string
}

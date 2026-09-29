/**
 * 微信链路诊断探针：把入站/状态/出站三个状态机的关键跃迁写成结构化 JSONL，
 * 便于事后回答"这条消息走到哪一步、卡在哪、为什么没回复"。
 *
 * 与 llm 探针（DSH_LLM_PROBE_LOG）分工：
 * - llm 探针：模型请求与原始流事件；
 * - 本探针：微信协议、状态机、outbox、lease。
 *
 * 仅在设置 `DSH_WEIXIN_PROBE_LOG`（文件路径）时生效；探针写入失败绝不影响主流程。
 * @module dsh-webhook-weixin/probe
 */

import { appendFile } from 'node:fs/promises'

/** 解析探针日志路径；未配置返回 undefined。 */
function probe_path(): string | undefined {
  const path = process.env.DSH_WEIXIN_PROBE_LOG
  return path !== undefined && path.length > 0 ? path : undefined
}

/** 探针是否启用。 */
export function probe_enabled(): boolean {
  return probe_path() !== undefined
}

/**
 * 追加一条探针记录。
 * @param scope - 子系统名：ingress / state / inbound / outbound / lifecycle / turn-context。
 * @param event - 事件名，如 delivery.received / outbox.sent。
 * @param fields - 结构化字段；值会被安全序列化并截断。
 */
export function probe(scope: string, event: string, fields?: Record<string, unknown>): void {
  const path = probe_path()
  if (path === undefined) return
  const record = {
    at: new Date().toISOString(),
    scope,
    event,
    ...fields === undefined ? {} : { data: sanitize(fields) },
  }
  void appendFile(path, JSON.stringify(record) + '\n', 'utf8').catch(() => undefined)
}

/** 计时器：`const done = probe_timer('scope','event',{...}); ... done({extra})`。 */
export function probe_timer(scope: string, event: string, fields?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
  const started = Date.now()
  return extra => probe(scope, event, { ...fields, ...extra, duration_ms: Date.now() - started })
}

/** 截断长字符串、限制数组长度，保证探针日志不会自我爆炸。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + `…(+${value.length - 400})` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(item => sanitize(item, depth + 1))
    return value.length > 20 ? [...head, `…(+${value.length - 20})`] : head
  }
  if (typeof value === 'object') {
    if (depth > 3) return '[deep]'
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = sanitize(item, depth + 1)
    return out
  }
  return String(value)
}

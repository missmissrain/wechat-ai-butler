/**
 * 诊断探针：把每次模型调用的请求摘要与原始流事件写入 JSONL，用于排查"模型到底回了什么"。
 * 仅在设置 DSH_LLM_PROBE_LOG（文件路径）时生效；探针写入失败不得影响主流程。
 * @module @deepseek-ai/dsh-llm-pi-ai/probe
 */

import { appendFileSync } from 'node:fs'

/** 追加一条探针记录；未设置 DSH_LLM_PROBE_LOG 时什么都不做。 */
export function probe(record: Record<string, unknown>): void {
  const path = process.env.DSH_LLM_PROBE_LOG
  if (path === undefined || path.length === 0) return
  try {
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8')
  } catch {
    // 探针只是诊断辅助，写不进去也不该打断模型调用。
  }
}

/** 把任意值截断成适合写日志的短字符串。 */
export function brief(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return text.length > max ? text.slice(0, max) + `…(+${text.length - max})` : text
}

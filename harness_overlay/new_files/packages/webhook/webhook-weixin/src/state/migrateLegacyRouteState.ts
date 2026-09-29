/**
 * 旧路由状态（JSON）→ SQLite 的一次性迁移。
 *
 * 重构设计文档 §11 阶段 5：旧文件**只读保留**，迁移失败时禁止从空状态启动。
 * 迁移是幂等的：目标库已有数据时直接跳过，不会重复导入。
 * @module dsh-webhook-weixin/migrate-legacy
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from './weixinStateStore.ts'

/** 旧 JSON 的形状。 */
interface LegacyRouteState {
  sessions?: Record<string, string>
  cursor?: string
  deliveries?: string[]
}

/** 迁移结果。 */
export interface MigrationResult {
  readonly migrated: boolean
  readonly reason: string
  readonly sessions: number
  readonly deliveries: number
  readonly cursor: boolean
}

/**
 * 把旧 JSON 路由状态导入 SQLite。
 *
 * @param store - 目标状态库。
 * @param legacy_path - 旧 JSON 路径；不存在时视为无需迁移。
 * @throws 旧文件存在但损坏/无法解析时抛出（fail closed，禁止静默从空状态启动）。
 */
export function migrate_legacy_route_state(store: WeixinStateStore, legacy_path: string): MigrationResult {
  if (!existsSync(legacy_path)) {
    return { migrated: false, reason: 'legacy_absent', sessions: 0, deliveries: 0, cursor: false }
  }
  // 目标库已有状态（路由或游标）时视为已迁移，避免覆盖线上状态。
  const existing = store.route_summary()
  if (existing.users > 0 || store.get_cursor().length > 0) {
    probe('state', 'migrate.skip', { reason: 'target_not_empty', users: existing.users })
    return { migrated: false, reason: 'target_not_empty', sessions: 0, deliveries: 0, cursor: false }
  }

  let parsed: LegacyRouteState
  try {
    parsed = JSON.parse(readFileSync(legacy_path, 'utf8')) as LegacyRouteState
  } catch (error) {
    probe('state', 'migrate.failed', { error: String(error) })
    throw new Error(
      `旧路由状态无法解析，拒绝从空状态启动（fail closed）：${legacy_path} —— `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // 迁移前留一份只读副本，便于人工核对与回退。
  const snapshot = `${legacy_path}.migrated-${Date.now()}`
  try {
    copyFileSync(legacy_path, snapshot)
  } catch (error) {
    probe('state', 'migrate.snapshot_failed', { error: String(error) })
  }

  const sessions = Object.entries(parsed.sessions ?? {})
  const deliveries = parsed.deliveries ?? []
  store.transaction(() => {
    for (const [user_id, session_id] of sessions) store.set_session_id(user_id, session_id)
    for (const delivery_id of deliveries) {
      // 历史 delivery 只登记为已处理（injected），避免迁移后重放旧消息。
      const user_id = sessions.find(([, sid]) => sid !== undefined)?.[0] ?? 'legacy'
      if (store.put_delivery_if_absent({ delivery_id, user_id, received_at: Date.now() })) {
        store.update_delivery(delivery_id, 'injected', { injected_at: Date.now(), session_id: user_id })
      }
    }
    if (parsed.cursor) store.set_cursor(parsed.cursor)
  })

  const result: MigrationResult = {
    migrated: true, reason: 'migrated', sessions: sessions.length,
    deliveries: deliveries.length, cursor: Boolean(parsed.cursor),
  }
  probe('state', 'migrate.done', { ...result })
  console.error(`[webhook-weixin] 已迁移旧路由状态：路由 ${result.sessions} 条、去重 ${result.deliveries} 条、`
    + `游标 ${result.cursor ? '有' : '无'}；旧文件保留在 ${legacy_path}`)
  return result
}

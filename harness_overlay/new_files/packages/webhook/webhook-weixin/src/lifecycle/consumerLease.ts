/**
 * 微信消费者单实例 lease + OpenClaw 隔离 preflight。
 *
 * 重构设计文档 §9.2：
 * - lease 必须是**原子**获取（旧的"读文件-查 PID-写文件"存在竞态）；
 * - 获取失败必须让连接器**启动失败**，不能只打印日志继续；
 * - OpenClaw 不得同时拥有同一微信账号，启动前必须 preflight 检查。
 *
 * 本实现用状态库里的 `consumer_lease` 表做主（原子事务）；同时写一个人类可读的标记文件便于运维排查。
 * @module dsh-webhook-weixin/consumer-lease
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import type { WeixinStateStore } from '../state/weixinStateStore.ts'

/** lease 判定为过期的时间（毫秒）；超时未续租即可被抢占。 */
const DEFAULT_STALE_MS = 90_000

/** 续租间隔（毫秒）；应显著小于 stale。 */
const DEFAULT_HEARTBEAT_MS = 30_000

/** 构造参数。 */
export interface ConsumerLeaseOptions {
  /** 状态库。 */
  readonly store: WeixinStateStore
  /** 账号标识（通常是 bot id），用于提示"谁占着这个账号"。 */
  readonly account_id: string
  /** 人类可读的锁文件路径（仅诊断用，不参与互斥判定）。 */
  readonly marker_path?: string
  /** 过期阈值。 */
  readonly stale_ms?: number
  /** 续租间隔。 */
  readonly heartbeat_ms?: number
}

/** 原子 lease 的持有者句柄。 */
export class ConsumerLease {
  private readonly owner_id: string
  private readonly store: WeixinStateStore
  private readonly account_id: string
  private readonly marker_path: string | undefined
  private readonly stale_ms: number
  private readonly heartbeat_ms: number
  private timer: ReturnType<typeof setInterval> | undefined
  private released = false

  /** 创建持有者（尚未获取）。 */
  constructor(options: ConsumerLeaseOptions) {
    this.store = options.store
    this.account_id = options.account_id
    this.marker_path = options.marker_path
    this.stale_ms = options.stale_ms ?? DEFAULT_STALE_MS
    this.heartbeat_ms = options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS
    this.owner_id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * 尝试获取 lease；失败抛出（调用方必须让连接器启动失败）。
   * @throws 已有活跃消费者时抛出，错误信息包含持有者 pid/账号，便于直接定位。
   */
  acquire(): void {
    const held = this.store.try_acquire_lease({
      owner_id: this.owner_id,
      pid: process.pid,
      process_started_at: Date.now() - Math.round(process.uptime() * 1000),
      account_id: this.account_id,
      stale_ms: this.stale_ms,
    })
    if (!held) {
      const existing = this.store.get_lease()
      const detail = existing === undefined
        ? '（未知持有者）'
        : `pid=${existing.pid} owner=${existing.owner_id} account=${existing.account_id} `
          + `心跳于 ${Math.round((Date.now() - existing.heartbeat_at) / 1000)} 秒前`
      probe('lifecycle', 'lease.acquire_failed', { detail })
      throw new Error(
        `webhook-weixin: 已有另一个微信消费者在运行，拒绝启动 —— ${detail}。`
        + '同一微信账号只允许一个消费者，否则会重复处理消息、分裂会话。请先停掉它。',
      )
    }
    this.write_marker()
    this.timer = setInterval(() => {
      if (!this.store.heartbeat_lease(this.owner_id)) {
        probe('lifecycle', 'lease.heartbeat_lost', { owner_id: this.owner_id })
        console.error('[webhook-weixin] lease 已丢失（可能被抢占），停止续租')
        this.stop_heartbeat()
      }
    }, this.heartbeat_ms)
    this.timer.unref?.()
    probe('lifecycle', 'lease.held', { owner_id: this.owner_id, account_id: this.account_id })
  }

  /** 是否仍持有 lease（心跳丢失后为 false）。 */
  is_held(): boolean {
    return !this.released && this.store.get_lease()?.owner_id === this.owner_id
  }

  /** 释放 lease；幂等。 */
  release(): void {
    if (this.released) return
    this.released = true
    this.stop_heartbeat()
    this.store.release_lease(this.owner_id)
    if (this.marker_path !== undefined) {
      try {
        writeFileSync(this.marker_path, '', 'utf8')
      } catch { /* 标记文件只是诊断辅助 */ }
    }
  }

  /** 停止续租定时器。 */
  private stop_heartbeat(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 写人类可读标记；仅诊断用途。 */
  private write_marker(): void {
    if (this.marker_path === undefined) return
    try {
      mkdirSync(dirname(this.marker_path), { recursive: true })
      writeFileSync(this.marker_path, `owner=${this.owner_id} pid=${process.pid} account=${this.account_id}\n`, 'utf8')
    } catch { /* 忽略 */ }
  }
}

/** preflight 结果。 */
export interface PreflightResult {
  readonly ok: boolean
  readonly problems: readonly string[]
}

/**
 * OpenClaw 隔离 preflight（设计文档 §9.2）。
 *
 * 只做只读检查：OpenClaw 的微信通道若处于启用状态，说明同一账号存在第二个消费者。
 * 检查项：
 * 1. `~/.openclaw/openclaw.json` 的 `plugins.entries.openclaw-weixin.enabled` 必须为 false；
 * 2. 没有正在运行的 OpenClaw gateway 进程持有微信通道。
 *
 * @param openclawConfigPath - 配置文件路径；默认 ~/.openclaw/openclaw.json。
 */
export function preflight_openclaw_isolation(openclawConfigPath?: string): PreflightResult {
  const problems: string[] = []
  const path = openclawConfigPath
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.openclaw', 'openclaw.json')
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as {
      plugins?: { entries?: Record<string, { enabled?: boolean }> }
      channels?: Record<string, unknown>
    }
    const entry = parsed.plugins?.entries?.['openclaw-weixin']
    if (entry?.enabled === true) {
      problems.push(`OpenClaw 的 openclaw-weixin 仍为 enabled: true（${path}）`)
    }
  } catch (error) {
    // 配置文件不存在属正常（未安装 OpenClaw）；解析失败要报出来。
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT') {
      problems.push(`OpenClaw 配置无法解析（${path}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  problems.push(...scan_openclaw_gateway_processes())
  const result: PreflightResult = { ok: problems.length === 0, problems }
  probe('lifecycle', 'preflight.openclaw', { ok: result.ok, problems })
  return result
}

/**
 * 扫描正在运行的 OpenClaw 微信 gateway 进程（Windows）。
 *
 * 只读配置文件是不够的：进程可能正持有同一微信通道，此时两个消费者会互相抢消息
 * （表现为回复丢一半、或收到别人的回复）。因此必须真的查进程。
 *
 * 判定：命令行同时包含 openclaw + gateway + (weixin|channel)。
 * 查询本身失败时 **fail-closed**（报问题），不能因为查不到就当作"没有 OpenClaw"。
 */
function scan_openclaw_gateway_processes(): string[] {
  if (process.platform !== 'win32') return []
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  try {
    const stdout = execFileSync('powershell.exe',
      ['-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    const parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const found: string[] = []
    for (const row of rows as Array<{ ProcessId?: number; CommandLine?: string }>) {
      const command = (row.CommandLine ?? '').toLowerCase()
      if (!command.includes('openclaw')) continue
      if (!command.includes('gateway')) continue
      if (!command.includes('weixin') && !command.includes('channel')) continue
      found.push(`检测到正在运行的 OpenClaw 微信 gateway（pid=${row.ProcessId ?? '?'}）`)
    }
    return found
  } catch (error) {
    return ['无法确认 OpenClaw gateway 是否在运行（进程扫描失败，按 fail-closed 处理）：'
      + (error instanceof Error ? error.message : String(error))]
  }
}

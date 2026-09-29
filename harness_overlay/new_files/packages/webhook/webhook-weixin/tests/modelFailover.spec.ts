/**
 * 模型故障转移测试：错误分类、候选顺序、健康表冷却。
 *
 * 这些是"换不换、换成谁"的判定核心——判错会出现两种坏结果：
 * 网络抖动就乱换模型（对话体验断掉），或者额度用完了死抱着不放（用户干等）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModelHealth,
  classify_llm_failure,
  cooldown_ms,
  find_model_config,
  next_alive_candidate,
  parse_failover_config,
} from '../src/runtime/modelFailover.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 可能仍被占用 */ }
  }
  dirs = []
})

describe('模型配置路径', () => {
  it('优先在 config/ 子目录里找（真实部署就在那儿）', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ws-'))
    dirs.push(workspace)
    mkdirSync(join(workspace, 'config'), { recursive: true })
    writeFileSync(join(workspace, 'config', 'modelConfig.json'), '{}')
    expect(find_model_config(workspace)).toBe(join(workspace, 'config', 'modelConfig.json'))
  })

  it('退回工作区根目录也能找到；都没有则 undefined（调用方据此报"配置缺失"）', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ws-'))
    dirs.push(workspace)
    writeFileSync(join(workspace, 'modelConfig.json'), '{}')
    expect(find_model_config(workspace)).toBe(join(workspace, 'modelConfig.json'))

    const empty = mkdtempSync(join(tmpdir(), 'ws-'))
    dirs.push(empty)
    expect(find_model_config(empty)).toBeUndefined()
  })
})

describe('错误分类', () => {
  it('额度类（限额/quota/欠费）判为 quota', () => {
    // 注意它的 type 也叫 rate_limit_exceeded：额度必须比限流先判
    expect(classify_llm_failure('429: {"message":"api key 日限额已用完","type":"rate_limit_exceeded"}')).toBe('quota')
    expect(classify_llm_failure('api key 7天限额已用完')).toBe('quota')
    expect(classify_llm_failure('quota exceeded for this key')).toBe('quota')
    expect(classify_llm_failure('账户余额不足，请充值')).toBe('quota')
  })

  it('普通 429 / Too Many Requests 归限流（几秒后就能用，不该等一小时）', () => {
    expect(classify_llm_failure('HTTP 429 Too Many Requests')).toBe('rate_limit')
  })

  it('鉴权失败（401/403、key 无效）判为 auth', () => {
    expect(classify_llm_failure('401 Unauthorized')).toBe('auth')
    expect(classify_llm_failure('{"error":{"message":"invalid api key"}}')).toBe('auth')
    expect(classify_llm_failure('api key 已失效，请重新获取')).toBe('auth')
  })

  it('并发/限流类的 403 判为 rate_limit，不能当鉴权失败（否则好模型被长期拉黑）', () => {
    // 实测原文：中转站并发满了就回这个
    expect(classify_llm_failure("HTTP 403: You've reached your concurrent request limit. Please wait"))
      .toBe('rate_limit')
    expect(classify_llm_failure('403 Too Many Requests')).toBe('rate_limit')
    expect(classify_llm_failure('Our servers are currently overloaded. Please try again later.'))
      .toBe('rate_limit')
    expect(classify_llm_failure('服务繁忙，请稍后重试')).toBe('rate_limit')
  })

  it('模型不存在/下线判为 model_missing', () => {
    expect(classify_llm_failure('404 model not found')).toBe('model_missing')
    expect(classify_llm_failure('the model `gpt-x` does not exist')).toBe('model_missing')
  })

  it('网络抖动、5xx、超时不换模型（交给 harness 自己的重试）', () => {
    expect(classify_llm_failure('ECONNRESET')).toBeUndefined()
    expect(classify_llm_failure('500 Internal Server Error')).toBeUndefined()
    expect(classify_llm_failure('request timed out after 300000ms')).toBeUndefined()
    expect(classify_llm_failure('stream closed unexpectedly')).toBeUndefined()
  })
})

describe('候选顺序', () => {
  const config = {
    defaultModel: { provider: 'dahuangfen', model: 'gpt-5.6-terra' },
    providers: {
      dahuangfen: { apiKey: 'k1', models: [{ id: 'gpt-5.6-terra' }] },
      volcengine: { apiKey: 'k2', models: [{ id: 'doubao-pro' }, { id: 'doubao-lite' }] },
      'gemma-local': { apiKey: 'none', models: [{ id: 'gemma' }] },
    },
  }

  it('没写 failover.order 时：默认模型打头，其余按配置顺序跟上，本地模型不参与', () => {
    const parsed = parse_failover_config(config)
    expect(parsed.enabled).toBe(true)
    expect(parsed.order.map(item => `${item.provider}/${item.model}`)).toEqual([
      'dahuangfen/gpt-5.6-terra', 'volcengine/doubao-pro', 'volcengine/doubao-lite',
    ])
  })

  it('写了 order 就用它（可以显式排除某个 provider）', () => {
    const parsed = parse_failover_config({
      ...config,
      failover: { order: [{ provider: 'volcengine', model: 'doubao-pro' }] },
    })
    expect(parsed.order).toEqual([{ provider: 'volcengine', model: 'doubao-pro' }])
  })

  it('显式顺序里指向已删除 provider/模型的条目会被丢掉（不留悬空引用）', () => {
    const parsed = parse_failover_config({
      ...config,
      failover: {
        order: [
          { provider: 'aihub', model: 'Doubao-Seed-2.0-lite' },   // provider 已删
          { provider: 'volcengine', model: '不存在的模型' },        // 模型不存在
          { provider: 'volcengine', model: 'doubao-pro' },        // 这条有效
        ],
      },
    })
    expect(parsed.order).toEqual([{ provider: 'volcengine', model: 'doubao-pro' }])
  })

  it('enabled:false 时整体关掉', () => {
    expect(parse_failover_config({ ...config, failover: { enabled: false } }).enabled).toBe(false)
  })

  it('挑下一个活着的：跳过已失活的，且不回头横跳', () => {
    const order = [
      { provider: 'a', model: 'm1' },
      { provider: 'b', model: 'm2' },
      { provider: 'c', model: 'm3' },
    ]
    const dead = new Set(['b/m2'])
    expect(next_alive_candidate(order, order[0], item => dead.has(`${item.provider}/${item.model}`)))
      .toEqual(order[2])
    // 当前是最后一个 → 回头找前面还活着的
    expect(next_alive_candidate(order, order[2], item => dead.has(`${item.provider}/${item.model}`)))
      .toEqual(order[0])
    // 全都失活 → undefined（调用方据此告诉用户"都不行了"）
    expect(next_alive_candidate(order, order[0], () => true)).toBeUndefined()
  })
})

describe('健康表', () => {
  it('失活后进冷却；冷却到期自动恢复尝试', () => {
    let now = 1_000_000
    const health = new ModelHealth(() => now)
    const candidate = { provider: 'a', model: 'm1' }
    health.mark_dead(candidate, 'quota', '429 限额已用完', 60_000)

    expect(health.is_dead(candidate)).toBe(true)
    expect(health.snapshot()[0]).toMatchObject({ provider: 'a', model: 'm1', reason: 'quota' })
    now += 59_999
    expect(health.is_dead(candidate)).toBe(true)
    now += 2
    expect(health.is_dead(candidate)).toBe(false)      // 到期即视为可再试
    expect(health.snapshot()).toEqual([])
  })

  it('冷却时间：限流最短（3 分钟）、额度类用配置值、鉴权类最长（24 小时）', () => {
    const config = parse_failover_config({ failover: { cooldownMs: 7_200_000 } })
    expect(cooldown_ms('rate_limit', config)).toBe(3 * 60_000)
    expect(cooldown_ms('quota', config)).toBe(7_200_000)
    expect(cooldown_ms('auth', config)).toBe(24 * 60 * 60_000)
  })
})

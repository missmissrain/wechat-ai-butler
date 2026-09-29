/**
 * 密钥与模型定义分离的测试。
 *
 * 背景：`config/modelConfig.json` 以前既放模型定义又放密钥，分享/备份/贴给别人看时
 * 很容易把 key 带出去。现在拆成 `modelConfig.json`（只有定义）+ `secrets.json`（只有密钥）。
 * 这里验证 harness 侧读云端模型时能正确从 secrets.json 取到 key（缺文件时也不炸）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolve_cloud_target } from '../src/memory/memoryModel.ts'

let dirs: string[] = []

function workspace_with(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'config'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'config', name), JSON.stringify(content, null, 2), 'utf8')
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* Windows 可能仍被占用 */ }
  }
  dirs = []
})

const MODEL_CONFIG = {
  providers: {
    volcengine: {
      baseURL: 'https://ark.example.com/api/v3',
      apiKeyEnv: 'ARK_API_KEY',
      models: [{ id: 'doubao-lite' }],
    },
  },
}

describe('密钥与模型定义分离', () => {
  it('modelConfig 只有定义时，apiKey 从同目录 secrets.json 取', () => {
    const dir = workspace_with({
      'modelConfig.json': MODEL_CONFIG,
      'secrets.json': { providers: { volcengine: { apiKey: 'sk-from-secrets' } } },
    })
    const target = resolve_cloud_target(join(dir, 'config', 'modelConfig.json'), 'volcengine/doubao-lite')
    expect(target).toEqual({
      base_url: 'https://ark.example.com/api/v3',
      model: 'doubao-lite',
      api_key: 'sk-from-secrets',
    })
  })

  it('没有 secrets.json 时仍能解析出目标（只是没有 key），不抛错', () => {
    const dir = workspace_with({ 'modelConfig.json': MODEL_CONFIG })
    const target = resolve_cloud_target(join(dir, 'config', 'modelConfig.json'), 'volcengine/doubao-lite')
    expect(target?.base_url).toBe('https://ark.example.com/api/v3')
    expect(target?.api_key).toBeUndefined()
  })

  it('modelConfig 里残留的 apiKey 仍然优先（兼容手工把 key 写回旧位置）', () => {
    const dir = workspace_with({
      'modelConfig.json': {
        providers: {
          volcengine: { baseURL: 'https://ark.example.com/api/v3', apiKey: 'sk-legacy', models: [{ id: 'doubao-lite' }] },
        },
      },
      'secrets.json': { providers: { volcengine: { apiKey: 'sk-from-secrets' } } },
    })
    const target = resolve_cloud_target(join(dir, 'config', 'modelConfig.json'), 'volcengine/doubao-lite')
    expect(target?.api_key).toBe('sk-legacy')
  })
})

/** 中文短协议测试：字典无歧义、往返一致、工具 schema 与参数键改名正确。 */

import { describe, expect, it } from 'vitest'
import {
  PARAM_NAME_ZH,
  TOOL_NAME_ZH,
  canonicalParamName,
  canonicalToolName,
  canonicalizeArguments,
  canonicalizeBlock,
  wireParamName,
  wireToolSchema,
  wireToolName,
  wireTools,
} from '../src/zh-wire.ts'
import type { ContentBlock, ToolSchema } from '../src/types.ts'

describe('zh-wire 字典', () => {
  it('工具短名唯一且长度 1-4 个字符', () => {
    const seen = new Set<string>()
    for (const [canonical, zh] of Object.entries(TOOL_NAME_ZH)) {
      expect(zh.length, `${canonical} -> ${zh}`).toBeGreaterThanOrEqual(1)
      expect(zh.length, `${canonical} -> ${zh}`).toBeLessThanOrEqual(4)
      expect(seen.has(zh), `重复短名 ${zh}`).toBe(false)
      seen.add(zh)
    }
  })

  it('参数短名唯一且长度 1-4 个字符', () => {
    const seen = new Set<string>()
    for (const [canonical, zh] of Object.entries(PARAM_NAME_ZH)) {
      expect(zh.length, `${canonical} -> ${zh}`).toBeGreaterThanOrEqual(1)
      expect(zh.length, `${canonical} -> ${zh}`).toBeLessThanOrEqual(4)
      expect(seen.has(zh), `重复短名 ${zh}`).toBe(false)
      seen.add(zh)
    }
  })

  it('工具名与参数名往返一致', () => {
    for (const canonical of Object.keys(TOOL_NAME_ZH)) {
      expect(canonicalToolName(wireToolName(canonical))).toBe(canonical)
    }
    for (const canonical of Object.keys(PARAM_NAME_ZH)) {
      expect(canonicalParamName(wireParamName(canonical))).toBe(canonical)
    }
  })

  it('未登记的规范名原样透传', () => {
    expect(wireToolName('unknown_tool')).toBe('unknown_tool')
    expect(canonicalToolName('unknown_tool')).toBe('unknown_tool')
    expect(wireParamName('mystery')).toBe('mystery')
  })
})

describe('zh-wire 转换', () => {
  const readTool: ToolSchema = {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  }

  it('改名工具名、顶层参数键与 required，嵌套结构保持原样', () => {
    const wired = wireToolSchema(readTool)
    expect(wired.name).toBe('读')
    expect(wired.description).toBe('览文得号')
    expect(Object.keys(wired.parameters.properties as Record<string, unknown>)).toEqual(['文件', '起', '限'])
    expect(wired.parameters.required).toEqual(['文件'])
  })

  it('带嵌套数组参数的工具只改顶层键', () => {
    const tool: ToolSchema = {
      name: 'ask_user_question',
      description: 'Questions to ask the user before continuing.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: { type: 'object', properties: { question: { type: 'string' }, header: { type: 'string' } } },
          },
        },
      },
    }
    const wired = wireToolSchema(tool)
    expect(wired.name).toBe('问')
    const props = wired.parameters.properties as Record<string, { items: { properties: Record<string, unknown> } }>
    expect(Object.keys(props)).toEqual(['问项'])
    expect(Object.keys(props['问项']!.items.properties)).toEqual(['question', 'header'])
  })

  it('把模型返回的顶层参数键映射回规范名', () => {
    expect(canonicalizeArguments('{"文件":"a.txt","起":1}')).toBe('{"file_path":"a.txt","offset":1}')
    expect(canonicalizeArguments('')).toBe('')
    expect(canonicalizeArguments('not-json')).toBe('not-json')
    expect(canonicalizeArguments('{"嵌套":{"文件":"x"}}')).toBe('{"嵌套":{"文件":"x"}}')
  })

  it('把回流的工具调用块映射回规范名', () => {
    const block: ContentBlock = { type: 'tool-call', id: 'c1' as never, name: '读', arguments: '{"文件":"a.txt"}' }
    const canonical = canonicalizeBlock(block)
    expect(canonical).toEqual({ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' })
  })

  it('wireTools 对 undefined 返回 undefined，对空数组返回空数组', () => {
    expect(wireTools(undefined)).toBeUndefined()
    expect(wireTools([])).toEqual([])
  })
})

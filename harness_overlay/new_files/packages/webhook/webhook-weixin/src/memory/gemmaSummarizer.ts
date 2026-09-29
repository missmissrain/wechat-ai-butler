/**
 * 用本地 Gemma（llama.cpp llama-server）生成时间线摘要。
 *
 * 为什么是本地：摘要只需"读懂一天对话并写几条要点"，Gemma 实测一整天才 ~10 秒，
 * 且免费、不占云端配额。缺点是上下文 32k、长输入会变概括，所以这里对超长的一天
 * 自动走**分块 map-reduce**（分块小结 → 合并）。
 *
 * 显存是懒加载的：llama-server 用 `--sleep-idle-seconds` 启动，空闲后自动把模型
 * 从显存卸下（实测 4.4GB → 0.8GB），下次请求自动唤醒（约 18 秒）。
 * 因此这里的超时必须给足，覆盖"唤醒 + 生成"。
 *
 * @module dsh-webhook-weixin/gemma-summarizer
 */

import { probe } from '../diagnostics/probe.ts'
import type { TimelineAttachment, TimelineEntry, TimelineSummarizer, TimelineSummaryRequest } from './timelineTypes.ts'

/** 摘要生成参数。 */
export interface GemmaSummarizerOptions {
  /** OpenAI 兼容端点根，默认 `http://127.0.0.1:8080/v1`。 */
  readonly base_url?: string
  /** 模型名，默认 `gemma-4-E4B-it-Q4_K_M`。 */
  readonly model?: string
  /** 单次输出上限，默认 600 token。 */
  readonly max_tokens?: number
  /**
   * 单次请求超时（毫秒），默认 5 分钟。
   *
   * 必须够宽：llama-server 处于休眠时，第一次请求要先把模型读回显存（实测 ~18 秒）。
   */
  readonly timeout_ms?: number
  /** 超过这个字符数就分块（默认 24000 字符，约 7k token，留足余量）。 */
  readonly chunk_chars?: number
  /** 可注入的 fetch，便于测试。 */
  readonly fetch_impl?: typeof fetch
  /**
   * 可注入的"补全"实现：给了就用它，绕过内置的本地 Gemma 直连。
   *
   * 用途：让摘要走**记忆模型客户端**——本地 Gemma 或云端模型由配置决定，
   * 而这里只需关心"给提示词、拿文本"。
   */
  readonly complete?: (prompt: string, max_tokens: number) => Promise<string>
}

/**
 * 摘要提示词（A 段：规则；数据单独放在 B 段）。
 *
 * 这里是 A/B 实测出来的版本，改动都有依据：
 * - **A/B 分离**（规则块 + 【数据】块）：混在一起时模型会把规则当数据读。
 * - **给"完成"立唯一判据**：旧版把"已设置提醒"误判成"已完成"（实测 3 次里错 2 次），
 *   所以现在显式列举什么算完成、并**明确否定**"设置提醒/安排时间/记下来"。
 * - **完成标记只允许出现在"事实"行**：待办行禁止出现任何完成字样，
 *   这样语义上不可能再把待办标成完成。
 * 实测（同一份带陷阱的评测集，各跑 3 次）：误标 2/3 → 0/3；完成标记 1/3 → 3/3。
 */
const INSTRUCTIONS = [
  '【角色】你是长期记忆整理器。输入是某一天"用户"与"助手"的对话记录。',
  '【输出格式】',
  '- 中文，最多 6 条，每条一行，以 "- " 开头',
  '- 每行以类别开头，类别只能是：事实 / 待办 / 偏好',
  '- 只输出这些行，不要标题、前言、结语、解释',
  '【完成标记的唯一判据】',
  'A. 只有"记录里明确说了这件事已经做完"才能标"（已完成）"：助手的完成声明（改好了/已发出/测试通过/已关闭），或用户的完成声明（已经交了/已经弄完了/不用了）。',
  'B. "设置提醒""安排时间""约定日期""记下来"一律**不是**完成，必须写成待办。',
  'C. 未完成的、正在进行中的、未来的事情，一律**不得**出现"（已完成）"三个字。',
  '【逐行规则】',
  '1. 已完成的事项写成："- 事实：<事项>（已完成）"；完成标记**只允许出现在 事实 行**。',
  '2. 待办写成："- 待办：<事项>（<时间，若有>）"，待办行**禁止**出现任何完成字样。',
  '3. 偏好写成："- 偏好：<内容>"；用户发来的图片若写了内容描述，可写成 "- 事实：用户发来一张照片（<描述要点>）"。',
  '4. 每条必须能对应到记录原话；对应不上就不写。禁止推断、补常识、评价、编造。',
  '5. 时间口径保留记录原话；记录未给具体日期时不要自己换算。',
  '6. 不写寒暄、情绪、客套话。',
].join('\n')

/** 把一天的记录渲染成给模型看的文本（含媒体描述，让摘要能提到"发了什么图"）。 */
function render_entries(entries: readonly TimelineEntry[]): string {
  return entries.map(item => {
    const head = `[${item.role === 'user' ? '用户' : '助手'}] ${item.text.trim()}`
    const media = (item.attachments ?? [])
      .map(attach => `  [图片${attach.name === undefined ? '' : ' ' + attach.name}] ${attach.description ?? '(无描述)'}`)
      .join('\n')
    return media === '' ? head : `${head}\n${media}`
  }).join('\n')
}

/** 按字符预算把记录切成若干块（至少一块）。 */
function chunk_entries(entries: readonly TimelineEntry[], budget: number): TimelineEntry[][] {
  const chunks: TimelineEntry[][] = []
  let current: TimelineEntry[] = []
  let size = 0
  for (const item of entries) {
    const cost = item.text.length + 16
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 创建 Gemma 摘要器。
 *
 * @param options - 端点与生成参数。
 * @returns 可直接交给 `TimelineStore.summarize_due()` 的摘要器。
 */
export function create_gemma_summarizer(options?: GemmaSummarizerOptions): TimelineSummarizer {
  const base_url = (options?.base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
  const model = options?.model ?? 'gemma-4-E4B-it-Q4_K_M'
  const max_tokens = options?.max_tokens ?? 600
  const timeout_ms = options?.timeout_ms ?? 300_000
  const chunk_chars = options?.chunk_chars ?? 24_000
  const fetch_impl = options?.fetch_impl ?? fetch

  const complete = options?.complete ?? (async (prompt: string, tokens: number): Promise<string> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    try {
      const response = await fetch_impl(`${base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: tokens,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`gemma HTTP ${response.status}`)
      const parsed = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = parsed.choices?.[0]?.message?.content ?? ''
      probe('timeline', 'gemma.completion', {
        model, prompt_tokens: parsed.usage?.prompt_tokens,
        completion_tokens: parsed.usage?.completion_tokens,
      })
      return text.trim()
    } finally {
      clearTimeout(timer)
    }
  })

  return async (request: TimelineSummaryRequest) => {
    const rendered = render_entries(request.entries)
    // 刻意**不把上一版摘要喂回去**（request.previous_summary 保留在类型里但这里不用）。
    //
    // 实测教训：旧摘要里一旦有错（例如把"已设提醒"写成"已完成"），
    // 把它作为"参考"再喂给模型，模型会**照抄错误**，于是错一句就永远错下去。
    // 一天的记录是完整的（我们不裁剪历史），所以摘要完全可以只由当天记录推出；
    // 宁可每次从原始记录重算，也不让旧错误有机会自我延续。
    const previous = ''

    // 短的一天：一次搞定。规则（A 段）与数据（B 段）必须分开，否则模型会把规则当数据读。
    if (rendered.length <= chunk_chars) {
      const text = await complete(
        `${INSTRUCTIONS}${previous}\n\n【数据】\n日期：${request.date}\n对话记录：\n${rendered}`,
        max_tokens,
      )
      return { text, model }
    }

    // 长的一天：分块小结，再合并。避免一次性超过 32k 上下文而丢信息。
    const chunks = chunk_entries(request.entries, chunk_chars)
    probe('timeline', 'gemma.map_reduce', { date: request.date, chunks: chunks.length, chars: rendered.length })
    const partials: string[] = []
    for (const [index, chunk] of chunks.entries()) {
      const text = await complete(
        `${INSTRUCTIONS}\n\n【数据】\n这是当天第 ${index + 1}/${chunks.length} 段记录，请只整理这一段：\n${render_entries(chunk)}`,
        300,
      )
      partials.push(`【第 ${index + 1} 段】\n${text}`)
    }
    const merged = await complete(
      `${INSTRUCTIONS}${previous}\n\n【数据】\n下面是同一天各段的小结，请合并成一份当天摘要（格式同上，不要照抄段落编号）：\n\n${partials.join('\n\n')}`,
      max_tokens,
    )
    return { text: merged, model }
  }
}

/** 图片描述器参数。 */
export interface GemmaImageDescriberOptions extends GemmaSummarizerOptions {
  /** 描述要求（默认一句话，突出可检索的要素）。 */
  readonly instruction?: string
}

/**
 * 创建"图片一句话描述"生成器（走同一个 llama-server 的视觉通道）。
 *
 * 前置条件：llama-server 必须用 `--mmproj` 载入视觉投影器，否则图片会被忽略或报错。
 * 描述会写进时间线记录，并随当天摘要一起被检索——**原图仍是权威**，
 * 描述只是让"发了什么图"变成可搜索的文本。
 *
 * @param options - 端点与生成参数。
 * @returns 描述函数；输入图片字节与 mime，输出一句话。
 */
export function create_gemma_image_describer(
  options?: GemmaImageDescriberOptions,
): (input: { data: Uint8Array, media_type: string }) => Promise<string> {
  const base_url = (options?.base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
  const model = options?.model ?? 'gemma-4-E4B-it-Q4_K_M'
  const timeout_ms = options?.timeout_ms ?? 300_000
  const instruction = options?.instruction
    ?? '用一句中文描述这张图片的主要内容（谁/什么、在哪、在做什么、明显的文字）。只输出这一句话，不要评价，不要客套。'
  const fetch_impl = options?.fetch_impl ?? fetch

  return async (input) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    try {
      const response = await fetch_impl(`${base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${input.media_type};base64,${Buffer.from(input.data).toString('base64')}`,
                },
              },
            ],
          }],
          temperature: 0.2,
          max_tokens: 200,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`gemma vision HTTP ${response.status}`)
      const parsed = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const text = (parsed.choices?.[0]?.message?.content ?? '').trim()
      probe('timeline', 'gemma.image_described', { model, chars: text.length })
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 从附件引用里挑出"还没描述"的项，便于回填。 */
export function undescribed_attachments(attachments: readonly TimelineAttachment[] | undefined): TimelineAttachment[] {
  return (attachments ?? []).filter(item => item.description === undefined)
}

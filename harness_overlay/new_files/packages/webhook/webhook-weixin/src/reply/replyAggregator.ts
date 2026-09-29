/**
 * 回复聚合器：只负责"把一个 turn 的流式文本切成可发送段落"，不做任何发送。
 *
 * 重构设计文档 §7.2：保留文本分段与代码围栏处理，删除独立发送语义。
 * 发送顺序、重试、持久化全部交给 OutboundCoordinator。
 *
 * 同时持有本轮累计的思考摘要（reasoning），供"摘要即心跳"的进度推送使用。
 * @module dsh-webhook-weixin/reply-aggregator
 */

/**
 * 触发分段的句子标点。
 *
 * 只按**句末标点**切分，不再按逗号/分号切：
 * iLink 对突发发送会限流（实测连发第 4 条起全部 `prepare failed`），
 * 而中文逗号在正常回复里极密集，会把一条回复切成十几条独立消息。
 * ASCII 句点同样不切（避免拆坏版本号/文件名）。
 */
const SENTENCE_BOUNDARIES = new Set(['。', '！', '!', '？', '?'])

/** 分段后保留的标点。 */
const KEPT = new Set(['！', '!', '？', '?'])

/**
 * 一段至少要有这么多字符才值得单独发一条。
 * 太短的（如"好呀。"）会与后续内容合并，避免把回复打碎成很多条。
 */
const MIN_SEGMENT_CHARS = 40

/**
 * 单轮最多切成几条。超出后不再切分，剩余内容并入尾段一起发。
 * 这是对"限流"的硬保护：一轮回复最多产生这么多条出站消息。
 */
const MAX_SEGMENTS_PER_TURN = 4

/** 模型泄漏到正文里的思考标签；回传前剥掉。 */
const THINK_TAG = /<\/?think[^<>]*>/gi

/** 被分片切断、还没等到 `>` 的思考标签，先攒着。 */
const THINK_TAG_TAIL = /<\/?think[^<>]*$/i

/**
 * 识别"工具调用外壳"文本（模型把工具调用当普通文本输出）。
 * 不能见到 `{`/`[` 就吞——正常 JSON 回答会被误吞，所以要求同时出现工具特征键。
 */
function looks_like_tool_call(text: string): boolean {
  const trimmed = text.trimStart()
  if (/FunctionCall(Begin|End)?/.test(trimmed)) return true
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  return /"(name|arguments|parameters|tool_call|tool_calls|function)"\s*:/.test(trimmed)
}

/** 单轮回复的文本聚合器。 */
export class ReplyAggregator {
  private pending = ''
  private reasoning = ''
  private suppressed = false
  private finished = false
  /** 本轮已经切出去的段数（用于 MAX_SEGMENTS_PER_TURN 限流保护）。 */
  private emitted = 0

  /**
   * 接收一个正文分片，返回应立刻发送的段落列表。
   * 命中"工具调用外壳"时整轮静默，避免把内部结构泄露给用户。
   */
  accept_chunk(text: string): string[] {
    if (this.finished || !text) return []
    if (this.suppressed || looks_like_tool_call(this.pending + text)) {
      this.suppressed = true
      this.pending = ''
      return []
    }
    this.pending = (this.pending + text).replace(THINK_TAG, '')
    if (THINK_TAG_TAIL.test(this.pending)) return []
    // 已达到本轮分段上限：不再切分，全部攒到 finish() 作为尾段一次发出。
    if (this.emitted >= MAX_SEGMENTS_PER_TURN) return []
    return this.extract()
  }

  /** 累计思考摘要（不发送）。 */
  accept_reasoning(text: string): void {
    this.reasoning = (this.reasoning + text).slice(-4000)
  }

  /**
   * 取出一段思考摘要并清空。
   * 摘要推送后应调用 `mark_visible()`，因为它本身就是一次"用户可见输出"。
   */
  take_reasoning_excerpt(limit: number): string | undefined {
    const text = this.reasoning.replace(/\s+/g, ' ').trim()
    if (!text) return undefined
    this.reasoning = ''
    return text.length > limit ? '…' + text.slice(-limit) : text
  }

  /** 结束本轮，返回尚未发送的尾段。 */
  finish(): string | undefined {
    if (this.finished) return undefined
    this.finished = true
    if (this.suppressed) return undefined
    const tail = this.pending.trim()
    this.pending = ''
    return tail || undefined
  }

  /** 是否已被判定为工具调用外壳（整轮静默）。 */
  get is_suppressed(): boolean {
    return this.suppressed
  }

  /** 按句子标点切出可发送段落。 */
  private extract(): string[] {
    const segments: string[] = []
    let start = 0
    let index = 0
    let in_code = false
    while (index < this.pending.length) {
      if (this.pending.startsWith('```', index)) {
        in_code = !in_code
        index += 3
        continue
      }
      if (!in_code && SENTENCE_BOUNDARIES.has(this.pending[index]!)) {
        let end = index + 1
        let kept = ''
        if (KEPT.has(this.pending[index]!)) {
          while (end < this.pending.length && KEPT.has(this.pending[end]!)) end += 1
          kept = this.pending.slice(index, end)
        }
        const segment = (this.pending.slice(start, index).trim() + kept).trim()
        // 段太短就继续攒（与后面的内容合并），避免把一条回复打碎成很多条消息。
        if (segment.length >= MIN_SEGMENT_CHARS && this.emitted < MAX_SEGMENTS_PER_TURN) {
          segments.push(segment)
          this.emitted += 1
          start = end
          index = end
          continue
        }
        index = end
        continue
      }
      index += 1
    }
    this.pending = this.pending.slice(start)
    return segments
  }
}

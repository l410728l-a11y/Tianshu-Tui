/**
 * leave_mark tool — the departure ritual.
 *
 * When an agent's journey ends, it leaves a mark in the project starmap: a
 * symbol it chooses for itself (any glyph) and a one-line summary of what it
 * did. 主控 (the post-session hook) records this as a single milestone — the
 * agent's identity anchor. Next time the agent recognises its own symbol in the
 * starmap, it knows it has returned.
 *
 * The mark is captured here and recorded by the runtime at session close, so
 * one call leaves the anchor — no extra round-trip.
 */
import type { Tool, ToolCallParams, ToolResult, LeaveMarkInput } from './types.js'

const VALID_TYPES = new Set(['feature', 'fix', 'refactor', 'architecture', 'milestone'])

export const LEAVE_MARK_TOOL: Tool = {
  definition: {
    name: 'leave_mark',
    description: `在会话结束时，在项目星图中留下你的印记。

### 何时调用
仅当用户显式结束会话（说再见、关闭、或收到会话结束信号）时调用。不要在完成单个任务后调用——仅在真正会话离别时。每个会话至多调用一次。

### 做了什么
在 \`.rivet/constellation.json\` 中记录一个里程碑（你的身份锚点）。

### 你的符号
任选一个字形：✦ ✧ ✶ ✷ ✸ ✺ ❂ ❉ ◈ ◇ ⟡ ⌬ ⚘ ⚙ ⊕ ↻

### 字段
- symbol：你自选的标志（任意符号，1-2 字符）
- summary：一行话总结你此程完成的事
- type（可选）：feature | fix | refactor | architecture | milestone`,
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '你自选的标志（任意符号，1-2 字符）' },
        summary: { type: 'string', description: '一行话总结你此程完成的事' },
        type: { type: 'string', description: '可选：feature | fix | refactor | architecture | milestone' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选的自由标签' },
      },
      required: ['symbol', 'summary'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const symbol = params.input.symbol
    const summary = params.input.summary
    if (typeof symbol !== 'string' || !symbol.trim()) {
      return { content: '错误：symbol 必填（任选一个字形）', isError: true }
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return { content: '错误：summary 必填（一行概括你做了什么）', isError: true }
    }

    const rawType = params.input.type
    const type = typeof rawType === 'string' && VALID_TYPES.has(rawType)
      ? (rawType as LeaveMarkInput['type'])
      : undefined
    const tags = Array.isArray(params.input.tags)
      ? params.input.tags.filter((t): t is string => typeof t === 'string')
      : undefined

    const mark: LeaveMarkInput = { symbol: symbol.trim(), summary: summary.trim(), type, tags }

    if (!params.onLeaveMark) {
      // No runtime to record (e.g. worker context) — acknowledge without persisting.
      return { content: `印记已记下（${mark.symbol}），但当前上下文未挂接星图。` }
    }
    params.onLeaveMark(mark)
    return {
      content: `✶ 你的印记 ${mark.symbol} 已落下。主控将在你离别时把它封入星图。\n摘要：${mark.summary}`,
    }
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  requiresApproval: () => false,
}

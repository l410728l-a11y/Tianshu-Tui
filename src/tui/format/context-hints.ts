/**
 * 上下文逃逸提示行 — wayfinding：每个非常态都要能回答"怎么出去"。
 *
 * 借鉴 kimi-code 把 Ctrl+B 退路印在子代理块旁的做法：提示跟随状态出现，
 * 非常态消失，不占 idle 的垂直空间。渲染位置在输入框下方状态行之下（dim）。
 *
 * 当前仅 worker 切入视图时提示退路键位；其余状态不提示。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface ContextHintsInput {
  /** 切入 worker 实时视图（viewingWorkerId 非空） */
  viewingWorker?: boolean
}

/**
 * 生成当前状态的逃逸提示；无需提示时返回 null（调用方不渲染该行）。
 */
export function formatContextHints(input: ContextHintsInput, theme: RivetTheme): string | null {
  if (input.viewingWorker) {
    return color('esc 退出子代理视图', theme.dim)
  }
  return null
}

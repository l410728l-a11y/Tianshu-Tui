/**
 * T9 格式化函数 — 用户消息（闪亮贯穿导轨与清晰视觉分层）。
 *
 * 渲染结构：
 * ▌ 消息首行             (userColor + bold，闪亮标识)
 * ▌ 消息后续行           (使用 userColor 贯穿左侧导轨，全文高亮分色)
 * ▌
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatUserMessageInput {
  /** 消息文本内容 */
  content: string
  /** 终端宽度（列数） */
  width: number
}

export function formatUserMessage(input: FormatUserMessageInput, theme: RivetTheme): string[] {
  const lines: string[] = []

  const contentLines = input.content.split('\n')
  const useAscii = chalk.level < 3
  const marker = useAscii ? '❯' : '▌'
  const prefix = color(marker, theme.userColor, { bold: true })

  if (contentLines.length > 0) {
    // 首行：亮色 marker 符印 + 首行文字（用 userColor + bold 打亮）
    lines.push(`${prefix} ${color(contentLines[0]!, theme.userColor, { bold: true })}`)
    
    // 后续所有行：贯穿式亮色 marker 边框 + 消息正文（使用高亮 userColor 上色）
    for (let i = 1; i < contentLines.length; i++) {
      const lineText = contentLines[i]!
      if (lineText.trim().length === 0) {
        lines.push(`${prefix}`)
      } else {
        lines.push(`${prefix} ${color(lineText, theme.userColor)}`)
      }
    }
  }

  return lines
}

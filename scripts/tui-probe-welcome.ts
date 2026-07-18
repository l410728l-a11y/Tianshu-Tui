/**
 * TUI 探针 — 首屏欢迎页多形态预览。
 *
 * 用途：渲染 formatWelcome 在 80/40/20 列与 compact（恢复会话）形态下的输出，
 * 验证刊头对齐（版本右栏）、截断降级与配色。改 welcome.ts 后跑一遍即可目视回归。
 *
 * 运行：node --import tsx scripts/tui-probe-welcome.ts [--cols 80,40,20]
 * 环境：TUI_PROBE_THEME 指定主题（默认 graphite）。
 */
import { formatWelcome } from '../src/tui/format/welcome.js'
import { setTheme, getTheme } from '../src/tui/theme.js'

const args = process.argv.slice(2)
const colsArg = args.find(a => a.startsWith('--cols=')) ?? args[args.indexOf('--cols') + 1]
const colsList = (typeof colsArg === 'string' ? colsArg : '80,40,20').split(',').map(Number)

const themeName = process.env.TUI_PROBE_THEME ?? 'graphite'
setTheme(themeName)
const theme = getTheme(3) // truecolor 轨

const base = {
  modelName: 'deepseek-v4',
  cwd: process.cwd(),
  sessionId: '878e2108-abcd-1234-5678-0123456789ab',
  priorMsgCount: 0,
  version: '2.19.5',
  approvalMode: 'auto-safe',
  reasoningEffort: 'high',
  numericId: 7281,
}

for (const cols of colsList) {
  console.log(`\x1b[2m─── cols=${cols} ${'─'.repeat(Math.max(0, cols - 12))}\x1b[0m`)
  for (const line of formatWelcome({ ...base, columns: cols, rows: 24 }, theme)) {
    console.log(line)
  }
}

console.log('\x1b[2m─── compact (resume) ──────────────\x1b[0m')
for (const line of formatWelcome({ ...base, columns: 80, priorMsgCount: 7, compact: true }, theme)) {
  console.log(line)
}

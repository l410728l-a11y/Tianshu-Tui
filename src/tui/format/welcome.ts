/**
 * T9 格式化函数 — 首屏欢迎（概念 A「启明」紧凑刊头，graphite 专业终端美学）。
 *
 * 渲染结构（6 行含呼吸空行）：
 *    ✦  天枢 Tianshu Code                          v2.19.3
 *       ────────────────────────────────────────────────
 *       deepseek-v4 · ◎high · auto-safe
 *       ~/app/deepseek-tui/opencode-tui · #7281
 *
 * 设计纪律（Apple Design 转译）：
 * - 单一 accent：冰青只落在品牌星与 effort glyph，其余全部灰阶；
 *   层级靠字重（bold/regular/dim）而非颜色数量。
 * - 刊头线 `─` 用 pulseQuiet（最暗结构色），chrome 后退、内容前进。
 * - 版本号右对齐形成刊头右栏；窄终端自动并入品牌行（无右栏）。
 * - 行数纪律：≤6 行；矮终端 / 恢复会话 / 窄终端走 compact 单行降级。
 */

import { homedir } from 'node:os'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'

/** 宽度口径：与终端一致（CJK 终端把 `·`/`✦` 等 ambiguous 符号按 2 列渲染）。 */
const WIDE = { ambiguousAsWide: true }

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). Shown in compact mode. */
  numericId?: number
  /** 折叠为单行极简版（用于非首次启动/恢复会话）。 */
  compact?: boolean
  /** 终端可视高度（行）。极矮终端降级为 compact 单行。 */
  rows?: number
  /** Tianshu Code 版本号（来自安装根 package.json），无则不显示。 */
  version?: string | null
  /** 当前权限模式（auto-safe / manual / dangerously-skip-permissions …）。 */
  approvalMode?: string
  /** 当前推理 effort 档位（low / medium / high / max）。 */
  reasoningEffort?: string
}

/** 刊头 4 行内容 + 前后空行 2 行；输入框 3 行 + 底部状态栏/呼吸余量 ~2 行。 */
const BANNER_ROWS = 6
const RESERVED_ROWS = 5

/** 刊头线最大列数——超过则在右侧留白，不让 chrome 铺满整行（后退原则）。 */
const RULE_MAX = 72

function truncateToWidth(text: string, maxWidth: number): string {
  const ellW = displayWidth('…', WIDE)
  return displayWidth(text, WIDE) > maxWidth
    ? `${truncateToDisplayWidth(text, Math.max(0, maxWidth - ellW), WIDE)}…`
    : text
}

/** cwd 的 `~` 缩写（Claude Code 同款展示口径）。 */
function tildify(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)

  const effortColor = input.reasoningEffort === 'max' || input.reasoningEffort === 'auto' ? theme.secondary
    : input.reasoningEffort === 'high' ? theme.primary
    : input.reasoningEffort === 'off' ? theme.dim
    : theme.muted
  const effortShort = input.reasoningEffort === 'medium' ? 'med' : input.reasoningEffort
  const effortLabel = input.reasoningEffort
    ? ` ${color('·', theme.dim)} ${color(`◎${effortShort}`, effortColor)}`
    : ''

  const compactLine = (): string => {
    const numeric = input.numericId ? ` · #${input.numericId}` : ''
    const line = `${color('✦', theme.primary, { bold: true })} ${color('天枢', theme.primary, { bold: true })}${numeric}  ${color('·', theme.dim)}  ${color(input.modelName, theme.secondary)}${effortLabel}  ${color('·', theme.dim)}  ${color(dir + '/', theme.muted)}  ${color('·', theme.dim)}  ${color(session, theme.muted)}  ${color('·', theme.dim)}  ${color('/help', theme.secondary)}`
    return truncateToWidth(line, cols)
  }

  // 折叠模式：单行极简提示，适合恢复会话或非首次启动
  if (input.compact) {
    return [compactLine()]
  }

  // 高度自适应：极矮终端（放不下刊头 + 输入框）退单行。
  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  if (rows < BANNER_ROWS + RESERVED_ROWS) {
    return [compactLine()]
  }

  // ── 「启明」刊头 ────────────────────────────────────────────────
  // 左列：单颗启明星（只在第一行），下行按其显示宽度留白对齐。
  const prefixPlain = '  ✦  '
  const indent = ' '.repeat(displayWidth(prefixPlain, WIDE))
  const star = `  ${color('✦', theme.primary, { bold: true })}  `

  // L1 刊头行：品牌（亮白 bold 中文 + muted 英文）+ 版本号右对齐右栏。
  const brand = `${color('天枢', theme.userColor, { bold: true })} ${color('Tianshu Code', theme.muted)}`
  const brandPlainW = displayWidth(`${prefixPlain}天枢 Tianshu Code`, WIDE)
  let headLine: string
  if (input.version) {
    const versionText = color(`v${input.version}`, theme.dim)
    const pad = cols - brandPlainW - displayWidth(`v${input.version}`, WIDE)
    // 右栏至少留 2 列间隔才成立，否则并入品牌行（窄终端降级）。
    headLine = pad >= 2
      ? `${star}${brand}${' '.repeat(pad)}${versionText}`
      : `${star}${brand} ${versionText}`
  } else {
    headLine = `${star}${brand}`
  }

  // L2 刊头线：pulseQuiet（最暗结构色），长度封顶 RULE_MAX，chrome 后退。
  const ruleLen = Math.max(0, Math.min(cols - indent.length, RULE_MAX))
  const rule = `${indent}${color('─'.repeat(ruleLen), theme.pulseQuiet)}`

  // L3 配置行：模型 + effort + 权限模式（短标签，与输入框下方权限行同口径）。
  const modeLabel = input.approvalMode === 'dangerously-skip-permissions' ? 'yolo' : input.approvalMode
  const modeSuffix = modeLabel
    ? ` ${color('·', theme.dim)} ${color(modeLabel, theme.muted)}`
    : ''
  const configLine = `${indent}${color(input.modelName, theme.muted)}${effortLabel}${modeSuffix}`

  // L4 位置行：cwd（~ 缩写）+ 会话标识（有 numericId 用友好的 #id，否则 session 前缀）。
  const idLabel = input.numericId ? `#${input.numericId}` : session
  const placeLine = `${indent}${color(tildify(input.cwd), theme.muted)} ${color('·', theme.dim)} ${color(idLabel, theme.dim)}`

  // 前后各留一行呼吸空行：欢迎块上贴启动日志、下贴历史会话提示/输入框时
  // 不至于挤成一坨（压抑感的主要来源）。
  const out: string[] = ['', headLine, rule, configLine, placeLine, '']

  return out.map(line => truncateToWidth(line, cols))
}

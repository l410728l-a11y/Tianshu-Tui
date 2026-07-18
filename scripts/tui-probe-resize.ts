/**
 * TUI 探针 — resize 重影 / 回顶欠擦检测。
 *
 * 用途：连续变更终端宽度（经 ResizeHandler 轮询真实触发 app 重渲染），
 * 包装 LiveEngine.buildFullRewrite 记录每帧的实际爬升量（prevDisplayRows），
 * 并与「上一帧行在新宽度下的 reflow 行数」独立对账——不一致即叠屏前兆。
 *
 * 背景：LiveEngine 回顶量必须与旧帧 reflow 后的屏上行数精确一致，否则
 * 旧帧顶部残留进 scrollback（resize 输入框叠屏）。曾修的根因：CPR 污染
 * 恢复路径漏掉 reconcileWidth（见 live-engine-ghost-render.test.ts 回归用例）。
 *
 * 运行：node --import tsx scripts/tui-probe-resize.ts [--seq 110,70,110,90,44]
 */
import { makeApp, stripAnsi } from '../src/tui/engine/__tests__/_harness.js'
import { LiveEngine } from '../src/tui/engine/live-engine.js'
import { displayWidth } from '../src/tui/width.js'
import { setTheme } from '../src/tui/theme.js'

const args = process.argv.slice(2)
const seqArg = args.find(a => a.startsWith('--seq=')) ?? args[args.indexOf('--seq') + 1]
const seq = (typeof seqArg === 'string' ? seqArg : '110,70,110,90,44').split(',').map(Number)

setTheme(process.env.TUI_PROBE_THEME ?? 'graphite')

const narrowRows = (text: string, cols: number) =>
  Math.max(1, Math.ceil(displayWidth(text, { ambiguousAsWide: false }) / cols))

let prevFrameLines: string[] = []
let mismatches = 0

// ── 插桩：抓每次全量重写的爬升基准并与 reflow 对账 ──
const origFull = (LiveEngine.prototype as any).buildFullRewrite
;(LiveEngine.prototype as any).buildFullRewrite = function (bounded: any[], prevDisplayRows: number) {
  const self = this as any
  const cols = self.stdout.columns
  const reflow = prevFrameLines.reduce((n, t) => n + narrowRows(stripAnsi(t), cols), 0)
  const ok = prevDisplayRows === reflow
  if (!ok) mismatches++
  console.log(`  fullRewrite: climb=${prevDisplayRows - 1} | 上帧 ${prevFrameLines.length} 行 @${cols} 列 reflow=${reflow} ${ok ? '✓' : '✗ 不一致（叠屏风险）'}`)
  return origFull.call(this, bounded, prevDisplayRows)
}
const origRender = LiveEngine.prototype.render
LiveEngine.prototype.render = function (lines: any, opts?: any) {
  origRender.call(this, lines, opts)
  prevFrameLines = lines.map((l: any) => l.text)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const firstCols = seq[0] ?? 110
const { app, out } = makeApp({ cols: firstCols, rows: 30, modelName: 'longcat' })
await sleep(300)
out.clear()

for (const next of seq.slice(1)) {
  console.log(`\n═══ resize → ${next} ═══`)
  out.columns = next
  await sleep(900) // poll(300ms) + debounce(150ms) + margin
  out.clear()
}

console.log(mismatches === 0 ? '\n✓ 全部 resize 爬升量与 reflow 一致' : `\n✗ ${mismatches} 处不一致`)
app.dispose()
process.exit(mismatches === 0 ? 0 : 1)

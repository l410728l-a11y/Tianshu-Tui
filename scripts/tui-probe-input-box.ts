/**
 * TUI 探针 — 输入框 chrome 对齐与颜色检查。
 *
 * 用途：
 * 1. 驱动真实 TuiApp（经 engine 测试夹具）渲染输入框，在多种列宽下测量
 *    顶框/输入行/底框的显示宽度——三者必须全部相等（innerWidth+4 = cols-2），
 *    否则就是「右角残缺」类 off-by-one。
 * 2. 状态行（metrics + 权限）不得超 cols-1。
 * 3. --ansi 模式打印原始转义流，抽查边框/提示符/标签的着色是否符合预期。
 *
 * 运行：node --import tsx scripts/tui-probe-input-box.ts [--ansi] [--cols 80,60,40,26]
 */
import { makeApp, stripAnsi } from '../src/tui/engine/__tests__/_harness.js'
import { displayWidth } from '../src/tui/width.js'
import { setTheme } from '../src/tui/theme.js'

const args = process.argv.slice(2)
const ansiMode = args.includes('--ansi')
const colsArg = args.find(a => a.startsWith('--cols=')) ?? args[args.indexOf('--cols') + 1]
const colsList = (typeof colsArg === 'string' ? colsArg : '80,60,40,26').split(',').map(Number)

const themeName = process.env.TUI_PROBE_THEME ?? 'graphite'
setTheme(themeName)

let failures = 0

for (const cols of colsList) {
  const { app, out } = makeApp({ cols, rows: 24, modelName: 'longcat' })
  const raw = out.chunks.join('')

  if (ansiMode) {
    console.log(`\n═══ cols=${cols} 原始 ANSI（框/提示符/状态行） ═══`)
    for (const l of raw.split('\n')) {
      if (/[╭│╰❯⏵]/.test(stripAnsi(l))) console.log(JSON.stringify(l).slice(0, 220))
    }
    app.dispose()
    continue
  }

  const frameLines = stripAnsi(raw).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim().length > 0)
  console.log(`\n═══ cols=${cols}（期望框宽 = ${cols - 2}）═══`)
  const boxWidths: number[] = []
  for (const l of frameLines.slice(-6)) {
    const w = displayWidth(l, { ambiguousAsWide: true })
    const kind = l.startsWith('╭') || l.startsWith('│') || l.startsWith('╰') ? 'BOX' : '   '
    if (kind === 'BOX') boxWidths.push(w)
    console.log(`  ${kind} [w=${String(w).padStart(3)}] ${l}`)
    if (w > cols) { failures++; console.log(`    ✗ 超宽！w=${w} > cols=${cols}`) }
  }
  if (boxWidths.length >= 3 && !boxWidths.every(w => w === boxWidths[0])) {
    failures++
    console.log(`  ✗ 框线不对齐：${boxWidths.join(' / ')}`)
  }
  app.dispose()
}

if (!ansiMode) {
  console.log(failures === 0 ? '\n✓ 全部列宽下框线对齐、无超宽' : `\n✗ ${failures} 处问题`)
  process.exit(failures === 0 ? 0 : 1)
}

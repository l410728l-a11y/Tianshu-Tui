import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import stringWidth from 'string-width'
import { formatWelcome } from '../format/welcome.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

test('welcome renders 「启明」masthead with breathing blanks', () => {
  const lines = formatWelcome({
    modelName: 'opus-4-8',
    cwd: '/Users/x/app/deepseek-tui/opencode-tui',
    sessionId: '878e2108abcd',
    priorMsgCount: 0,
    columns: 80,
    version: '2.15.1',
    approvalMode: 'auto-safe',
  }, theme)
  assert.equal(lines.length, 6, `masthead is 6 lines (blank + 4 + blank), got ${lines.length}`)
  assert.equal(lines[0], '', 'leading blank line for breathing room')
  assert.equal(lines[lines.length - 1], '', 'trailing blank line for breathing room')
})

test('welcome contains brand, version, model, approval mode and cwd', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x/proj',
    sessionId: 'deadbeef1234',
    priorMsgCount: 0,
    columns: 80,
    version: '2.15.1',
    approvalMode: 'auto-safe',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Tianshu Code'), 'should show brand')
  assert.ok(joined.includes('天枢'), 'should show Chinese brand name')
  assert.ok(joined.includes('v2.15.1'), 'should show version')
  assert.ok(joined.includes('glm-5.1'), 'should show model')
  assert.ok(joined.includes('auto-safe'), 'should show approval mode')
  assert.ok(joined.includes('/tmp/x/proj'), 'should show cwd')
})

test('version is right-aligned as masthead right column on wide terminals', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80,
    version: '2.15.1',
  }, theme)
  const head = strip(lines[1]!)
  assert.ok(head.endsWith('v2.15.1'), `version sits at the right edge: "${head}"`)
  assert.ok(/Code {2,}v2\.15\.1$/.test(head), `right column separated by padding: "${head}"`)
})

test('welcome omits version/mode gracefully when not provided', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Tianshu Code'), 'brand still present')
  assert.ok(!joined.includes('v undefined') && !joined.includes('vnull'), 'no dangling version text')
})

test('masthead rule line recedes (no box frame, no shortcut matrix)', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 120, rows: 40,
    version: '2.15.1',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(!/[╭╮╰╯┌┐└┘│]/.test(joined), 'no box frame characters')
  assert.ok(joined.includes('─'), 'thin masthead rule present')
  assert.ok(!joined.includes('Ctrl+'), 'no shortcut matrix')
  // 刊头线是第 2 行内容（索引 2），宽度 ≤ 72 封顶
  const rule = strip(lines[2]!)
  assert.ok(stringWidth(rule) <= 72 + 6, `rule capped at RULE_MAX + indent, got ${stringWidth(rule)}`)
})

test('welcome shows session prefix and reasoning effort', () => {
  const lines = formatWelcome({
    modelName: 'over2',
    cwd: '/tmp/x/proj',
    sessionId: '8938a88f-c865-4c49-9c75-2c69e5b49e24',
    priorMsgCount: 0,
    columns: 120,
    rows: 40,
    version: '2.18.0',
    approvalMode: 'yolo',
    reasoningEffort: 'high',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('8938a88f'), 'should show session prefix when no numericId')
  assert.ok(joined.includes('◎high'), 'should show reasoning effort')
})

test('welcome prefers friendly #numericId over session prefix on place line', () => {
  const lines = formatWelcome({
    modelName: 'over2',
    cwd: '/tmp/x/proj',
    sessionId: '8938a88f-c865-4c49-9c75-2c69e5b49e24',
    priorMsgCount: 0,
    columns: 120,
    rows: 40,
    numericId: 7281,
  }, theme)
  const placeLine = strip(lines[4]!)
  assert.ok(placeLine.includes('#7281'), `numericId shown: "${placeLine}"`)
  assert.ok(!placeLine.includes('8938a88f'), 'session prefix replaced by numericId')
})

test('welcome shows auto reasoning effort', () => {
  const lines = formatWelcome({
    modelName: 'over2',
    cwd: '/tmp/x/proj',
    sessionId: '8938a88f-c865-4c49-9c75-2c69e5b49e24',
    priorMsgCount: 0,
    columns: 120,
    rows: 40,
    reasoningEffort: 'auto',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('◎auto'), 'should show auto reasoning effort')
})

test('cwd under home is tildified', () => {
  const home = homedir()
  const lines = formatWelcome({
    modelName: 'm', cwd: `${home}/app/proj`, sessionId: 'abcdefgh', priorMsgCount: 0, columns: 120,
  }, theme)
  assert.ok(lines.join('\n').includes('~/app/proj'), 'home prefix collapsed to ~')
})

test('compact mode renders single line with essentials', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x',
    sessionId: 'deadbeef1234',
    priorMsgCount: 7,
    columns: 80,
    compact: true,
  }, theme)
  assert.equal(lines.length, 1, 'compact welcome is a single line')
  const joined = lines[0]!
  assert.ok(joined.includes('天枢'), 'should show branding')
  assert.ok(joined.includes('glm-5.1'), 'should show model')
  assert.ok(joined.includes('deadbeef'), 'should show session prefix')
  assert.ok(joined.includes('/help'), 'should hint /help')
})

test('compact mode shows prior count', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 7, columns: 80, compact: true,
  }, theme)
  assert.ok(lines.join('\n').includes('7 prior'), 'should show prior message count')
})

test('height-aware: very short terminal (<11 rows) collapses to single line', () => {
  const lines = formatWelcome({
    modelName: 'gpt-5.5', cwd: '/x', sessionId: 'abcdef012345', priorMsgCount: 0, columns: 100, rows: 6,
  }, theme)
  assert.equal(lines.length, 1, `very short terminal → single line, got ${lines.length}`)
  assert.ok(lines[0]!.includes('天枢'), 'single line still branded')
})

test('24-row terminal keeps the full masthead (fits easily)', () => {
  const lines = formatWelcome({
    modelName: 'deepseek-v4', cwd: '/x/proj', sessionId: 'abcdef012345', priorMsgCount: 0, columns: 80, rows: 24,
    version: '2.15.1', approvalMode: 'auto-safe',
  }, theme)
  assert.equal(lines.length, 6, `80×24 → full masthead, got ${lines.length}`)
})

test('no rows provided → full masthead (back-compat)', () => {
  const lines = formatWelcome({ modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 100 }, theme)
  assert.equal(lines.length, 6, 'defaults to full masthead')
})

test('no line exceeds terminal width (display width ≤ columns)', () => {
  for (const cols of [20, 40, 80]) {
    const lines = formatWelcome({
      modelName: '天枢模型-超长名字测试-deepseek-v4-pro',
      cwd: '/Users/banxia/app/深度求索/超长中文目录名/opencode-tui',
      sessionId: '012345678',
      priorMsgCount: 3,
      columns: cols,
      version: '2.15.1',
      approvalMode: 'dangerously-skip-permissions',
    }, theme)
    for (const line of lines) {
      assert.ok(
        stringWidth(strip(line)) <= cols,
        `at cols=${cols}, line width ${stringWidth(strip(line))} should be ≤ ${cols}`,
      )
    }
  }
})

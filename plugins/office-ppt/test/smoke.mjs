// office-ppt smoke test — exercises pptx_create (theme/chart/notes) and pptx_read.
// Output files go to os.tmpdir(). Exits non-zero on any assertion failure.

import assert from 'node:assert/strict'
import { existsSync, statSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { tools } from '../index.js'

const byName = Object.fromEntries(tools.map(t => [t.definition.name, t]))
const create = byName.pptx_create
const read = byName.pptx_read
assert.ok(create, 'pptx_create tool registered')
assert.ok(read, 'pptx_read tool registered')

const dest = join(os.tmpdir(), `tianshu-pptx-smoke-${process.pid}.pptx`)
const destDefault = join(os.tmpdir(), `tianshu-pptx-smoke-default-${process.pid}.pptx`)

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`PASS ${label}`)
  } catch (err) {
    failures++
    console.error(`FAIL ${label}: ${err.message}`)
  }
}

// ── 1. create with theme + chart + notes ────────────────────────

const createRes = await create.execute({
  destination_path: dest,
  title: '天枢冒烟测试',
  theme: { titleColor: '#0F766E', textColor: '111827', bgColor: 'FFFFFF', accentColor: 'F59E0B', fontFace: 'Helvetica' },
  slides: [
    { type: 'title', title: '天枢 PPT 冒烟测试', body: '主题/图表/备注 全链路', notes: '开场白：这是封面备注' },
    { type: 'section', title: '第一部分 市场概览' },
    { type: 'content', title: '核心要点', items: ['第一条要点 Alpha', '第二条要点 Beta'], notes: '这一页讲快一点' },
    { type: 'two-column', title: '对比分析', body: '左栏正文：方案 A 成本低', items: ['右栏要点一', '右栏要点二'] },
    { type: 'table', title: '数据表', headers: ['季度', '收入'], rows: [['Q1', '120'], ['Q2', '180']] },
    { type: 'chart', title: '收入趋势', chart: 'bar', data: [{ name: '收入', labels: ['Q1', 'Q2', 'Q3'], values: [120, 180, 240] }] },
  ],
})
check('create returns success', () => assert.ok(!createRes.isError, createRes.content))
check('create output file exists and is non-trivial', () => {
  assert.ok(existsSync(dest), `${dest} missing`)
  assert.ok(statSync(dest).size > 5000, `file too small: ${statSync(dest).size}`)
})

// ── 2. backward compat: no theme, original slide types only ────

const defaultRes = await create.execute({
  destination_path: destDefault,
  slides: [
    { type: 'title', title: 'Default Look', body: 'no theme passed' },
    { type: 'content', title: 'Plain Content', body: 'plain body text' },
  ],
})
check('create without theme still works (backward compat)', () => {
  assert.ok(!defaultRes.isError, defaultRes.content)
  assert.ok(existsSync(destDefault))
})

// ── 3. read back and assert content ─────────────────────────────

const readRes = await read.execute({ file_path: dest, include_notes: true })
check('read returns success', () => assert.ok(!readRes.isError, readRes.content))
const md = readRes.content
check('read: all 6 slides present in order', () => {
  for (let i = 1; i <= 6; i++) assert.ok(md.includes(`## Slide ${i}`), `missing ## Slide ${i}`)
  assert.ok(!md.includes('## Slide 7'), 'unexpected extra slide')
})
check('read: title slide text extracted', () => {
  assert.ok(md.includes('天枢 PPT 冒烟测试'), 'title missing')
  assert.ok(md.includes('主题/图表/备注 全链路'), 'subtitle missing')
})
check('read: content/body text extracted', () => {
  assert.ok(md.includes('第一部分 市场概览'), 'section title missing')
  assert.ok(md.includes('核心要点'), 'content title missing')
  assert.ok(md.includes('第一条要点 Alpha'), 'bullet missing')
  assert.ok(md.includes('左栏正文：方案 A 成本低'), 'two-column body missing')
  assert.ok(md.includes('季度'), 'table header missing')
  assert.ok(md.includes('收入趋势'), 'chart slide title missing')
})
check('read: speaker notes extracted', () => {
  assert.ok(md.includes('Speaker notes'), 'notes header missing')
  assert.ok(md.includes('开场白：这是封面备注'), 'title slide notes missing')
  assert.ok(md.includes('这一页讲快一点'), 'content slide notes missing')
})

const noNotes = await read.execute({ file_path: dest })
check('read: notes omitted by default', () => assert.ok(!noNotes.content.includes('开场白'), 'notes leaked without include_notes'))

// ── 4. error paths ──────────────────────────────────────────────

const missing = await read.execute({ file_path: join(os.tmpdir(), 'no-such-file-xyz.pptx') })
check('read: missing file returns isError', () => assert.ok(missing.isError))

const noDest = await create.execute({ slides: [] })
check('create: missing destination_path returns isError', () => assert.ok(noDest.isError))

// ── cleanup + summary ───────────────────────────────────────────

rmSync(dest, { force: true })
rmSync(destDefault, { force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll smoke checks passed ✔')

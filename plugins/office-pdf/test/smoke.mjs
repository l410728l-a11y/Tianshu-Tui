// Smoke test for office-pdf: CJK rendering, page numbers, list blocks, pdf_read round-trip.
// Output files go to os.tmpdir(). Run: npm test

import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tools } from '../index.js'
import { containsCjk, resolveCjkFont } from '../fonts.js'

const create = tools.find(t => t.definition.name === 'pdf_create')
const read = tools.find(t => t.definition.name === 'pdf_read')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`)
  } else {
    failures++
    console.error(`  FAIL  ${msg}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'office-pdf-smoke-'))
console.log(`smoke dir: ${dir}`)

// ── font resolution sanity ──────────────────────────────────────
console.log('\n[fonts]')
assert(containsCjk('天枢测试'), 'containsCjk detects Chinese')
assert(!containsCjk('plain english'), 'containsCjk ignores plain ASCII')
const cjkFont = await resolveCjkFont()
console.log(`  resolved CJK font: ${cjkFont ? `${cjkFont.path} (${cjkFont.name})` : 'NONE — warning path will be exercised'}`)
assert(cjkFont !== null || true, 'resolveCjkFont ran without throwing')

// ── 1. CJK document: all block types + page numbers ─────────────
console.log('\n[cjk pdf]')
const cjkPath = join(dir, 'cjk.pdf')
const r1 = await create.execute({
  destination_path: cjkPath,
  title: '天枢测试 中文渲染',
  page_numbers: true,
  content: [
    { type: 'heading', text: '第一章 概述' },
    { type: 'paragraph', text: '这是一个包含中文的段落，用于验证 CJK 字体渲染是否正常。' },
    { type: 'list', items: ['第一条要点', 'Second item', '第三条要点'] },
    { type: 'list', items: ['步骤一', '步骤二'], ordered: true },
    { type: 'table', headers: ['名称', '数值'], rows: [['天枢', 42], ['破军', 7]] },
    { type: 'code', text: 'const answer = 42 // code stays Courier' },
  ],
})
assert(!r1.isError, `pdf_create (CJK) succeeded${r1.isError ? ': ' + r1.content : ''}`)
if (String(r1.content).includes('未找到 CJK 字体')) {
  console.log('  WARN  CJK font warning surfaced in tool output (expected only on font-less systems)')
}
assert(existsSync(cjkPath) && statSync(cjkPath).size > 500, `file written (${existsSync(cjkPath) ? statSync(cjkPath).size : 0} bytes)`)

const rd1 = await read.execute({ file_path: cjkPath })
assert(!rd1.isError, 'pdf_read (CJK) succeeded')
const t1 = String(rd1.content)
assert(t1.includes('天枢测试'), 'read-back contains title 天枢测试')
assert(t1.includes('中文渲染'), 'read-back contains 中文渲染')
assert(t1.includes('第一章'), 'read-back contains heading 第一章')
assert(t1.includes('第一条要点'), 'read-back contains list item 第一条要点')
assert(t1.includes('步骤一'), 'read-back contains ordered list item 步骤一')
assert(t1.includes('破军'), 'read-back contains table cell 破军')
assert(t1.includes('const answer = 42'), 'read-back contains code line')
assert(/第\s*1\s*页/.test(t1), `read-back contains Chinese page footer (matched: ${JSON.stringify(t1.match(/第[^]*?页/)?.[0] ?? null)})`)

// ── 2. pure-English document: Helvetica path + Page X of Y ─────
console.log('\n[english pdf]')
const enPath = join(dir, 'en.pdf')
const r2 = await create.execute({
  destination_path: enPath,
  title: 'English Smoke',
  page_numbers: true,
  content: [
    { type: 'paragraph', text: 'Plain English paragraph stays on Helvetica.' },
    { type: 'list', items: ['alpha', 'beta'], ordered: true },
  ],
})
assert(!r2.isError, 'pdf_create (EN) succeeded')
assert(!String(r2.content).includes('未找到 CJK 字体'), 'no CJK warning for pure-English doc')
const rd2 = await read.execute({ file_path: enPath })
const t2 = String(rd2.content)
assert(t2.includes('English Smoke'), 'read-back contains English title')
assert(/Page\s+1\s+of\s+1/.test(t2), 'read-back contains "Page 1 of 1" footer')
assert(t2.includes('1.') && t2.includes('alpha'), 'read-back contains ordered list markers')

// ── 3. no page_numbers → no footer ──────────────────────────────
console.log('\n[no page numbers]')
const npPath = join(dir, 'np.pdf')
const r3 = await create.execute({
  destination_path: npPath,
  content: [{ type: 'paragraph', text: 'No footer here.' }],
})
assert(!r3.isError, 'pdf_create without page_numbers succeeded')
const t3 = String((await read.execute({ file_path: npPath })).content)
assert(t3.includes('No footer here.') && !/Page\s+1\s+of/.test(t3), 'no footer rendered')

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} ASSERTION(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * office-excel smoke test — exercises xlsx_read / xlsx_write / xlsx_edit
 * against real files in os.tmpdir() and asserts results.
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { tools } from '../index.js'

const toolMap = Object.fromEntries(tools.map(t => [t.definition.name, t]))
assert.ok(toolMap.xlsx_read, 'xlsx_read exported')
assert.ok(toolMap.xlsx_write, 'xlsx_write exported')
assert.ok(toolMap.xlsx_edit, 'xlsx_edit exported')

const dir = mkdtempSync(join(tmpdir(), 'office-excel-smoke-'))
const file = join(dir, 'smoke.xlsx')
console.log(`tmp dir: ${dir}`)

// ── 1. xlsx_write: plain values + formula + styles ────────────────
{
  const res = await toolMap.xlsx_write.execute({
    file_path: file,
    sheet_name: 'Sales',
    header_bold: true,
    column_widths: [14, 12],
    number_formats: { B: '#,##0.00' },
    data: [
      ['Item', 'Amount'],
      ['Apples', 1200.5],
      ['Oranges', 800.25],
      ['Total', { formula: 'SUM(B2:B3)' }],
    ],
  })
  assert.ok(!res.isError, `write failed: ${res.content}`)
  assert.ok(existsSync(file), 'file created')
  console.log('1. xlsx_write ok —', res.content)

  // Verify styles + formula via exceljs directly
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet('Sales')
  assert.equal(ws.getRow(1).font?.bold, true, 'header row bold')
  assert.equal(ws.getColumn(1).width, 14, 'column A width')
  assert.equal(ws.getColumn('B').numFmt, '#,##0.00', 'column B numFmt')
  const f = ws.getCell('B4').value
  assert.equal(f.formula, 'SUM(B2:B3)', 'formula stored')
  console.log('1b. styles + formula verified via exceljs')
}

// ── 2. xlsx_read: list sheets ──────────────────────────────────────
{
  const res = await toolMap.xlsx_read.execute({ file_path: file })
  assert.ok(!res.isError, `read-list failed: ${res.content}`)
  assert.ok(res.content.includes('Sales'), 'sheet listed')
  console.log('2. xlsx_read list ok')
}

// ── 3. xlsx_read: range read (regression: used to throw on sheet "_") ──
{
  const res = await toolMap.xlsx_read.execute({
    file_path: file,
    sheet: 'Sales',
    range_start: 'A2',
    range_end: 'B3',
  })
  assert.ok(!res.isError, `range read failed: ${res.content}`)
  assert.ok(res.content.includes('Apples'), 'range contains Apples')
  assert.ok(res.content.includes('Oranges'), 'range contains Oranges')
  assert.ok(!res.content.includes('Total'), 'range excludes row 4')
  console.log('3. xlsx_read range ok (bug fix verified)')
}

// ── 4. xlsx_read: formula original text visible ───────────────────
{
  const res = await toolMap.xlsx_read.execute({ file_path: file, sheet: 'Sales' })
  assert.ok(!res.isError, `read failed: ${res.content}`)
  assert.ok(res.content.includes('=SUM(B2:B3)'), `formula text in read output, got:\n${res.content}`)
  console.log('4. formula read-back ok')
}

// ── 5. xlsx_edit: add sheet + update cells + append rows ──────────
{
  const res = await toolMap.xlsx_edit.execute({
    file_path: file,
    operations: [
      { action: 'update_cells', sheet: 'Sales', cells: [
        { cell: 'B2', value: 1500.75 },
        { cell: 'C1', value: 'Note' },
        { cell: 'C4', formula: 'B4*2' },
      ] },
      { action: 'append_rows', sheet: 'Sales', rows: [
        ['Bananas', 300],
        ['Grand Total', { formula: 'SUM(B2:B5)' }],
      ] },
      { action: 'add_sheet', name: 'Meta' },
    ],
  })
  assert.ok(!res.isError, `edit failed: ${res.content}`)
  console.log('5. xlsx_edit ok —\n' + res.content)

  // Read back and verify
  const read = await toolMap.xlsx_read.execute({ file_path: file, sheet: 'Sales' })
  assert.ok(read.content.includes('1500.75'), 'updated cell value present')
  assert.ok(read.content.includes('Bananas'), 'appended row present')
  assert.ok(read.content.includes('=SUM(B2:B5)'), 'appended formula present')
  assert.ok(read.content.includes('=B4*2'), 'updated formula present')

  const list = await toolMap.xlsx_read.execute({ file_path: file })
  assert.ok(list.content.includes('Meta'), 'new sheet listed')

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  assert.equal(wb.getWorksheet('Sales').getCell('C1').value, 'Note')
  assert.ok(wb.getWorksheet('Meta'), 'Meta sheet exists')
  console.log('5b. edit results verified via read + exceljs')
}

// ── 6. xlsx_edit: output_path variant + style_sheet ───────────────
{
  const out = join(dir, 'edited-copy.xlsx')
  const res = await toolMap.xlsx_edit.execute({
    file_path: file,
    output_path: out,
    operations: [
      { action: 'append_rows', sheet: 'Sales', rows: [['Kiwi', 99]] },
    ],
    style_sheet: 'Sales',
    header_bold: true,
  })
  assert.ok(!res.isError, `edit output_path failed: ${res.content}`)
  assert.ok(existsSync(out), 'output_path file created')

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out)
  assert.equal(wb.getWorksheet('Sales').getCell('A7').value, 'Kiwi', 'row appended in copy')
  assert.equal(wb.getWorksheet('Sales').getRow(1).font?.bold, true, 'style applied in copy')

  // Original untouched by the append
  const wbOrig = new ExcelJS.Workbook()
  await wbOrig.xlsx.readFile(file)
  assert.equal(wbOrig.getWorksheet('Sales').getCell('A7').value, null, 'original file not modified')
  console.log('6. xlsx_edit output_path ok')
}

// ── 7. error paths ────────────────────────────────────────────────
{
  const missing = await toolMap.xlsx_read.execute({ file_path: join(dir, 'nope.xlsx') })
  assert.equal(missing.isError, true, 'read missing file errors')
  const badOp = await toolMap.xlsx_edit.execute({
    file_path: file,
    operations: [{ action: 'nuke' }],
  })
  assert.equal(badOp.isError, true, 'unknown action errors')
  const badSheet = await toolMap.xlsx_edit.execute({
    file_path: file,
    operations: [{ action: 'append_rows', sheet: 'Nope', rows: [[1]] }],
  })
  assert.equal(badSheet.isError, true, 'missing sheet errors')
  console.log('7. error paths ok')
}

console.log('\n✅ office-excel smoke: all 7 groups passed')

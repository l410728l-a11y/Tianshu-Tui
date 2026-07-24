import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { POINTER_GUARD_ERROR_MARKER } from '../pointer-guard.js'
import { POINTER_INTERNAL_TAG } from '../pointer-tag.js'
import { toPosixPath } from '../../path-format.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'write-pointer-idempotent-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

/** 与 arg processor 的 render 同构的指针行（格式单一来源见 write-file-arg-processor）。 */
function pointerLine(posixPath: string, lines: number, chars: number): string {
  return `[file written to ${posixPath} — ${lines} lines, ${chars} chars. ${POINTER_INTERNAL_TAG} Display placeholder — never emit this as content; use read_file to review.]`
}

const BODY = 'line1\nline2\nline3\n'
const BODY_LINES = BODY.split('\n').length
const BODY_CHARS = BODY.length

describe('write_file — 显示指针回传的幂等化解', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('路径一致且磁盘内容相符 → 幂等成功，不落盘、内容不变', async () => {
    const file = join(TEST_DIR, 'recon.md')
    writeFileSync(file, BODY)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: pointerLine(toPosixPath(file), BODY_LINES, BODY_CHARS),
    }))
    assert.ok(!result.isError, `expected idempotent success, got: ${result.content}`)
    assert.ok(result.content.includes('幂等'), 'receipt explains the idempotent resolution')
    assert.equal(readFileSync(file, 'utf-8'), BODY, 'file content untouched')
  })

  it('指针路径与本文件不同 → 仍走拦截错误', async () => {
    const file = join(TEST_DIR, 'recon.md')
    writeFileSync(file, BODY)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: pointerLine('/tmp/somewhere/else.md', BODY_LINES, BODY_CHARS),
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
  })

  it('路径一致但文件不存在 → 拦截错误（无凭可依）', async () => {
    const file = join(TEST_DIR, 'missing.md')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: pointerLine(toPosixPath(file), BODY_LINES, BODY_CHARS),
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
  })

  it('路径一致但磁盘统计不符（文件已变） → 拦截错误', async () => {
    const file = join(TEST_DIR, 'changed.md')
    writeFileSync(file, 'completely different content, much longer than before\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: pointerLine(toPosixPath(file), BODY_LINES, BODY_CHARS),
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
  })

  it('指针行混在真实内容中（前置句子） → 拦截错误，不误判幂等', async () => {
    const file = join(TEST_DIR, 'recon.md')
    writeFileSync(file, BODY)
    const content = `我重新写出完整内容如下：\n${pointerLine(toPosixPath(file), BODY_LINES, BODY_CHARS)}\n更多真实内容\n`
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content,
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
    assert.equal(readFileSync(file, 'utf-8'), BODY, 'file content untouched')
  })
})

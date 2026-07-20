import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTitleUser,
  cleanTitle,
  extractSessionTitle,
  type CompletionFn,
} from '../title-extract.js'

describe('cleanTitle', () => {
  it('passes through plain text', () => {
    assert.equal(cleanTitle('加排序按钮'), '加排序按钮')
    assert.equal(cleanTitle('Add sort button'), 'Add sort button')
  })

  it('strips wrapping double quotes', () => {
    assert.equal(cleanTitle('"加排序按钮"'), '加排序按钮')
  })

  it('strips wrapping single quotes', () => {
    assert.equal(cleanTitle("'Add sort button'"), 'Add sort button')
  })

  it('strips CJK corner brackets 「…」', () => {
    assert.equal(cleanTitle('「加排序按钮」'), '加排序按钮')
  })

  it('strips CJK curly quotes “…”', () => {
    assert.equal(cleanTitle('“加排序按钮”'), '加排序按钮')
  })

  it('strips a leading "标题:" / "Title:" prefix', () => {
    assert.equal(cleanTitle('标题: 加排序按钮'), '加排序按钮')
    assert.equal(cleanTitle('Title: Add sort button'), 'Add sort button')
  })

  it('collapses internal whitespace and newlines into single spaces', () => {
    assert.equal(cleanTitle('加  排序\n按钮  '), '加 排序 按钮')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(cleanTitle('  加排序按钮  '), '加排序按钮')
  })

  it('truncates to 40 chars', () => {
    const long = 'a'.repeat(80)
    const out = cleanTitle(long)
    assert.equal(out?.length, 40)
    assert.equal(out, 'a'.repeat(40))
  })

  it('returns null for empty / whitespace-only input', () => {
    assert.equal(cleanTitle(''), null)
    assert.equal(cleanTitle('   '), null)
    assert.equal(cleanTitle('""'), null)
    assert.equal(cleanTitle('「」'), null)
  })
})

describe('buildTitleUser', () => {
  it('wraps the message with the extraction instruction', () => {
    const out = buildTitleUser('加排序按钮')
    assert.ok(out.includes('加排序按钮'), out)
    assert.ok(out.includes('First message:'), out)
  })

  it('truncates input longer than 800 chars', () => {
    const long = 'x'.repeat(2000)
    const out = buildTitleUser(long)
    // 800-char slice should appear, the remaining 1200 chars should not.
    assert.ok(out.length < long.length + 200, `out.length=${out.length}`)
    assert.ok(!out.includes('x'.repeat(1000)), 'full 1000+ char run should be truncated')
  })
})

describe('extractSessionTitle', () => {
  it('returns the cleaned title on a happy path', async () => {
    const mock: CompletionFn = async () => '  「加排序按钮」  '
    const title = await extractSessionTitle('帮我给列表加个排序按钮', mock)
    assert.equal(title, '加排序按钮')
  })

  it('returns null when the model returns empty', async () => {
    const mock: CompletionFn = async () => '   '
    const title = await extractSessionTitle('whatever', mock)
    assert.equal(title, null)
  })

  it('fail-opens (returns null) when completion throws', async () => {
    const mock: CompletionFn = async () => { throw new Error('boom') }
    const title = await extractSessionTitle('whatever', mock)
    assert.equal(title, null)
  })

  it('truncates over-long model output to 40 chars', async () => {
    const mock: CompletionFn = async () => 'a'.repeat(80)
    const title = await extractSessionTitle('whatever', mock)
    assert.equal(title?.length, 40)
  })

  it('passes the abort signal through to the completion fn', async () => {
    let receivedSignal: AbortSignal | undefined
    const mock: CompletionFn = async (_s, _u, signal) => {
      receivedSignal = signal
      return 'title'
    }
    const ctrl = new AbortController()
    await extractSessionTitle('whatever', mock, ctrl.signal)
    assert.equal(receivedSignal, ctrl.signal)
  })
})

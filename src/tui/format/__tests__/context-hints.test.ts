import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatContextHints } from '../context-hints.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatContextHints（wayfinding 逃逸提示）', () => {
  it('idle 返回 null（不占垂直空间）', () => {
    assert.equal(formatContextHints({}, theme), null)
  })

  it('worker 切入视图提示 esc 退出', () => {
    const hint = stripAnsi(formatContextHints({ viewingWorker: true }, theme)!)
    assert.ok(hint.includes('esc'), hint)
    assert.ok(hint.includes('退出子代理视图'), hint)
  })
})

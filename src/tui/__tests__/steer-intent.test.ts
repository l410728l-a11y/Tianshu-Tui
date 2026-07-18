import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySteerIntent,
  highestSteerIntent,
  MAX_STEER_CLASSIFY_CHARS,
} from '../steer-intent.js'

describe('classifySteerIntent', () => {
  it('halt: short stop phrases (zh/en)', () => {
    assert.equal(classifySteerIntent('停').intent, 'halt')
    assert.equal(classifySteerIntent('先停').intent, 'halt')
    assert.equal(classifySteerIntent('别动').intent, 'halt')
    assert.equal(classifySteerIntent('暂停').intent, 'halt')
    assert.equal(classifySteerIntent('stop').intent, 'halt')
    assert.equal(classifySteerIntent('wait').intent, 'halt')
    assert.equal(classifySteerIntent('hold on').intent, 'halt')
  })

  it('redirect: negation / wrong-direction phrases', () => {
    assert.equal(classifySteerIntent('不对').intent, 'redirect')
    assert.equal(classifySteerIntent('不是这个').intent, 'redirect')
    assert.equal(classifySteerIntent('错了').intent, 'redirect')
    assert.equal(classifySteerIntent('方向不对').intent, 'redirect')
    assert.equal(classifySteerIntent('换个思路').intent, 'redirect')
    assert.equal(classifySteerIntent('wrong').intent, 'redirect')
    assert.equal(classifySteerIntent('not that').intent, 'redirect')
  })

  it('「不对吗？」is question (trailing ? before redirect)', () => {
    assert.equal(classifySteerIntent('不对吗？').intent, 'question')
    assert.equal(classifySteerIntent('不对吗?').intent, 'question')
  })

  it('question: words without imperative', () => {
    assert.equal(classifySteerIntent('为什么选这个').intent, 'question')
    assert.equal(classifySteerIntent('这是什么').intent, 'question')
    assert.equal(classifySteerIntent('what is this').intent, 'question')
    assert.equal(classifySteerIntent('why this approach').intent, 'question')
    // 「怎么实现的」含祈使「实现」→ 不进 question（计划：疑问词 ∧ 无祈使）
    assert.notEqual(classifySteerIntent('怎么实现的').intent, 'question')
  })

  it('augment: marker + imperative', () => {
    assert.equal(classifySteerIntent('顺便加个日志').intent, 'augment')
    assert.equal(classifySteerIntent('另外改一下注释').intent, 'augment')
    assert.equal(classifySteerIntent('还有 fix the typo').intent, 'augment')
  })

  it('ack: whole short confirmations only', () => {
    assert.equal(classifySteerIntent('继续').intent, 'ack')
    assert.equal(classifySteerIntent('好的').intent, 'ack')
    assert.equal(classifySteerIntent('可以').intent, 'ack')
    assert.equal(classifySteerIntent('ok').intent, 'ack')
    assert.equal(classifySteerIntent('go ahead').intent, 'ack')
    assert.equal(classifySteerIntent('没问题').intent, 'ack')
  })

  it('「继续修复登录」is not ack (has task content)', () => {
    const r = classifySteerIntent('继续修复登录')
    assert.notEqual(r.intent, 'ack')
    assert.equal(r.intent, 'guidance')
  })

  it('ack is whole-phrase only — 好的，但换个思路 → redirect (not swallowed)', () => {
    // Whole-phrase ACK_RE avoids the plan's ack-then-redirect swallow failure mode.
    const r = classifySteerIntent('好的，但换个思路')
    assert.equal(r.intent, 'redirect')
    assert.equal(classifySteerIntent('好的').intent, 'ack')
  })

  it('「不对，为什么选这个？」→ question via trailing mark', () => {
    assert.equal(classifySteerIntent('不对，为什么选这个？').intent, 'question')
  })

  it('empty / whitespace / emoji → guidance, not halt', () => {
    assert.equal(classifySteerIntent('').intent, 'guidance')
    assert.equal(classifySteerIntent('   ').intent, 'guidance')
    assert.equal(classifySteerIntent('👍').intent, 'guidance')
    assert.equal(classifySteerIntent('谢谢').intent, 'guidance')
  })

  it('truncates to MAX_STEER_CLASSIFY_CHARS (buried halt not seen)', () => {
    const buried = 'x'.repeat(MAX_STEER_CLASSIFY_CHARS) + '停'
    assert.equal(classifySteerIntent(buried).intent, 'guidance')
    const early = '停' + 'x'.repeat(MAX_STEER_CLASSIFY_CHARS)
    // 「停」+ junk is not a whole-phrase halt
    assert.equal(classifySteerIntent(early).intent, 'guidance')
    // Exact halt within cap still works
    assert.equal(classifySteerIntent('停').intent, 'halt')
  })

  it('deterministic for same input', () => {
    assert.deepEqual(
      classifySteerIntent('换个思路再试试'),
      classifySteerIntent('换个思路再试试'),
    )
  })

  it('guidance fallback for ordinary task steer', () => {
    assert.equal(classifySteerIntent('focus on performance').intent, 'guidance')
    assert.equal(classifySteerIntent('先看 auth 模块').intent, 'guidance')
  })
})

describe('highestSteerIntent', () => {
  it('picks most urgent from a drained subset', () => {
    assert.equal(highestSteerIntent(['guidance', 'question', 'ack']), 'question')
    assert.equal(highestSteerIntent(['augment', 'halt', 'redirect']), 'halt')
    assert.equal(highestSteerIntent(['guidance']), 'guidance')
  })
})

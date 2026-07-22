import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'

describe('SessionContext.appendSystemReminder', () => {
  it('appends SR to last user message without adding new message entry', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')
    session.addAssistantBlocks([{ type: 'text', text: 'hi' }])
    session.addUserMessage('do task')

    const lenBefore = session.getMessages().length
    session.appendSystemReminder('convergence kick')
    const lenAfter = session.getMessages().length

    assert.equal(lenAfter, lenBefore, 'message array length must not change')

    const msgs = session.getMessages()
    const last = msgs[msgs.length - 1]!
    assert.equal(last.role, 'user')
    assert.ok(typeof last.content === 'string')
    assert.ok(last.content.includes('<system-reminder>'), 'must contain SR tag')
    assert.ok(last.content.includes('convergence kick'), 'must contain SR text')
    assert.ok(last.content.includes('do task'), 'must preserve original content')
  })

  // W3：每轮最多 1 条 system-reminder。第二条静默丢弃。
  it('W3: silently drops second SR in same turn (per-turn cap)', () => {
    const session = new SessionContext()
    session.addUserMessage('继续')

    session.appendSystemReminder('kick A')
    session.appendSystemReminder('kick B')

    const msgs = session.getMessages()
    assert.equal(msgs.length, 1, 'still only 1 message')
    const content = msgs[0]!.content as string
    assert.ok(content.includes('kick A'), 'first SR should be delivered')
    assert.ok(!content.includes('kick B'), 'second SR must be silently dropped (per-turn cap)')
    assert.ok(content.includes('继续'))
  })

  it('W3: resetSrCount allows new SR in next turn', () => {
    const session = new SessionContext()
    session.addUserMessage('turn 1')

    session.appendSystemReminder('turn 1 SR')
    // Second SR in same turn → dropped
    session.appendSystemReminder('turn 1 SR second')
    const afterTurn1 = session.getMessages()
    const c1 = afterTurn1[0]!.content as string
    assert.ok(c1.includes('turn 1 SR'), 'first SR delivered')
    assert.ok(!c1.includes('turn 1 SR second'), 'second SR dropped')

    // Reset → new turn
    session.resetSrCount()
    session.addUserMessage('turn 2')
    session.appendSystemReminder('turn 2 SR')

    const afterTurn2 = session.getMessages()
    assert.equal(afterTurn2.length, 2, 'new turn adds a new message')
    const c2 = afterTurn2[1]!.content as string
    assert.ok(c2.includes('turn 2 SR'), 'SR in new turn should be delivered after reset')
  })

  it('falls back to addUserMessage when no user message exists', () => {
    const session = new SessionContext()
    session.appendSystemReminder('orphan SR')

    const msgs = session.getMessages()
    assert.equal(msgs.length, 1, 'fallback creates a new message')
    assert.equal(msgs[0]!.role, 'user')
    assert.ok((msgs[0]!.content as string).includes('<system-reminder>'))
  })

  it('triggers mutation listener with replace type', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')
    const mutations: Array<{ type: string; messages?: unknown }> = []
    session.setMutationListener(m => mutations.push(m))

    session.appendSystemReminder('nudge')

    assert.equal(mutations.length, 1)
    assert.equal(mutations[0]!.type, 'replace')
  })

  // Regression guard for 5fedd9b6: SR injection during a turn (tool/assistant
  // messages already follow the last user message) must NOT rewrite that
  // mid-array user message. DeepSeek's exact-prefix cache keys on the token
  // sequence, so rewriting any earlier message invalidates the prefix from that
  // point onward — collapsing every cached tool output after it. SR must be
  // append-only at the tail.
  it('does NOT rewrite a mid-array user message — appends SR as a new tail entry', () => {
    const session = new SessionContext()
    session.addUserMessage('task')
    session.addAssistantBlocks([{ type: 'text', text: 'doing' }])
    session.addToolResults([{ type: 'tool_result', tool_use_id: 'x', content: 'BIG TOOL OUTPUT'.repeat(100) }])
    session.addAssistantBlocks([{ type: 'text', text: 'done' }])

    const snapshot = session.getMessages().map(m => JSON.stringify(m))

    session.appendSystemReminder('gate hint')

    const after = session.getMessages()
    // Every pre-existing message must be byte-identical (prefix untouched).
    for (let i = 0; i < snapshot.length; i++) {
      assert.equal(JSON.stringify(after[i]), snapshot[i],
        `message at index ${i} must not be rewritten (prefix cache stability)`)
    }
    // SR lands as a NEW tail entry, not merged into the mid-array user message.
    assert.equal(after.length, snapshot.length + 1, 'SR appended as a new tail message')
    const last = after[after.length - 1]!
    assert.equal(last.role, 'user')
    assert.ok((last.content as string).includes('gate hint'), 'SR text in the new tail message')
    assert.ok((last.content as string).includes('<system-reminder>'), 'SR carries the marker')
  })

  it('does not rewrite a mid-array string user message when the tail is multimodal', () => {
    const session = new SessionContext()
    session.addUserMessage('text msg')
    // Simulate a multimodal user message (array content) as the tail.
    session.getMessages().push({ role: 'user', content: [{ type: 'text', text: 'image msg' }] })

    const before = session.getMessages().map(m => JSON.stringify(m))
    // Tail is non-string user → SR must be a new tail entry, leaving the
    // mid-array string user message untouched (prefix stability).
    session.appendSystemReminder('sr text')

    const msgs = session.getMessages()
    assert.equal(JSON.stringify(msgs[0]), before[0], 'mid-array string user must not be rewritten')
    assert.equal(JSON.stringify(msgs[1]), before[1], 'multimodal user must not be rewritten')
    assert.equal(msgs.length, 3, 'SR appended as a new tail entry')
    assert.ok((msgs[2]!.content as string).includes('sr text'), 'SR in the new tail message')
  })

  // ── appendSystemReminderAndReport return-value contract ──
  // 义务门/action-intent gate 依赖此返回值判断是否放弃续轮。
  // 返回 false = SR cap 已耗尽，调用方必须放弃续轮（fail-closed）。

  it('appendSystemReminderAndReport returns true on first call, false when cap exhausted', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    const first = session.appendSystemReminderAndReport('first SR')
    assert.equal(first, true, 'first SR should be delivered')

    const second = session.appendSystemReminderAndReport('second SR')
    assert.equal(second, false, 'second SR must be rejected by cap')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('first SR'), 'first SR in message')
    assert.ok(!content.includes('second SR'), 'second SR must NOT be in message')
  })

  it('appendSystemReminderAndReport vs appendSystemReminder: only AndReport signals failure', () => {
    // 核心缺陷复现：appendSystemReminder 返回 void，调用方无感知。
    // appendSystemReminderAndReport 返回 boolean，调用方可据此决策。
    const session = new SessionContext()
    session.addUserMessage('task')

    // 先消耗额度
    session.appendSystemReminder('consumer')

    // void 返回的 appendSystemReminder：静默丢弃，调用方不知道
    session.appendSystemReminder('should-be-dropped')

    // AndReport 返回 false：调用方知道被吞了
    const ok = session.appendSystemReminderAndReport('should-also-be-dropped')
    assert.equal(ok, false, 'AndReport must return false when cap exhausted')
  })

  // ── W1 通道分级契约 ──

  it('W1: cls=user bypasses cap — multiple user-class SRs all delivered', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    session.appendSystemReminder('steer A', 'user')
    session.appendSystemReminder('steer B', 'user')
    session.appendSystemReminder('steer C', 'user')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('steer A'), 'first user SR should be delivered')
    assert.ok(content.includes('steer B'), 'second user SR should also be delivered')
    assert.ok(content.includes('steer C'), 'third user SR should also be delivered')
  })

  it('W1: cls=user does not consume discipline quota', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    // 先发一条 user 类（不占额度）
    session.appendSystemReminder('user steer', 'user')
    // 再发一条 discipline（应该成功，因为 user 不占额度）
    session.appendSystemReminder('discipline nudge')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('user steer'), 'user SR should be delivered')
    assert.ok(content.includes('discipline nudge'), 'discipline SR should still have quota')
  })

  it('W1: cls=functional bypasses cap even when discipline quota is exhausted', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    // 消耗 discipline 额度
    session.appendSystemReminder('discipline A', 'discipline')
    // discipline 第二条应被拦截
    session.appendSystemReminder('discipline B', 'discipline')
    // functional 不应受影响
    session.appendSystemReminder('functional gate', 'functional')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('discipline A'), 'first discipline SR should be delivered')
    assert.ok(!content.includes('discipline B'), 'second discipline SR must be dropped')
    assert.ok(content.includes('functional gate'), 'functional SR must be delivered despite discipline cap exhausted')
  })

  it('W1: cls=functional appendSystemReminderAndReport always returns true (cannot fail)', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    // 先消耗 discipline 额度
    session.appendSystemReminder('discipline A', 'discipline')

    // functional AndReport：即使 discipline 额度耗尽，仍应返回 true
    const ok = session.appendSystemReminderAndReport('obligation gate', 'functional')
    assert.equal(ok, true, 'functional AndReport must return true even when discipline cap is exhausted')

    // discipline AndReport：应返回 false（额度已耗尽）
    const ok2 = session.appendSystemReminderAndReport('discipline B', 'discipline')
    assert.equal(ok2, false, 'discipline AndReport must return false when cap exhausted')
  })

  it('W1: functional does not consume discipline quota — discipline still works after functional', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    // 先发 functional（不应占 discipline 额度）
    session.appendSystemReminder('functional reminder', 'functional')
    // 再发 discipline（应该成功）
    session.appendSystemReminder('discipline nudge', 'discipline')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('functional reminder'), 'functional SR delivered')
    assert.ok(content.includes('discipline nudge'), 'discipline SR still has quota after functional')
  })

  it('W1: resetSrCount only resets discipline counter — user/functional unaffected', () => {
    const session = new SessionContext()
    session.addUserMessage('turn 1')

    // 消耗 discipline 额度
    session.appendSystemReminder('disc T1', 'discipline')
    // 再发 discipline 应被拦截
    session.appendSystemReminder('disc T1 B', 'discipline')

    const t1 = session.getMessages()[0]!.content as string
    assert.ok(!t1.includes('disc T1 B'), 'second discipline dropped in turn 1')

    // 重置 → 新轮
    session.resetSrCount()
    session.addUserMessage('turn 2')

    // discipline 新轮应恢复
    session.appendSystemReminder('disc T2', 'discipline')
    // user 仍然无条件放行
    session.appendSystemReminder('user T2', 'user')

    const msgs = session.getMessages()
    const t2 = msgs[1]!.content as string
    assert.ok(t2.includes('disc T2'), 'discipline restored after reset')
    assert.ok(t2.includes('user T2'), 'user always passes through')
  })

  it('W1: no cls argument → discipline (backward compatible)', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')

    // 不传 cls → 默认 discipline，行为与改前一致
    session.appendSystemReminder('first')
    session.appendSystemReminder('second')

    const msgs = session.getMessages()
    const content = msgs[0]!.content as string
    assert.ok(content.includes('first'), 'first delivered (default discipline)')
    assert.ok(!content.includes('second'), 'second dropped (discipline cap)')
  })
})

/**
 * 集成测试：SR cap 耗尽时各 gate 的 fail-closed 行为。
 *
 * 事故（2026-07-21）：义务门在 SR 被 W3 限流静默丢弃后仍执行 continue，
 * 导致空载荷续轮 → 模型幻觉生成幻影文件读取。
 *
 * 测试策略：
 * - SessionContext 级：验证 AndReport 返回值契约（无法 mock 的硬事实）
 * - PostTurnDecisionController 级：真实构造 deps，验证 SR 耗尽时放弃 retry
 *   （六处里 deps 最小的一处，能做真实集成测试）
 *
 * 不做套套逻辑测试——不在测试体内重新实现被测代码的 if/else 分支。
 * 若有人回滚 gate 的 if (obInjected) 守卫，这里的 SessionContext 级测试
 * 虽不能直接捕获，但 PostTurnDecisionController 的集成测试会 RED。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import { PostTurnDecisionController } from '../post-turn-decision.js'
import type { PostTurnState } from '../post-turn-decision.js'

describe('SR gate fail-closed (integration)', () => {
  // ── 辅助：创建 SR cap 已耗尽的 SessionContext ──
  function exhaustedSession(): SessionContext {
    const s = new SessionContext()
    s.addUserMessage('user input')
    s.appendSystemReminder('consumer: 只读螺旋提醒消耗本轮 SR 额度')
    return s
  }

  // ── SessionContext 契约（硬事实，AndReport 返回值不能被 mock 欺骗）──

  it('AndReport returns false when SR cap exhausted', () => {
    const s = exhaustedSession()
    assert.equal(s.appendSystemReminderAndReport('义务门提醒'), false)
  })

  it('AndReport returns true when cap not exhausted', () => {
    const s = new SessionContext()
    s.addUserMessage('fresh turn')
    assert.equal(s.appendSystemReminderAndReport('first reminder'), true)
  })

  it('steer preempt: resetSrCount restores SR delivery', () => {
    const s = exhaustedSession()
    assert.equal(s.appendSystemReminderAndReport('义务门提醒'), false)
    s.resetSrCount()
    assert.equal(s.appendSystemReminderAndReport('用户 steer 文本'), true)
  })

  // ── PostTurnDecisionController 真实集成测试 ──
  // 这是六处里唯一 deps 足够小、可以真实构造并驱动被测代码的路径。
  // 如果 someone 回滚了 if (obInjected) 守卫，这个测试会 RED。

  it('PostTurnDecisionController: SR cap exhausted → shouldRetry=false', async () => {
    const session = exhaustedSession()
    // cap 已耗尽，AndReport 返回 false
    assert.equal(session.appendSystemReminderAndReport('dummy'), false)

    // 构造真实 PostTurnDecisionController，用同一个 session
    const state: PostTurnState = {
      streamedText: '',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    }

    // 让 thinking-retry 判定为 shouldRetry，但 SR 注入会失败
    // thinkingAccum 非空 + thinkingOnlyRetries < 阈值 → 触发 retry
    const ctrl = new PostTurnDecisionController({
      state,
      getDoomLoopLevel: () => 'none',
      appendSystemReminder: (content) => { session.appendSystemReminder(content) },
      appendSystemReminderAndReport: (content) => session.appendSystemReminderAndReport(content),
      completeTurn: async () => {},
      getTotalUsage: () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      getTurnCount: () => 1,
      skipThinkingRetry: false,
    })

    // thinking-retry 判定条件：collectedBlockCount=0（只有 thinking）+ thinkingAccum 非空
    const result = await ctrl.evaluateThinkingRetry({
      collectedBlockCount: 0,
      thinkingAccum: 'some reasoning',
      turn: 1,
      callbacks: { onTurnComplete: () => {} } as any,
      signal: new AbortController().signal,
    })

    // SR cap 耗尽 → AndReport 返回 false → 放弃 retry
    assert.equal(result.shouldRetry, false,
      'RED: must skip retry when SR injection fails (empty-payload continuation guard)')
  })

  it('PostTurnDecisionController: SR available → shouldRetry=true', async () => {
    const session = new SessionContext()
    session.addUserMessage('fresh turn')
    // cap 未耗尽
    assert.equal(session.appendSystemReminderAndReport('dummy'), true)
    session.resetSrCount() // 重置以允许 retry 注入

    const state: PostTurnState = {
      streamedText: '',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    }

    const ctrl = new PostTurnDecisionController({
      state,
      getDoomLoopLevel: () => 'none',
      appendSystemReminder: (content) => { session.appendSystemReminder(content) },
      appendSystemReminderAndReport: (content) => session.appendSystemReminderAndReport(content),
      completeTurn: async () => {},
      getTotalUsage: () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      getTurnCount: () => 1,
      skipThinkingRetry: false,
    })

    const result = await ctrl.evaluateThinkingRetry({
      collectedBlockCount: 0,
      thinkingAccum: 'some reasoning',
      turn: 1,
      callbacks: { onTurnComplete: () => {} } as any,
      signal: new AbortController().signal,
    })

    // SR 可用 → 正常 retry
    assert.equal(result.shouldRetry, true,
      'GREEN: normal retry when SR cap not exhausted')
  })
})

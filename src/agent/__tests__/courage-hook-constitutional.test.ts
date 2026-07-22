import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCourageHook } from '../hooks/courage-hook.js'
import { createSycophancyTrap } from '../sycophancy-trap.js'

describe('courage-hook constitutional override', () => {
  it('bypasses cooldown when sycophancy trap is active', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })

    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 5, getCourageThreshold: () => 0.5, sycophancyTrap: trap })
    const makeCtx = (turn: number) => ({
      snapshot: { turn, recentToolHistory: [] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    })

    hook.run(makeCtx(1) as any)
    hook.run(makeCtx(2) as any)

    assert.equal(messages.length, 2, `expected 2 triggers (bypass cooldown), got ${messages.length}`)
    for (const msg of messages) {
      assert.ok(msg.includes('必须'), `expected 必须 in ${msg}`)
      assert.ok(msg.includes('信念宪法'), `expected 信念宪法 tag in ${msg}`)
    }
  })

  it('emits risk message when only risk signals present, not constitutional', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })

    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 1, getCourageThreshold: () => 0.3, sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 1)
    assert.ok(messages[0]!.includes('风险信号'), `expected 风险信号, got: ${messages[0]}`)
    assert.ok(!messages[0]!.includes('信念宪法'), 'risk message should not be constitutional')
  })

  it('does not trigger when no risk and trap inactive', () => {
    const trap = createSycophancyTrap()
    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 1, getCourageThreshold: () => 0.5, sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'success' as const, target: 'npm test' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 0)
  })

  it('constitutional message requires structural verification, bars dismissal', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })

    const messages: string[] = []
    const hook = createCourageHook({ sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 1)
    const msg = messages[0]!
    // Bars simple dismissal — message explicitly forbids these phrases
    assert.ok(!msg.includes('无阻塞风险'), 'constitutional must not allow no-risk dismissal')
    // Requires structural verification: file + lines + fact + impact
    assert.ok(msg.includes('文件'), 'must reference file path')
    assert.ok(msg.includes('行'), 'must reference line numbers')
    assert.ok(msg.includes('事实'), 'must reference specific facts')
    assert.ok(msg.includes('下一步'), 'must reference next-step impact')
    // Contains consequence for non-compliance
    assert.ok(msg.includes('方向暂停'), 'must specify consequence')
    // Forbids trivial fulfillment
    assert.ok(msg.includes('不可用'), 'must explicitly forbid trivial responses')
  })

  it('respects cooldown in regular (non-sycophancy) mode', () => {
    const trap = createSycophancyTrap()
    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 10, getCourageThreshold: () => 0.3, sycophancyTrap: trap })

    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 1)

    hook.run({
      snapshot: { turn: 2, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 1, 'cooldown should block when trap inactive')
  })

  it('W0 regression: getter is called on each trigger, not cached at construction', () => {
    // 验证活引用语义：getCourageThreshold 在每次 run() 时求值，
    // 而非在 createCourageHook() 构造期一次性快照。
    let callCount = 0
    let threshold = 0.5
    const hook = createCourageHook({
      cooldownTurns: 0,
      getCourageThreshold: () => {
        callCount++
        return threshold
      },
    })

    const makeCtx = (turn: number) => ({
      snapshot: { turn, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (_msg: string) => {} },
    })

    // 第一次触发：getter 被调用，阈值 0.5 → 1/1=1.0 ≥ 0.5 → 触发
    hook.run(makeCtx(1) as any)
    assert.equal(callCount, 1, 'getter should be called on first trigger')

    // 第二次触发：getter 再次被调用
    hook.run(makeCtx(2) as any)
    assert.equal(callCount, 2, 'getter should be called on each run(), not cached')

    // 修改阈值：切换为瑶光的高阈值 0.8
    threshold = 0.8
    const messages: string[] = []
    const hook2 = createCourageHook({
      cooldownTurns: 0,
      getCourageThreshold: () => threshold,
    })
    const ctx = {
      snapshot: { turn: 3, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    }
    hook2.run(ctx as any)
    // 1/1=1.0 ≥ 0.8 → 应触发
    assert.equal(messages.length, 1, 'should trigger with high threshold when risk ratio >= 0.8')

    // 降低风险信号：success 不计入风险
    const messages2: string[] = []
    const ctx2 = {
      snapshot: { turn: 4, recentToolHistory: [{ tool: 'bash', status: 'success' as const, target: 'echo ok' }] },
      effects: { injectUserMessage: (msg: string) => { messages2.push(msg) } },
    }
    hook2.run(ctx2 as any)
    // 0/1=0 < 0.8 → 不触发
    assert.equal(messages2.length, 0, 'should NOT trigger with high threshold when risk ratio = 0')
  })

  it('W0 regression: domain switch takes immediate effect via getter', () => {
    // 模拟域切换时序：构造时绑定破军(0.25)→切换瑶光(0.8)→断言阈值即时变更
    let currentThreshold = 0.25 // 破军

    const messages: string[] = []
    const hook = createCourageHook({
      cooldownTurns: 0,
      getCourageThreshold: () => currentThreshold,
    })

    // 破军 0.25：1 条 fail → 1/1=1.0 ≥ 0.25 → 触发
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 1, '破军 0.25: should trigger on single failure')

    // 切换域：破军→瑶光 (0.8)
    currentThreshold = 0.8

    // 瑶光 0.8：同样的 1 条 fail → 1/1=1.0 ≥ 0.8 → 仍应触发
    hook.run({
      snapshot: { turn: 2, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 2, '瑶光 0.8: single failure still triggers (ratio 1.0 ≥ 0.8)')

    // 但 success 不应在瑶光触发
    currentThreshold = 0.8 // 确保仍是瑶光
    const messages3: string[] = []
    const hook2 = createCourageHook({
      cooldownTurns: 0,
      getCourageThreshold: () => currentThreshold,
    })
    hook2.run({
      snapshot: { turn: 3, recentToolHistory: [{ tool: 'bash', status: 'success' as const, target: 'echo ok' }] },
      effects: { injectUserMessage: (msg: string) => { messages3.push(msg) } },
    } as any)
    // 0/1=0 < 0.8 → 不触发，证明用的是瑶光阈值而非破军
    assert.equal(messages3.length, 0, '瑶光 0.8: success-only should NOT trigger (proves getter not stale)')
  })
})

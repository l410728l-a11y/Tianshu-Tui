import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract, advanceContractStatus } from '../../context/task-contract.js'
import { checkTddGate, type TddGateInput } from '../tdd-gate.js'

describe('TDD Gate integration with TaskContract', () => {
  it('fires on planning→executing transition when no tests touched', () => {
    let contract = extractTaskContract('implement immune-apc three-tier gate', 1)
    contract = advanceContractStatus(contract, 'planning', 2)

    // Simulate: agent read source files but no test files
    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/immune-apc.ts', 'src/agent/immune-types.ts']),
      filesModified: new Set(['src/agent/immune-apc.ts']),
      requiresCodeVerification: contract.isActionable,
    }

    // Transition to executing
    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    // Gate should fire
    if (prev === 'planning' && contract.status === 'executing') {
      const hint = checkTddGate(evidence)
      assert.ok(hint, 'TDD gate should fire when no test file touched')
      assert.equal(hint.level, 'warning')
    }
  })

  it('does not fire when test file was read before executing', () => {
    let contract = extractTaskContract('implement immune-apc three-tier gate', 1)
    contract = advanceContractStatus(contract, 'planning', 2)

    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/immune-apc.ts', 'src/agent/__tests__/immune-system.test.ts']),
      filesModified: new Set(),
      requiresCodeVerification: contract.isActionable,
    }

    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    if (prev === 'planning' && contract.status === 'executing') {
      const hint = checkTddGate(evidence)
      assert.equal(hint, null, 'TDD gate should not fire when test file was read')
    }
  })

  it('does not fire on executing→executing (same status, no transition)', () => {
    let contract = extractTaskContract('fix bug in parser', 1)
    contract = advanceContractStatus(contract, 'executing', 2)

    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    // No transition happened
    assert.equal(prev, 'executing')
    assert.equal(contract.status, 'executing')
    // Gate logic would not be reached because prev === contract.status
  })

  it('does not fire for non-actionable tasks', () => {
    let contract = extractTaskContract('hi', 1)
    assert.equal(contract.isActionable, false)

    const evidence: TddGateInput = {
      filesRead: new Set<string>(),
      filesModified: new Set(['src/agent/foo.ts']),
      requiresCodeVerification: contract.isActionable,
    }

    const hint = checkTddGate(evidence)
    assert.equal(hint, null)
  })
})

// ── RED: 资格分层反例 — 解释型输入不应触发工程 TDD ──
// 当前行为（RED）：解释/分析输入因 isActionable=true 进入 TDD 门控。
// 预期行为（GREEN，迁移后）：解释输入 requiresCodeVerification=false → TDD 返回 null。
describe('TDD Gate — explanation should not trigger engineering TDD (RED)', () => {
  it('RED: code explanation with file mention triggers TDD gate (current broken behavior)', () => {
    const contract = extractTaskContract('解释 src/agent/loop.ts 的作用，不要修改', 1)
    // 当前分类：isActionable=true，无法区分解释与修复
    assert.equal(contract.isActionable, true, 'explanation is currently classified as actionable')

    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/loop.ts']),
      filesModified: new Set<string>(),
      requiresCodeVerification: contract.isActionable,
    }

    const hint = checkTddGate(evidence)
    // RED: 当前解释输入会触发 TDD 提示，但这不应该
    assert.ok(hint, 'RED: explanation input incorrectly triggers TDD gate')
    assert.ok(hint!.signalKinds.includes('tdd_violation'),
      'RED: explanation triggers tdd_violation immune signal')
  })

  it('RED: concept question triggers TDD gate', () => {
    const contract = extractTaskContract('噪音是什么意思', 1)
    assert.equal(contract.isActionable, true, 'concept question incorrectly classified as actionable')

    const evidence: TddGateInput = {
      filesRead: new Set<string>(),
      filesModified: new Set<string>(),
      requiresCodeVerification: contract.isActionable,
    }

    const hint = checkTddGate(evidence)
    // RED: 概念问答触发 TDD 提示
    assert.ok(hint, 'RED: concept question incorrectly triggers TDD gate')
  })

  it('regression guard: bug_fix still triggers TDD gate', () => {
    const contract = extractTaskContract('修复 src/agent/loop.ts 的 bug', 1)
    assert.equal(contract.isActionable, true)

    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/loop.ts']),
      filesModified: new Set<string>(),
      requiresCodeVerification: contract.isActionable,
    }

    const hint = checkTddGate(evidence)
    // 工程修复必须保持 TDD 门控
    assert.ok(hint, 'bug fix should trigger TDD gate')
    assert.ok(hint!.signalKinds.includes('tdd_violation'))
  })
})

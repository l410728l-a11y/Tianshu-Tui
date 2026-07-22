/**
 * cognitive-capsule-router 让位补缝 RED 测试。
 *
 * 验证：CV3/CV2 对 edit-failure-recovery:<path> 的前缀匹配让位。
 * 修复前 edit-failure-recovery 不在 PERSPECTIVE_YIELD_KEYS 且 includes 无法匹配动态后缀。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCvmVectorEvaluator, type CvmVectorInput } from '../cognitive-capsule-router.js'
import { emptyObligationStore } from '../../evidence-obligation.js'

function baseInput(overrides: Partial<CvmVectorInput> = {}): CvmVectorInput {
  return {
    turn: 5,
    phaseClass: 'attack',
    convergence: null,
    pressure: { ratio: 0.3, cvmOverheadRatio: 0.1, thrashing: false, shouldThrottleCvm: false, hardCeiling: false },
    obligations: emptyObligationStore(),
    evidence: { filesModified: 2, deliveryStatus: 'none' },
    pendingAdvisoryKeys: [],
    convergenceEmittedRecently: false,
    scoutOwned: false,
    hasDecisionGates: false,
    attackLayerEnabled: true,
    ...overrides,
  }
}

// 模拟 convergence-abort 触发 CV3-attack-stalled 的最小输入
function cv3TriggerInput(): CvmVectorInput {
  return baseInput({
    convergence: { score: 0.15, level: 3, textRepetitionPenalty: 0.2, oscillationPenalty: 0.3 },
    caseOpenSignals: [
      {
        anchor: { kind: 'failure_pattern', ref: 'dead-end-file' },
        source: 'dead-end-file',
        summary: 'test',
      },
    ],
  })
}

describe('CvmVectorEvaluator — edit-failure-recovery 让位', () => {
  it('edit-failure-recovery:<path> pending 时 CV3 应 yield', () => {
    const evaluate = createCvmVectorEvaluator()
    const input = cv3TriggerInput()
    const decision = evaluate.evaluate({
      ...input,
      pendingAdvisoryKeys: ['edit-failure-recovery:src/foo.ts'],
    })

    // 修复前：CV3 candidate 非 null（未让位，叠声）
    // 修复后：CV3 yielded.to === 'edit-failure-recovery'
    if (decision.yielded) {
      assert.equal(decision.yielded.to, 'edit-failure-recovery')
    } else {
      assert.fail('CV3 should yield to edit-failure-recovery')
    }
  })

  it('CV3 仍对已知专用声源让位（回归）', () => {
    const evaluate = createCvmVectorEvaluator()
    const input = cv3TriggerInput()
    const decision = evaluate.evaluate({
      ...input,
      pendingAdvisoryKeys: ['convergence', 'typecheck-reminder'],
    })
    assert.ok(decision.yielded)
    assert.equal(decision.yielded!.to, 'convergence')
  })

  it('CV3 仍对 dead-end-file 让位（回归）', () => {
    const evaluate = createCvmVectorEvaluator()
    const input = cv3TriggerInput()
    const decision = evaluate.evaluate({
      ...input,
      pendingAdvisoryKeys: ['dead-end-file'],
    })
    assert.ok(decision.yielded)
    assert.equal(decision.yielded!.to, 'dead-end-file')
  })

  it('CV3 仍对 regression-bisect 让位（回归）', () => {
    const evaluate = createCvmVectorEvaluator()
    const input = cv3TriggerInput()
    const decision = evaluate.evaluate({
      ...input,
      pendingAdvisoryKeys: ['regression-bisect'],
    })
    assert.ok(decision.yielded)
    assert.equal(decision.yielded!.to, 'regression-bisect')
  })

  it('让位后 caseOpenSignals 不受影响（信号仍在，次轮可升级）', () => {
    const evaluate = createCvmVectorEvaluator()
    const base = cv3TriggerInput()
    const decision = evaluate.evaluate({
      ...base,
      pendingAdvisoryKeys: ['edit-failure-recovery:src/foo.ts'],
    })

    // 让位记录存在
    assert.ok(decision.yielded)
    // classification 仍记录 caseOpenSignals 数量（信号未丢）
    assert.ok(decision.classification)
    assert.equal(decision.classification!.facts.caseOpenSignals, 1)
  })

  it('升级阶梯不断裂：让位轮→开火轮两步序列', () => {
    // 反证表②：次轮无专用声源时 CV3-open 正常开火。
    // Turn N: edit-failure-recovery pending → CV3 让位
    const evaluate = createCvmVectorEvaluator()
    const base = cv3TriggerInput()
    const decisionN = evaluate.evaluate({
      ...base,
      turn: 5,
      pendingAdvisoryKeys: ['edit-failure-recovery:src/foo.ts'],
    })
    assert.ok(decisionN.yielded, 'turn N: should yield to edit-failure-recovery')
    assert.equal(decisionN.yielded!.to, 'edit-failure-recovery')
    assert.equal(decisionN.candidate, null, 'turn N: no candidate when yielded')

    // Turn N+1: edit-failure ttl 到期（不再 pending），信号仍在 caseOpenSignals
    // → CV3-open 应正常开火
    const decisionN1 = evaluate.evaluate({
      ...base,
      turn: 6,
      pendingAdvisoryKeys: [], // 专用声源已退场
      caseOpenSignals: [
        {
          anchor: { kind: 'failure_pattern', ref: 'edit-failure-recovery:src/foo.ts' },
          source: 'edit-failure',
          summary: 'test',
        },
      ],
    })
    assert.equal(decisionN1.yielded, null, 'turn N+1: no specialized voice → should not yield')
    assert.ok(decisionN1.candidate, 'turn N+1: CV3-open should fire with candidate')
    assert.equal(decisionN1.classification!.facts.caseOpenSignals, 1)
  })
})

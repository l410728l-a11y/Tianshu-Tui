/**
 * Case-open signals（PAL 第四波 W1）— 开案信号聚合纯函数反证测试。
 *
 * 覆盖计划反证清单：trace 空/无 steps 时 plan-blocked 源自然缺席不炸；
 * obligation 源只认 high+blocked（open/attempted 会命中 evaluator gate，
 * 信号到不了 CV3）；确定性（同输入同输出、顺序稳定）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectCaseOpenSignals, PLAN_BLOCKED_STREAK_THRESHOLD, type CaseOpenSignalInput } from '../case-open-signals.js'
import { emptyObligationStore, type EvidenceObligation, type ObligationStore } from '../evidence-obligation.js'
import { createTrace, type PlanExecutionTrace, type StepResult } from '../plan-execution-trace.js'
import type { WaveGateRecord } from '../wave-gate.js'

function obligation(partial: Partial<EvidenceObligation>): EvidenceObligation {
  return {
    id: 'ob-1',
    family: 'behavior',
    claim: 'x',
    targets: [],
    risk: 'medium',
    requiredAction: 'targeted_verification',
    state: 'open',
    attempts: 0,
    evidenceRefs: [],
    ...partial,
  }
}

function storeWith(...obs: EvidenceObligation[]): ObligationStore {
  return { obligations: obs }
}

function baseInput(overrides: Partial<CaseOpenSignalInput> = {}): CaseOpenSignalInput {
  return {
    pendingAdvisoryKeys: [],
    obligations: emptyObligationStore(),
    planTrace: null,
    waveGate: undefined,
    ...overrides,
  }
}

function result(stepId: string, status: StepResult['status'], turn: number): StepResult {
  return { stepId, turnNumber: turn, toolCalls: [], status }
}

function traceWith(history: StepResult[]): PlanExecutionTrace {
  const t = createTrace('c1', 'wiring', [
    { id: 'step-1', description: 's1', expectedTools: [], status: 'done' },
    { id: 'step-2', description: 's2', expectedTools: [], status: 'active' },
  ])
  return { ...t, history }
}

describe('collectCaseOpenSignals', () => {
  it('全空输入 → 空数组（不炸、无假阳性）', () => {
    assert.deepEqual(collectCaseOpenSignals(baseInput()), [])
  })

  it('pending 含 regression-bisect / dead-end-file → failure_pattern 锚信号', () => {
    const signals = collectCaseOpenSignals(baseInput({
      pendingAdvisoryKeys: ['regression-bisect', 'dead-end-file', 'typecheck-reminder'],
    }))
    assert.equal(signals.length, 2)
    assert.deepEqual(signals[0]!.anchor, { kind: 'failure_pattern', ref: 'regression-bisect' })
    assert.equal(signals[0]!.source, 'regression-bisect')
    assert.deepEqual(signals[1]!.anchor, { kind: 'failure_pattern', ref: 'dead-end-file' })
  })

  it('obligation 源只认 high+blocked：open/attempted high 与 medium blocked 都不产生信号', () => {
    const none = collectCaseOpenSignals(baseInput({
      obligations: storeWith(
        obligation({ id: 'a', risk: 'high', state: 'open' }),
        obligation({ id: 'b', risk: 'high', state: 'attempted' }),
        obligation({ id: 'c', risk: 'medium', state: 'blocked' }),
      ),
    }))
    assert.deepEqual(none, [])
    const hit = collectCaseOpenSignals(baseInput({
      obligations: storeWith(obligation({ id: 'ob_x', risk: 'high', state: 'blocked', claim: 'auth 回归未复现' })),
    }))
    assert.equal(hit.length, 1)
    assert.deepEqual(hit[0]!.anchor, { kind: 'obligation', ref: 'ob_x' })
    assert.equal(hit[0]!.source, 'obligation-high')
    assert.match(hit[0]!.summary, /auth 回归未复现/)
  })

  it('多条 blocked high 义务按 id 字典序稳定输出', () => {
    const signals = collectCaseOpenSignals(baseInput({
      obligations: storeWith(
        obligation({ id: 'zz', risk: 'high', state: 'blocked' }),
        obligation({ id: 'aa', risk: 'high', state: 'blocked' }),
      ),
    }))
    assert.deepEqual(signals.map(s => s.anchor.ref), ['aa', 'zz'])
  })

  it('trace 为 null 或无 steps → plan-blocked 源自然缺席（④c 反证核心）', () => {
    assert.deepEqual(collectCaseOpenSignals(baseInput({ planTrace: null })), [])
    const emptySteps = createTrace('c1', 'unit')
    assert.deepEqual(collectCaseOpenSignals(baseInput({ planTrace: emptySteps })), [])
  })

  it(`尾部连续 blocked ≥ ${PLAN_BLOCKED_STREAK_THRESHOLD} → trace_step 锚（ref=最后 blocked stepId）`, () => {
    const signals = collectCaseOpenSignals(baseInput({
      planTrace: traceWith([
        result('step-1', 'done', 1),
        result('step-2', 'blocked', 2),
        result('step-2', 'blocked', 3),
      ]),
    }))
    assert.equal(signals.length, 1)
    assert.deepEqual(signals[0]!.anchor, { kind: 'trace_step', ref: 'step-2' })
    assert.equal(signals[0]!.source, 'plan-blocked')
  })

  it('反证：单次 blocked 或被 done 中断的 streak 不产生信号', () => {
    assert.deepEqual(collectCaseOpenSignals(baseInput({
      planTrace: traceWith([result('step-1', 'done', 1), result('step-2', 'blocked', 2)]),
    })), [])
    assert.deepEqual(collectCaseOpenSignals(baseInput({
      planTrace: traceWith([
        result('step-1', 'blocked', 1),
        result('step-1', 'done', 2),
        result('step-2', 'blocked', 3),
      ]),
    })), [])
  })

  it('wave-gate 失败 → failure_pattern 锚；通过则无信号', () => {
    const failed: WaveGateRecord = {
      wave: 1,
      passed: false,
      checks: [
        { command: 'npx tsc --noEmit', status: 'failed', detail: '2 errors' },
        { command: 'npm test', status: 'passed' },
      ],
      changedFiles: [],
      commands: [],
      checkedAt: 0,
    }
    const signals = collectCaseOpenSignals(baseInput({ waveGate: failed }))
    assert.equal(signals.length, 1)
    assert.deepEqual(signals[0]!.anchor, { kind: 'failure_pattern', ref: 'wave-1-gate-failed' })
    assert.match(signals[0]!.summary, /npx tsc --noEmit/)
    assert.deepEqual(collectCaseOpenSignals(baseInput({ waveGate: { ...failed, passed: true } })), [])
  })

  it('确定性：同输入两次调用输出 deepEqual 且顺序稳定（专用 hook → 义务 → trace → gate）', () => {
    const input = baseInput({
      pendingAdvisoryKeys: ['dead-end-file'],
      obligations: storeWith(obligation({ id: 'ob_1', risk: 'high', state: 'blocked' })),
      planTrace: traceWith([result('step-2', 'blocked', 2), result('step-2', 'blocked', 3)]),
      waveGate: { wave: 0, passed: false, checks: [], changedFiles: [], commands: [], checkedAt: 0 },
    })
    const a = collectCaseOpenSignals(input)
    const b = collectCaseOpenSignals(input)
    assert.deepEqual(a, b)
    assert.deepEqual(a.map(s => s.source), ['dead-end-file', 'obligation-high', 'plan-blocked', 'wave-gate'])
  })

  // ── 遗产回收 W-A2：edit-failure + convergence-abort 两源 ──

  it('edit-failure：前缀匹配 advisory key，每文件独立信号，按路径字典序', () => {
    const signals = collectCaseOpenSignals(baseInput({
      pendingAdvisoryKeys: [
        'edit-failure-recovery:src/z.ts',
        'typecheck-reminder',
        'edit-failure-recovery:src/a.ts',
      ],
    }))
    assert.equal(signals.length, 2)
    assert.deepEqual(signals.map(s => s.anchor.ref), [
      'edit-failure-recovery:src/a.ts',
      'edit-failure-recovery:src/z.ts',
    ])
    assert.equal(signals[0]!.source, 'edit-failure')
    assert.match(signals[0]!.summary, /src\/a\.ts/)
  })

  it('反证：前缀过滤不误伤——无冒号变体或其他 key 不产生 edit-failure 信号', () => {
    assert.deepEqual(collectCaseOpenSignals(baseInput({
      pendingAdvisoryKeys: ['edit-failure-recovery', 'edit-tool-advisory', 'dead-end'],
    })), [])
  })

  it('convergence-abort：shouldAbort + cause 区分 no-tool / score 锚与建议', () => {
    const noTool = collectCaseOpenSignals(baseInput({
      convergenceAbort: { shouldAbort: true, abortCause: 'no-tool' },
    }))
    assert.equal(noTool.length, 1)
    assert.deepEqual(noTool[0]!.anchor, { kind: 'failure_pattern', ref: 'convergence-abort:no-tool' })
    assert.equal(noTool[0]!.source, 'convergence-abort')
    assert.match(noTool[0]!.summary, /工具权限|工具定义/)

    const score = collectCaseOpenSignals(baseInput({
      convergenceAbort: { shouldAbort: true, abortCause: 'score' },
    }))
    assert.deepEqual(score[0]!.anchor, { kind: 'failure_pattern', ref: 'convergence-abort:score' })
    assert.match(score[0]!.summary, /策略/)
  })

  it('反证：shouldAbort=false 或源缺席不产生 convergence-abort 信号', () => {
    assert.deepEqual(collectCaseOpenSignals(baseInput({
      convergenceAbort: { shouldAbort: false, abortCause: undefined },
    })), [])
    assert.deepEqual(collectCaseOpenSignals(baseInput({ convergenceAbort: null })), [])
  })

  it('七源共存时输出顺序确定（专用 hook 按 bisect→dead-end→edit-failure→abort）', () => {
    const input = baseInput({
      pendingAdvisoryKeys: ['regression-bisect', 'edit-failure-recovery:src/a.ts', 'dead-end-file'],
      obligations: storeWith(obligation({ id: 'ob_1', risk: 'high', state: 'blocked' })),
      convergenceAbort: { shouldAbort: true, abortCause: 'score' },
      planTrace: traceWith([result('step-2', 'blocked', 2), result('step-2', 'blocked', 3)]),
      waveGate: { wave: 0, passed: false, checks: [], changedFiles: [], commands: [], checkedAt: 0 },
    })
    const a = collectCaseOpenSignals(input)
    assert.deepEqual(a, collectCaseOpenSignals(input))
    assert.deepEqual(a.map(s => s.source), [
      'regression-bisect', 'dead-end-file', 'edit-failure', 'convergence-abort',
      'obligation-high', 'plan-blocked', 'wave-gate',
    ])
  })
})

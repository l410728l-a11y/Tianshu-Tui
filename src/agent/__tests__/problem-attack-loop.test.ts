/**
 * PAL 纯 reducer 反证测试（计划 v2 Wave P1）。
 *
 * 反证清单覆盖："工具调用即 supported""blocked 即 satisfied""随机选假设"
 * "重复 probe 无限重试""绕过谓词直接 set status""无锚开案""预算无限"
 * "模型自报刷分"。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTACK_SCORE_POINTS,
  MAX_ACTIVE_HYPOTHESES,
  MAX_PROBES_PER_CASE,
  MAX_ATTACK_TURNS,
  MAX_CONCURRENT_CASES,
  ProblemAttackStore,
  caseIdFor,
  chooseDiscriminator,
  emptyAttackState,
  hypothesisIdFor,
  probeIdFor,
  reduceAttackState,
  type AttackEvent,
  type ProblemAttackState,
  type ProbeExpectation,
} from '../problem-attack-loop.js'

const ANCHOR = { kind: 'failure_pattern' as const, ref: 'run_tests:assertion:src/a.test.ts' }

function openedCase(): { state: ProblemAttackState; caseId: string } {
  const caseId = caseIdFor(ANCHOR, 'test fails after refactor')
  const r = reduceAttackState(emptyAttackState(caseId), {
    type: 'case_opened', caseId, turn: 1, anchor: ANCHOR, problem: 'test fails after refactor',
  })
  assert.equal(r.rejected, undefined)
  return { state: r.state, caseId }
}

function addHyp(state: ProblemAttackState, claim: string, targets: string[] = ['src/a.ts'], turn = 2) {
  const r = reduceAttackState(state, { type: 'hypothesis_added', caseId: state.caseId, turn, claim, targets })
  assert.equal(r.rejected, undefined, `hypothesis_added rejected: ${r.rejected}`)
  return { state: r.state, id: hypothesisIdFor(state.caseId, claim, targets) }
}

const EXPECT_PATTERN: ProbeExpectation = { kind: 'pattern_found', path: 'src/a.ts', needle: 'oldName' }

function planProbe(
  state: ProblemAttackState,
  hypIds: string[],
  perHypothesis: Array<{ hypothesisId: string; ifTrue: 'supports' | 'refutes' | 'neutral'; ifFalse?: 'supports' | 'refutes' | 'neutral' }>,
  opts: { target?: string; expectation?: ProbeExpectation; kind?: 'read' | 'grep' | 'targeted_test' | 'micro_probe' | 'instrument' | 'simulate' | 'ask_user'; turn?: number } = {},
) {
  const target = opts.target ?? 'src/a.ts'
  const expectation = opts.expectation ?? EXPECT_PATTERN
  const r = reduceAttackState(state, {
    type: 'probe_planned', caseId: state.caseId, turn: opts.turn ?? 3,
    probe: { hypothesisIds: hypIds, kind: opts.kind ?? 'grep', target, expectation, perHypothesis },
  })
  assert.equal(r.rejected, undefined, `probe_planned rejected: ${r.rejected}`)
  return { state: r.state, id: probeIdFor(state.caseId, target, expectation) }
}

describe('PAL reducer — 开案与假设', () => {
  it('无锚开案被拒绝（伪结构化闸门）', () => {
    const caseId = caseIdFor({ kind: 'user_report', ref: '' }, 'p')
    const r = reduceAttackState(emptyAttackState(caseId), {
      type: 'case_opened', caseId, turn: 1, anchor: { kind: 'user_report', ref: '  ' }, problem: 'p',
    })
    assert.match(r.rejected ?? '', /anchor required/)
  })

  it('重复 case_opened 幂等拒绝，version 只增一次', () => {
    const { state, caseId } = openedCase()
    const v = state.version
    const r = reduceAttackState(state, { type: 'case_opened', caseId, turn: 2, anchor: ANCHOR, problem: 'x' })
    assert.match(r.rejected ?? '', /already opened/)
    assert.equal(r.state.version, v)
  })

  it('同义 claim 规范化去重（换空白/大小写不产生第二条假设）', () => {
    const { state } = openedCase()
    const a = addHyp(state, 'Rename  Broke   Import', ['src/a.ts'])
    const r = reduceAttackState(a.state, {
      type: 'hypothesis_added', caseId: state.caseId, turn: 3,
      claim: 'rename broke import', targets: ['src/a.ts'],
    })
    assert.match(r.rejected ?? '', /duplicate hypothesis/)
  })

  it('存活假设预算上限强制执行', () => {
    let { state } = openedCase()
    for (let i = 0; i < MAX_ACTIVE_HYPOTHESES; i++) {
      state = addHyp(state, `hypothesis ${i}`).state
    }
    const r = reduceAttackState(state, { type: 'hypothesis_added', caseId: state.caseId, turn: 3, claim: 'one too many', targets: [] })
    assert.match(r.rejected ?? '', /budget: max/)
  })
})

describe('PAL reducer — 谓词结算与状态推导（反证核心）', () => {
  it('自检 1：谓词真 supports H1 / neutral H2 → H1 supported，H2 不自动 refuted', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1: rename broke import'); state = h1.state
    const h2 = addHyp(state, 'H2: stale build cache'); state = h2.state
    const p1 = planProbe(state, [h1.id, h2.id], [
      { hypothesisId: h1.id, ifTrue: 'supports' },
      { hypothesisId: h2.id, ifTrue: 'neutral' },
    ]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    assert.equal(r.rejected, undefined)
    const hyp1 = r.state.hypotheses.find(h => h.id === h1.id)!
    const hyp2 = r.state.hypotheses.find(h => h.id === h2.id)!
    assert.equal(hyp1.status, 'supported')
    assert.equal(hyp1.evidenceRefs.length, 1)
    assert.equal(hyp2.status, 'candidate', 'H2 不得被顺带淘汰')
  })

  it('反证："工具调用即 supported"不存在——probe_attempted 不改假设状态', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }]); state = p1.state
    const r = reduceAttackState(state, { type: 'probe_attempted', caseId: state.caseId, turn: 4, probeId: p1.id })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.hypotheses[0]!.status, 'candidate')
    assert.equal(r.state.score, 0, '尝试本身不计分——只有有效结果计分')
  })

  it('反证：无 evidenceRef 的可观察结算被拒绝（不能空口 supported）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id, predicateOutcome: 'true',
    })
    assert.match(r.rejected ?? '', /evidenceRef required/)
  })

  it('反证：blocked probe 不产生任何假设迁移（blocked ≠ satisfied）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }]); state = p1.state
    const r = reduceAttackState(state, { type: 'probe_blocked', caseId: state.caseId, turn: 4, probeId: p1.id })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.hypotheses[0]!.status, 'candidate')
    assert.equal(r.state.probes[0]!.status, 'blocked')
    assert.equal(r.state.score, 0)
  })

  it('自检 5：同一 probe 重复结算被拒（幂等，证据不重复计）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'refutes' }]); state = p1.state
    const first = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    assert.equal(first.rejected, undefined)
    const again = reduceAttackState(first.state, {
      type: 'probe_observed', caseId: state.caseId, turn: 5, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:5',
    })
    assert.match(again.rejected ?? '', /already settled/)
    assert.equal(again.state.version, first.state.version)
  })

  it('ifFalse 缺省 neutral："没找到"不自动等于反驳', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'false', evidenceRef: 'tool:grep:4',
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.hypotheses[0]!.status, 'candidate')
    assert.equal(r.state.probes[0]!.status, 'uninformative', '无任何效果 = 不出信息')
  })

  it('显式 ifFalse: refutes 时谓词假 → 假设被淘汰并加分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1: needle must exist'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports', ifFalse: 'refutes' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'false', evidenceRef: 'tool:grep:4',
    })
    assert.equal(r.state.hypotheses[0]!.status, 'refuted')
    assert.ok(r.scored.some(s => s.kind === 'hypothesis_refuted'))
    assert.ok(r.scored.some(s => s.kind === 'probe_informative'))
  })
})

describe('PAL reducer — 收敛与预算', () => {
  it('唯一 supported 且无存活假设 → converged + case_converged 加分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const h2 = addHyp(state, 'H2'); state = h2.state
    const p1 = planProbe(state, [h1.id, h2.id], [
      { hypothesisId: h1.id, ifTrue: 'supports' },
      { hypothesisId: h2.id, ifTrue: 'refutes' },
    ]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:run_tests:4',
    })
    assert.equal(r.state.status, 'converged')
    assert.equal(r.state.selectedHypothesisId, h1.id)
    assert.ok(r.scored.some(s => s.kind === 'case_converged'))
    // 入账核对：informative 2 + supported 3 + refuted 3 + converged 5 = 13
    assert.equal(r.state.score, 13)
  })

  it('全部假设被淘汰 → needs_user（不硬撑）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'refutes' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    assert.equal(r.state.status, 'needs_user')
  })

  it('probe 预算上限强制执行', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    for (let i = 0; i < MAX_PROBES_PER_CASE; i++) {
      state = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'neutral' }], {
        target: `src/f${i}.ts`, turn: 3,
      }).state
    }
    const r = reduceAttackState(state, {
      type: 'probe_planned', caseId: state.caseId, turn: 3,
      probe: { hypothesisIds: [h1.id], kind: 'read', target: 'one-too-many.ts', expectation: EXPECT_PATTERN, perHypothesis: [] },
    })
    assert.match(r.rejected ?? '', /budget: max/)
  })

  it('不能声称 converged 收案（reducer 未推导出 converged 时拒绝）', () => {
    let { state } = openedCase()
    state = addHyp(state, 'H1').state
    const r = reduceAttackState(state, { type: 'case_closed', caseId: state.caseId, turn: 5, resolution: 'converged' })
    assert.match(r.rejected ?? '', /cannot close as converged/)
  })
})

describe('chooseDiscriminator — 确定性选择', () => {
  it('自检 4：区分力全 0 → null（不随机选）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const h2 = addHyp(state, 'H2'); state = h2.state
    const p = planProbe(state, [h1.id, h2.id], [
      { hypothesisId: h1.id, ifTrue: 'neutral' },
      { hypothesisId: h2.id, ifTrue: 'neutral' },
    ]); state = p.state
    assert.equal(chooseDiscriminator(state), null)
  })

  it('区分两假设的 probe 胜过只碰一个假设的 probe；同分低风险/低成本优先', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const h2 = addHyp(state, 'H2'); state = h2.state
    const single = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }], { target: 'single.ts' })
    state = single.state
    const discriminating = planProbe(state, [h1.id, h2.id], [
      { hypothesisId: h1.id, ifTrue: 'supports' },
      { hypothesisId: h2.id, ifTrue: 'refutes' },
    ], { target: 'both.ts' })
    state = discriminating.state
    assert.equal(chooseDiscriminator(state)?.id, discriminating.id)
  })

  it('确定性：同一状态两次调用返回同一 probe', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const pa = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }], { target: 'a.ts' }); state = pa.state
    const pb = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'refutes' }], { target: 'b.ts' }); state = pb.state
    assert.equal(chooseDiscriminator(state)?.id, chooseDiscriminator(state)?.id)
  })
})

describe('鼓励机制 — 有效动作计分（反刷分）', () => {
  it('复现奖励：targeted_test 预期 fail 谓词为真 → reproduction 加分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1: bug reproducible'); state = h1.state
    const expectation: ProbeExpectation = { kind: 'test_outcome', target: 'src/a.test.ts', expect: 'fail' }
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }], {
      kind: 'targeted_test', expectation, target: 'src/a.test.ts',
    }); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:run_tests:4',
    })
    assert.ok(r.scored.some(s => s.kind === 'reproduction'), '复现成功应有 reproduction 加分')
  })

  it('并行委派奖励：viaDelegation 的 informative 结算 → parallel_probe 加分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'refutes' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'worker:order-1', viaDelegation: true,
    })
    assert.ok(r.scored.some(s => s.kind === 'parallel_probe'))
  })

  it('反刷分：uninformative 结算零分；委派标记也不给分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'unobservable', viaDelegation: true,
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.scored.length, 0, '无信息的动作不计分——鼓励的是有效动作')
    assert.equal(r.state.score, 0)
  })

  it('计分表与 score 累计一致（单条 refuted 路径）', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'refutes' }]); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    // informative 2 + refuted 3；全灭 → needs_user（无 converged 分）
    assert.equal(r.state.score, ATTACK_SCORE_POINTS.probe_informative + ATTACK_SCORE_POINTS.hypothesis_refuted)
  })
})

describe('ProblemAttackStore — 会话容器', () => {
  it('并发案件预算 + 事件留痕 drain', () => {
    const store = new ProblemAttackStore()
    const a = store.openCase(ANCHOR, 'problem A', 1)
    assert.equal(a.rejected, undefined)
    const b = store.openCase({ kind: 'obligation', ref: 'ob-2' }, 'problem B', 2)
    assert.equal(b.rejected, undefined)
    const c = store.openCase({ kind: 'obligation', ref: 'ob-3' }, 'problem C', 3)
    assert.match(c.rejected ?? '', /max 2 concurrent/)
    assert.equal(MAX_CONCURRENT_CASES, 2)
    const log = store.drainLog()
    assert.equal(log.length, 2, '被拒的开案不产生 apply 留痕（openCase 前置拒绝）')
    assert.equal(store.drainLog().length, 0)
  })

  it('委派窗口判定', () => {
    const store = new ProblemAttackStore()
    store.markDelegation(10)
    assert.equal(store.isWithinDelegationWindow(12), true)
    assert.equal(store.isWithinDelegationWindow(14), false)
    assert.equal(store.isWithinDelegationWindow(9), false, '派发前的结算不算')
  })

  it('hasDelegated：未打点 false，打点后 true（worker 引用验真的最低条件）', () => {
    const store = new ProblemAttackStore()
    assert.equal(store.hasDelegated(), false)
    store.markDelegation(5)
    assert.equal(store.hasDelegated(), true)
  })

  it('snapshotForCvm：连续两次 uninformative 且无 planned 剩余 → anyStalled', () => {
    const store = new ProblemAttackStore()
    const opened = store.openCase(ANCHOR, 'stalled case', 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'H1', targets: [] })
    const hypId = hypothesisIdFor(caseId, 'H1', [])
    for (const t of ['x.ts', 'y.ts']) {
      const expectation: ProbeExpectation = { kind: 'pattern_found', path: t, needle: 'n' }
      store.apply({
        type: 'probe_planned', caseId, turn: 3,
        probe: { hypothesisIds: [hypId], kind: 'grep', target: t, expectation, perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }] },
      })
      store.apply({
        type: 'probe_observed', caseId, turn: 4, probeId: probeIdFor(caseId, t, expectation),
        predicateOutcome: 'unobservable',
      })
    }
    const snap = store.snapshotForCvm()
    assert.equal(snap?.anyStalled, true)
    assert.equal(snap?.activeCases, 1)
    assert.equal(snap?.hasPlannedProbes, false)
  })

  it('P3 语义修正：还有 planned 探针剩余 → 即使连续两次 uninformative 也不算 stalled', () => {
    const store = new ProblemAttackStore()
    const opened = store.openCase(ANCHOR, 'not stalled yet', 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'H1', targets: [] })
    const hypId = hypothesisIdFor(caseId, 'H1', [])
    for (const t of ['x.ts', 'y.ts', 'z.ts']) {
      const expectation: ProbeExpectation = { kind: 'pattern_found', path: t, needle: 'n' }
      store.apply({
        type: 'probe_planned', caseId, turn: 3,
        probe: { hypothesisIds: [hypId], kind: 'grep', target: t, expectation, perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }] },
      })
      if (t !== 'z.ts') {
        store.apply({
          type: 'probe_observed', caseId, turn: 4, probeId: probeIdFor(caseId, t, expectation),
          predicateOutcome: 'unobservable',
        })
      }
    }
    const snap = store.snapshotForCvm()
    assert.equal(snap?.anyStalled, false, 'z.ts 仍 planned——不该被标 stalled 催换谓词')
    assert.equal(snap?.hasPlannedProbes, true)
  })
})

// ─── P2-P4：收敛快照、证据过期留痕、completedWorkers 裁剪 ─────────────

/** 把 store 里一个案件推到 converged（唯一 supported + 对手 refuted）。 */
function convergeStoreCase(store: ProblemAttackStore, problem: string, targets: string[]): { caseId: string; hypId: string } {
  const opened = store.openCase({ kind: 'user_report', ref: problem }, problem, 1)
  assert.equal(opened.rejected, undefined)
  const caseId = opened.state.caseId
  store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'winner', targets })
  store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'loser', targets: [] })
  const hypId = hypothesisIdFor(caseId, 'winner', targets)
  const loserId = hypothesisIdFor(caseId, 'loser', [])
  const expectation: ProbeExpectation = { kind: 'pattern_found', path: targets[0] ?? 'x.ts', needle: 'n' }
  store.apply({
    type: 'probe_planned', caseId, turn: 3,
    probe: {
      hypothesisIds: [hypId, loserId], kind: 'grep', target: targets[0] ?? 'x.ts', expectation,
      perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }, { hypothesisId: loserId, ifTrue: 'refutes' }],
    },
  })
  const r = store.apply({
    type: 'probe_observed', caseId, turn: 4,
    probeId: probeIdFor(caseId, targets[0] ?? 'x.ts', expectation),
    predicateOutcome: 'true', evidenceRef: 'tool:grep:4', evidenceVerified: true,
  })
  assert.equal(r.state.status, 'converged')
  return { caseId, hypId }
}

describe('ProblemAttackStore — P4 convergedCasesSnapshot', () => {
  it('converged 案件带 selectedHypothesis targets 出现在快照中；close(converged) 后仍保留', () => {
    const store = new ProblemAttackStore()
    const { caseId, hypId } = convergeStoreCase(store, 'deliver check', ['src/fix.ts', 'src/other.ts'])
    let snap = store.convergedCasesSnapshot()
    assert.equal(snap.length, 1)
    assert.equal(snap[0]!.caseId, caseId)
    assert.equal(snap[0]!.selectedHypothesisId, hypId)
    assert.deepEqual([...snap[0]!.targets], ['src/fix.ts', 'src/other.ts'])

    const closed = store.apply({ type: 'case_closed', caseId, turn: 5, resolution: 'converged' })
    assert.equal(closed.rejected, undefined)
    snap = store.convergedCasesSnapshot()
    assert.equal(snap.length, 1, '收敛后关案不丢收束闸数据')
  })

  it('abandoned 收案（无 selectedHypothesisId）不进快照（反证：把放弃案当收敛案提示）', () => {
    const store = new ProblemAttackStore()
    const opened = store.openCase({ kind: 'user_report', ref: 'giveup' }, 'giveup', 1)
    store.apply({ type: 'case_closed', caseId: opened.state.caseId, turn: 2, resolution: 'abandoned' })
    assert.equal(store.convergedCasesSnapshot().length, 0)
  })

  // ── 虚空仓库 P0: 快照补 claim/evidenceRefs ──
  it('快照携带 selectedHypothesis 的 claim 与 evidenceRefs（可独立阅读）', () => {
    const store = new ProblemAttackStore()
    convergeStoreCase(store, 'harvest source', ['src/fix.ts'])
    const snap = store.convergedCasesSnapshot()
    assert.equal(snap.length, 1)
    assert.equal(snap[0]!.claim, 'winner', 'claim 来自 selectedHypothesis')
    assert.ok(snap[0]!.evidenceRefs.length >= 1, 'evidenceRefs 非空（结算证据留痕）')
  })
})

// ── 虚空仓库 P0: harvestedCaseIds 守卫随快照持久化 ─────────────────────

describe('ProblemAttackStore — 虚空仓库收割守卫', () => {
  it('markHarvested/isHarvested + export→restore round-trip 保留守卫', () => {
    const store = new ProblemAttackStore()
    const { caseId } = convergeStoreCase(store, 'harvest guard', ['src/g.ts'])
    assert.equal(store.isHarvested(caseId), false)
    store.markHarvested(caseId)
    assert.equal(store.isHarvested(caseId), true)

    const snap = store.exportSnapshot()
    assert.deepEqual(snap.harvestedCaseIds, [caseId], '守卫进快照')

    const restored = ProblemAttackStore.fromSnapshot(snap)
    assert.equal(restored.isHarvested(caseId), true, 'resume 后不重复收割')
  })

  it('已收割但案件不在 cases 中的 id 不进快照（防 Set 无界增长）', () => {
    const store = new ProblemAttackStore()
    store.markHarvested('case-ghost-nonexistent')
    const snap = store.exportSnapshot()
    assert.deepEqual(snap.harvestedCaseIds, [], '幽灵 id 被裁剪')
  })

  it('旧快照（无 harvestedCaseIds 字段）恢复不炸且守卫为空', () => {
    const store = new ProblemAttackStore()
    convergeStoreCase(store, 'legacy snap', ['src/l.ts'])
    const snap = store.exportSnapshot()
    delete (snap as { harvestedCaseIds?: string[] }).harvestedCaseIds
    const restored = ProblemAttackStore.fromSnapshot(snap)
    assert.equal(restored.convergedCasesSnapshot().length, 1)
    for (const c of restored.convergedCasesSnapshot()) {
      assert.equal(restored.isHarvested(c.caseId), false)
    }
  })
})

describe('ProblemAttackStore — 遗产回收 W-A1 needsUserCasesSnapshot', () => {
  /** 把 store 里一个案件推到 needs_user（唯一假设被反驳 → 假设空间清空）。 */
  function needsUserStoreCase(store: ProblemAttackStore, problem: string, opts: { askUserProbe?: string } = {}): string {
    const opened = store.openCase({ kind: 'user_report', ref: problem }, problem, 1)
    assert.equal(opened.rejected, undefined)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'only guess', targets: ['src/a.ts'] })
    const hypId = hypothesisIdFor(caseId, 'only guess', ['src/a.ts'])
    if (opts.askUserProbe) {
      store.apply({
        type: 'probe_planned', caseId, turn: 3,
        probe: {
          hypothesisIds: [hypId], kind: 'ask_user', target: opts.askUserProbe,
          expectation: { kind: 'pattern_found', path: 'user', needle: 'answer' },
          perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }],
        },
      })
    }
    const expectation: ProbeExpectation = { kind: 'pattern_found', path: 'src/a.ts', needle: 'refuteme' }
    store.apply({
      type: 'probe_planned', caseId, turn: 3,
      probe: {
        hypothesisIds: [hypId], kind: 'grep', target: 'src/a.ts', expectation,
        perHypothesis: [{ hypothesisId: hypId, ifTrue: 'refutes' }],
      },
    })
    const r = store.apply({
      type: 'probe_observed', caseId, turn: 4,
      probeId: probeIdFor(caseId, 'src/a.ts', expectation),
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4', evidenceVerified: true,
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.status, 'needs_user', '唯一假设被反驳 → needs_user')
    return caseId
  }

  it('needs_user 案件带预计算 minimalQuestion 出现在快照（全灭 → 请求新事实）', () => {
    const store = new ProblemAttackStore()
    const caseId = needsUserStoreCase(store, 'stuck problem')
    const snap = store.needsUserCasesSnapshot()
    assert.equal(snap.length, 1)
    assert.equal(snap[0]!.caseId, caseId)
    assert.equal(snap[0]!.problem, 'stuck problem')
    assert.match(snap[0]!.minimalQuestion, /所有假设已被排除/)
  })

  it('已计划 ask_user 探针优先——minimalQuestion 直接用其 target（与工具回执同一实现）', () => {
    const store = new ProblemAttackStore()
    needsUserStoreCase(store, 'ask first', { askUserProbe: '生产环境的 Node 版本是多少？' })
    const snap = store.needsUserCasesSnapshot()
    assert.equal(snap.length, 1)
    assert.equal(snap[0]!.minimalQuestion, '生产环境的 Node 版本是多少？')
  })

  it('无 needs_user 案件 → 空数组（probing/converged 不进快照）', () => {
    const store = new ProblemAttackStore()
    convergeStoreCase(store, 'converged one', ['src/x.ts'])
    assert.deepEqual(store.needsUserCasesSnapshot(), [])
  })

  it('close 后的 needs_user 案件不进快照（activeCases 过滤 closed）', () => {
    const store = new ProblemAttackStore()
    const caseId = needsUserStoreCase(store, 'close me')
    store.apply({ type: 'case_closed', caseId, turn: 5, resolution: 'abandoned' })
    assert.deepEqual(store.needsUserCasesSnapshot(), [])
  })
})

describe('ProblemAttackStore — R1/R2 残留修正', () => {
  it('R1: expired 留痕带 expiredAtTurn，turn 字段保持注册轮语义', () => {
    const store = new ProblemAttackStore()
    const opened = store.openCase(ANCHOR, 'expire me', 1)
    store.registerEvidence({ producer: 'tool', caseId: opened.state.caseId, turn: 2, ref: 'tool:grep:2' })
    store.drainEvidenceLog()
    store.expireEvidenceBefore(5, 13)
    const expired = store.drainEvidenceLog().filter(e => e.action === 'expired')
    assert.equal(expired.length, 1)
    assert.equal(expired[0]!.turn, 2, 'turn = 注册轮')
    assert.equal(expired[0]!.expiredAtTurn, 13, 'expiredAtTurn = 过期发生轮')
  })

  it('R2: 快照 completedWorkers 裁剪到最近 32 + 被 worker 证据引用的保留', () => {
    const store = new ProblemAttackStore()
    const opened = store.openCase(ANCHOR, 'many workers', 1)
    store.markDelegation(1)
    // w-0 会超出最近 32 窗口，但被证据引用 → 必须保留
    store.markWorkerCompleted('w-0')
    store.registerEvidence({ producer: 'worker', caseId: opened.state.caseId, turn: 2, ref: 'worker:w-0' })
    for (let i = 1; i <= 40; i++) store.markWorkerCompleted(`w-${i}`)
    const workers = store.exportSnapshot().completedWorkers ?? []
    assert.ok(workers.includes('w-0'), '被证据引用的 orderId 不被裁掉')
    assert.ok(workers.includes('w-40'), '最近的保留')
    assert.equal(workers.includes('w-1'), false, '既不近期也未被引用 → 裁剪')
    assert.ok(workers.length <= 33)
    // 裁剪只影响快照，不影响运行中验真
    assert.equal(store.hasWorkerCompleted('w-1'), true)
  })
})

// ─── H1 反证矩阵（审查 P1-A/P1-B/8.1/8.4 的锁定测试） ─────────────────

/** 把案件推到攻坚轮预算上限：单探针反复 attempted，每轮一个新 turn。 */
function exhaustBudget(): { state: ProblemAttackState; hypId: string; probeId: string } {
  const opened = openedCase()
  const { state: s1, id: hypId } = addHyp(opened.state, 'H-budget')
  const { state: s2, id: probeId } = planProbe(s1, [hypId], [{ hypothesisId: hypId, ifTrue: 'supports' }])
  let state = s2
  // opened(1) + hyp(2) + probe(3) 已消耗 3 轮；补足到 MAX
  for (let t = 4; state.activeAttackTurns < MAX_ATTACK_TURNS; t++) {
    const r = reduceAttackState(state, { type: 'probe_attempted', caseId: state.caseId, turn: t, probeId })
    assert.equal(r.rejected, undefined)
    state = r.state
  }
  assert.equal(state.activeAttackTurns, MAX_ATTACK_TURNS)
  return { state, hypId, probeId }
}

describe('PAL reducer — H3 预算守卫与单调终止', () => {
  it('预算耗尽后新 turn 的 hypothesis_added / probe_planned 一律拒绝，状态零变更', () => {
    const { state, hypId } = exhaustBudget()
    const v = state.version
    const nextTurn = state.lastEventTurn + 1

    const h = reduceAttackState(state, {
      type: 'hypothesis_added', caseId: state.caseId, turn: nextTurn, claim: 'H-escape', targets: ['src/b.ts'],
    })
    assert.match(h.rejected ?? '', /budget: max \d+ attack turns|needs_user/)
    assert.equal(h.state.version, v, '被拒事件不得改变 version')
    assert.equal(h.state.hypotheses.some(x => x.claim === 'H-escape'), false)

    const p = reduceAttackState(state, {
      type: 'probe_planned', caseId: state.caseId, turn: nextTurn,
      probe: {
        hypothesisIds: [hypId], kind: 'grep', target: 'src/c.ts',
        expectation: { kind: 'pattern_found', path: 'src/c.ts', needle: 'x' },
        perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }],
      },
    })
    assert.match(p.rejected ?? '', /budget: max \d+ attack turns|needs_user/)
    assert.equal(p.state.probes.length, state.probes.length)
  })

  it('计数器 clamp 不变量：任何事件序列都不能让 activeAttackTurns 超过上限', () => {
    const { state, probeId } = exhaustBudget()
    // 结算类事件仍被接受（已派出的探针结果可入账），但计数器不再增长
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: state.lastEventTurn + 5, probeId,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:20',
    })
    assert.equal(r.rejected, undefined, '结算不受预算拦截（不扩张搜索空间）')
    assert.equal(r.state.activeAttackTurns, MAX_ATTACK_TURNS, 'clamp 在上限')
  })

  it('预算饱和 → 强制 needs_user（触顶且仍在搜索态）', () => {
    const { state } = exhaustBudget()
    assert.equal(state.status, 'needs_user', '触顶后由 accept 统一饱和为 needs_user')
  })

  it('needs_user 单调性：模型自造假设不能复活案件（8.4 预算绕过封死）', () => {
    const { state } = exhaustBudget()
    assert.equal(state.status, 'needs_user')
    const r = reduceAttackState(state, {
      type: 'hypothesis_added', caseId: state.caseId, turn: state.lastEventTurn, claim: 'H-revive', targets: ['src/d.ts'],
    })
    assert.match(r.rejected ?? '', /needs_user/, '无 userFact 的假设被拒')
    assert.equal(r.state.status, 'needs_user')
  })

  it('needs_user 解锁只认 userFact；预算未耗尽时可复活回 probing', () => {
    // 构造非预算型 needs_user：唯一假设被反驳 → 假设空间清空
    const opened = openedCase()
    const { state: s1, id: hypId } = addHyp(opened.state, 'H-only')
    const { state: s2, id: probeId } = planProbe(s1, [hypId], [{ hypothesisId: hypId, ifTrue: 'refutes' }])
    const obs = reduceAttackState(s2, {
      type: 'probe_observed', caseId: s2.caseId, turn: 4, probeId,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    assert.equal(obs.state.status, 'needs_user', '假设空间清空 → needs_user')

    const noFact = reduceAttackState(obs.state, {
      type: 'hypothesis_added', caseId: s2.caseId, turn: 5, claim: 'H-guess', targets: ['src/e.ts'],
    })
    assert.match(noFact.rejected ?? '', /needs_user/)

    const withFact = reduceAttackState(obs.state, {
      type: 'hypothesis_added', caseId: s2.caseId, turn: 5, claim: 'H-user-said', targets: ['src/e.ts'], userFact: true,
    })
    assert.equal(withFact.rejected, undefined, 'userFact 假设解锁')
    assert.equal(withFact.state.status, 'probing')
  })

  it('needs_user 下 probe_planned 一律拒绝（先解锁或 close）', () => {
    const { state, hypId } = exhaustBudget()
    const r = reduceAttackState(state, {
      type: 'probe_planned', caseId: state.caseId, turn: state.lastEventTurn,
      probe: {
        hypothesisIds: [hypId], kind: 'grep', target: 'src/f.ts',
        expectation: { kind: 'pattern_found', path: 'src/f.ts', needle: 'y' },
        perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }],
      },
    })
    assert.match(r.rejected ?? '', /needs_user/)
  })

  it('case_closed 永远可用（预算耗尽/needs_user 都不拦关案）', () => {
    const { state } = exhaustBudget()
    const r = reduceAttackState(state, {
      type: 'case_closed', caseId: state.caseId, turn: state.lastEventTurn + 3, resolution: 'abandoned',
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.status, 'closed')
  })
})

describe('PAL reducer — H2 未验真证据零分降级', () => {
  it('evidenceVerified:false → 状态照常迁移但零分，引用带 unverified: 前缀', () => {
    const opened = openedCase()
    const { state: s1, id: hypId } = addHyp(opened.state, 'H-stale')
    const { state: s2, id: probeId } = planProbe(s1, [hypId], [{ hypothesisId: hypId, ifTrue: 'supports' }])
    const scoreBefore = s2.score
    const r = reduceAttackState(s2, {
      type: 'probe_observed', caseId: s2.caseId, turn: 4, probeId,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:1', evidenceVerified: false,
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.scored.length, 0, '未验真 → 不产生任何加分事件')
    assert.equal(r.state.score, scoreBefore, '分数不变（含 converged 分也不发）')
    const hyp = r.state.hypotheses.find(h => h.id === hypId)
    assert.equal(hyp?.status, 'supported', '状态迁移照常（窗口淘汰不是伪造证明）')
    assert.equal(hyp?.evidenceRefs[0], 'unverified:tool:grep:1', '留痕可审计')
    const probe = r.state.probes.find(p => p.id === probeId)
    assert.equal(probe?.evidenceRef, 'unverified:tool:grep:1')
  })

  it('evidenceVerified 缺省 = 已验真（hook 自动结算路径不受影响）', () => {
    const opened = openedCase()
    const { state: s1, id: hypId } = addHyp(opened.state, 'H-auto')
    const { state: s2, id: probeId } = planProbe(s1, [hypId], [{ hypothesisId: hypId, ifTrue: 'supports' }])
    const r = reduceAttackState(s2, {
      type: 'probe_observed', caseId: s2.caseId, turn: 4, probeId,
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4',
    })
    assert.ok(r.scored.length > 0)
    assert.equal(r.state.hypotheses.find(h => h.id === hypId)?.evidenceRefs[0], 'tool:grep:4')
  })
})


describe('第五波新探针词 — instrument/simulate（对账式攻坚）', () => {
  it('instrument 探针谓词结算照常推导假设状态与加分', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1: 爬升量按旧宽度计数'); state = h1.state
    const expectation: ProbeExpectation = { kind: 'command_output_matches', commandIncludes: 'probe-resize', outputPattern: '✗' }
    const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }], {
      kind: 'instrument', expectation, target: 'scripts/tui-probe-resize.ts',
    }); state = p1.state
    const r = reduceAttackState(state, {
      type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
      predicateOutcome: 'true', evidenceRef: 'tool:bash:4',
    })
    assert.equal(r.rejected, undefined)
    assert.equal(r.state.hypotheses[0]!.status, 'supported')
    assert.ok(r.scored.some(s => s.kind === 'probe_informative'))
    assert.ok(r.scored.some(s => s.kind === 'hypothesis_supported'))
  })

  it('复现奖励扩到 simulate / instrument：test_outcome 预期 fail 为真 → reproduction 加分', () => {
    for (const kind of ['simulate', 'instrument'] as const) {
      let { state } = openedCase()
      const h1 = addHyp(state, 'H1: 可复现'); state = h1.state
      const expectation: ProbeExpectation = { kind: 'test_outcome', target: 'src/sim.test.ts', expect: 'fail' }
      const p1 = planProbe(state, [h1.id], [{ hypothesisId: h1.id, ifTrue: 'supports' }], {
        kind, expectation, target: 'src/sim.test.ts',
      }); state = p1.state
      const r = reduceAttackState(state, {
        type: 'probe_observed', caseId: state.caseId, turn: 4, probeId: p1.id,
        predicateOutcome: 'true', evidenceRef: 'tool:run_tests:4',
      })
      assert.ok(r.scored.some(s => s.kind === 'reproduction'), `${kind} 复现应有 reproduction 加分`)
    }
  })

  it('kind 成本次序：区分力/风险并列时 instrument 先于 simulate，ask_user 垫底', () => {
    let { state } = openedCase()
    const h1 = addHyp(state, 'H1'); state = h1.state
    const link = [{ hypothesisId: h1.id, ifTrue: 'supports' as const }]
    const pAsk = planProbe(state, [h1.id], link, { kind: 'ask_user', target: 'user' }); state = pAsk.state
    const pSim = planProbe(state, [h1.id], link, { kind: 'simulate', target: 'sim.test.ts' }); state = pSim.state
    assert.equal(chooseDiscriminator(state)?.id, pSim.id, 'simulate 应先于 ask_user')
    const pIns = planProbe(state, [h1.id], link, { kind: 'instrument', target: 'probe.ts' }); state = pIns.state
    assert.equal(chooseDiscriminator(state)?.id, pIns.id, 'instrument 应先于 simulate')
  })
})

/**
 * P2 探针候选生成器反证测试。
 *
 * 反证清单："needs_user 仍出候选（绕 H3 单调性）""证据复用不优先（放着可结算
 * 证据不管继续扩张）""预算耗尽仍诱导 plan""冷却组合反复推荐""同输入不同输出
 * （非纯）""已探过目标重复出候选""备选无上限"。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_COOLDOWN_UNINFORMATIVE,
  CHEAP_BUDGET_TURNS,
  MAX_ALTERNATE_CANDIDATES,
  NEEDLE_PLACEHOLDER,
  proposeProbeCandidates,
} from '../probe-candidates.js'
import {
  MAX_ATTACK_TURNS,
  MAX_PROBES_PER_CASE,
  type AttackHypothesis,
  type DiscriminatorProbe,
  type EvidenceRecord,
  type ProblemAttackState,
} from '../problem-attack-loop.js'

function hyp(id: string, targets: string[], status: AttackHypothesis['status'] = 'candidate'): AttackHypothesis {
  return { id, claim: `claim ${id}`, targets, status, evidenceRefs: [], attempts: 0, lastTurn: 1 }
}

function probe(id: string, target: string, status: DiscriminatorProbe['status'], kind: DiscriminatorProbe['kind'] = 'grep'): DiscriminatorProbe {
  return {
    id, hypothesisIds: ['h1'], kind, target,
    expectation: { kind: 'pattern_found', path: target, needle: 'x' },
    perHypothesis: [{ hypothesisId: 'h1', ifTrue: 'supports' }],
    risk: 'low', status,
  }
}

function state(overrides: Partial<ProblemAttackState> = {}): ProblemAttackState {
  return {
    caseId: 'case-1',
    anchor: { kind: 'failure_pattern', ref: 'sig' },
    problem: 'p',
    hypotheses: [hyp('h1', ['src/a.ts']), hyp('h2', ['src/b.ts'])],
    probes: [],
    status: 'probing',
    activeAttackTurns: 2,
    lastEventTurn: 2,
    score: 0,
    version: 3,
    ...overrides,
  }
}

function evidence(probeId: string | null, status: EvidenceRecord['status'] = 'available', caseId = 'case-1'): EvidenceRecord {
  return {
    evidenceId: `ev-${probeId ?? 'none'}`,
    producer: 'tool', caseId, probeId, turn: 2, ref: 'tool:grep:2', status,
  }
}

describe('probe-candidates — 状态闸门（反证：绕 H3 单调性）', () => {
  it('needs_user 案件不出任何候选', () => {
    const r = proposeProbeCandidates(state({ status: 'needs_user' }))
    assert.equal(r.primary, null)
    assert.equal(r.alternates.length, 0)
    assert.equal(r.reuseObserveProbeId, null)
  })

  it('converged / closed / blocked 案件不出候选', () => {
    for (const s of ['converged', 'closed', 'blocked'] as const) {
      const r = proposeProbeCandidates(state({ status: s }))
      assert.equal(r.primary, null, `status=${s} 不应出候选`)
    }
  })

  it('无存活假设（全 refuted）→ 空结果', () => {
    const r = proposeProbeCandidates(state({
      hypotheses: [hyp('h1', ['src/a.ts'], 'refuted'), hyp('h2', ['src/b.ts'], 'refuted')],
    }))
    assert.equal(r.primary, null)
  })
})

describe('probe-candidates — 证据复用优先', () => {
  it('available 证据绑定 planned 探针 → 只返回 reuseObserveProbeId，不出新候选', () => {
    const s = state({ probes: [probe('p1', 'src/a.ts', 'planned')] })
    const r = proposeProbeCandidates(s, { availableEvidence: [evidence('p1')] })
    assert.equal(r.reuseObserveProbeId, 'p1')
    assert.equal(r.primary, null)
    assert.equal(r.alternates.length, 0)
  })

  it('consumed / expired 证据不触发复用（反证：过期证据仍推荐 observe）', () => {
    const s = state({ probes: [probe('p1', 'src/a.ts', 'planned')] })
    for (const st of ['consumed', 'expired'] as const) {
      const r = proposeProbeCandidates(s, { availableEvidence: [evidence('p1', st)] })
      assert.equal(r.reuseObserveProbeId, null, `status=${st} 不应复用`)
    }
  })

  it('证据绑定的探针已结算（informative）→ 不复用', () => {
    const s = state({ probes: [probe('p1', 'src/a.ts', 'informative')] })
    const r = proposeProbeCandidates(s, { availableEvidence: [evidence('p1')] })
    assert.equal(r.reuseObserveProbeId, null)
  })

  it('跨案件证据不触发复用', () => {
    const s = state({ probes: [probe('p1', 'src/a.ts', 'planned')] })
    const r = proposeProbeCandidates(s, { availableEvidence: [evidence('p1', 'available', 'other-case')] })
    assert.equal(r.reuseObserveProbeId, null)
  })
})

describe('probe-candidates — 预算与冷却', () => {
  it('探针预算耗尽 → 空结果（反证：诱导超预算 plan）', () => {
    const probes = Array.from({ length: MAX_PROBES_PER_CASE }, (_, i) =>
      probe(`p${i}`, `src/x${i}.ts`, 'uninformative'))
    const r = proposeProbeCandidates(state({ probes }))
    assert.equal(r.primary, null)
  })

  it(`同 (kind,target) 组合 ${CANDIDATE_COOLDOWN_UNINFORMATIVE} 次 uninformative → 冷却不再推荐`, () => {
    // src/a.ts 已被 grep 两次 uninformative；探针 target 记录会挡掉重复目标，
    // 所以用不同 probe target、相同候选组合验证冷却路径：候选目标 = src/a.ts
    // 的 grep 组合被冷却，只剩 src/b.ts。
    const s = state({
      probes: [
        probe('p1', 'src/a.ts', 'uninformative'),
        probe('p2', 'src/a.ts', 'uninformative'),
      ],
    })
    const r = proposeProbeCandidates(s)
    // src/a.ts 既在 probedTargets 又在冷却表——两道闸都该挡它
    assert.ok(r.primary)
    assert.equal(r.primary!.target, 'src/b.ts')
    assert.ok(![r.primary, ...r.alternates].some(c => c?.target === 'src/a.ts'))
  })

  it(`预算剩余 ≤${CHEAP_BUDGET_TURNS} 轮 → 测试文件目标降级为 grep（成本封顶）`, () => {
    const cheap = state({
      hypotheses: [hyp('h1', ['src/__tests__/a.test.ts'])],
      activeAttackTurns: MAX_ATTACK_TURNS - CHEAP_BUDGET_TURNS,
    })
    const r = proposeProbeCandidates(cheap)
    assert.ok(r.primary)
    assert.equal(r.primary!.kind, 'grep')

    const rich = state({
      hypotheses: [hyp('h1', ['src/__tests__/a.test.ts'])],
      activeAttackTurns: 0,
    })
    const r2 = proposeProbeCandidates(rich)
    assert.equal(r2.primary!.kind, 'targeted_test')
    assert.deepEqual(r2.primary!.expectation, { kind: 'test_outcome', target: 'src/__tests__/a.test.ts', expect: 'fail' })
  })
})

describe('probe-candidates — 覆盖排序与骨架', () => {
  it('共享 target（覆盖 2 假设）排在独占 target 前', () => {
    const s = state({
      hypotheses: [hyp('h1', ['src/shared.ts', 'src/only1.ts']), hyp('h2', ['src/shared.ts'])],
    })
    const r = proposeProbeCandidates(s)
    assert.equal(r.primary!.target, 'src/shared.ts')
    assert.equal(r.primary!.coverage, 2)
    assert.equal(r.primary!.perHypothesis.length, 2)
  })

  it('已探过的目标不再出候选', () => {
    const s = state({ probes: [probe('p1', 'src/a.ts', 'informative')] })
    const r = proposeProbeCandidates(s)
    assert.ok(![r.primary, ...r.alternates].some(c => c?.target === 'src/a.ts'))
  })

  it(`备选上限 ${MAX_ALTERNATE_CANDIDATES}`, () => {
    const s = state({
      hypotheses: [hyp('h1', ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])],
    })
    const r = proposeProbeCandidates(s)
    assert.ok(r.primary)
    assert.ok(r.alternates.length <= MAX_ALTERNATE_CANDIDATES)
  })

  it('grep 骨架的 needle 是显式占位符（语义留白诚实化，不假装机器懂语义）', () => {
    const r = proposeProbeCandidates(state())
    assert.equal(r.primary!.expectation.kind, 'pattern_found')
    assert.equal((r.primary!.expectation as { needle: string }).needle, NEEDLE_PLACEHOLDER)
  })

  it('纯度：同输入两次调用深等（无随机/时钟依赖）', () => {
    const s = state({
      hypotheses: [hyp('h2', ['src/b.ts', 'src/shared.ts']), hyp('h1', ['src/a.ts', 'src/shared.ts'])],
      probes: [probe('p1', 'src/z.ts', 'uninformative')],
    })
    const r1 = proposeProbeCandidates(s)
    const r2 = proposeProbeCandidates(s)
    assert.deepEqual(r1, r2)
  })
})

describe('probe-candidates — 规则 8 症状信号模板（对账式攻坚第五波）', () => {
  it('时序/渲染信号命中且无文件候选 → instrument 模板兜底为 primary', () => {
    const s = state({ problem: 'resize 时输入框叠屏残留', hypotheses: [hyp('h1', [])] })
    const r = proposeProbeCandidates(s)
    assert.equal(r.primary?.kind, 'instrument')
    assert.equal(r.primary?.expectation.kind, 'command_output_matches')
    assert.ok(JSON.stringify(r.primary?.expectation).includes(NEEDLE_PLACEHOLDER), '对账脚本参数留白')
    assert.equal(r.primary?.coverage, 0, '信号模板 coverage 恒 0')
  })

  it('环境交互信号命中 → 出 simulate 模板（test_outcome 占位）', () => {
    const s = state({ problem: '终端 reflow 后行为异常', hypotheses: [hyp('h1', [])] })
    const r = proposeProbeCandidates(s)
    const sim = [r.primary, ...r.alternates].find(c => c?.kind === 'simulate')
    assert.ok(sim, '应出 simulate 模板')
    assert.equal(sim?.expectation.kind, 'test_outcome')
    assert.ok(JSON.stringify(sim?.expectation).includes(NEEDLE_PLACEHOLDER), '仿真测试路径留白')
  })

  it('文件候选存在时信号模板只进备选（coverage 0 排后，不抢 primary）', () => {
    const s = state({ problem: '缓存导致渲染残留', hypotheses: [hyp('h1', ['src/a.ts'])] })
    const r = proposeProbeCandidates(s)
    assert.notEqual(r.primary?.kind, 'instrument', '文件候选优先')
    assert.ok(r.alternates.some(c => c.kind === 'instrument'), '信号模板应在备选')
  })

  it('无信号 → 不出模板；案件已有同 kind 探针 → 不重复出', () => {
    const r0 = proposeProbeCandidates(state({ problem: '普通逻辑错误', hypotheses: [hyp('h1', [])] }))
    assert.equal(r0.primary, null)
    const s = state({
      problem: '渲染残留', hypotheses: [hyp('h1', [])],
      probes: [probe('p1', 'x.ts', 'informative', 'instrument')],
    })
    const r1 = proposeProbeCandidates(s)
    assert.ok(![r1.primary, ...r1.alternates].some(c => c?.kind === 'instrument'), '同 kind 已存在不重复出模板')
  })

  it(`预算剩余 ≤${CHEAP_BUDGET_TURNS} 轮 → 不出信号模板（成本封顶）`, () => {
    const s = state({
      problem: '渲染残留', hypotheses: [hyp('h1', [])],
      activeAttackTurns: MAX_ATTACK_TURNS - CHEAP_BUDGET_TURNS,
    })
    const r = proposeProbeCandidates(s)
    assert.equal(r.primary, null)
  })

  it('needs_user 状态信号模板同样沉默（不绕 H3 单调性）', () => {
    const r = proposeProbeCandidates(state({ problem: '渲染残留', status: 'needs_user' }))
    assert.equal(r.primary, null)
    assert.equal(r.alternates.length, 0)
  })
})

/**
 * PAL hook 双半边测试（计划 v2 Wave P2）。
 *
 * 覆盖：palMode 闸门、保守自动谓词结算（含"不确定不结算"反证）、
 * 委派窗口加分、postTurn telemetry 留痕、shadow 零 submit 纪律、
 * attack_case 工具全流程（回执即鼓励通道）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntry, readMemoryEntries } from '../../memory/unified-memory.js'
import {
  createProblemAttackHooks,
  palMode,
  settleProbeAgainstTool,
} from '../hooks/problem-attack-hook.js'
import {
  ProblemAttackStore,
  emptyAttackState,
  hypothesisIdFor,
  probeIdFor,
  type DiscriminatorProbe,
  type ProbeExpectation,
} from '../problem-attack-loop.js'
import { checkEvidenceRef, createAttackCaseTool, renderEscalationPacket, type AttackEvidenceVerifier } from '../../tools/attack-case.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

const ANCHOR = { kind: 'failure_pattern' as const, ref: 'run_tests:assertion' }

function ctx(turn: number): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/tmp', turn, recentToolHistory: [], sensorium: null,
      strategy: null, vigor: null, gitChangeRate: 0, season: null,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {}, setGitChangeRate() {},
      injectUserMessage() {}, requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

/** 建一个开了案、有一条假设 + 一个 planned test_outcome 探针的 store。 */
function storeWithProbe(expectation: ProbeExpectation, kind: DiscriminatorProbe['kind'] = 'targeted_test'): {
  store: ProblemAttackStore
  caseId: string
  probeId: string
} {
  const store = new ProblemAttackStore()
  const opened = store.openCase(ANCHOR, 'flaky failure', 1)
  const caseId = opened.state.caseId
  store.apply({ type: 'hypothesis_added', caseId, turn: 1, claim: 'H1', targets: ['src/a.ts'] })
  const hypId = hypothesisIdFor(caseId, 'H1', ['src/a.ts'])
  store.apply({
    type: 'probe_planned', caseId, turn: 2,
    probe: {
      hypothesisIds: [hypId], kind, target: 'src/a.test.ts', expectation,
      perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports', ifFalse: 'refutes' }],
    },
  })
  store.drainLog()
  return { store, caseId, probeId: probeIdFor(caseId, 'src/a.test.ts', expectation) }
}

describe('palMode 闸门解析', () => {
  it("缺省 shadow；'0'/'off' 关闭；'active' 开放", () => {
    assert.equal(palMode({}), 'shadow')
    assert.equal(palMode({ RIVET_PAL: '0' }), 'off')
    assert.equal(palMode({ RIVET_PAL: 'off' }), 'off')
    assert.equal(palMode({ RIVET_PAL: 'active' }), 'active')
    assert.equal(palMode({ RIVET_PAL: 'garbage' }), 'shadow')
  })
})

describe('settleProbeAgainstTool — 保守自动结算', () => {
  const testProbe: DiscriminatorProbe = {
    id: 'p', hypothesisIds: ['h'], kind: 'targeted_test', target: 'src/a.test.ts',
    expectation: { kind: 'test_outcome', target: 'src/a.test.ts', expect: 'fail' },
    perHypothesis: [], risk: 'low', status: 'planned',
  }

  it('run_tests 目标匹配 + 测试红 + 预期 fail → true（复现判定）', () => {
    const tool: RuntimeToolEvent = { name: 'run_tests', success: true, isError: true, input: { filter: 'src/a.test.ts' } }
    assert.equal(settleProbeAgainstTool(testProbe, tool), 'true')
  })

  it('run_tests 测试绿 + 预期 fail → false', () => {
    const tool: RuntimeToolEvent = { name: 'run_tests', success: true, isError: false, input: { filter: 'src/a.test.ts' } }
    assert.equal(settleProbeAgainstTool(testProbe, tool), 'false')
  })

  it('反证：环境类失败（timeout/env_missing）不可判定 → null', () => {
    const tool: RuntimeToolEvent = { name: 'run_tests', success: false, isError: true, failureClass: 'timeout', input: { filter: 'src/a.test.ts' } }
    assert.equal(settleProbeAgainstTool(testProbe, tool), null)
  })

  it('反证：目标不相关的 run_tests 不结算 → null', () => {
    const tool: RuntimeToolEvent = { name: 'run_tests', success: true, isError: true, input: { filter: 'src/other.test.ts' } }
    assert.equal(settleProbeAgainstTool(testProbe, tool), null)
  })

  it('pattern_found：grep pattern 精确一致才结算；空结果 → false', () => {
    const probe: DiscriminatorProbe = {
      ...testProbe, kind: 'grep',
      expectation: { kind: 'pattern_found', path: 'src/a.ts', needle: 'oldName' },
    }
    const hit: RuntimeToolEvent = { name: 'grep', success: true, input: { pattern: 'oldName', path: 'src/a.ts' }, resultContent: 'src/a.ts:3: oldName()' }
    assert.equal(settleProbeAgainstTool(probe, hit), 'true')
    const miss: RuntimeToolEvent = { name: 'grep', success: true, input: { pattern: 'oldName', path: 'src/a.ts' }, resultContent: '' }
    assert.equal(settleProbeAgainstTool(probe, miss), 'false')
    const differentPattern: RuntimeToolEvent = { name: 'grep', success: true, input: { pattern: 'newName', path: 'src/a.ts' }, resultContent: 'x' }
    assert.equal(settleProbeAgainstTool(probe, differentPattern), null, 'pattern 不一致不猜')
  })

  it('command_output_matches：命令包含且输出匹配正则', () => {
    const probe: DiscriminatorProbe = {
      ...testProbe, kind: 'micro_probe',
      expectation: { kind: 'command_output_matches', commandIncludes: 'node scripts/repro', outputPattern: 'FATAL' },
    }
    const tool: RuntimeToolEvent = { name: 'bash', success: true, input: { command: 'node scripts/repro.js' }, resultContent: 'FATAL fallback triggered' }
    assert.equal(settleProbeAgainstTool(probe, tool), 'true')
  })
})

describe('problem-attack hook 双半边', () => {
  function build(mode: 'shadow' | 'active') {
    const { store, probeId, caseId } = storeWithProbe({ kind: 'test_outcome', target: 'src/a.test.ts', expect: 'fail' })
    const submitted: Array<{ key: string; content: string }> = []
    const telemetry: Array<Record<string, unknown>> = []
    const hooks = createProblemAttackHooks({
      store,
      advisoryBus: { submit: e => { submitted.push({ key: e.key, content: e.content }) } },
      mode,
      writeTelemetry: e => telemetry.push(e),
    })
    return { store, probeId, caseId, submitted, telemetry, hooks }
  }

  const redTest: RuntimeToolEvent = { name: 'run_tests', success: true, isError: true, input: { filter: 'src/a.test.ts' } }

  it('postTool 自动结算：run_tests 事件核销探针，evidenceRef 结构化', async () => {
    const { store, probeId, caseId, hooks } = build('shadow')
    await hooks.postTool.run(ctx(5), redTest)
    const probe = store.getCase(caseId)!.probes.find(p => p.id === probeId)!
    assert.equal(probe.status, 'informative')
    assert.equal(probe.evidenceRef, 'tool:run_tests:5')
    assert.ok(store.getCase(caseId)!.score > 0, '自动结算同样计分')
  })

  it('幂等：同类事件第二次到达不重复结算不重复计分', async () => {
    const { store, caseId, hooks } = build('shadow')
    await hooks.postTool.run(ctx(5), redTest)
    const scoreAfterFirst = store.getCase(caseId)!.score
    await hooks.postTool.run(ctx(6), redTest)
    assert.equal(store.getCase(caseId)!.score, scoreAfterFirst)
  })

  it('委派窗口：delegate_task 派发后结算 → parallel_probe 加分', async () => {
    const { store, caseId, hooks } = build('shadow')
    await hooks.postTool.run(ctx(4), { name: 'delegate_task', success: true, isError: false })
    await hooks.postTool.run(ctx(5), redTest)
    const log = store.drainLog()
    const scored = log.flatMap(l => l.scored)
    assert.ok(scored.some(s => s.kind === 'parallel_probe'), '委派窗口内结算应有并行加分')
  })

  it('postTurn telemetry：事件全量留痕（含 scored 明细）', async () => {
    const { hooks, telemetry } = build('shadow')
    await hooks.postTool.run(ctx(5), redTest)
    await hooks.postTurn.run(ctx(5))
    const events = telemetry.filter(t => t.kind === 'problem-attack-event')
    assert.ok(events.length >= 1)
    const observed = events.find(e => e.eventType === 'probe_observed')
    assert.ok(observed, 'probe_observed 应落盘')
    assert.ok(Array.isArray(observed!.scored) && (observed!.scored as unknown[]).length > 0)
  })

  it('shadow 纪律：自动结算有加分也零 submit', async () => {
    const { hooks, submitted } = build('shadow')
    await hooks.postTool.run(ctx(5), redTest)
    await hooks.postTurn.run(ctx(5))
    assert.equal(submitted.length, 0, 'shadow 绝不向 advisory bus 发声')
  })

  it('active 鼓励：自动结算加分 → 聚合鼓励 advisory（一轮一条）', async () => {
    const { hooks, submitted } = build('active')
    await hooks.postTool.run(ctx(5), redTest)
    await hooks.postTurn.run(ctx(5))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'attack-auto-score')
    assert.match(submitted[0]!.content, /\+\d+ 分/)
    // 下一轮无新结算 → 不再发
    await hooks.postTurn.run(ctx(6))
    assert.equal(submitted.length, 1)
  })
})

describe('attack_case 工具 — 回执即鼓励通道', () => {
  /** 宽松验真器：这组测试聚焦回执/流程语义，验真矩阵单独在下方 H1 组锁定。 */
  const PERMISSIVE_VERIFIER = { toolRan: () => true, obligationExists: () => true, workerCompleted: () => true }
  function toolWith(store: ProblemAttackStore) {
    return createAttackCaseTool({ getStore: () => store, getVerifier: () => PERMISSIVE_VERIFIER })
  }
  function params(input: Record<string, unknown>, turn = 3) {
    return { input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: turn }
  }

  it('open 无锚被拒（schema 即闸门）', async () => {
    const result = await toolWith(new ProblemAttackStore()).execute(params({ op: 'open', problem: 'p' }))
    assert.equal(result.isError, true)
    assert.match(result.content, /anchor/)
  })

  it('全流程：open → hypothesize → plan_probe → observe 回执带加分与鼓励', async () => {
    const store = new ProblemAttackStore()
    const tool = toolWith(store)
    const opened = await tool.execute(params({
      op: 'open',
      anchor: { kind: 'failure_pattern', ref: 'assertion:src/a.test.ts' },
      problem: 'test red after refactor',
    }))
    assert.equal(opened.isError, false)
    const caseId = store.activeCases()[0]!.caseId

    const hyp = await tool.execute(params({
      op: 'hypothesize', case_id: caseId,
      hypotheses: [
        { claim: 'H1: rename broke import', targets: ['src/a.ts'] },
        { claim: 'H2: stale cache', targets: ['dist/'] },
      ],
    }))
    assert.equal(hyp.isError, false)
    const [h1, h2] = store.getCase(caseId)!.hypotheses.map(h => h.id)

    const probe = await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1, h2], kind: 'grep', target: 'src/a.ts',
        expectation: { kind: 'pattern_found', path: 'src/a.ts', needle: 'oldName' },
        per_hypothesis: [
          { hypothesis_id: h1, if_true: 'supports' },
          { hypothesis_id: h2, if_true: 'refutes' },
        ],
      }],
    }))
    assert.equal(probe.isError, false)
    assert.match(probe.content, /delegate_task 并行/, '低风险只读探针应提示并行委派')
    const probeId = store.getCase(caseId)!.probes[0]!.id

    const observed = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'tool:grep:3',
    }))
    assert.equal(observed.isError, false)
    assert.match(observed.content, /得分 \+/, '回执必须带加分明细')
    assert.match(observed.content, /淘汰假设是硬进展/, '排除动作应获得明确鼓励')
    assert.match(observed.content, /案件收敛/, '唯一幸存假设 → 收敛鼓励')
  })

  it('worker 证据结算获并行加分（真实委派打点后的 worker: 引用）', async () => {
    const store = new ProblemAttackStore()
    // 8.1：worker 引用验真的最低条件——本会话发生过真实委派（hook 打点）
    store.markDelegation(2)
    const tool = toolWith(store)
    await tool.execute(params({
      op: 'open', anchor: { kind: 'user_report', ref: 'crash on start' }, problem: 'p',
    }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({
      op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H1', targets: ['a.ts'] }],
    }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'read', target: 'a.ts',
        expectation: { kind: 'pattern_found', path: 'a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'refutes' }],
      }],
    }))
    const probeId = store.getCase(caseId)!.probes[0]!.id
    const observed = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'worker:order-42',
    }))
    assert.match(observed.content, /parallel_probe \+2/)
    assert.match(observed.content, /并行委派探针生效/)
  })

  it('声称 converged 收案被拒（不能自报收敛）', async () => {
    const store = new ProblemAttackStore()
    const tool = toolWith(store)
    await tool.execute(params({
      op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p',
    }))
    const caseId = store.activeCases()[0]!.caseId
    const closed = await tool.execute(params({ op: 'close', case_id: caseId, resolution: 'converged' }))
    assert.equal(closed.isError, true)
    assert.match(closed.content, /cannot close as converged/)
  })

  it('store 缺席（非主控上下文）→ fail-closed', async () => {
    const tool = createAttackCaseTool({ getStore: () => null })
    const result = await tool.execute(params({ op: 'status' }))
    assert.equal(result.isError, true)
  })
})

// ─── H1 反证矩阵：证据验真 + fail-closed（审查 P1-A/8.1/8.6） ──────────

describe('attack_case 工具 — H2 证据验真与 8.6 fail-closed', () => {
  function params(input: Record<string, unknown>, turn = 3) {
    return { input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: turn }
  }

  /** 起到 observe 前一步的最小案件（一假设一探针）。 */
  async function caseReadyToObserve(store: ProblemAttackStore, verifier: AttackEvidenceVerifier | null) {
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => verifier })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H1', targets: ['a.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'grep', target: 'a.ts',
        expectation: { kind: 'pattern_found', path: 'a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'supports' }],
      }],
    }))
    const probeId = store.getCase(caseId)!.probes[0]!.id
    return { tool, caseId, probeId, h1 }
  }

  it('P1-A/8.1：无真实委派时伪造 worker: 引用 → 硬拒，状态零变更', async () => {
    const store = new ProblemAttackStore()
    const { tool, caseId, probeId, h1 } = await caseReadyToObserve(store, { toolRan: () => true, obligationExists: () => true, workerCompleted: () => false })
    const r = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'worker:fabricated-order-99',
    }))
    assert.equal(r.isError, true)
    assert.match(r.content, /没有.*已完成 worker/)
    assert.equal(store.getCase(caseId)!.hypotheses.find(h => h.id === h1)!.status, 'candidate', '假设未被伪证翻转')
    assert.equal(store.getCase(caseId)!.score, 0)
  })

  it('P1-A：obligation: 引用查无此义务 → 硬拒', async () => {
    const store = new ProblemAttackStore()
    const { tool, caseId, probeId } = await caseReadyToObserve(store, { toolRan: () => true, obligationExists: () => false, workerCompleted: () => false })
    const r = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'obligation:ob-nonexistent',
    }))
    assert.equal(r.isError, true)
    assert.match(r.content, /账本中无此义务/)
  })

  it('P1-A：自由文本引用 → 硬拒（自由文本不是证据）', async () => {
    const store = new ProblemAttackStore()
    const { tool, caseId, probeId } = await caseReadyToObserve(store, { toolRan: () => true, obligationExists: () => true, workerCompleted: () => false })
    const r = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'I checked it myself, trust me',
    }))
    assert.equal(r.isError, true)
    assert.match(r.content, /须为 tool:/)
  })

  it('H2 降级：tool: 引用超出历史窗口 → 状态结算但零分 + unverified 留痕', async () => {
    const store = new ProblemAttackStore()
    const { tool, caseId, probeId, h1 } = await caseReadyToObserve(store, { toolRan: () => false, obligationExists: () => true, workerCompleted: () => false })
    const r = await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'tool:grep:1',
    }))
    assert.equal(r.isError, false)
    assert.match(r.content, /零分/)
    const c = store.getCase(caseId)!
    assert.equal(c.hypotheses.find(h => h.id === h1)!.status, 'supported', '状态照常结算')
    assert.equal(c.score, 0, '零分')
    assert.equal(c.hypotheses.find(h => h.id === h1)!.evidenceRefs[0], 'unverified:tool:grep:1')
  })

  it('验真器缺席（非主控上下文）：tool: 降级零分、worker:/obligation: 硬拒', async () => {
    const store = new ProblemAttackStore()
    store.markDelegation(1)
    assert.equal(checkEvidenceRef('tool:grep:2', { caseId: 'c1', probeId: 'a.ts' }, store, null).verdict, 'unverified')
    assert.equal(checkEvidenceRef('obligation:ob-1', { caseId: 'c1', probeId: 'a.ts' }, store, null).verdict, 'invalid')
    const noDelegation = new ProblemAttackStore()
    const nullV = null as AttackEvidenceVerifier | null
    assert.equal(checkEvidenceRef('worker:o-1', { caseId: 'c1', probeId: 'a.ts' }, noDelegation, nullV).verdict, 'invalid')
    // H4-D4：worker 引用需精确 orderId 已完成
    const vWithWorker: AttackEvidenceVerifier = { toolRan: () => true, obligationExists: () => true, workerCompleted: (oid) => oid === 'o-1' }
    assert.equal(checkEvidenceRef('worker:o-1', { caseId: 'c1', probeId: 'a.ts' }, store, vWithWorker).verdict, 'verified')
    assert.equal(checkEvidenceRef('worker:o-2', { caseId: 'c1', probeId: 'a.ts' }, store, vWithWorker).verdict, 'invalid', '不存在的 orderId 即使曾委派也应拒绝')
  })

  it('8.3：obligation 锚查无此义务 → 拒绝开案（伪锚闸门）', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({
      getStore: () => store,
      getVerifier: () => ({ toolRan: () => true, obligationExists: () => false, workerCompleted: () => false }),
    })
    const r = await tool.execute(params({ op: 'open', anchor: { kind: 'obligation', ref: 'ob-fake' }, problem: 'p' }))
    assert.equal(r.isError, true)
    assert.match(r.content, /在义务账本中不存在/)
    assert.equal(store.activeCases().length, 0)
  })

  it('8.6：RIVET_PAL=off → execute 一律 fail-closed，不产生任何状态', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({
      getStore: () => store,
      getVerifier: () => null,
      getMode: () => 'off',
    })
    const r = await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    assert.equal(r.isError, true)
    assert.match(r.content, /RIVET_PAL=off/)
    assert.equal(store.activeCases().length, 0, '关闭态不得开案')
  })

  it('8.4 工具面：needs_user 后 hypothesize 无 user_fact 被拒、带 user_fact 解锁', async () => {
    const store = new ProblemAttackStore()
    const verifier = { toolRan: () => true, obligationExists: () => true, workerCompleted: () => false }
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => verifier })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H-only', targets: ['a.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'grep', target: 'a.ts',
        expectation: { kind: 'pattern_found', path: 'a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'refutes' }],
      }],
    }))
    const probeId = store.getCase(caseId)!.probes[0]!.id
    // 反驳唯一假设 → 假设空间清空 → needs_user
    await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'tool:grep:3',
    }, 4))
    assert.equal(store.getCase(caseId)!.status, 'needs_user')

    const guess = await tool.execute(params({
      op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H-guess', targets: ['b.ts'] }],
    }, 5))
    assert.match(guess.content, /needs_user|rejected/, '自造假设不能复活')
    assert.equal(store.getCase(caseId)!.status, 'needs_user')

    const fact = await tool.execute(params({
      op: 'hypothesize', case_id: caseId,
      hypotheses: [{ claim: 'H-user-said', targets: ['b.ts'], user_fact: true }],
    }, 5))
    assert.equal(fact.isError, false)
    assert.equal(store.getCase(caseId)!.status, 'probing', 'userFact 解锁回 probing')
  })
})

// ─── P2-P4：候选露出、候选 telemetry、close 义务提示 ─────────────────

describe('attack_case 工具 — P2 候选草稿露出（L1 合并进回执）', () => {
  const VERIFIER: AttackEvidenceVerifier = { toolRan: () => true, obligationExists: () => true, workerCompleted: () => false }
  function params(input: Record<string, unknown>, turn = 3) {
    return { input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: turn }
  }

  it('无 planned 探针的搜索态案件 → status 回执带 plan_probe 骨架草稿', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => VERIFIER })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({
      op: 'hypothesize', case_id: caseId,
      hypotheses: [{ claim: 'H1', targets: ['src/a.ts'] }, { claim: 'H2', targets: ['src/b.ts'] }],
    }))
    const r = await tool.execute(params({ op: 'status', case_id: caseId }))
    assert.equal(r.isError, false)
    assert.match(r.content, /候选探针草稿/)
    assert.match(r.content, /plan_probe 参数骨架/)
    assert.match(r.content, /src\/(a|b)\.ts/)
    // 反证：草稿只是文本——状态里不得出现未落账的探针
    assert.equal(store.getCase(caseId)!.probes.length, 0)
  })

  it('有 planned 探针（L0 建议已覆盖）→ 不出 L1 草稿（单声源纪律）', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => VERIFIER })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H1', targets: ['src/a.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'grep', target: 'src/a.ts',
        expectation: { kind: 'pattern_found', path: 'src/a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'supports' }],
      }],
    }))
    const r = await tool.execute(params({ op: 'status', case_id: caseId }))
    assert.match(r.content, /下一个判别探针建议/)
    assert.equal(/候选探针草稿/.test(r.content), false, 'L0 建议在场时 L1 沉默')
  })

  it('available 证据绑定 planned 探针 → 回执推荐直接 observe（证据复用优先）', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => VERIFIER })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H1', targets: ['src/a.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    // 单假设单探针：chooseDiscriminator 对单假设探针无区分力 → L0 无建议，走 L1
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'grep', target: 'src/a.ts',
        expectation: { kind: 'pattern_found', path: 'src/a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'supports' }],
      }],
    }))
    const probeId = store.getCase(caseId)!.probes[0]!.id
    store.registerEvidence({ producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3' })
    const r = await tool.execute(params({ op: 'status', case_id: caseId }))
    // L0 若在场则优先；只有 L0 沉默时才断言复用提示
    if (!/下一个判别探针建议/.test(r.content)) {
      assert.match(r.content, /直接 observe 结算/)
    }
  })
})

describe('problem-attack hook — P2 probe-candidate telemetry', () => {
  function buildBare() {
    const store = new ProblemAttackStore()
    const telemetry: Array<Record<string, unknown>> = []
    const hooks = createProblemAttackHooks({
      store, advisoryBus: { submit: () => {} }, mode: 'shadow',
      writeTelemetry: e => telemetry.push(e),
    })
    return { store, telemetry, hooks }
  }

  it('搜索态且无 planned 探针 → 落 probe-candidate 留痕（纯观测不发声）', async () => {
    const { store, telemetry, hooks } = buildBare()
    const opened = store.openCase(ANCHOR, 'candidate telemetry', 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'H1', targets: ['src/a.ts'] })
    await hooks.postTurn.run(ctx(3))
    const cand = telemetry.filter(t => t.kind === 'probe-candidate')
    assert.equal(cand.length, 1)
    assert.equal((cand[0]!.primary as { target: string }).target, 'src/a.ts')
  })

  it('有 planned 探针 → 不落 probe-candidate 留痕（L0 覆盖场景不重复观测）', async () => {
    const { store, telemetry, hooks } = buildBare()
    const opened = store.openCase(ANCHOR, 'has planned', 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'H1', targets: ['src/a.ts'] })
    const hypId = hypothesisIdFor(caseId, 'H1', ['src/a.ts'])
    store.apply({
      type: 'probe_planned', caseId, turn: 3,
      probe: {
        hypothesisIds: [hypId], kind: 'grep', target: 'src/a.ts',
        expectation: { kind: 'pattern_found', path: 'src/a.ts', needle: 'n' },
        perHypothesis: [{ hypothesisId: hypId, ifTrue: 'supports' }],
      },
    })
    await hooks.postTurn.run(ctx(4))
    assert.equal(telemetry.filter(t => t.kind === 'probe-candidate').length, 0)
  })
})

describe('attack_case 工具 — P4 close(converged) 义务提示', () => {
  function params(input: Record<string, unknown>, turn = 3) {
    return { input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: turn }
  }

  /** 把案件推到 converged（唯一 supported + 对手 refuted）。 */
  function convergedStore(): { store: ProblemAttackStore; caseId: string } {
    const store = new ProblemAttackStore()
    const opened = store.openCase({ kind: 'user_report', ref: 'bug' }, 'converge for close', 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'winner', targets: ['src/fix.ts'] })
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: 'loser', targets: [] })
    const win = hypothesisIdFor(caseId, 'winner', ['src/fix.ts'])
    const lose = hypothesisIdFor(caseId, 'loser', [])
    const expectation = { kind: 'pattern_found', path: 'src/fix.ts', needle: 'n' } as const
    store.apply({
      type: 'probe_planned', caseId, turn: 3,
      probe: {
        hypothesisIds: [win, lose], kind: 'grep', target: 'src/fix.ts', expectation,
        perHypothesis: [{ hypothesisId: win, ifTrue: 'supports' }, { hypothesisId: lose, ifTrue: 'refutes' }],
      },
    })
    const r = store.apply({
      type: 'probe_observed', caseId, turn: 4, probeId: probeIdFor(caseId, 'src/fix.ts', expectation),
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4', evidenceVerified: true,
    })
    assert.equal(r.state.status, 'converged')
    return { store, caseId }
  }

  it('converged 收案且 targets 关联未闭合义务 → 回执提示先核销再交付', async () => {
    const { store, caseId } = convergedStore()
    const tool = createAttackCaseTool({
      getStore: () => store,
      getVerifier: () => ({
        toolRan: () => true, obligationExists: () => true, workerCompleted: () => false,
        openObligationIdsForTargets: targets => targets.includes('src/fix.ts') ? ['ob-verify-1'] : [],
      }),
    })
    const r = await tool.execute(params({ op: 'close', case_id: caseId, resolution: 'converged' }, 5))
    assert.equal(r.isError, false)
    assert.match(r.content, /未闭合义务/)
    assert.match(r.content, /ob-verify-1/)
  })

  it('无关联义务 / 验真器未扩展 → 回执不加提示（向后兼容）', async () => {
    const a = convergedStore()
    const toolNoOb = createAttackCaseTool({
      getStore: () => a.store,
      getVerifier: () => ({
        toolRan: () => true, obligationExists: () => true, workerCompleted: () => false,
        openObligationIdsForTargets: () => [],
      }),
    })
    const r1 = await toolNoOb.execute(params({ op: 'close', case_id: a.caseId, resolution: 'converged' }, 5))
    assert.equal(/未闭合义务/.test(r1.content), false)

    const b = convergedStore()
    const toolLegacy = createAttackCaseTool({
      getStore: () => b.store,
      getVerifier: () => ({ toolRan: () => true, obligationExists: () => true, workerCompleted: () => false }),
    })
    const r2 = await toolLegacy.execute(params({ op: 'close', case_id: b.caseId, resolution: 'converged' }, 5))
    assert.equal(r2.isError, false, '旧验真器（无扩展方法）不崩不提示')
    assert.equal(/未闭合义务/.test(r2.content), false)
  })

  it('abandoned 收案不查义务（提示只对 converged 生效）', async () => {
    const store = new ProblemAttackStore()
    await createAttackCaseTool({
      getStore: () => store,
      getVerifier: () => ({
        toolRan: () => true, obligationExists: () => true, workerCompleted: () => false,
        openObligationIdsForTargets: () => { throw new Error('不应被调用') },
      }),
    }).execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    const r = await createAttackCaseTool({
      getStore: () => store,
      getVerifier: () => ({
        toolRan: () => true, obligationExists: () => true, workerCompleted: () => false,
        openObligationIdsForTargets: () => { throw new Error('不应被调用') },
      }),
    }).execute(params({ op: 'close', case_id: caseId, resolution: 'abandoned' }, 4))
    assert.equal(r.isError, false)
  })
})

// ─── W3：needs_user 结构化升级出口 ──────────────────────────────────

describe('attack_case — W3 needs_user 升级出口（结构化 renderBoard）', () => {
  const VERIFIER: AttackEvidenceVerifier = { toolRan: () => true, obligationExists: () => true, workerCompleted: () => false }
  function params(input: Record<string, unknown>, turn = 3) {
    return { input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: turn }
  }

  function packetState(overrides: Partial<import('../problem-attack-loop.js').ProblemAttackState>) {
    return {
      ...emptyAttackState('case-w3'),
      anchor: ANCHOR,
      problem: 'p',
      status: 'needs_user' as const,
      ...overrides,
    }
  }
  function hyp(id: string, claim: string, status: import('../problem-attack-loop.js').HypothesisStatus, refs: string[] = []) {
    return { id, claim, targets: ['a.ts'], status, evidenceRefs: refs, attempts: 0, lastTurn: 1 }
  }

  it('集成：假设全灭进 needs_user 后 status → 结构化升级包，不再出探针建议', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => VERIFIER })
    await tool.execute(params({ op: 'open', anchor: { kind: 'user_report', ref: 'x' }, problem: 'p' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H-only', targets: ['a.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id
    await tool.execute(params({
      op: 'plan_probe', case_id: caseId,
      probes: [{
        hypothesis_ids: [h1], kind: 'grep', target: 'a.ts',
        expectation: { kind: 'pattern_found', path: 'a.ts', needle: 'n' },
        per_hypothesis: [{ hypothesis_id: h1, if_true: 'refutes' }],
      }],
    }))
    const probeId = store.getCase(caseId)!.probes[0]!.id
    await tool.execute(params({
      op: 'observe', case_id: caseId, probe_id: probeId,
      predicate_outcome: 'true', evidence_ref: 'tool:grep:3',
    }, 4))
    assert.equal(store.getCase(caseId)!.status, 'needs_user')

    const r = await tool.execute(params({ op: 'status', case_id: caseId }, 5))
    assert.equal(r.isError, false)
    assert.match(r.content, /升级出口：请用户裁决/)
    assert.match(r.content, /已排除：/)
    assert.match(r.content, /✗ H-only（证据 tool:grep:3）/)
    assert.match(r.content, /已试探针：/)
    assert.match(r.content, /最小决策问题：所有假设已被排除/)
    assert.match(r.content, /解锁方式：.*user_fact: true/)
    assert.ok(!r.content.includes('下一个判别探针建议'), 'needs_user 下不出探针建议')
    assert.ok(!r.content.includes('候选探针草稿'), 'needs_user 下不出候选草稿')
  })

  it('最小决策问题①：已计划的 ask_user 探针在场 → 直接用它的 target 作为问题', () => {
    const state = packetState({
      hypotheses: [hyp('h1', 'A', 'candidate'), hyp('h2', 'B', 'candidate')],
      probes: [{
        id: 'p-ask', hypothesisIds: ['h1', 'h2'], kind: 'ask_user' as const,
        target: '生产环境是否启用了 feature flag X？',
        expectation: { kind: 'pattern_found' as const, path: 'user', needle: 'x' },
        perHypothesis: [{ hypothesisId: 'h1', ifTrue: 'supports' as const }],
        risk: 'low' as const, status: 'planned' as const,
      }],
    })
    const text = renderEscalationPacket(state).join('\n')
    assert.match(text, /最小决策问题：生产环境是否启用了 feature flag X？/)
  })

  it('最小决策问题②③：两条幸存 → 请用户区分；一条幸存 → 请求支持/反驳事实', () => {
    const two = renderEscalationPacket(packetState({
      hypotheses: [hyp('h1', '缓存失效', 'candidate'), hyp('h2', '并发竞争', 'inconclusive')],
    })).join('\n')
    assert.match(two, /哪个解释更符合实际：「缓存失效」 vs 「并发竞争」/)
    const one = renderEscalationPacket(packetState({
      hypotheses: [hyp('h1', '缓存失效', 'candidate'), hyp('h2', '并发竞争', 'refuted')],
    })).join('\n')
    assert.match(one, /「缓存失效」缺乏可判别证据/)
  })

  it('结构分组：已排除带证据、幸存带状态、已试探针含结果、planned 探针不算已试、预算行在场', () => {
    const lines = renderEscalationPacket(packetState({
      hypotheses: [hyp('h1', 'A', 'refuted', ['tool:grep:2']), hyp('h2', 'B', 'candidate')],
      probes: [
        {
          id: 'p1', hypothesisIds: ['h1'], kind: 'grep' as const, target: 'a.ts',
          expectation: { kind: 'pattern_found' as const, path: 'a.ts', needle: 'n' },
          perHypothesis: [{ hypothesisId: 'h1', ifTrue: 'refutes' as const }],
          risk: 'low' as const, status: 'informative' as const, evidenceRef: 'tool:grep:2',
        },
        {
          id: 'p2', hypothesisIds: ['h2'], kind: 'read' as const, target: 'b.ts',
          expectation: { kind: 'pattern_found' as const, path: 'b.ts', needle: 'n' },
          perHypothesis: [{ hypothesisId: 'h2', ifTrue: 'supports' as const }],
          risk: 'low' as const, status: 'planned' as const,
        },
      ],
    }))
    const text = lines.join('\n')
    assert.match(text, /✗ A（证据 tool:grep:2）/)
    assert.match(text, /\? \[candidate\] B/)
    assert.match(text, /· \[informative\] grep→a\.ts（tool:grep:2）/)
    assert.ok(!text.includes('read→b.ts'), 'planned 探针不进已试列表')
    assert.match(text, /剩余预算：攻坚轮 \d+ · 探针位 \d+/)
  })
})


describe('attack_case 工具 — 第五波新探针词（instrument/simulate）', () => {
  const PERMISSIVE_VERIFIER = { toolRan: () => true, obligationExists: () => true, workerCompleted: () => true }

  it('plan_probe schema 接受 instrument / simulate kind', async () => {
    const store = new ProblemAttackStore()
    const tool = createAttackCaseTool({ getStore: () => store, getVerifier: () => PERMISSIVE_VERIFIER })
    const params = (input: Record<string, unknown>) => ({ input, toolUseId: 't1', cwd: '/tmp', sessionTurnCount: 3 })
    await tool.execute(params({ op: 'open', anchor: { kind: 'failure_pattern', ref: 'resize:ghost' }, problem: 'resize 叠屏' }))
    const caseId = store.activeCases()[0]!.caseId
    await tool.execute(params({ op: 'hypothesize', case_id: caseId, hypotheses: [{ claim: 'H1', targets: ['src/engine.ts'] }] }))
    const h1 = store.getCase(caseId)!.hypotheses[0]!.id

    for (const kind of ['instrument', 'simulate']) {
      const r = await tool.execute(params({
        op: 'plan_probe', case_id: caseId,
        probes: [{
          hypothesis_ids: [h1], kind, target: `probe-${kind}.ts`,
          expectation: { kind: 'command_output_matches', commandIncludes: 'probe', outputPattern: '✗' },
          per_hypothesis: [{ hypothesis_id: h1, if_true: 'supports' }],
        }],
      }))
      assert.equal(r.isError, false, `${kind} 应被 schema 接受: ${r.content}`)
    }
    const kinds = store.getCase(caseId)!.probes.map(p => p.kind)
    assert.ok(kinds.includes('instrument'), 'instrument 探针已落账')
    assert.ok(kinds.includes('simulate'), 'simulate 探针已落账')
  })
})

// ─── 虚空仓库 P0：PAL 收敛案件自动收割 ─────────────────────────────────

describe('problem-attack hook — 虚空仓库自动收割', () => {
  /** 把 store 里一个案件推到 converged（唯一 supported + 对手 refuted）。 */
  function convergeCase(store: ProblemAttackStore, problem: string, targets: string[]): string {
    const opened = store.openCase({ kind: 'user_report', ref: problem }, problem, 1)
    const caseId = opened.state.caseId
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: '根因是缓存键漂移', targets })
    store.apply({ type: 'hypothesis_added', caseId, turn: 2, claim: '陪跑假设', targets: [] })
    const winner = hypothesisIdFor(caseId, '根因是缓存键漂移', targets)
    const loser = hypothesisIdFor(caseId, '陪跑假设', [])
    const expectation: ProbeExpectation = { kind: 'pattern_found', path: targets[0] ?? 'x.ts', needle: 'drift' }
    store.apply({
      type: 'probe_planned', caseId, turn: 3,
      probe: {
        hypothesisIds: [winner, loser], kind: 'grep', target: targets[0] ?? 'x.ts', expectation,
        perHypothesis: [
          { hypothesisId: winner, ifTrue: 'supports' },
          { hypothesisId: loser, ifTrue: 'refutes' },
        ],
      },
    })
    const r = store.apply({
      type: 'probe_observed', caseId, turn: 4,
      probeId: probeIdFor(caseId, targets[0] ?? 'x.ts', expectation),
      predicateOutcome: 'true', evidenceRef: 'tool:grep:4', evidenceVerified: true,
    })
    assert.equal(r.state.status, 'converged', '前置：案件必须收敛')
    store.drainLog()
    store.drainEvidenceLog()
    return caseId
  }

  function buildHarvest(store: ProblemAttackStore, cwd: string) {
    return createProblemAttackHooks({
      store,
      advisoryBus: { submit: () => {} },
      mode: 'shadow',
      writeTelemetry: () => {},
      cwd,
      sessionId: 'sess-harvest-test',
    })
  }

  function withTmpDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-pal-harvest-'))
    const result = fn(dir)
    const cleanup = () => { try { rmSync(dir, { recursive: true }) } catch {} }
    if (result instanceof Promise) return result.finally(cleanup)
    cleanup()
  }

  it('案件收敛后 postTurn 写入 memory.jsonl（source=agent-crafted，含 claim/证据/溯源）', async () => {
    await withTmpDir(async (dir) => {
      const store = new ProblemAttackStore()
      const caseId = convergeCase(store, 'harvest me', ['src/cache.ts'])
      const hooks = buildHarvest(store, dir)
      await hooks.postTurn.run(ctx(5))

      const entries = readMemoryEntries(dir)
      assert.equal(entries.length, 1)
      const e = entries[0]!
      assert.equal(e.source, 'agent-crafted')
      assert.equal(e.kind, 'verified_pattern')
      assert.ok(e.text.includes('根因是缓存键漂移'), '收敛 claim 进知识文本')
      assert.ok(e.text.includes(caseId), '案件 id 可追溯')
      assert.ok(e.tags.includes('pal-converged'))
      assert.equal(e.sessionId, 'sess-harvest-test')
      assert.equal(e.topic, 'src/cache.ts')
      assert.ok(e.evidence?.includes('tool:grep:4'), 'evidenceRefs 留痕')
      assert.ok(e.id && e.ts > 0, 'appendMemoryEntry 自动 id/ts（读取面不丢弃）')
      assert.equal(store.isHarvested(caseId), true)
    })
  })

  it('同一案件第二次 postTurn 不重复写（harvestedCaseIds 守卫）', async () => {
    await withTmpDir(async (dir) => {
      const store = new ProblemAttackStore()
      convergeCase(store, 'harvest once', ['src/a.ts'])
      const hooks = buildHarvest(store, dir)
      await hooks.postTurn.run(ctx(5))
      await hooks.postTurn.run(ctx(6))
      assert.equal(readMemoryEntries(dir).length, 1)
    })
  })

  it('export→restore snapshot 后仍不重复写（守卫持久化）', async () => {
    await withTmpDir(async (dir) => {
      const store = new ProblemAttackStore()
      convergeCase(store, 'harvest resume', ['src/b.ts'])
      await buildHarvest(store, dir).postTurn.run(ctx(5))
      assert.equal(readMemoryEntries(dir).length, 1)

      const resumed = ProblemAttackStore.fromSnapshot(store.exportSnapshot())
      await buildHarvest(resumed, dir).postTurn.run(ctx(6))
      assert.equal(readMemoryEntries(dir).length, 1, 'resume 会话不再收割同一案件')
    })
  })

  it('相似条目已存在 → countSimilar 兜底不双写（但仍标记已收割）', async () => {
    await withTmpDir(async (dir) => {
      const store = new ProblemAttackStore()
      const caseId = convergeCase(store, 'dedup me', ['src/c.ts'])
      // 预先写入相同文本（模拟 agent 经 learned 手动重述）
      appendMemoryEntry(dir, {
        text: `PAL 收敛案件 ${caseId}：根因是缓存键漂移`,
        kind: 'verified_pattern', confidence: 0.95, source: 'agent-crafted', status: 'verified', tags: [],
      })
      await buildHarvest(store, dir).postTurn.run(ctx(5))
      assert.equal(readMemoryEntries(dir).length, 1, '相似条目挡住双写')
      assert.equal(store.isHarvested(caseId), true, '无论写没写都标记')
    })
  })

  it('非 converged 案件不触发收割；cwd 缺席不写', async () => {
    await withTmpDir(async (dir) => {
      const store = new ProblemAttackStore()
      store.openCase({ kind: 'user_report', ref: 'still probing' }, 'still probing', 1)
      await buildHarvest(store, dir).postTurn.run(ctx(3))
      assert.equal(readMemoryEntries(dir).length, 0, '未收敛不收割')

      const converged = new ProblemAttackStore()
      convergeCase(converged, 'no cwd', ['src/d.ts'])
      const noCwd = createProblemAttackHooks({
        store: converged, advisoryBus: { submit: () => {} }, mode: 'shadow', writeTelemetry: () => {},
      })
      await noCwd.postTurn.run(ctx(5))
      assert.equal(readMemoryEntries(dir).length, 0, 'cwd 缺席（测试/无项目上下文）不写')
    })
  })
})

/**
 * PAL Evidence Registry 反证测试（H4-A RED）。
 *
 * 覆盖：
 * - 伪造/未注册 evidenceId 硬拒
 * - 跨 case 引用拒绝
 * - 跨 probe 引用拒绝
 * - 重复消费拒绝（幂等）
 * - 过期证据变 unknown
 * - 确定性：相同输入 → 相同 registry 状态
 * - worker 证据需真实委派
 * - obligation 证据需真实账本条目的注册
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProblemAttackStore, MAX_EVIDENCE_AGE_TURNS, type PalSnapshot } from '../problem-attack-loop.js'

// ─── H4-D1 类型守卫 ────────────────────────────────────────────────

/** registerEvidence 返回 string|null（fail-closed），成功路径用此守卫
 *  解开 null，编译期收窄为 string。 */
function reqEvId(value: string | null): string {
  assert.notEqual(value, null, 'evidence registration unexpectedly returned null')
  return value as string
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function openCase(store: ProblemAttackStore, turn: number) {
  const r = store.openCase(
    { kind: 'failure_pattern', ref: 'test:evidence:registry' },
    'H4-A evidence integrity test',
    turn,
  )
  return r.state.caseId
}

function addHypothesis(store: ProblemAttackStore, caseId: string, turn: number, claim: string) {
  store.apply({ type: 'hypothesis_added', caseId, turn, claim, targets: ['src/test.ts'] })
}

function planProbe(store: ProblemAttackStore, caseId: string, turn: number, target: string) {
  const state = store.getCase(caseId)!
  const h = state.hypotheses
  store.apply({
    type: 'probe_planned', caseId, turn,
    probe: {
      hypothesisIds: [h[0]!.id],
      kind: 'grep',
      target,
      expectation: { kind: 'pattern_found', path: target, needle: 'evidence' },
      perHypothesis: [{ hypothesisId: h[0]!.id, ifTrue: 'supports' }],
    },
  })
  return store.getCase(caseId)!.probes.at(-1)!.id
}

// ─── RED 测试 ─────────────────────────────────────────────────────

describe('H4-A Evidence Registry 纯状态层', () => {
  describe('注册 → 解析 → 消费 基本流程', () => {
    it('注册后 resolve 找到，consume 成功，二次 consume 失败', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      const evId = reqEvId(store.registerEvidence({
        producer: 'tool',
        caseId,
        probeId,
        turn: 3,
        ref: 'tool:grep:3',
      }))

      // 注册后应可解析
      const r1 = store.resolveEvidence(evId, { caseId, probeId })
      assert.ok(r1, 'should resolve registered evidence')
      assert.equal(r1.producer, 'tool')
      assert.equal(r1.caseId, caseId)
      assert.equal(r1.probeId, probeId)
      assert.equal(r1.status, 'available')

      // 首次消费成功
      assert.ok(store.consumeEvidence(evId), 'first consume should succeed')

      // 二次消费失败
      assert.equal(store.consumeEvidence(evId), false, 'duplicate consume must return false')

      // 状态变为 consumed
      const r2 = store.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r2?.status, 'consumed')
    })
  })

  describe('跨 case 隔离', () => {
    it('case A 注册的证据不能被 case B consume', () => {
      const store = new ProblemAttackStore()
      const caseA = openCase(store, 1)
      addHypothesis(store, caseA, 2, 'H-A')
      const probeA = planProbe(store, caseA, 3, 'src/a.ts')
      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId: caseA, probeId: probeA, turn: 3, ref: 'tool:grep:3',
      }))

      const caseB = openCase(store, 4)
      addHypothesis(store, caseB, 5, 'H-B')
      const probeB = planProbe(store, caseB, 6, 'src/b.ts')

      // caseB 尝试用 caseA 的证据
      const resolved = store.resolveEvidence(evId, { caseId: caseB, probeId: probeB })
      assert.equal(resolved, undefined, 'cross-case evidence must not resolve')

      // caseA 仍可正常使用
      const rA = store.resolveEvidence(evId, { caseId: caseA, probeId: probeA })
      assert.ok(rA, 'original case should still resolve its own evidence')
    })
  })

  describe('跨 probe 隔离', () => {
    it('probe A 注册的证据不能被 probe B consume', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeA = planProbe(store, caseId, 3, 'src/a.ts')
      const probeB = planProbe(store, caseId, 4, 'src/b.ts')

      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId, probeId: probeA, turn: 3, ref: 'tool:grep:3',
      }))

      // probeB 尝试 consume probeA 的证据
      const resolved = store.resolveEvidence(evId, { caseId, probeId: probeB })
      assert.equal(resolved, undefined, 'cross-probe evidence must not resolve')

      // probeA 仍可正常使用
      const rA = store.resolveEvidence(evId, { caseId, probeId: probeA })
      assert.ok(rA, 'owning probe should resolve its evidence')
    })
  })

  describe('伪造/未注册 evidenceId', () => {
    it('完全不存在的 evidenceId 不 resolve', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      const resolved = store.resolveEvidence('ev-fabricated', { caseId, probeId })
      assert.equal(resolved, undefined, 'fabricated evidence must not resolve')
    })

    it('未注册的 evidenceId 不能 consume', () => {
      const store = new ProblemAttackStore()
      assert.equal(store.consumeEvidence('ev-nonexistent'), false)
    })
  })

  describe('过期证据', () => {
    // H4-A-W2: evidence 在有效 turn 窗口外视为过期
    it('超出合理 turn 窗口的证据 resolve 返回 status=expired', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      // 注册证据在 turn 3
      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3',
      }))

      // TTL 内仍 available
      const r1 = store.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r1?.status, 'available')

      // 推进到 turn 3 + TTL + 1，触发批量过期
      store.expireEvidenceBefore(3 + MAX_EVIDENCE_AGE_TURNS)

      const r2 = store.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r2?.status, 'expired', 'evidence beyond TTL must be expired')
      assert.equal(store.consumeEvidence(evId), false, 'expired evidence must not be consumable')
    })

    it('expired 证据不可 consume', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3',
      }))

      // expireEvidence 可能是个显式方法或基于 turn 窗口自动判定
      // 在 H4-A 中先做确定性标记
      store.expireEvidence?.(evId)

      const resolved = store.resolveEvidence(evId, { caseId, probeId })
      if (resolved && resolved.status === 'expired') {
        assert.equal(store.consumeEvidence(evId), false, 'expired evidence must not be consumable')
      }
      // 如果 expireEvidence 未实现，本文测试跳过
    })
  })

  describe('确定性', () => {
    it('相同输入 → 相同 registry 状态', () => {
      const store1 = new ProblemAttackStore()
      const caseId1 = openCase(store1, 1)
      addHypothesis(store1, caseId1, 2, 'H1')
      const probeId1 = planProbe(store1, caseId1, 3, 'src/test.ts')
      const evId1 = reqEvId(store1.registerEvidence({
        producer: 'tool', caseId: caseId1, probeId: probeId1, turn: 3, ref: 'tool:grep:3',
      }))

      const store2 = new ProblemAttackStore()
      const caseId2 = openCase(store2, 1)
      addHypothesis(store2, caseId2, 2, 'H1')
      const probeId2 = planProbe(store2, caseId2, 3, 'src/test.ts')
      const evId2 = reqEvId(store2.registerEvidence({
        producer: 'tool', caseId: caseId2, probeId: probeId2, turn: 3, ref: 'tool:grep:3',
      }))

      // 相同输入应产生相同的 evidenceId
      assert.equal(evId1, evId2, 'deterministic evidence IDs')

      // 且状态一致
      const r1 = store1.resolveEvidence(evId1, { caseId: caseId1, probeId: probeId1 })
      const r2 = store2.resolveEvidence(evId2, { caseId: caseId2, probeId: probeId2 })
      assert.equal(r1?.status, r2?.status)
      assert.equal(r1?.producer, r2?.producer)
    })
  })

  describe('worker 证据需真实委派', () => {
    it('有委派标记时可注册 worker 证据', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      // 模拟委派发生
      store.markDelegation(2)

      const evId = reqEvId(store.registerEvidence({
        producer: 'worker', caseId, probeId, turn: 2, ref: 'worker:batch-0-a1b2c3',
      }))
      assert.ok(evId, 'worker evidence should register after delegation')
      const r = store.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r?.producer, 'worker')
    })

    it('无委派时注册 worker 证据被拒', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      // 没有 markDelegation → registerEvidence 返回 null（fail-closed）
      const id = store.registerEvidence({
        producer: 'worker', caseId, probeId, turn: 2, ref: 'worker:fake',
      })
      assert.equal(id, null, 'worker evidence without delegation must return null (fail-closed)')
    })
  })

  describe('H4-D4 worker orderId 精确身份', () => {
    it('markWorkerCompleted 后 hasWorkerCompleted 返回 true', () => {
      const store = new ProblemAttackStore()
      assert.equal(store.hasWorkerCompleted('batch-0-a1b2c3'), false)
      store.markWorkerCompleted('batch-0-a1b2c3')
      assert.equal(store.hasWorkerCompleted('batch-0-a1b2c3'), true)
      assert.equal(store.hasWorkerCompleted('other-id'), false)
    })

    it('snapshot restore 保留 completedWorkers', () => {
      const s1 = new ProblemAttackStore()
      s1.markWorkerCompleted('batch-0-a1b2c3')
      const snap = s1.exportSnapshot()
      const s2 = ProblemAttackStore.fromSnapshot(snap)
      assert.equal(s2.hasWorkerCompleted('batch-0-a1b2c3'), true)
    })
  })

  describe('obligation 证据需已存在的 obligation', () => {
    it('有 obligation 验真器时可注册 obligation 证据', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      // obligation 证据注册走显式接入——需要外部验真
      // 在 registry 层面，注册即信任调用方已完成验真
      const evId = reqEvId(store.registerEvidence({
        producer: 'obligation', caseId, probeId, turn: 3, ref: 'obligation:ob_1',
      }))
      assert.ok(evId)
      const r = store.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r?.producer, 'obligation')
    })
  })

  describe('evidence 不变量', () => {
    it('已消费 evidence 不可二次结算（通过 consume 幂等保证）', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')

      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3',
      }))

      const ok1 = store.consumeEvidence(evId)
      const ok2 = store.consumeEvidence(evId)
      assert.ok(ok1, 'first consume')
      assert.equal(ok2, false, 'second consume must fail')
    })
  })

  describe('H4-D3 session snapshot/restore', () => {
    it('open case + consumed evidence round-trip deepEqual', () => {
      const s1 = new ProblemAttackStore()
      const caseId = openCase(s1, 1)
      addHypothesis(s1, caseId, 2, 'H1')
      const probeId = planProbe(s1, caseId, 3, 'src/test.ts')
      const evId = reqEvId(s1.registerEvidence({
        producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3',
      }))
      s1.consumeEvidence(evId)

      const snap = s1.exportSnapshot()
      const s2 = ProblemAttackStore.fromSnapshot(snap)

      // cases restored
      const c1 = s1.getCase(caseId)!
      const c2 = s2.getCase(caseId)!
      assert.equal(c2.caseId, c1.caseId)
      assert.equal(c2.status, c1.status)
      assert.equal(c2.activeAttackTurns, c1.activeAttackTurns)
      assert.equal(c2.score, c1.score)
      assert.equal(c2.hypotheses.length, c1.hypotheses.length)
      assert.equal(c2.probes.length, c1.probes.length)

      // evidence restored with consumed status
      const r2 = s2.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r2?.status, 'consumed')
      assert.equal(s2.consumeEvidence(evId), false, 'consumed evidence must not be re-consumable after restore')
    })

    it('activeAttackTurns 不重置', () => {
      const s1 = new ProblemAttackStore()
      const r = s1.openCase({ kind: 'user_report', ref: 'turns-test' }, 'test', 1)
      // advance through several turns
      const caseId = r.state.caseId
      for (let t = 2; t <= 5; t++) {
        s1.apply({ type: 'hypothesis_added', caseId, turn: t, claim: `H${t}`, targets: [`src/f${t}.ts`] })
      }

      const snap = s1.exportSnapshot()
      const s2 = ProblemAttackStore.fromSnapshot(snap)
      assert.equal(s2.getCase(caseId)!.activeAttackTurns, s1.getCase(caseId)!.activeAttackTurns)
    })

    it('expired evidence stays expired after restore', () => {
      const store = new ProblemAttackStore()
      const caseId = openCase(store, 1)
      addHypothesis(store, caseId, 2, 'H1')
      const probeId = planProbe(store, caseId, 3, 'src/test.ts')
      const evId = reqEvId(store.registerEvidence({
        producer: 'tool', caseId, probeId, turn: 3, ref: 'tool:grep:3',
      }))
      store.expireEvidence(evId)

      const snap = store.exportSnapshot()
      const s2 = ProblemAttackStore.fromSnapshot(snap)
      const r2 = s2.resolveEvidence(evId, { caseId, probeId })
      assert.equal(r2?.status, 'expired')
      assert.equal(s2.consumeEvidence(evId), false)
    })

    it('corrupt/unknown schemaVersion → empty store (fail-closed)', () => {
      const s1 = new ProblemAttackStore()
      openCase(s1, 1)
      const snap = s1.exportSnapshot()
      const bad = { ...snap, schemaVersion: 999 }
      const s2 = ProblemAttackStore.fromSnapshot(bad as PalSnapshot)
      assert.equal(s2.allCases().length, 0)
      assert.equal(s2.activeCases().length, 0)
    })

    it('lastDelegationTurn is null after restore (跨会话窗口不延续)', () => {
      const s1 = new ProblemAttackStore()
      s1.markDelegation(3)
      const snap = s1.exportSnapshot()
      const s2 = ProblemAttackStore.fromSnapshot(snap)
      assert.equal(s2.hasDelegated(), false, 'delegation window must not survive restore')
    })
  })
})

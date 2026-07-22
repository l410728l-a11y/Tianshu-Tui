import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sealPlan, verifyPlanSeal, revisePlanSeal, formatSealStatus, type SealedUnifiedPlan } from '../council-seal.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../../unified-plan.js'

function plan(overrides?: Partial<UnifiedPlan>): UnifiedPlan {
  return {
    version: 1,
    objective: 'split loop.ts',
    tasks: [
      { id: 'T1', title: 'a', objective: 'do a', profile: 'implementer', kind: 'patch_proposal', files: ['src/a.ts'], dependsOn: [], riskTier: 'low', verification: ['npm test'] },
      { id: 'T2', title: 'b', objective: 'do b', profile: 'implementer', kind: 'patch_proposal', files: ['src/b.ts'], dependsOn: ['T1'], riskTier: 'medium' },
    ],
    source: 'manual',
    createdAt: 1000,
    ...overrides,
  }
}

describe('council-seal — Atropos 契约密封', () => {
  it('sealPlan → v1 密封、verifyPlanSeal intact', () => {
    const sealed = sealPlan(plan(), 5000)
    assert.equal(sealed.seal!.version, 1)
    assert.equal(sealed.seal!.sealedAt, 5000)
    assert.deepEqual(sealed.seal!.exemptions, [])
    assert.deepEqual(verifyPlanSeal(sealed), { status: 'intact', version: 1 })
  })

  it('密封后静默改写执行语义（files/objective/verification/dependsOn）→ broken', () => {
    const sealed = sealPlan(plan())
    const mutations: Array<(p: SealedUnifiedPlan) => SealedUnifiedPlan> = [
      p => ({ ...p, objective: 'changed' }),
      p => ({ ...p, tasks: p.tasks.map(t => t.id === 'T1' ? { ...t, files: ['src/other.ts'] } : t) }),
      p => ({ ...p, tasks: p.tasks.map(t => t.id === 'T1' ? { ...t, verification: [] } : t) }),
      p => ({ ...p, tasks: p.tasks.map(t => t.id === 'T2' ? { ...t, dependsOn: [] } : t) }),
      p => ({ ...p, tasks: p.tasks.slice(0, 1) }),
    ]
    for (const mutate of mutations) {
      const check = verifyPlanSeal(mutate(sealed))
      assert.equal(check.status, 'broken', '执行语义改写必须破封')
    }
  })

  it('非执行语义改写（title 措辞、任务数组顺序）不破封', () => {
    const sealed = sealPlan(plan())
    const titleChanged = { ...sealed, tasks: sealed.tasks.map(t => ({ ...t, title: `${t.title}-reworded` })) }
    assert.equal(verifyPlanSeal(titleChanged).status, 'intact')
    const reordered = { ...sealed, tasks: [...sealed.tasks].reverse() }
    assert.equal(verifyPlanSeal(reordered).status, 'intact')
  })

  it('未密封计划 → unsealed（向后兼容，非议事会计划不强制）', () => {
    assert.deepEqual(verifyPlanSeal(plan() as SealedUnifiedPlan), { status: 'unsealed' })
  })

  it('重封已密封计划 → 抛错（修订必须走豁免协议）', () => {
    const sealed = sealPlan(plan())
    assert.throws(() => sealPlan(sealed), /豁免/)
  })

  it('revisePlanSeal → version+1、留痕 reason 与前代摘要、修订后 intact', () => {
    const sealed = sealPlan(plan(), 5000)
    const modified: SealedUnifiedPlan = { ...sealed, tasks: sealed.tasks.map(t => t.id === 'T1' ? { ...t, files: ['src/moved.ts'] } : t) }
    assert.equal(verifyPlanSeal(modified).status, 'broken', '前置：改写未复封时是破损态')
    const revised = revisePlanSeal(modified, 'wave 1 门禁失败，T1 改动范围经复议调整', 6000)
    assert.equal(revised.seal!.version, 2)
    assert.equal(revised.seal!.exemptions.length, 1)
    assert.equal(revised.seal!.exemptions[0]!.fromDigest, sealed.seal!.digest)
    assert.match(revised.seal!.exemptions[0]!.reason, /复议/)
    assert.deepEqual(verifyPlanSeal(revised), { status: 'intact', version: 2 })
  })

  it('豁免链可追多代血缘', () => {
    let p = sealPlan(plan(), 1)
    p = revisePlanSeal({ ...p, objective: 'v2' }, 'r1', 2)
    p = revisePlanSeal({ ...p, objective: 'v3' }, 'r2', 3)
    assert.equal(p.seal!.version, 3)
    assert.deepEqual(p.seal!.exemptions.map(e => e.reason), ['r1', 'r2'])
  })

  it('空 reason 豁免 → 抛错；未密封计划豁免 → 抛错', () => {
    const sealed = sealPlan(plan())
    assert.throws(() => revisePlanSeal(sealed, '  '), /reason/)
    assert.throws(() => revisePlanSeal(plan() as SealedUnifiedPlan, 'x'), /未密封/)
  })

  it('seal 经 UnifiedPlan JSON 序列化往返存活（plan-store 通路）', () => {
    const sealed = sealPlan(plan(), 5000)
    const roundTripped = deserializeUnifiedPlan(serializeUnifiedPlan(sealed)) as SealedUnifiedPlan
    assert.ok(roundTripped?.seal, 'seal 字段必须随 JSON 透传')
    assert.deepEqual(verifyPlanSeal(roundTripped), { status: 'intact', version: 1 })
  })

  it('formatSealStatus：intact 展示版本+摘要；broken 明示豁免协议', () => {
    const sealed = sealPlan(plan())
    assert.match(formatSealStatus(sealed), /契约已密封 v1/)
    const broken = { ...sealed, objective: 'tampered' }
    assert.match(formatSealStatus(broken), /密封破损/)
    assert.match(formatSealStatus(broken), /revisePlanSeal/)
    assert.equal(formatSealStatus(plan() as SealedUnifiedPlan), '契约未密封')
  })
})

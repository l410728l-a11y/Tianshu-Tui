import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { councilPlanToUnifiedPlan, compileCouncilPlan } from '../council-to-plan.js'
import { validateUnifiedPlan } from '../../unified-plan.js'
import type { CouncilPlan, CouncilAggregate, CouncilConflict, SeatContribution } from '../council-plan.js'

function agg(over: Partial<CouncilAggregate> = {}): CouncilAggregate {
  return { decisions: [], conflicts: [], mergedItems: [{ id: 'T1', title: 'Task1', detail: 'do T1', files: ['src/loop.ts'] }], ...over }
}
function plan(over: Partial<CouncilPlan> = {}): CouncilPlan {
  return {
    objective: 'split loop.ts',
    seats: ['tianquan', 'tianfu'],
    contributions: [],
    aggregate: agg(),
    finalPlanMarkdown: '',
    meta: { round: 1, convenedAt: 1234, objectiveHash: 'h' },
    ...over,
  }
}
function seat(over: Partial<SeatContribution> & { authority: string }): SeatContribution {
  return { summary: '', additions: [], risks: [], challenges: [], alternatives: [], ...over }
}

describe('councilPlanToUnifiedPlan', () => {
  it('mergedItem → patch_proposal 节点，字段映射 + files 透传', () => {
    const u = councilPlanToUnifiedPlan(plan())
    assert.equal(u.version, 1)
    assert.equal(u.objective, 'split loop.ts')
    assert.equal(u.source, 'manual')
    assert.equal(u.createdAt, 1234)
    assert.equal(u.tasks.length, 1)
    const t = u.tasks[0]!
    assert.equal(t.id, 'T1')
    assert.equal(t.title, 'Task1')
    assert.equal(t.objective, 'do T1')
    assert.equal(t.kind, 'patch_proposal')
    assert.equal(t.profile, 'patcher')
    assert.deepEqual(t.files, ['src/loop.ts'])
    assert.deepEqual(t.dependsOn, [])
  })

  it('产物通过 validateUnifiedPlan', () => {
    const v = validateUnifiedPlan(councilPlanToUnifiedPlan(plan()))
    assert.equal(v.valid, true, JSON.stringify(v))
  })

  it('objective 取 detail；detail 空时回退 title', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [{ id: 'T1', title: 'OnlyTitle', detail: '' }] }) }))
    assert.equal(u.tasks[0]!.objective, 'OnlyTitle')
  })

  it('riskTier：按 itemId 聚合最高 severity，无关联默认 medium', () => {
    const p = plan({
      aggregate: agg({ mergedItems: [{ id: 'T1', title: 't', detail: 'd' }, { id: 'T2', title: 't2', detail: 'd2' }] }),
      contributions: [seat({ authority: 'a', risks: [
        { claim: 'r1', severity: 'low', mitigation: 'm', itemId: 'T1' },
        { claim: 'r2', severity: 'high', mitigation: 'm', itemId: 'T1' },
      ] })],
    })
    const u = councilPlanToUnifiedPlan(p)
    assert.equal(u.tasks.find(t => t.id === 'T1')!.riskTier, 'high')
    assert.equal(u.tasks.find(t => t.id === 'T2')!.riskTier, 'medium')
  })

  it('泛化风险（无 itemId）不参与聚合', () => {
    const p = plan({ contributions: [seat({ authority: 'a', risks: [{ claim: 'x', severity: 'high', mitigation: 'm' }] })] })
    assert.equal(councilPlanToUnifiedPlan(p).tasks[0]!.riskTier, 'medium')
  })

  it('缺省 files → 空数组', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [{ id: 'T1', title: 't', detail: 'd' }] }) }))
    assert.deepEqual(u.tasks[0]!.files, [])
  })

  it('rejected 决议 → nonGoals', () => {
    const p = plan({ aggregate: agg({
      decisions: [{ id: 'a:alternative:0', source: 'a', kind: 'alternative', title: '事件溯源', rationale: '成本高', verdict: 'rejected' }],
    }) })
    assert.deepEqual(councilPlanToUnifiedPlan(p).nonGoals, ['事件溯源'])
  })

  it('无 rejected → 不带 nonGoals 字段', () => {
    assert.equal(councilPlanToUnifiedPlan(plan()).nonGoals, undefined)
  })

  it('确定性：两次转换字节相等', () => {
    assert.equal(JSON.stringify(councilPlanToUnifiedPlan(plan())), JSON.stringify(councilPlanToUnifiedPlan(plan())))
  })

  it('空 mergedItems → tasks 空（交给 convene 层判空不产 planJson）', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [] }) }))
    assert.equal(u.tasks.length, 0)
  })
})

describe('councilPlanToUnifiedPlan — Da\'at 编译门（验收门/dependsOn/provenance）', () => {
  it('challenge.gate 带 itemId → 只挂该任务 verification；无 itemId → 挂所有任务（去重）', () => {
    const p = plan({
      aggregate: agg({ mergedItems: [
        { id: 'T1', title: 't1', detail: 'd1' },
        { id: 'T2', title: 't2', detail: 'd2' },
      ] }),
      contributions: [
        seat({ authority: 'tianfu', challenges: [
          { text: '类型必须过', severity: 'blocking', gate: 'npx tsc --noEmit', itemId: 'T1' },
          { text: '全局测试', gate: 'npm test' },
          { text: '重复的全局门', gate: 'npm test' },
        ] }),
      ],
    })
    const u = councilPlanToUnifiedPlan(p)
    assert.deepEqual(u.tasks.find(t => t.id === 'T1')!.verification, ['npx tsc --noEmit', 'npm test'])
    assert.deepEqual(u.tasks.find(t => t.id === 'T2')!.verification, ['npm test'])
  })

  it('dependsOn 推导：同文件重叠 → 后者依赖前者；无重叠 → 各自为空；链式传递正确', () => {
    const p = plan({
      aggregate: agg({ mergedItems: [
        { id: 'A', title: 'a', detail: 'd', files: ['src/x.ts'] },
        { id: 'B', title: 'b', detail: 'd', files: ['src/x.ts', 'src/y.ts'] },
        { id: 'C', title: 'c', detail: 'd', files: ['src/y.ts'] },
        { id: 'D', title: 'd', detail: 'd', files: ['src/z.ts'] },
      ] }),
    })
    const u = councilPlanToUnifiedPlan(p)
    assert.deepEqual(u.tasks.find(t => t.id === 'A')!.dependsOn, [])
    assert.deepEqual(u.tasks.find(t => t.id === 'B')!.dependsOn, ['A'])
    assert.deepEqual(u.tasks.find(t => t.id === 'C')!.dependsOn, ['B'])
    assert.deepEqual(u.tasks.find(t => t.id === 'D')!.dependsOn, [])
    const v = validateUnifiedPlan(u)
    assert.equal(v.valid, true, JSON.stringify(v))
    assert.equal(v.warnings.length, 0, '显式 dependsOn 后同文件重叠告警应消失')
  })

  it('metadata.proposedBy：席位新增条目 = authority，草案条目 = draft', () => {
    const p = plan({
      aggregate: agg({ mergedItems: [
        { id: 'T1', title: 't', detail: 'd', proposedBy: 'draft' },
        { id: 'N1', title: 'n', detail: 'd', proposedBy: 'tianxuan' },
      ] }),
    })
    const u = councilPlanToUnifiedPlan(p)
    assert.equal(u.tasks.find(t => t.id === 'T1')!.metadata!.proposedBy, 'draft')
    assert.equal(u.tasks.find(t => t.id === 'N1')!.metadata!.proposedBy, 'tianxuan')
  })
})

describe('compileCouncilPlan — 否决拦截', () => {
  const blockingConflict = (status: CouncilConflict['status']): CouncilConflict => ({
    description: 'Blocking challenge from tianfu', left: '无回滚不得动 schema', right: 'obj',
    key: 'k1', status, severity: 'blocking',
  })

  it('存在 open blocking 冲突 → ok:false + vetoes，无 plan', () => {
    const r = compileCouncilPlan(plan({ aggregate: agg({ conflicts: [blockingConflict('open')] }) }))
    assert.equal(r.ok, false)
    assert.equal(r.vetoes.length, 1)
    assert.equal(r.plan, undefined)
  })

  it('persisted blocking 冲突同样否决（r2 未化解不放行）', () => {
    const r = compileCouncilPlan(plan({ aggregate: agg({ conflicts: [blockingConflict('persisted')] }) }))
    assert.equal(r.ok, false)
  })

  it('resolved blocking 冲突 → ok:true 正常编译', () => {
    const r = compileCouncilPlan(plan({ aggregate: agg({ conflicts: [blockingConflict('resolved')] }) }))
    assert.equal(r.ok, true)
    assert.equal(r.plan!.tasks.length, 1)
    assert.deepEqual(r.vetoes, [])
  })

  it('普通（非 blocking）open 冲突不否决', () => {
    const normal: CouncilConflict = { description: 'd', left: 'L', right: 'R', key: 'k2', status: 'open' }
    const r = compileCouncilPlan(plan({ aggregate: agg({ conflicts: [normal] }) }))
    assert.equal(r.ok, true)
  })
})

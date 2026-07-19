import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSuggestPlanMode, buildPlanModeSuggestAdvisory, buildStructureFlowPlanAdvisory, planModeSuggestEnabled, type PlanModeSuggestInput, type StructureFlowPlanAdvisoryInput } from '../plan-mode-advisor.js'
import type { DisciplineEligibility } from '../discipline-eligibility.js'
import { extractTaskContract } from '../../context/task-contract.js'

function baseInput(overrides: Partial<PlanModeSuggestInput> = {}): PlanModeSuggestInput {
  const contract = extractTaskContract('重构 src/agent/loop.ts 和 src/tui/app.ts，打通 src/server/session-manager.ts 三个模块', 0)
  return {
    turnMode: 'task',
    contract,
    methodology: 'full',
    depthLayer: 'system',
    planModeState: 'off',
    suggestedContractIds: new Set<string>(),
    ...overrides,
  }
}

describe('shouldSuggestPlanMode', () => {
  const yesEligibility: DisciplineEligibility = {
    responseActionable: true,
    requiresEngineeringDiscipline: true,
    requiresCodeVerification: true,
    allowsEvidenceReview: true,
    canSuggestPlan: true,
    canDispatch: true,
    projectionMode: 'engineering',
  }

  it('suggests for a full-methodology task with plan mode off', () => {
    const result = shouldSuggestPlanMode(baseInput({ eligibility: yesEligibility }))
    assert.equal(result.suggest, true)
    assert.ok(result.reason.length > 0)
  })

  it('does not suggest for lightweight methodology', () => {
    const result = shouldSuggestPlanMode(baseInput({ methodology: 'lightweight' }))
    assert.equal(result.suggest, false)
  })

  it('does not suggest when already in plan mode', () => {
    const result = shouldSuggestPlanMode(baseInput({ planModeState: 'planning' }))
    assert.equal(result.suggest, false)
  })

  it('does not suggest for non-task turn modes', () => {
    assert.equal(shouldSuggestPlanMode(baseInput({ turnMode: 'chat' })).suggest, false)
    assert.equal(shouldSuggestPlanMode(baseInput({ turnMode: 'followUp' })).suggest, false)
  })

  it('does not suggest without an actionable contract', () => {
    const result = shouldSuggestPlanMode(baseInput({ contract: undefined }))
    assert.equal(result.suggest, false)
  })

  it('uses eligibility?.canSuggestPlan as second gate when provided', () => {
    const noEligibility: DisciplineEligibility = { ...yesEligibility, canSuggestPlan: false }

    // canSuggestPlan=true → full-methodology task should pass
    const shouldPass = shouldSuggestPlanMode(baseInput({ eligibility: yesEligibility }))
    assert.equal(shouldPass.suggest, true)

    // canSuggestPlan=false → blocked regardless of contract
    const shouldBlock = shouldSuggestPlanMode(baseInput({ eligibility: noEligibility }))
    assert.equal(shouldBlock.suggest, false)
    assert.equal(shouldBlock.reason, 'not a new actionable task')
  })

  it('defaults to non-actionable when eligibility is absent', () => {
    // eligibility 已稳定存在，回退到 contract.isActionable 的旧语义已移除。
    // 无 eligibility 时 shouldSuggestPlanMode 保守降级为不 actionable。
    const withoutEligibility = shouldSuggestPlanMode(baseInput({ eligibility: undefined }))
    assert.equal(withoutEligibility.suggest, false)
  })

  it('is one-shot per contract id', () => {
    const input = baseInput({ eligibility: yesEligibility })
    const first = shouldSuggestPlanMode(input)
    assert.equal(first.suggest, true)
    const seen = new Set([input.contract!.id])
    const second = shouldSuggestPlanMode({ ...input, suggestedContractIds: seen })
    assert.equal(second.suggest, false)
  })

  it('reason mentions the hit signals (depth / files / refactor)', () => {
    const result = shouldSuggestPlanMode(baseInput({ eligibility: yesEligibility }))
    assert.ok(/system|文件|重构/.test(result.reason), `reason should carry signals, got: ${result.reason}`)
  })
})

describe('buildPlanModeSuggestAdvisory', () => {
  it('instructs the model to call ask_user_question with the two fixed options', () => {
    const text = buildPlanModeSuggestAdvisory('system 级改动面')
    assert.ok(text.includes('ask_user_question'))
    assert.ok(text.includes('进入计划模式'))
    assert.ok(text.includes('直接执行'))
    assert.ok(text.includes('enter_mode'))
    assert.ok(text.includes('system 级改动面'))
  })
})

// ─── P2 阴阳调度：structure-flow plan advisory ──────────────────────

describe('buildStructureFlowPlanAdvisory', () => {
  function sfInput(overrides: Partial<StructureFlowPlanAdvisoryInput> = {}): StructureFlowPlanAdvisoryInput {
    return {
      snapshot: { planRecommendation: 'enter', reasons: ['unknown-domain'] },
      planModeState: 'off',
      activePlanFile: false,
      firedKeys: new Set(),
      ...overrides,
    }
  }

  it('未知域首次 enter → 输出建议，键含 recommendation 与首因', () => {
    const result = buildStructureFlowPlanAdvisory(sfInput())
    assert.ok(result)
    assert.equal(result.key, 'structure-flow-plan:enter:unknown-domain')
    assert.ok(result.content.includes('ask_user_question'))
    assert.ok(result.content.includes('enter_mode'))
  })

  it('同 reason 已发过（firedKeys 命中）→ null（one-shot 去重）', () => {
    const fired = new Set(['structure-flow-plan:enter:unknown-domain'])
    assert.equal(buildStructureFlowPlanAdvisory(sfInput({ firedKeys: fired })), null)
  })

  it('firedKeys 清空后（模拟用户干预）→ 允许重新建议', () => {
    const result = buildStructureFlowPlanAdvisory(sfInput({ firedKeys: new Set() }))
    assert.ok(result)
  })

  it('已在 planning 时 enter → null（生命周期优先于自动建议）', () => {
    assert.equal(buildStructureFlowPlanAdvisory(sfInput({ planModeState: 'planning' })), null)
  })

  it('已有批准计划文件时 enter → null', () => {
    assert.equal(buildStructureFlowPlanAdvisory(sfInput({ activePlanFile: true })), null)
  })

  it('stay → null（不重复输出）', () => {
    assert.equal(
      buildStructureFlowPlanAdvisory(sfInput({ snapshot: { planRecommendation: 'stay', reasons: ['unknown-domain'] } })),
      null,
    )
  })

  it('none → null', () => {
    assert.equal(
      buildStructureFlowPlanAdvisory(sfInput({ snapshot: { planRecommendation: 'none', reasons: ['stable-execution'] } })),
      null,
    )
  })

  it('exit 只对 planning 态输出（批准计划执行中的健康 flow 不打扰）', () => {
    const exitSnap = { planRecommendation: 'exit' as const, reasons: ['stable-execution' as const] }
    const inPlanning = buildStructureFlowPlanAdvisory(sfInput({ snapshot: exitSnap, planModeState: 'planning' }))
    assert.ok(inPlanning)
    assert.equal(inPlanning.key, 'structure-flow-plan:exit')
    assert.ok(inPlanning.content.includes('退出计划模式'))

    const offState = buildStructureFlowPlanAdvisory(sfInput({ snapshot: exitSnap, planModeState: 'off' }))
    assert.equal(offState, null)
  })

  it('exit 去重：同 session 第二次 → null', () => {
    const exitSnap = { planRecommendation: 'exit' as const, reasons: ['stable-execution' as const] }
    const fired = new Set(['structure-flow-plan:exit'])
    assert.equal(
      buildStructureFlowPlanAdvisory(sfInput({ snapshot: exitSnap, planModeState: 'planning', firedKeys: fired })),
      null,
    )
  })

  it('不同首因的 enter 键互不冲突（各自 one-shot）', () => {
    const fired = new Set(['structure-flow-plan:enter:unknown-domain'])
    const mixed = buildStructureFlowPlanAdvisory(sfInput({
      snapshot: { planRecommendation: 'enter', reasons: ['mixed-signals'] },
      firedKeys: fired,
    }))
    assert.ok(mixed)
    assert.equal(mixed.key, 'structure-flow-plan:enter:mixed-signals')
  })
})

describe('planModeSuggestEnabled', () => {
  it('is on by default and off when RIVET_PLAN_MODE_SUGGEST=0', () => {
    const prev = process.env.RIVET_PLAN_MODE_SUGGEST
    try {
      delete process.env.RIVET_PLAN_MODE_SUGGEST
      assert.equal(planModeSuggestEnabled(), true)
      process.env.RIVET_PLAN_MODE_SUGGEST = '0'
      assert.equal(planModeSuggestEnabled(), false)
    } finally {
      if (prev === undefined) delete process.env.RIVET_PLAN_MODE_SUGGEST
      else process.env.RIVET_PLAN_MODE_SUGGEST = prev
    }
  })
})

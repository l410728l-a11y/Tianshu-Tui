/**
 * 主动 Plan Mode 建议 — 任务入口识别多模块任务，提示主控询问用户是否先规划。
 *
 * 识别复用既有意图信号：initializeRun 里 classifyPlanMethodology 已把
 * 「多执法文件 / 重构 / system 深度 / 安全关键」任务归为 'full' 方法论——
 * 这正是「值得先进 plan mode 并行调研再动手」的任务形态（对齐 Cursor/Codex
 * 桌面版的主动规划交互）。本模块是纯函数判定；advisory 文案由 wiring 侧组装。
 *
 * one-shot 语义：同一 task contract 只建议一次（用户选「直接执行」后不复问）；
 * 新任务（新 contract id）重新评估。RIVET_PLAN_MODE_SUGGEST=0 整体禁用。
 */

import type { TaskContract, TaskDepthLayer, PlanMethodology, TurnMode } from '../context/task-contract.js'
import type { PlanModeState } from './plan-mode.js'
import type { StructureFlowSnapshot } from './structure-flow-controller.js'

export interface PlanModeSuggestInput {
  turnMode: TurnMode
  contract: TaskContract | undefined
  methodology: PlanMethodology | undefined
  depthLayer: TaskDepthLayer | undefined
  planModeState: PlanModeState
  /** 本会话已建议过的 contract id 集合（one-shot 记忆）。 */
  suggestedContractIds: ReadonlySet<string>
}

export interface PlanModeSuggestion {
  suggest: boolean
  /** 命中理由（advisory 文案 + 遥测用）。 */
  reason: string
}

export function planModeSuggestEnabled(): boolean {
  return process.env.RIVET_PLAN_MODE_SUGGEST !== '0'
}

/** 纯函数：是否建议进入 plan mode。命中条件全部满足才建议。 */
export function shouldSuggestPlanMode(input: PlanModeSuggestInput): PlanModeSuggestion {
  const { contract } = input
  if (input.turnMode !== 'task' || !contract?.isActionable) {
    return { suggest: false, reason: 'not a new actionable task' }
  }
  if (input.planModeState !== 'off') {
    return { suggest: false, reason: 'already planning' }
  }
  if (input.methodology !== 'full') {
    return { suggest: false, reason: 'lightweight methodology — plan overhead not justified' }
  }
  if (input.suggestedContractIds.has(contract.id)) {
    return { suggest: false, reason: 'already suggested for this contract' }
  }

  const parts: string[] = []
  if (input.depthLayer === 'system') parts.push('system 级改动面')
  else if (input.depthLayer === 'wiring') parts.push('跨模块接线')
  const fileCount = contract.scope.mentionedFiles.length
  if (fileCount >= 2) parts.push(`${fileCount} 个文件在 scope`)
  if (/\b(refactor|rewrite|migrat)/i.test(contract.objective) || /重构|重写|迁移/.test(contract.objective)) {
    parts.push('重构信号')
  }
  const reason = parts.length > 0 ? parts.join(' · ') : 'full 方法论命中（多门/安全关键信号）'
  return { suggest: true, reason }
}

// ─── P2 阴阳调度：structure-flow 驱动的 plan 建议（advisory-only）──────
//
// 与上面的任务入口建议（full 方法论 one-shot）互补：本通道由运行中的
// structure-flow 快照驱动——未知域高结构压力时建议进 plan mode，稳定执行
// 区建议收敛计划退出。生命周期幂等由调用方持有的 firedKeys 保证：
// 同一 (recommendation, 首因) 键本 session 只发一次；用户干预或 plan
// 生命周期变化时调用方清空 firedKeys 允许新建议。绝不直接改 plan mode。

export interface StructureFlowPlanAdvisoryInput {
  snapshot: Pick<StructureFlowSnapshot, 'planRecommendation' | 'reasons'>
  planModeState: PlanModeState
  /** 已批准的计划文件在执行中（plan execution session）。 */
  activePlanFile: boolean
  /** 本 session 已发过的建议键（调用方持有；用户干预/生命周期变化时清空）。 */
  firedKeys: ReadonlySet<string>
}

export interface StructureFlowPlanAdvisoryResult {
  key: string
  content: string
}

/** 纯函数：从 structure-flow 快照产出至多一条 plan 建议；不满足门槛 → null。 */
export function buildStructureFlowPlanAdvisory(
  input: StructureFlowPlanAdvisoryInput,
): StructureFlowPlanAdvisoryResult | null {
  const rec = input.snapshot.planRecommendation
  if (rec === 'enter') {
    // 已在 planning / 已有批准计划 → 不建议进入（生命周期优先于自动建议）。
    if (input.planModeState !== 'off' || input.activePlanFile) return null
    const key = `structure-flow-plan:enter:${input.snapshot.reasons[0] ?? 'unknown'}`
    if (input.firedKeys.has(key)) return null
    return {
      key,
      content:
        '结构压力信号持续偏高（认知不确定性/新颖域占优）且当前没有计划上下文。'
        + '如果任务规模成立，考虑用 `ask_user_question` 征询用户是否进入计划模式'
        + '（`plan` 工具 action="enter_mode"，先并行调研再动手）；小任务可忽略本条。',
    }
  }
  if (rec === 'exit') {
    // 只对 planning 态建议退出——批准计划执行中的 flow 是健康形态，不打扰。
    if (input.planModeState !== 'planning') return null
    const key = 'structure-flow-plan:exit'
    if (input.firedKeys.has(key)) return null
    return {
      key,
      content:
        '稳定执行信号持续健康（目标推进+清单推进、认知不确定性低）——当前 plan mode '
        + '的调研开销可能不再必要。可以考虑收敛计划提交审批，或与用户确认后退出计划模式转入执行。',
    }
  }
  // 'stay' 不重复发声；'none' 无建议。
  return null
}

/** 建议 advisory 文案 — 指令主控先用 ask_user_question 征询用户。 */
export function buildPlanModeSuggestAdvisory(reason: string): string {
  return (
    `此任务命中 full 规划方法论（${reason}），当前不在 plan mode。` +
    `在动手前，先调用 \`ask_user_question\` 征询用户，问题为「这个任务涉及多个模块，要先进入计划模式吗？」，` +
    `options 固定两项：「进入计划模式 — 先并行调研相关模块，产出计划供你审批后再动手」和` +
    `「直接执行 — 跳过规划，立即开始改动」。` +
    `用户选择进入计划模式后：调用 \`plan\` 工具 action="enter_mode" 进入，然后用 \`delegate_batch\` 并行派 code_scout 调研。` +
    `用户选择直接执行则正常开工，本任务内不再询问。`
  )
}

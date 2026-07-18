/**
 * collab-branch-advisories — W3 分支消费 advisory 的纯决策层。
 *
 * 输入本 turn 的 route 分支事实 + 会话状态事实，输出「应投递的 advisory 规格」
 * 与「被抑制的分支 + 原因」。决策全部在纯函数内完成（可测的 yielded/selected
 * 结果，不靠优先级猜测），producer 只负责取数与 submit。
 *
 * 规则（计划 Wave 3 过门条件）：
 * - A 前置对齐：branches 含 A ∧ 低置信对齐提示未渲染（渠道去重）∧ 本契约未
 *   触发过（每契约至多一次）∧ 未让位 convergence。
 * - D 诊断优先：branches 含 D ∧ 非 plan mode ∧ 无活跃 PAL 案件 ∧ 未让位
 *   convergence。只标注优先级——不创建案件、不跳过 RED 义务、不改变
 *   regression-bisect-hook 的 5 轮阈值。
 * - CV3 单声源：convergence 相邻轮已发射（wasConvergenceEmittedRecently，
 *   与 CCR/kick 同一让位判据）→ A/D 一律让位，不得双发。
 */

import type { CollabBranch } from './collab-branches.js'

export type CollabAdvisoryBranch = 'A' | 'D'

export interface CollabAdvisorySpec {
  branch: CollabAdvisoryBranch
  key: string
  priority: number
  category: 'star_domain'
  tier: 'informational' | 'operational'
  content: string
  ttl: number
}

export type SuppressionReason =
  | 'low-confidence-advisory-covers-alignment'
  | 'already-fired-for-contract'
  | 'plan-mode-active'
  | 'pal-case-active'
  | 'yielded-to-convergence'

export interface CollabAdvisoryDecision {
  selected: CollabAdvisorySpec[]
  suppressed: Array<{ branch: CollabAdvisoryBranch; reason: SuppressionReason }>
}

export interface CollabAdvisoryInput {
  branches: readonly CollabBranch[]
  /** 任务契约 id（A 按契约一次性去重）；无契约时共用兜底串。 */
  contractId?: string
  /** 本 turn 低置信对齐提示已渲染（route.confidence < 0.6 且非 social_idle）。 */
  lowConfidenceRendered: boolean
  planMode: boolean
  /** 活跃 PAL 案件数（problemAttack.snapshotForCvm()?.activeCases ?? 0）。 */
  palActiveCases: number
  /** convergence 相邻轮已发射（AgentLoop.wasConvergenceEmittedRecently()）。 */
  convergenceEmitted: boolean
  /** A 已触发过的契约 id 集合。 */
  alignFiredContracts: ReadonlySet<string>
}

const ALIGN_CONTENT = '【天权·对齐】任务存在模糊信号。按单问约束：先用一句话确认目标、边界与成功标准再展开；或先 recall_capsule("辅") 做意图保存。'
const DIAGNOSIS_CONTENT = '【瑶光·诊断】入口信号指向诊断类任务：先按成本序取证（读实现→微探针→复现 RED→基线对照）锁定根因再修改；修复后必须 GREEN 回归。可用 attack_case open 开案追踪。'

function contractKey(prefix: string, contractId: string | undefined): string {
  return `${prefix}:${contractId && contractId.length > 0 ? contractId : '(no-contract)'}`
}

export function selectCollabAdvisories(input: CollabAdvisoryInput): CollabAdvisoryDecision {
  const selected: CollabAdvisorySpec[] = []
  const suppressed: CollabAdvisoryDecision['suppressed'] = []

  if (input.branches.includes('A')) {
    const reason: SuppressionReason | null = input.convergenceEmitted
      ? 'yielded-to-convergence'
      : input.lowConfidenceRendered
        ? 'low-confidence-advisory-covers-alignment'
        : input.alignFiredContracts.has(contractKey('collab:align', input.contractId))
          ? 'already-fired-for-contract'
          : null
    if (reason) {
      suppressed.push({ branch: 'A', reason })
    } else {
      selected.push({
        branch: 'A',
        key: contractKey('collab:align', input.contractId),
        priority: 0.5,
        category: 'star_domain',
        tier: 'informational',
        content: ALIGN_CONTENT,
        ttl: 1,
      })
    }
  }

  if (input.branches.includes('D')) {
    const reason: SuppressionReason | null = input.convergenceEmitted
      ? 'yielded-to-convergence'
      : input.planMode
        ? 'plan-mode-active'
        : input.palActiveCases > 0
          ? 'pal-case-active'
          : null
    if (reason) {
      suppressed.push({ branch: 'D', reason })
    } else {
      selected.push({
        branch: 'D',
        key: contractKey('collab:diagnosis', input.contractId),
        priority: 0.7,
        category: 'star_domain',
        tier: 'operational',
        content: DIAGNOSIS_CONTENT,
        ttl: 1,
      })
    }
  }

  return { selected, suppressed }
}

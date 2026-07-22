// W-C7 桥接：把 council 评审产物转成可执行 UnifiedPlan（Da'at 编译门）。
// 铁律：纯函数，零 I/O、零 Date（createdAt 复用 plan.meta.convenedAt 的确定时钟）。

import { unresolvedBlockingConflicts, type CouncilConflict, type CouncilPlan, type PlanItem } from './council-plan.js'
import type { UnifiedPlan, UnifiedTaskNode } from '../unified-plan.js'

type RiskTier = 'low' | 'medium' | 'high'
const SEVERITY_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 }

/** 执行类 profile —— council 任务是代码改动，交给 patcher（role:hands, 写工具集）。 */
const EXECUTOR_PROFILE = 'patcher'

/** 编译门结果：存在未化解 blocking challenge 时拒绝产出计划（否决态）。 */
export interface CouncilCompileResult {
  ok: boolean
  plan?: UnifiedPlan
  /** 未化解的 blocking 冲突（否决依据）。ok=false 时非空。 */
  vetoes: CouncilConflict[]
}

/**
 * Da'at 编译门：裁决 → 可执行契约的唯一入口。
 * 两个消费方（council_convene 工具、serve-agent 桌面路由）都必须经此判定，
 * 否决态没有可执行契约——blocking challenge 未化解时任何一侧都不得产出 planJson。
 */
export function compileCouncilPlan(plan: CouncilPlan): CouncilCompileResult {
  const vetoes = unresolvedBlockingConflicts(plan.aggregate)
  if (vetoes.length > 0) return { ok: false, vetoes }
  return { ok: true, plan: councilPlanToUnifiedPlan(plan), vetoes: [] }
}

/**
 * CouncilPlan → UnifiedPlan（可经 team_orchestrate 的 planJson 直传执行）。
 *
 * 映射：
 *  - 每个 mergedItem → patch_proposal 任务节点；objective 取 detail（空则 title）。
 *  - files 来自席位只读工具定位（缺省空数组 = 全局任务，team 侧并行）。
 *  - riskTier 从各席 risks 按 itemId 聚合最高 severity；无关联默认 medium；
 *    泛化风险（无 itemId）不参与。
 *  - dependsOn 按同文件重叠推导：后声明条目依赖先声明条目（保守规则——不发明
 *    无重叠依赖；mergedItems 序确定，推导结果确定）。
 *  - verification 从席位 challenge.gate 编译：itemId 命中的挂该任务，全局 gate
 *    挂所有任务（波级去重由 wave-gate 处理）——席位质疑变成波间硬验收门。
 *  - metadata.proposedBy 携带提案席位（问责血缘，失败复议召回依据）。
 *  - rejected 决议 → nonGoals（留痕，下游知道哪些方向已被否）。
 *
 * 注：空 mergedItems 时产出 tasks 为空（validateUnifiedPlan 会判 invalid）——
 * 由调用方（council_convene）在产 planJson 前自行判空，本函数只做确定性映射。
 * 否决判定不在本函数——用 compileCouncilPlan 作为消费入口。
 */
export function councilPlanToUnifiedPlan(plan: CouncilPlan): UnifiedPlan {
  const riskByItem = new Map<string, RiskTier>()
  for (const c of plan.contributions) {
    for (const r of c.risks) {
      if (!r.itemId) continue
      const prev = riskByItem.get(r.itemId)
      if (!prev || SEVERITY_RANK[r.severity] > SEVERITY_RANK[prev]) riskByItem.set(r.itemId, r.severity)
    }
  }

  // 验收门收集：challenge.gate → verification（itemId 定向 / 全局）。
  const gatesByItem = new Map<string, string[]>()
  const globalGates: string[] = []
  for (const c of plan.contributions) {
    for (const ch of c.challenges) {
      const gate = ch.gate?.trim()
      if (!gate) continue
      if (ch.itemId) gatesByItem.set(ch.itemId, [...(gatesByItem.get(ch.itemId) ?? []), gate])
      else globalGates.push(gate)
    }
  }

  // dependsOn 推导：同文件重叠时后者依赖前者（先声明者先执行）。
  const seen: Array<{ id: string; files: string[] }> = []
  const dependsFor = (item: PlanItem): string[] => {
    const files = item.files ?? []
    const deps = files.length === 0
      ? []
      : seen.filter(p => p.files.some(f => files.includes(f))).map(p => p.id)
    seen.push({ id: item.id, files })
    return [...new Set(deps)]
  }

  const tasks: UnifiedTaskNode[] = plan.aggregate.mergedItems.map(item => {
    const verification = [...new Set([...(gatesByItem.get(item.id) ?? []), ...globalGates])]
    return {
      id: item.id,
      title: item.title,
      objective: item.detail || item.title,
      profile: EXECUTOR_PROFILE,
      kind: 'patch_proposal' as const,
      files: item.files ?? [],
      dependsOn: dependsFor(item),
      riskTier: riskByItem.get(item.id) ?? 'medium',
      ...(verification.length > 0 ? { verification } : {}),
      metadata: { proposedBy: item.proposedBy ?? 'draft' },
    }
  })

  const nonGoals = plan.aggregate.decisions
    .filter(d => d.verdict === 'rejected')
    .map(d => d.title)

  return {
    version: 1,
    objective: plan.objective,
    tasks,
    source: 'manual',
    createdAt: plan.meta.convenedAt,
    ...(nonGoals.length > 0 ? { nonGoals } : {}),
  }
}

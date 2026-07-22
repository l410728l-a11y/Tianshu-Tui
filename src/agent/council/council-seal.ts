// Atropos 契约密封 —— 织命议事会 Phase 3（命运三女神：剪线者的不可逆封印）。
//
// 机制：契约（UnifiedPlan）批准后密封——内容摘要钉进 seal；此后任何静默改写
// 在执行入口（team_orchestrate 消费点）被硬拦。修订必须走显式豁免协议：
// revisePlanSeal 产出新版本 + 留痕血缘（fromDigest + reason），不可原地涂改。
//
// 铁律（反高概念）：密封不发明新纪律层——强制点全部落在已有硬门
// （plan 消费入口 / wave-gate / deliver_task）。本模块只有纯函数。

import { createHash } from 'node:crypto'
import type { UnifiedPlan, UnifiedTaskNode } from '../unified-plan.js'

/** 豁免留痕：每次修订记录改写理由与前代摘要（血缘可审计）。 */
export interface PlanSealExemption {
  at: number
  reason: string
  /** 修订前的密封摘要——链式血缘，可回溯每一代契约。 */
  fromDigest: string
}

export interface PlanSeal {
  /** 契约版本，密封起为 1，每次豁免修订 +1。 */
  version: number
  /** 契约内容摘要（sha256 前 16 hex）——覆盖 objective + 全任务执行语义字段。 */
  digest: string
  sealedAt: number
  /** 豁免修订链（首封为空）。 */
  exemptions: PlanSealExemption[]
}

/** 携带密封的 UnifiedPlan——seal 挂在计划对象上随 JSON 序列化透传。 */
export type SealedUnifiedPlan = UnifiedPlan & { seal?: PlanSeal }

/** 契约摘要只覆盖执行语义字段：改标题措辞不该破封，改 files/verification/
 *  dependsOn/objective 必须破封。任务按 id 排序保证顺序无关。 */
function contractDigest(plan: UnifiedPlan): string {
  const normalizeTask = (t: UnifiedTaskNode) => ({
    id: t.id,
    objective: t.objective,
    files: [...t.files].sort(),
    dependsOn: [...t.dependsOn].sort(),
    verification: [...(t.verification ?? [])].sort(),
    riskTier: t.riskTier,
  })
  const body = JSON.stringify({
    objective: plan.objective,
    tasks: [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id)).map(normalizeTask),
  })
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** 首封：为契约计算摘要并挂 seal（version 1，零豁免）。已密封计划重封视为编程错误。 */
export function sealPlan(plan: UnifiedPlan, now: number = Date.now()): SealedUnifiedPlan {
  const existing = (plan as SealedUnifiedPlan).seal
  if (existing) throw new Error(`plan already sealed (v${existing.version}) — 修订走 revisePlanSeal 豁免协议，不可重封`)
  return {
    ...plan,
    seal: { version: 1, digest: contractDigest(plan), sealedAt: now, exemptions: [] },
  }
}

export type SealCheck =
  | { status: 'unsealed' }
  | { status: 'intact'; version: number }
  | { status: 'broken'; version: number; expected: string; actual: string }

/** 校验密封：重算摘要与 seal.digest 比对。未密封计划返回 unsealed（向后兼容——
 *  非议事会产出的计划不强制密封）。 */
export function verifyPlanSeal(plan: SealedUnifiedPlan): SealCheck {
  if (!plan.seal) return { status: 'unsealed' }
  const actual = contractDigest(plan)
  if (actual === plan.seal.digest) return { status: 'intact', version: plan.seal.version }
  return { status: 'broken', version: plan.seal.version, expected: plan.seal.digest, actual }
}

/** 豁免修订：对（已被修改的）契约产出下一版密封——version+1、留痕理由与前代摘要。
 *  reason 必填非空：无理由的豁免等于静默改写。 */
export function revisePlanSeal(plan: SealedUnifiedPlan, reason: string, now: number = Date.now()): SealedUnifiedPlan {
  if (!plan.seal) throw new Error('plan is not sealed — 未密封契约直接改写即可，无需豁免')
  if (!reason.trim()) throw new Error('revisePlanSeal requires a non-empty reason — 无理由豁免等于静默改写')
  return {
    ...plan,
    seal: {
      version: plan.seal.version + 1,
      digest: contractDigest(plan),
      sealedAt: now,
      exemptions: [...plan.seal.exemptions, { at: now, reason: reason.trim(), fromDigest: plan.seal.digest }],
    },
  }
}

/** 渲染密封状态行（工具输出/面板用）。 */
export function formatSealStatus(plan: SealedUnifiedPlan): string {
  if (!plan.seal) return '契约未密封'
  const check = verifyPlanSeal(plan)
  const lineage = plan.seal.exemptions.length > 0
    ? `（${plan.seal.exemptions.length} 次豁免修订，最近：${plan.seal.exemptions.at(-1)!.reason}）`
    : ''
  return check.status === 'intact'
    ? `🔏 契约已密封 v${plan.seal.version} · ${plan.seal.digest}${lineage}`
    : `⛔ 契约密封破损 v${plan.seal.version}：内容与密封摘要不符（expected ${plan.seal.digest}, actual ${(check as { actual: string }).actual}）——已密封契约不可静默改写，走 revisePlanSeal 豁免协议`
}

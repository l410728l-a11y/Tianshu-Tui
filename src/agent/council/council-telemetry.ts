// 议事会会诊遥测 —— append-only，落 MeridianDb p3_state（经 saveBanditState）。
// 铁律：唯一 key 含 timestamp，同 objective 多次会诊不互相覆盖
// （saveBanditState 是 ON CONFLICT(kind) UPSERT）。遥测绝不影响会诊。

import type { CouncilPlan } from './council-plan.js'

export interface CouncilTelemetryStore {
  saveBanditState(kind: string, json: string): void
}

export interface CouncilSessionEvent {
  schemaVersion: 1
  sessionId: string
  objective: string
  objectiveHash: string
  seats: string[]
  roundsRun: number
  decisionCount: number
  acceptedCount: number
  rejectedCount: number
  deferredCount: number
  conflictCount: number
  mergedItemCount: number
  convenedAt: number
  timestamp: number
  // ── Phase 2: 分歧度遥测 —— 回答「同模型戴星域面具是不是自我对话」──
  /** 是否三柱模式（pillars:true）会诊。 */
  pillarsMode: boolean
  /** 首轮席位实际用到的模型（去重排序；缺 modelUsed 的席位不计入）。 */
  modelsUsed: string[]
  /** 唯一模型数 > 1 —— 异构议事会。与 divergenceScore 联查验证对抗真实性。 */
  heterogeneous: boolean
  /** 冲突数 / 首轮席位数，截断到 [0,1]。同模型 vs 异构的分歧度对比指标。 */
  divergenceScore: number
}

/** append-only key —— sessionId + objectiveHash + timestamp 三元唯一。 */
export function councilSessionKey(
  e: Pick<CouncilSessionEvent, 'sessionId' | 'objectiveHash' | 'timestamp'>,
): string {
  return `council_session:${e.sessionId}:${e.objectiveHash}:${e.timestamp}`
}

export function buildCouncilSessionEvent(input: {
  sessionId: string
  plan: CouncilPlan
  timestamp: number
  /** 三柱模式标记（council_convene pillars:true 时传真）。 */
  pillars?: boolean
}): CouncilSessionEvent {
  const { plan } = input
  const decisions = plan.aggregate.decisions
  const round1 = plan.contributions.filter(c => (c.round ?? 1) === 1)
  const modelsUsed = [...new Set(round1.map(c => c.modelUsed).filter((m): m is string => Boolean(m)))].sort()
  const divergenceScore = round1.length > 0
    ? Math.min(1, plan.aggregate.conflicts.length / round1.length)
    : 0
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objective: plan.objective,
    objectiveHash: plan.meta.objectiveHash,
    seats: plan.seats,
    roundsRun: plan.meta.round,
    decisionCount: decisions.length,
    acceptedCount: decisions.filter(d => d.verdict === 'accepted').length,
    rejectedCount: decisions.filter(d => d.verdict === 'rejected').length,
    deferredCount: decisions.filter(d => d.verdict === 'deferred').length,
    conflictCount: plan.aggregate.conflicts.length,
    mergedItemCount: plan.aggregate.mergedItems.length,
    convenedAt: plan.meta.convenedAt,
    timestamp: input.timestamp,
    pillarsMode: input.pillars ?? false,
    modelsUsed,
    heterogeneous: modelsUsed.length > 1,
    divergenceScore,
  }
}

export function recordCouncilSession(
  store: CouncilTelemetryStore | undefined | null,
  event: CouncilSessionEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(councilSessionKey(event), JSON.stringify(event))
  } catch {
    // 遥测绝不影响会诊。
  }
}

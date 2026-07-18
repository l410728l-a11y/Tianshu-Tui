/**
 * PAL（复杂问题攻坚层）— 纯 reducer 核心（计划 v2 Wave P1）。
 *
 * 职责：管理"竞争假设 → 判别探针 → 证据支持/反驳 → 收敛"的搜索状态。
 * 设计红线（.rivet/plans/复杂问题攻坚层-pal.md v2）：
 *   - 模型（经 attack_case 工具）只能**提出**假设/探针；supported/refuted 是
 *     reducer 对 `probe_observed + predicateOutcome + perHypothesis` 的推导
 *     结果，不存在外部直接 set status 的事件类型（后门封死）。
 *   - probe 预期是机器可判定谓词（ProbeExpectation），不是自由文本——
 *     informative 判定不依赖字符串比对模型的话。
 *   - reducer 无 IO、无时钟、无随机；相同事件序列产生相同状态序列。
 *   - 稳定 ID：规范化文本 + 排序 targets + 父 case hash，无时间戳/随机数。
 *   - 硬预算：假设 ≤4、probes ≤12、attack turns ≤15，超限强制 needs_user。
 *
 * 鼓励机制（2026-07-17 需求）：**有效动作加分**——分数只来自 reducer 推导的
 * 证据增益事实（探针出信息 +2 / 淘汰假设 +3 / 假设获证 +3 / 复现成功 +1 /
 * 并行委派探针出结果 +2 / 案件收敛 +5），模型自报不计分。分数经 attack_case
 * 工具回执回流给主控（cache-safe，不占 advisory 预算），让"做探针、做排除、
 * 做复现、并行委派"成为被显式奖励的行为。
 */

// ─── 类型 ─────────────────────────────────────────────────────────

export type HypothesisStatus = 'candidate' | 'supported' | 'refuted' | 'blocked' | 'inconclusive'
export type ProbeKind = 'read' | 'grep' | 'lsp' | 'micro_probe' | 'targeted_test' | 'baseline_diff' | 'instrument' | 'simulate' | 'ask_user'
export type ProbeStatus = 'planned' | 'attempted' | 'informative' | 'uninformative' | 'blocked'
export type CaseStatus = 'forming' | 'probing' | 'converged' | 'blocked' | 'needs_user' | 'closed'

/** 机器可判定的探针预期——informative 判定不依赖自由文本比对。 */
export type ProbeExpectation =
  | { kind: 'pattern_found'; path: string; needle: string }
  | { kind: 'pattern_absent'; path: string; needle: string }
  | { kind: 'test_outcome'; target: string; expect: 'pass' | 'fail' }
  | { kind: 'tool_error_class'; tool: string; errorClass: string }
  | { kind: 'command_output_matches'; commandIncludes: string; outputPattern: string }

/** 谓词为真/假时对某假设的效果方向。 */
export type ProbeEffect = 'supports' | 'refutes' | 'neutral'

export interface ProbeHypothesisLink {
  hypothesisId: string
  ifTrue: ProbeEffect
  /** 谓词为假时的效果。缺省 neutral——"没找到"不自动等于反驳，
   *  只有假设明确预言"必须找到"时才填 refutes。 */
  ifFalse?: ProbeEffect
}

export interface AttackAnchor {
  kind: 'obligation' | 'trace_step' | 'failure_pattern' | 'user_report'
  ref: string
}

export interface AttackHypothesis {
  id: string
  claim: string
  targets: readonly string[]
  status: HypothesisStatus
  evidenceRefs: readonly string[]
  attempts: number
  lastTurn: number
}

export interface DiscriminatorProbe {
  id: string
  hypothesisIds: readonly string[]
  kind: ProbeKind
  target: string
  expectation: ProbeExpectation
  perHypothesis: readonly ProbeHypothesisLink[]
  risk: 'low' | 'medium' | 'high'
  status: ProbeStatus
  evidenceRef?: string
  turn?: number
}

export interface ProblemAttackState {
  caseId: string
  anchor: AttackAnchor
  problem: string
  hypotheses: readonly AttackHypothesis[]
  probes: readonly DiscriminatorProbe[]
  selectedHypothesisId?: string
  status: CaseStatus
  /** 消耗的攻坚轮数（出现过事件的不同 turn 数） */
  activeAttackTurns: number
  lastEventTurn: number
  /** 累计得分（鼓励机制）——只由 reducer 推导的证据增益事实累加 */
  score: number
  version: number
}

// ─── 计分 ─────────────────────────────────────────────────────────

export type AttackScoreKind =
  | 'probe_informative'
  | 'hypothesis_refuted'
  | 'hypothesis_supported'
  | 'reproduction'
  | 'parallel_probe'
  | 'case_converged'

export const ATTACK_SCORE_POINTS: Record<AttackScoreKind, number> = {
  probe_informative: 2,
  hypothesis_refuted: 3,
  hypothesis_supported: 3,
  reproduction: 1,
  parallel_probe: 2,
  case_converged: 5,
}

export interface AttackScoreEvent {
  kind: AttackScoreKind
  points: number
  turn: number
  probeId?: string
  hypothesisId?: string
}

// ─── 预算 ─────────────────────────────────────────────────────────

export const MAX_ACTIVE_HYPOTHESES = 4
export const MAX_PROBES_PER_CASE = 12
export const MAX_ATTACK_TURNS = 15

// ─── 事件 ─────────────────────────────────────────────────────────

export interface AttackEvent {
  type:
    | 'case_opened'
    | 'hypothesis_added'
    | 'probe_planned'
    | 'probe_attempted'
    | 'probe_observed'
    | 'probe_blocked'
    | 'case_closed'
  caseId: string
  turn: number
  // case_opened
  anchor?: AttackAnchor
  problem?: string
  // hypothesis_added
  claim?: string
  targets?: readonly string[]
  /** H3 单调性：needs_user 状态只能由携带用户事实的假设解锁（模型自证不算）。 */
  userFact?: boolean
  // probe_planned
  probe?: {
    hypothesisIds: readonly string[]
    kind: ProbeKind
    target: string
    expectation: ProbeExpectation
    perHypothesis: readonly ProbeHypothesisLink[]
    risk?: 'low' | 'medium' | 'high'
  }
  // probe_attempted / probe_observed / probe_blocked
  probeId?: string
  evidenceRef?: string
  predicateOutcome?: 'true' | 'false' | 'unobservable'
  /** 并行委派证据：探针结算发生在 delegate 派发窗口内（parallel_probe 加分） */
  viaDelegation?: boolean
  /** H2 引用验真结果（调用方对账本核验后传入）。false = 引用无法验真
   *  （如 tool: 引用超出工具历史窗口）——状态照常结算但**零分**，
   *  evidenceRef 以 unverified: 前缀落账。缺省 true（hook 自动结算的引用
   *  由真实工具事件自构造，天然可信）。 */
  evidenceVerified?: boolean
  // case_closed
  resolution?: 'converged' | 'abandoned' | 'resolved_externally'
}

export interface AttackReduceResult {
  state: ProblemAttackState
  /** 本事件推导出的加分（鼓励机制回执/遥测消费） */
  scored: readonly AttackScoreEvent[]
  /** 事件被拒绝的原因（幂等重复/预算超限/约束违反）。undefined = 已接受。 */
  rejected?: string
}

// ─── 稳定 ID ──────────────────────────────────────────────────────

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function caseIdFor(anchor: AttackAnchor, problem: string): string {
  return `case-${fnv1a(`${anchor.kind}:${anchor.ref}:${normalize(problem)}`)}`
}

export function hypothesisIdFor(caseId: string, claim: string, targets: readonly string[]): string {
  return `hyp-${fnv1a(`${caseId}:${normalize(claim)}:${[...targets].sort().join(',')}`)}`
}

export function probeIdFor(caseId: string, target: string, expectation: ProbeExpectation): string {
  return `probe-${fnv1a(`${caseId}:${normalize(target)}:${JSON.stringify(expectation)}`)}`
}

// ─── Reducer ─────────────────────────────────────────────────────

export function emptyAttackState(caseId: string): ProblemAttackState {
  return {
    caseId,
    anchor: { kind: 'user_report', ref: '' },
    problem: '',
    hypotheses: [],
    probes: [],
    status: 'forming',
    activeAttackTurns: 0,
    lastEventTurn: -1,
    score: 0,
    version: 0,
  }
}

function accept(state: ProblemAttackState, scored: AttackScoreEvent[] = []): AttackReduceResult {
  // H3：任何被接受的事件后统一检查预算饱和——触顶且仍在搜索态 → needs_user
  return { state: { ...saturateBudget(state), version: state.version + 1 }, scored }
}

function reject(state: ProblemAttackState, reason: string): AttackReduceResult {
  return { state, scored: [], rejected: reason }
}

/** 存活假设 = 仍参与区分竞争的（candidate/inconclusive）。 */
function isLive(h: AttackHypothesis): boolean {
  return h.status === 'candidate' || h.status === 'inconclusive'
}

/** 消耗攻坚轮预算（出现新 turn 才计一轮）。H3 不变量：计数器 clamp 在
 *  MAX_ATTACK_TURNS——任何事件路径都不可能让 activeAttackTurns 超上限。 */
function tickTurn(state: ProblemAttackState, turn: number): ProblemAttackState {
  if (turn <= state.lastEventTurn) return state
  return {
    ...state,
    lastEventTurn: turn,
    activeAttackTurns: Math.min(state.activeAttackTurns + 1, MAX_ATTACK_TURNS),
  }
}

/** H3 统一预算守卫：扩张搜索类事件（加假设/加探针）在预算耗尽后的新 turn
 *  一律拒绝。结算类事件（observe/blocked/close）不受限——已派出的探针结果
 *  仍可入账，但不能再扩张搜索空间。 */
function budgetGuard(state: ProblemAttackState, eventTurn: number): string | null {
  if (eventTurn > state.lastEventTurn && state.activeAttackTurns >= MAX_ATTACK_TURNS) {
    return `budget: max ${MAX_ATTACK_TURNS} attack turns reached — settle outstanding probes, escalate to user, or close (reopen with new user facts requires a fresh case)`
  }
  return null
}

/** H3 预算饱和：计数触顶且仍在搜索态 → 强制 needs_user（单调，不可自复活）。 */
function saturateBudget(state: ProblemAttackState): ProblemAttackState {
  if (
    state.activeAttackTurns >= MAX_ATTACK_TURNS
    && (state.status === 'probing' || state.status === 'forming')
  ) {
    return { ...state, status: 'needs_user' }
  }
  return state
}

/** 收敛判定：唯一 supported 且无其他存活假设 → converged。 */
function evaluateConvergence(state: ProblemAttackState, turn: number, scored: AttackScoreEvent[]): ProblemAttackState {
  if (state.status === 'converged' || state.status === 'closed') return state
  const supported = state.hypotheses.filter(h => h.status === 'supported')
  const live = state.hypotheses.filter(isLive)
  if (supported.length === 1 && live.length === 0) {
    scored.push({ kind: 'case_converged', points: ATTACK_SCORE_POINTS.case_converged, turn })
    return { ...state, status: 'converged', selectedHypothesisId: supported[0]!.id }
  }
  // 全部被淘汰/终态且无 supported → 假设空间清空，需要新解释或用户输入
  if (state.hypotheses.length > 0 && live.length === 0 && supported.length === 0) {
    return { ...state, status: 'needs_user' }
  }
  // 预算耗尽 → needs_user 由 accept() 统一经 saturateBudget 处理
  return state
}

export function reduceAttackState(state: ProblemAttackState, event: AttackEvent): AttackReduceResult {
  if (event.caseId !== state.caseId) return reject(state, `caseId mismatch: ${event.caseId}`)
  if (state.status === 'closed') return reject(state, 'case is closed')

  switch (event.type) {
    case 'case_opened': {
      if (state.version > 0) return reject(state, 'case already opened (duplicate event)')
      const anchor = event.anchor
      // 开案锚事实是硬闸门：无锚 = 随口猜测包装成案件，拒绝。
      if (!anchor || !anchor.ref.trim()) return reject(state, 'anchor required: bind to obligation/trace_step/failure_pattern/user_report')
      if (!event.problem?.trim()) return reject(state, 'problem statement required')
      return accept(tickTurn({
        ...state,
        anchor,
        problem: event.problem.trim(),
        status: 'forming',
      }, event.turn))
    }

    case 'hypothesis_added': {
      if (state.version === 0) return reject(state, 'case not opened')
      // H3 单调性：needs_user 只能被用户来源的事实解锁——模型自己再编一条
      // 假设不能复活案件（8.4 审查定位的预算绕过路径）。
      if (state.status === 'needs_user' && event.userFact !== true) {
        return reject(state, 'needs_user: hypothesis space exhausted — only a user-sourced fact (userFact) can reopen probing, or close the case')
      }
      // H3 预算：新 turn 上的搜索扩张在预算耗尽后拒绝（userFact 也不豁免——
      // 预算耗尽的案件应 close 后携新事实重开，保持单调终止）。
      const budget = budgetGuard(state, event.turn)
      if (budget) return reject(state, budget)
      const claim = event.claim?.trim()
      if (!claim) return reject(state, 'claim required')
      const targets = event.targets ?? []
      const id = hypothesisIdFor(state.caseId, claim, targets)
      if (state.hypotheses.some(h => h.id === id)) return reject(state, `duplicate hypothesis (normalized): ${id}`)
      const liveCount = state.hypotheses.filter(isLive).length
      if (liveCount >= MAX_ACTIVE_HYPOTHESES) return reject(state, `budget: max ${MAX_ACTIVE_HYPOTHESES} live hypotheses`)
      const hypothesis: AttackHypothesis = {
        id, claim, targets, status: 'candidate', evidenceRefs: [], attempts: 0, lastTurn: event.turn,
      }
      return accept(tickTurn({
        ...state,
        hypotheses: [...state.hypotheses, hypothesis],
        status: state.status === 'forming' || state.status === 'needs_user' ? 'probing' : state.status,
      }, event.turn))
    }

    case 'probe_planned': {
      if (state.version === 0) return reject(state, 'case not opened')
      const p = event.probe
      if (!p) return reject(state, 'probe payload required')
      // H3 单调性：needs_user 状态下不能规划新探针——先经 userFact 假设解锁
      // 回 probing，或 close。
      if (state.status === 'needs_user') {
        return reject(state, 'needs_user: no live search — add a user-fact hypothesis (userFact) or close before planning probes')
      }
      const budget = budgetGuard(state, event.turn)
      if (budget) return reject(state, budget)
      if (state.probes.length >= MAX_PROBES_PER_CASE) return reject(state, `budget: max ${MAX_PROBES_PER_CASE} probes`)
      const unknownHyp = p.hypothesisIds.find(hid => !state.hypotheses.some(h => h.id === hid))
      if (unknownHyp) return reject(state, `unknown hypothesis: ${unknownHyp}`)
      if (p.perHypothesis.some(l => !p.hypothesisIds.includes(l.hypothesisId))) {
        return reject(state, 'perHypothesis references hypothesis outside hypothesisIds')
      }
      const id = probeIdFor(state.caseId, p.target, p.expectation)
      if (state.probes.some(pr => pr.id === id)) return reject(state, `duplicate probe: ${id}`)
      const probe: DiscriminatorProbe = {
        id,
        hypothesisIds: p.hypothesisIds,
        kind: p.kind,
        target: p.target,
        expectation: p.expectation,
        perHypothesis: p.perHypothesis,
        risk: p.risk ?? 'low',
        status: 'planned',
      }
      return accept(tickTurn({ ...state, probes: [...state.probes, probe], status: 'probing' }, event.turn))
    }

    case 'probe_attempted': {
      const probe = state.probes.find(p => p.id === event.probeId)
      if (!probe) return reject(state, `unknown probe: ${event.probeId}`)
      if (probe.status !== 'planned' && probe.status !== 'attempted') {
        return reject(state, `probe already settled: ${probe.status}`)
      }
      const probes = state.probes.map(p => p.id === probe.id ? { ...p, status: 'attempted' as const, turn: event.turn } : p)
      const hypotheses = state.hypotheses.map(h =>
        probe.hypothesisIds.includes(h.id) ? { ...h, attempts: h.attempts + 1, lastTurn: event.turn } : h)
      return accept(tickTurn({ ...state, probes, hypotheses }, event.turn))
    }

    case 'probe_observed': {
      const probe = state.probes.find(p => p.id === event.probeId)
      if (!probe) return reject(state, `unknown probe: ${event.probeId}`)
      if (probe.status === 'informative' || probe.status === 'uninformative' || probe.status === 'blocked') {
        return reject(state, `probe already settled: ${probe.status} (duplicate observation)`)
      }
      const outcome = event.predicateOutcome
      if (!outcome) return reject(state, 'predicateOutcome required (settled by hook/observe, not by claim)')

      const scored: AttackScoreEvent[] = []

      if (outcome === 'unobservable') {
        const probes = state.probes.map(p => p.id === probe.id ? { ...p, status: 'uninformative' as const, turn: event.turn } : p)
        let next = tickTurn({ ...state, probes }, event.turn)
        next = evaluateConvergence(next, event.turn, scored)
        next = { ...next, score: next.score + scored.reduce((s, e) => s + e.points, 0) }
        return accept(next, scored)
      }

      // 谓词可观察 → 依 perHypothesis 方向推导假设状态迁移
      if (!event.evidenceRef) return reject(state, 'evidenceRef required for observable outcome')
      // H2：验不上的引用（tool: 超出历史窗口等）状态照常结算，但零分入账、
      // 引用带 unverified: 前缀留痕——刷分通道封死，窗口淘汰不受惩罚。
      const verified = event.evidenceVerified !== false
      const storedRef = verified ? event.evidenceRef : `unverified:${event.evidenceRef}`
      const predicateTrue = outcome === 'true'
      let anyEffect = false
      let hypotheses = state.hypotheses
      for (const link of probe.perHypothesis) {
        const effect = predicateTrue ? link.ifTrue : (link.ifFalse ?? 'neutral')
        if (effect === 'neutral') continue
        hypotheses = hypotheses.map(h => {
          if (h.id !== link.hypothesisId) return h
          // blocked 假设不得由单次谓词翻成 supported（需要显式新证据链路，v1 保守不翻）
          if (h.status === 'blocked') return h
          // 已终态（refuted/supported）不重复迁移、不重复计分
          if (h.status === 'refuted' || h.status === 'supported') return h
          anyEffect = true
          if (effect === 'supports') {
            scored.push({ kind: 'hypothesis_supported', points: ATTACK_SCORE_POINTS.hypothesis_supported, turn: event.turn, hypothesisId: h.id, probeId: probe.id })
            return { ...h, status: 'supported' as const, evidenceRefs: [...h.evidenceRefs, storedRef], lastTurn: event.turn }
          }
          scored.push({ kind: 'hypothesis_refuted', points: ATTACK_SCORE_POINTS.hypothesis_refuted, turn: event.turn, hypothesisId: h.id, probeId: probe.id })
          return { ...h, status: 'refuted' as const, evidenceRefs: [...h.evidenceRefs, storedRef], lastTurn: event.turn }
        })
      }

      const informative = anyEffect
      if (informative) {
        scored.unshift({ kind: 'probe_informative', points: ATTACK_SCORE_POINTS.probe_informative, turn: event.turn, probeId: probe.id })
        // 复现奖励：测试/仿真/插桩类探针以"预期失败"谓词为真 = 让缺陷红起来了
        if (
          (probe.kind === 'targeted_test' || probe.kind === 'micro_probe' || probe.kind === 'instrument' || probe.kind === 'simulate')
          && probe.expectation.kind === 'test_outcome'
          && probe.expectation.expect === 'fail'
          && predicateTrue
        ) {
          scored.push({ kind: 'reproduction', points: ATTACK_SCORE_POINTS.reproduction, turn: event.turn, probeId: probe.id })
        }
        // 并行委派奖励：探针结算发生在委派窗口内——不阻塞主线的验证值得强化
        if (event.viaDelegation) {
          scored.push({ kind: 'parallel_probe', points: ATTACK_SCORE_POINTS.parallel_probe, turn: event.turn, probeId: probe.id })
        }
      }

      const probes = state.probes.map(p => p.id === probe.id
        ? { ...p, status: informative ? 'informative' as const : 'uninformative' as const, evidenceRef: storedRef, turn: event.turn }
        : p)
      let next = tickTurn({ ...state, probes, hypotheses }, event.turn)
      // 收敛判定可能追加 case_converged 加分——先判定后统一入账
      next = evaluateConvergence(next, event.turn, scored)
      // H2 零分降级：未验真的证据完成状态迁移但不产生任何加分（含 converged 分）
      const granted = verified ? scored : []
      next = { ...next, score: next.score + granted.reduce((s, e) => s + e.points, 0) }
      return accept(next, granted)
    }

    case 'probe_blocked': {
      const probe = state.probes.find(p => p.id === event.probeId)
      if (!probe) return reject(state, `unknown probe: ${event.probeId}`)
      if (probe.status === 'informative' || probe.status === 'uninformative' || probe.status === 'blocked') {
        return reject(state, `probe already settled: ${probe.status}`)
      }
      const probes = state.probes.map(p => p.id === probe.id ? { ...p, status: 'blocked' as const, turn: event.turn } : p)
      // 约束：blocked 不产生任何假设状态迁移（尤其不得 supported）
      return accept(tickTurn({ ...state, probes }, event.turn))
    }

    case 'case_closed': {
      if (state.version === 0) return reject(state, 'case not opened')
      const resolution = event.resolution ?? 'abandoned'
      // 不能声称 converged 收案，除非 reducer 已经推导出 converged
      if (resolution === 'converged' && state.status !== 'converged') {
        return reject(state, 'cannot close as converged: no reducer-derived converged state')
      }
      return accept(tickTurn({ ...state, status: 'closed' }, event.turn))
    }
  }
}

// ─── 判别探针选择（确定性打分，v2 ③）─────────────────────────────

const RISK_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 }
const KIND_RANK: Record<ProbeKind, number> = {
  read: 0, grep: 1, lsp: 2, micro_probe: 3, targeted_test: 4, baseline_diff: 5, instrument: 6, simulate: 7, ask_user: 8,
}

/** 效果指纹——两假设在该 probe 下指纹不同 = 可区分。 */
function effectProfile(probe: DiscriminatorProbe, hypothesisId: string): string {
  const link = probe.perHypothesis.find(l => l.hypothesisId === hypothesisId)
  if (!link) return 'neutral:neutral'
  return `${link.ifTrue}:${link.ifFalse ?? 'neutral'}`
}

/** 区分力 = 可区分存活假设对数 ×10 + 非中性存活假设数（单假设场景仍可选出探针）。 */
export function discriminatingPower(probe: DiscriminatorProbe, live: readonly AttackHypothesis[]): number {
  const linked = live.filter(h => probe.hypothesisIds.includes(h.id))
  let pairs = 0
  for (let i = 0; i < linked.length; i++) {
    for (let j = i + 1; j < linked.length; j++) {
      if (effectProfile(probe, linked[i]!.id) !== effectProfile(probe, linked[j]!.id)) pairs++
    }
  }
  const nonNeutral = linked.filter(h => effectProfile(probe, h.id) !== 'neutral:neutral').length
  return pairs * 10 + nonNeutral
}

/**
 * 选择下一个判别探针：planned 状态中区分力最高者。
 * 排序：区分力降序 → 风险升序 → kind 升序（read 最便宜）→ id 字典序。
 * 全部区分力为 0（没有探针能对存活假设产生非中性效果）→ null（needs_user，不随机选）。
 */
export function chooseDiscriminator(state: ProblemAttackState): DiscriminatorProbe | null {
  if (state.status === 'closed' || state.status === 'converged') return null
  const live = state.hypotheses.filter(isLive)
  if (live.length === 0) return null
  const planned = state.probes.filter(p => p.status === 'planned')
  if (planned.length === 0) return null
  const scoredProbes = planned
    .map(p => ({ p, power: discriminatingPower(p, live) }))
    .filter(x => x.power > 0)
  if (scoredProbes.length === 0) return null
  scoredProbes.sort((a, b) =>
    b.power - a.power
    || RISK_RANK[a.p.risk] - RISK_RANK[b.p.risk]
    || KIND_RANK[a.p.kind] - KIND_RANK[b.p.kind]
    || (a.p.id < b.p.id ? -1 : 1))
  return scoredProbes[0]!.p
}

/** P3：案件是否还有未结算探针（planned/attempted）——stalled 判定与 CV3 阶梯用。 */
export function hasRemainingPlannedProbes(state: ProblemAttackState): boolean {
  return state.probes.some(p => p.status === 'planned' || p.status === 'attempted')
}

/** 幸存假设：未被反驳/未受阻的解释（candidate/inconclusive/supported）。 */
export function survivingHypotheses(state: ProblemAttackState): AttackHypothesis[] {
  return state.hypotheses.filter(h => h.status === 'candidate' || h.status === 'inconclusive' || h.status === 'supported')
}

/**
 * W3 升级出口（needs_user）：最小用户决策问题的推导。优先级：
 * ① 已计划的 ask_user 探针（模型自己写过判别问题）→ 直接用它的 target；
 * ② ≥2 条幸存假设 → 让用户区分它们（或提供可区分事实）；
 * ③ 恰 1 条 → 请求支持/反驳它的事实；
 * ④ 全灭 → 请求新观察事实。
 *
 * 遗产回收 W-A1：从 tools/attack-case.ts 搬家至此——它依赖
 * ProblemAttackState 内部结构（probes 找 ask_user、hypotheses 过滤幸存），
 * 语义属于 PAL reducer 域；store 快照与工具回执共用这一份实现。
 */
export function minimalUserQuestion(state: ProblemAttackState, surviving: readonly { claim: string }[] = survivingHypotheses(state)): string {
  const askProbe = state.probes.find(p => p.kind === 'ask_user' && p.status === 'planned')
  if (askProbe) return askProbe.target
  if (surviving.length >= 2) {
    return `哪个解释更符合实际：${surviving.map(h => `「${h.claim}」`).join(' vs ')}？（或提供能区分它们的事实）`
  }
  if (surviving.length === 1) {
    return `「${surviving[0]!.claim}」缺乏可判别证据——能否提供支持或反驳它的事实（错误原文/复现步骤/环境差异）？`
  }
  return '所有假设已被排除——请提供新的观察事实或方向（错误信息原文/复现步骤/最近变更）。'
}

// ─── Session 级 store（mutation 隔离在此，reducer 保持纯）──────────

export interface AppliedAttackEvent {
  event: AttackEvent
  scored: readonly AttackScoreEvent[]
  rejected?: string
  version: number
}

/** H4-C evidence registry 事件留痕（telemetry 消费）。 */
export interface EvidenceLogEntry {
  action: 'registered' | 'resolved' | 'consumed' | 'expired' | 'rejected'
  evidenceId: string
  producer: EvidenceProducer
  ref: string
  caseId: string
  probeId: string | null
  turn: number
  /** resolve 时的 scope 校验信息（仅 resolved/rejected 填充）。 */
  scopeMatch?: boolean
  rejectReason?: string
  /** R1：expired 事件的过期发生轮（turn 字段保持注册轮语义）。 */
  expiredAtTurn?: number
}

export const MAX_CONCURRENT_CASES = 2

/** H4-D2：证据在注册后 MAX_EVIDENCE_AGE_TURNS 轮内有效，超期自动 expired。
 *  确定性 TTL（基于 turn 差值），不使用 Date.now()。 */
export const MAX_EVIDENCE_AGE_TURNS = 8

/** R2：快照中 completedWorkers 的近期保留上限（被证据引用的额外保留）。 */
export const COMPLETED_WORKERS_SNAPSHOT_CAP = 32

// ─── H4 Evidence Registry（生产证据生命周期）───────────────────────

export type EvidenceProducer = 'tool' | 'worker' | 'obligation' | 'verification'
export type EvidenceStatus = 'available' | 'consumed' | 'expired'

export interface EvidenceRecord {
  evidenceId: string
  producer: EvidenceProducer
  caseId: string
  /** 注册时可绑定探针（postTool 自动结算时已知），缺省则为 null。 */
  probeId: string | null
  turn: number
  /** 原始引用字符串（如 "tool:grep:3"），用于回放与审计。 */
  ref: string
  /** 可选的负载摘要（如测试命令输出 hash），不进入冻结前缀。 */
  payloadDigest?: string
  status: EvidenceStatus
}

/** 确定性 evidence ID——相同 producer+ref+case+probe 产生相同 ID。 */
export function evidenceIdFor(
  producer: EvidenceProducer,
  ref: string,
  caseId: string,
  probeId?: string | null,
): string {
  return `ev-${fnv1a(`${producer}:${ref}:${caseId}:${probeId ?? ''}`)}`
}

/**
 * 会话级案件容器。attack_case 工具与 problem-attack-hook 共享同一实例
 * （loop 持有）。所有变更走 apply() 单入口，全量留痕供遥测落盘与回放。
 */
export class ProblemAttackStore {
  private cases = new Map<string, ProblemAttackState>()
  private log: AppliedAttackEvent[] = []
  /** delegate_task/delegate_batch 最近派发的 turn（并行探针加分窗口） */
  private lastDelegationTurn = -Infinity
  /** H4-D4：已完成 worker orderId 集合（worker 证据最低验证条件）。 */
  private completedWorkers = new Set<string>()
  /** 虚空仓库 P0：已收割进知识库的案件 id（防跨 turn / 跨会话重复收割，
   *  随 exportSnapshot/restoreSnapshot 持久化）。 */
  private harvestedCaseIds = new Set<string>()

  openCase(anchor: AttackAnchor, problem: string, turn: number): AttackReduceResult {
    const caseId = caseIdFor(anchor, problem)
    const existing = this.cases.get(caseId)
    if (existing && existing.status !== 'closed') {
      return { state: existing, scored: [], rejected: `case already open: ${caseId}` }
    }
    const activeCount = [...this.cases.values()].filter(c => c.status !== 'closed' && c.status !== 'converged').length
    if (activeCount >= MAX_CONCURRENT_CASES) {
      return { state: existing ?? emptyAttackState(caseId), scored: [], rejected: `budget: max ${MAX_CONCURRENT_CASES} concurrent cases` }
    }
    return this.apply({ type: 'case_opened', caseId, turn, anchor, problem }, emptyAttackState(caseId))
  }

  apply(event: AttackEvent, seed?: ProblemAttackState): AttackReduceResult {
    const base = seed ?? this.cases.get(event.caseId)
    if (!base) return { state: emptyAttackState(event.caseId), scored: [], rejected: `unknown case: ${event.caseId}` }
    const result = reduceAttackState(base, event)
    if (!result.rejected) this.cases.set(event.caseId, result.state)
    this.log.push({ event, scored: result.scored, rejected: result.rejected, version: result.state.version })
    return result
  }

  getCase(caseId: string): ProblemAttackState | undefined {
    return this.cases.get(caseId)
  }

  /** 存活案件（未关闭未收敛）。 */
  activeCases(): ProblemAttackState[] {
    return [...this.cases.values()].filter(c => c.status !== 'closed' && c.status !== 'converged')
  }

  allCases(): ProblemAttackState[] {
    return [...this.cases.values()]
  }

  /** 会话累计得分（跨案件）。 */
  totalScore(): number {
    return [...this.cases.values()].reduce((s, c) => s + c.score, 0)
  }

  /** 委派派发标记（postTool delegate 事件喂入）。 */
  markDelegation(turn: number): void {
    this.lastDelegationTurn = turn
  }

  /** 探针结算是否落在委派窗口（派发后 ≤windowTurns 轮）内。 */
  isWithinDelegationWindow(turn: number, windowTurns = 3): boolean {
    return turn - this.lastDelegationTurn <= windowTurns && turn >= this.lastDelegationTurn
  }

  /** H2 验真：本会话是否发生过至少一次真实委派（markDelegation 由 hook 在
   *  真实 delegate 工具事件上打点）。worker: 引用的最低验真条件——没有真实
   *  委派就引用 worker 证据 = 伪造，硬拒。 */
  hasDelegated(): boolean {
    return this.lastDelegationTurn !== -Infinity
  }

  /** H4-D4：标记 worker orderId 已完成（delegate_task/batch completion 调用）。 */
  markWorkerCompleted(orderId: string): void {
    this.completedWorkers.add(orderId)
  }

  /** H4-D4：该 orderId 是否已完成。 */
  hasWorkerCompleted(orderId: string): boolean {
    return this.completedWorkers.has(orderId)
  }

  /** H4 Evidence Registry：生产证据登记表。key = evidenceId，value = EvidenceRecord。
   *  在 session compact/recovery 时按既有 session writer 规则持久化。 */
  private evidence = new Map<string, EvidenceRecord>()
  /** H4-C 证据注册表事件留痕（postTurn telemetry 消费后清空）。 */
  private evidenceLog: EvidenceLogEntry[] = []

  /**
   * 注册一条生产证据（H4-A）。调用方是真实 producer：
   * problem-attack-hook postTool、worker completion、obligation verification。
   *
   * - 同一 evidenceId 重复注册 → 幂等返回已有 ID（不覆盖 scope/status）。
   * - worker 证据要求本会话发生过真实委派（hasDelegated），否则拒绝。
   * - 返回 evidenceId 供后续 resolve/consume 使用。
   */
  registerEvidence(params: {
    producer: EvidenceProducer
    caseId: string
    probeId?: string | null
    turn: number
    ref: string
    payloadDigest?: string
  }): string | null {
    if (params.producer === 'worker' && !this.hasDelegated()) {
      this.evidenceLog.push({
        action: 'rejected', evidenceId: '',
        producer: params.producer, ref: params.ref,
        caseId: params.caseId, probeId: params.probeId ?? null,
        turn: params.turn, rejectReason: 'no delegation',
      })
      return null
    }
    const id = evidenceIdFor(params.producer, params.ref, params.caseId, params.probeId)
    const existing = this.evidence.get(id)
    if (existing) return id // 幂等
    this.evidence.set(id, {
      evidenceId: id,
      producer: params.producer,
      caseId: params.caseId,
      probeId: params.probeId ?? null,
      turn: params.turn,
      ref: params.ref,
      payloadDigest: params.payloadDigest,
      status: 'available',
    })
    this.evidenceLog.push({
      action: 'registered', evidenceId: id,
      producer: params.producer, ref: params.ref,
      caseId: params.caseId, probeId: params.probeId ?? null,
      turn: params.turn,
    })
    return id
  }

  /**
   * 按 scope 解析证据（H4-A）。校验：
   * - evidenceId 在注册表中存在；
   * - caseId 匹配（跨案件拒绝）；
   * - 若指定 probeId，必须匹配（跨探针拒绝）；
   * - 不在 scope 内的证据 → undefined。
   */
  resolveEvidence(
    evidenceId: string,
    scope: { caseId: string; probeId?: string },
  ): EvidenceRecord | undefined {
    const record = this.evidence.get(evidenceId)
    if (!record) {
      this.evidenceLog.push({
        action: 'rejected', evidenceId,
        producer: 'tool', ref: '', caseId: scope.caseId, probeId: scope.probeId ?? null,
        turn: -1, rejectReason: 'not found',
      })
      return undefined
    }
    const scopeOk = record.caseId === scope.caseId
      && (!scope.probeId || !record.probeId || record.probeId === scope.probeId)
    if (!scopeOk) {
      this.evidenceLog.push({
        action: 'rejected', evidenceId,
        producer: record.producer, ref: record.ref,
        caseId: scope.caseId, probeId: scope.probeId ?? null,
        turn: record.turn, scopeMatch: false,
        rejectReason: `scope mismatch: evidence bound to case=${record.caseId} probe=${record.probeId}`,
      })
      return undefined
    }
    this.evidenceLog.push({
      action: 'resolved', evidenceId,
      producer: record.producer, ref: record.ref,
      caseId: scope.caseId, probeId: scope.probeId ?? null,
      turn: record.turn, scopeMatch: true,
    })
    return record
  }

  /**
   * 消费证据（H4-A 幂等消费）。同一 evidenceId 只能成功消费一次。
   * 返回 true = 消费成功；false = 已消费、已过期或不存在。
   */
    consumeEvidence(evidenceId: string): boolean {
      const record = this.evidence.get(evidenceId)
      if (!record || record.status !== 'available') {
        this.evidenceLog.push({
          action: 'rejected', evidenceId,
          producer: record?.producer ?? 'tool', ref: record?.ref ?? '',
          caseId: record?.caseId ?? '', probeId: record?.probeId ?? null,
          turn: record?.turn ?? -1,
          rejectReason: record ? `status is ${record.status}` : 'not found',
        })
        return false
      }
      record.status = 'consumed'
      this.evidenceLog.push({
        action: 'consumed', evidenceId,
        producer: record.producer, ref: record.ref,
        caseId: record.caseId, probeId: record.probeId,
        turn: record.turn,
      })
      return true
    }

    /**
     * 标记证据为过期（超出有效 turn 窗口后由 hook 调用）。
     * 已消费证据不重复过期。
     */
    expireEvidence(evidenceId: string): void {
      const record = this.evidence.get(evidenceId)
      if (record && record.status === 'available') {
        record.status = 'expired'
        this.evidenceLog.push({
          action: 'expired', evidenceId,
          producer: record.producer, ref: record.ref,
          caseId: record.caseId, probeId: record.probeId,
          turn: record.turn,
        })
      }
    }

    /** H4-D2：批量过期——将 registeredTurn ≤ cutoffTurn 的 available 证据标记为 expired。
     *  已 consumed 证据不受影响。确定性（纯 turn 差值，不依赖 wall clock）。
     *  R1（P2 修订）：log 的 turn 仍为注册轮（审计寿命起点），过期发生轮
     *  另记 expiredAtTurn——两个时间点语义不同，不再混写。 */
    expireEvidenceBefore(cutoffTurn: number, expiredAtTurn?: number): void {
      for (const record of this.evidence.values()) {
        if (record.status === 'available' && record.turn <= cutoffTurn) {
          record.status = 'expired'
          this.evidenceLog.push({
            action: 'expired', evidenceId: record.evidenceId,
            producer: record.producer, ref: record.ref,
            caseId: record.caseId, probeId: record.probeId,
            turn: record.turn,
            expiredAtTurn: expiredAtTurn ?? cutoffTurn + MAX_EVIDENCE_AGE_TURNS,
          })
        }
      }
    }

    /** P2 候选生成 hints：该案件当前 available 的证据记录（只读副本）。 */
    availableEvidenceFor(caseId: string): EvidenceRecord[] {
      return [...this.evidence.values()]
        .filter(r => r.caseId === caseId && r.status === 'available')
        .map(r => ({ ...r }))
    }

    /** 取走证据注册表事件留痕（postTurn 遥测消费）。 */
    drainEvidenceLog(): EvidenceLogEntry[] {
      const out = this.evidenceLog
      this.evidenceLog = []
      return out
    }

    /** 取走未落盘的事件留痕（postTurn 遥测消费）。 */
  drainLog(): AppliedAttackEvent[] {
    const out = this.log
    this.log = []
    return out
  }

  /** CvmVectorInput.attack 只读快照（CV3 规则消费）。 */
  snapshotForCvm(): { activeCases: number; anyNeedsUser: boolean; anyStalled: boolean; hasPlannedProbes: boolean } | null {
    const active = this.activeCases()
    if (active.length === 0) return null
    const anyNeedsUser = active.some(c => c.status === 'needs_user')
    const hasPlannedProbes = active.some(c => hasRemainingPlannedProbes(c))
    // stalled：某案件连续 ≥2 个已结算探针 uninformative **且**无 planned 探针剩余。
    // P3 修订：此前实现漏了 planned 检查（注释与实现不一致）——还有备用探针的
    // 案件不算 stalled，CV3 不该催它"换谓词"，回执的判别探针建议已覆盖。
    const anyStalled = active.some(c => {
      if (hasRemainingPlannedProbes(c)) return false
      const settled = c.probes.filter(p => p.status === 'informative' || p.status === 'uninformative')
      const tail = settled.slice(-2)
      return tail.length === 2 && tail.every(p => p.status === 'uninformative')
    })
    return { activeCases: active.length, anyNeedsUser, anyStalled, hasPlannedProbes }
  }

  /** P4 收束闸：已收敛案件的只读快照（含 close(converged) 后仍保留
   *  selectedHypothesisId 的已关案件）。deliver_task 弱 advisory 消费。
   *  虚空仓库 P0：补 claim/evidenceRefs——没有这两个字段快照读不出"为什么"，
   *  知识收割（第四层）需要可独立阅读的结论文本。 */
  convergedCasesSnapshot(): ConvergedCaseEntry[] {
    const out: ConvergedCaseEntry[] = []
    for (const c of this.cases.values()) {
      if (!c.selectedHypothesisId) continue
      if (c.status !== 'converged' && c.status !== 'closed') continue
      const selected = c.hypotheses.find(h => h.id === c.selectedHypothesisId)
      out.push({
        caseId: c.caseId,
        selectedHypothesisId: c.selectedHypothesisId,
        targets: selected?.targets ?? [],
        claim: selected?.claim ?? '',
        evidenceRefs: selected?.evidenceRefs ?? [],
      })
    }
    return out
  }

  /** 遗产回收 W-A1：needs_user 案件只读快照（deliver_task 遗留项披露消费）。
   *  minimalQuestion 在 snapshot 时于 store 内预计算——agent 层不触碰
   *  reducer 内部结构（依赖方向 + 单一实现，与工具回执共用同一推导）。 */
  needsUserCasesSnapshot(): Array<{ caseId: string; problem: string; minimalQuestion: string }> {
    return this.activeCases()
      .filter(c => c.status === 'needs_user')
      .map(c => ({ caseId: c.caseId, problem: c.problem, minimalQuestion: minimalUserQuestion(c) }))
  }

  /** 虚空仓库 P0：案件是否已收割进知识库。 */
  isHarvested(caseId: string): boolean {
    return this.harvestedCaseIds.has(caseId)
  }

  /** 虚空仓库 P0：标记案件已收割（无论实际写没写——相似去重跳过也标记，
   *  防每 turn 反复相似度扫描）。 */
  markHarvested(caseId: string): void {
    this.harvestedCaseIds.add(caseId)
  }

  /** H4-D3：导出完整快照（cases + evidence registry），供 session persist 原子写入。
   *  R2（P2 修订）：completedWorkers 裁剪——只保留被 worker 证据引用的 orderId
   *  + 最近 32 个（Set 保插入序），防跨会话滚雪球无界增长。 */
  exportSnapshot(): PalSnapshot {
    const cases = [...this.cases.values()]
    const evidence = [...this.evidence.values()].map(r => ({ ...r }))
    const referencedWorkers = new Set<string>()
    for (const r of this.evidence.values()) {
      if (r.producer === 'worker' && r.ref.startsWith('worker:')) {
        referencedWorkers.add(r.ref.slice('worker:'.length))
      }
    }
    const allWorkers = [...this.completedWorkers]
    const recentWorkers = new Set(allWorkers.slice(-COMPLETED_WORKERS_SNAPSHOT_CAP))
    const completedWorkers = allWorkers.filter(id => referencedWorkers.has(id) || recentWorkers.has(id))
    // 虚空仓库 P0：只持久化仍在 cases 里的已收割 id——案件本身被裁剪后
    // 守卫也没有存在意义，防 Set 跨会话无界增长。
    const harvestedCaseIds = [...this.harvestedCaseIds].filter(id => this.cases.has(id))
    return {
      schemaVersion: 1,
      cases,
      evidence,
      lastDelegationTurn: this.lastDelegationTurn !== -Infinity ? this.lastDelegationTurn : null,
      completedWorkers,
      harvestedCaseIds,
    }
  }

  /** H4-D3/D5：向已存在实例恢复快照（loop 的 problemAttack 字段是 readonly，
   *  生产恢复路径必须原地恢复而非换实例）。未知 schemaVersion fail-closed：
   *  返回 false 且不做任何部分恢复。恢复后委派窗口显式失效——不延续上次
   *  会话/进程的并行加分窗口。 */
  restoreSnapshot(snapshot: PalSnapshot): boolean {
    if (snapshot.schemaVersion !== 1) return false
    for (const c of snapshot.cases) {
      this.cases.set(c.caseId, c)
    }
    for (const r of snapshot.evidence) {
      this.evidence.set(r.evidenceId, { ...r })
    }
    this.lastDelegationTurn = -Infinity
    // H4-D4：恢复已完成 worker 记录（已完成状态跨会话仍有效）
    if (snapshot.completedWorkers) {
      for (const oid of snapshot.completedWorkers) {
        this.completedWorkers.add(oid)
      }
    }
    // 虚空仓库 P0：恢复已收割守卫——resume 后收敛案件不重复入知识库
    if (snapshot.harvestedCaseIds) {
      for (const cid of snapshot.harvestedCaseIds) {
        this.harvestedCaseIds.add(cid)
      }
    }
    return true
  }

  /** H4-D3：从快照构造新 store（测试/离线回放用；生产恢复走 restoreSnapshot）。 */
  static fromSnapshot(snapshot: PalSnapshot): ProblemAttackStore {
    const store = new ProblemAttackStore()
    store.restoreSnapshot(snapshot)
    return store
  }
}

/** H4-D3 快照格式。schemaVersion 为未来迁移预留。 */
export interface PalSnapshot {
  schemaVersion: number
  cases: ProblemAttackState[]
  evidence: EvidenceRecord[]
  /** null = 未发生委派或跨会话恢复后显式失效。 */
  lastDelegationTurn: number | null
  /** H4-D4：已完成 worker orderId 列表（跨会话恢复时不丢失已完成状态）。 */
  completedWorkers?: string[]
  /** 虚空仓库 P0：已收割进知识库的案件 id（跨会话防重复收割）。 */
  harvestedCaseIds?: string[]
}

/** 虚空仓库 P0：收敛案件快照条目——claim/evidenceRefs 使快照可独立阅读，
 *  deliver_task P4 收束闸与 PAL 自动收割共同消费。 */
export interface ConvergedCaseEntry {
  caseId: string
  selectedHypothesisId: string
  targets: readonly string[]
  /** selectedHypothesis.claim（假设不存在 → 空字符串）。 */
  claim: string
  /** selectedHypothesis.evidenceRefs（假设不存在 → 空数组）。 */
  evidenceRefs: readonly string[]
}

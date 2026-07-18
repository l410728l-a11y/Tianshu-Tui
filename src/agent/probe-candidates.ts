/**
 * PAL P2：探针候选生成器（纯只读层）。
 *
 * 与 chooseDiscriminator 的分工（两层，不重复）：
 * - L0 `chooseDiscriminator`：在**已 plan_probe** 的 planned 集合上按区分力选型；
 * - L1 本模块：planned 集合为空或无区分力时，从存活假设的 targets 生成
 *   **结构化候选草稿**——只进工具回执文本，必须经 attack_case plan_probe
 *   落账才进 reducer（文本不能直接改状态）。
 *
 * 纪律（计划 pal-p2-p4 修订版）：
 * - 纯函数：无 IO / 时钟 / 随机，同输入 deepEqual 同输出；
 * - 不消耗攻坚预算、不改 state（调用方只读消费）；
 * - needs_user / converged / closed / blocked → 空结果（不绕 H3 单调性）；
 * - **语义留白诚实化**：生成器只做结构选型（目标覆盖 / 成本封顶 / 冷却退避），
 *   谓词的 needle 与 ifTrue/ifFalse 方向语义由模型补全——不假装机器能发明
 *   区分性符号。骨架里的占位符即为此设计，不是偷懒。
 */

import {
  MAX_ATTACK_TURNS,
  MAX_PROBES_PER_CASE,
  type AttackHypothesis,
  type EvidenceRecord,
  type ProbeExpectation,
  type ProbeHypothesisLink,
  type ProbeKind,
  type ProblemAttackState,
} from './problem-attack-loop.js'

/** 预算剩余 ≤ 该轮数时只出廉价只读候选（read/grep），禁 test/baseline。 */
export const CHEAP_BUDGET_TURNS = 3
/** 同 (kind, target) 组合累计 uninformative ≥ 该次数后冷却，不再推荐。 */
export const CANDIDATE_COOLDOWN_UNINFORMATIVE = 2
/** 备选上限（primary 之外）。 */
export const MAX_ALTERNATE_CANDIDATES = 2

/** 谓词 needle 占位符——模型在 plan_probe 时必须替换为真实区分性符号。 */
export const NEEDLE_PLACEHOLDER = '<区分性符号或断言文本>'

/** 规则 8 症状信号（对账式攻坚第五波）：案件文本显式携带症状语义时出结构模板。 */
const INSTRUMENT_SIGNAL = /时序|race|叠影|叠屏|重影|残留|渲染|缓存|状态机|并发/
const SIMULATE_SIGNAL = /终端|terminal|git|网络|文件系统|环境|reflow|仿真|模拟/

export interface ProbeCandidate {
  target: string
  kind: ProbeKind
  /** 结构骨架：kind 对应的谓词形状；needle 类字段为占位符。 */
  expectation: ProbeExpectation
  /** 方向模板：默认 ifTrue supports 挂给目标所属假设；模型需按语义拉开方向。 */
  perHypothesis: ProbeHypothesisLink[]
  /** 该目标挂在几条存活假设上（覆盖度，排序主键）。 */
  coverage: number
  /** 一句话：为何该结构有区分潜力 + 模型需要补什么。 */
  rationale: string
}

export interface ProbeCandidateHints {
  /** registry 中该案件的 available 证据（store.availableEvidenceFor）。 */
  availableEvidence?: readonly EvidenceRecord[]
}

export interface ProbeCandidateResult {
  primary: ProbeCandidate | null
  alternates: ProbeCandidate[]
  /** registry 已有 available 证据绑定某未结算探针 → 直接 observe 它，
   *  不出新候选（证据复用优先于扩张搜索）。 */
  reuseObserveProbeId: string | null
}

const EMPTY_RESULT: ProbeCandidateResult = { primary: null, alternates: [], reuseObserveProbeId: null }

/** 与 reducer 的 KIND_RANK 同序（read 最便宜）；本模块独立维护避免导出内部常量。 */
const KIND_COST: Record<ProbeKind, number> = {
  read: 0, grep: 1, lsp: 2, micro_probe: 3, targeted_test: 4, baseline_diff: 5, instrument: 6, simulate: 7, ask_user: 8,
}

function comboKey(kind: ProbeKind, target: string): string {
  return `${kind}:${target}`
}

function looksLikeTestFile(target: string): boolean {
  return /\.test\.|\.spec\.|__tests__\//.test(target)
}

function pickKind(target: string, cheapOnly: boolean): ProbeKind {
  if (!cheapOnly && looksLikeTestFile(target)) return 'targeted_test'
  return 'grep'
}

function expectationSkeleton(kind: ProbeKind, target: string): ProbeExpectation {
  if (kind === 'targeted_test') return { kind: 'test_outcome', target, expect: 'fail' }
  return { kind: 'pattern_found', path: target, needle: NEEDLE_PLACEHOLDER }
}

/**
 * 生成候选探针草稿。确定性规则：
 * 1. 案件不在搜索态（forming/probing）或无存活假设 → 空结果；
 * 2. **证据复用优先**：available 证据绑定某未结算（planned/attempted）探针
 *    → 返回 reuseObserveProbeId，不出新候选；
 * 3. 探针预算耗尽（≥MAX_PROBES_PER_CASE）→ 空结果（不诱导超预算 plan）；
 * 4. 覆盖缺口：存活假设的 targets 中尚未被任何探针探过的目标；
 * 5. 成本封顶：预算剩余 ≤CHEAP_BUDGET_TURNS 轮 → 只出 grep（含测试文件）；
 * 6. 冷却退避：同 (kind, target) 组合累计 ≥2 次 uninformative → 跳过；
 * 7. 排序：覆盖度降序 → kind 成本升序 → target 字典序；primary 1 + 备选 ≤2。
 */
export function proposeProbeCandidates(
  state: ProblemAttackState,
  hints: ProbeCandidateHints = {},
): ProbeCandidateResult {
  if (state.status !== 'probing' && state.status !== 'forming') return EMPTY_RESULT
  const live = state.hypotheses.filter(h => h.status === 'candidate' || h.status === 'inconclusive')
  if (live.length === 0) return EMPTY_RESULT

  // 规则 2：证据复用优先于扩张搜索
  const unsettled = new Set(
    state.probes.filter(p => p.status === 'planned' || p.status === 'attempted').map(p => p.id))
  const reuse = (hints.availableEvidence ?? []).find(ev =>
    ev.status === 'available' && ev.caseId === state.caseId
    && ev.probeId !== null && unsettled.has(ev.probeId))
  if (reuse) return { primary: null, alternates: [], reuseObserveProbeId: reuse.probeId }

  // 规则 3：探针预算耗尽
  if (state.probes.length >= MAX_PROBES_PER_CASE) return EMPTY_RESULT

  // 规则 6 数据：uninformative 冷却表
  const uninformativeCount = new Map<string, number>()
  for (const p of state.probes) {
    if (p.status !== 'uninformative') continue
    const key = comboKey(p.kind, p.target)
    uninformativeCount.set(key, (uninformativeCount.get(key) ?? 0) + 1)
  }

  // 规则 5：成本封顶
  const cheapOnly = MAX_ATTACK_TURNS - state.activeAttackTurns <= CHEAP_BUDGET_TURNS

  // 规则 4：覆盖缺口（已探过的目标不再出候选）
  const probedTargets = new Set(state.probes.map(p => p.target))
  const sortedLive = [...live].sort((a, b) => (a.id < b.id ? -1 : 1))
  const seenTargets = new Set<string>()
  const drafts: ProbeCandidate[] = []
  for (const h of sortedLive) {
    for (const target of h.targets) {
      if (!target || probedTargets.has(target) || seenTargets.has(target)) continue
      seenTargets.add(target)
      const kind = pickKind(target, cheapOnly)
      if ((uninformativeCount.get(comboKey(kind, target)) ?? 0) >= CANDIDATE_COOLDOWN_UNINFORMATIVE) continue
      const owners = sortedLive.filter(x => x.targets.includes(target))
      drafts.push({
        target,
        kind,
        expectation: expectationSkeleton(kind, target),
        perHypothesis: owners.map(o => ({ hypothesisId: o.id, ifTrue: 'supports' as const })),
        coverage: owners.length,
        rationale: owners.length >= 2
          ? `该目标同时挂在 ${owners.length} 条存活假设上——把方向拉开（一支 supports、一支 refutes）才有区分力`
          : `${owners[0]!.id} 的未探测目标——若该假设严格预言"必须找到"，把 ifFalse 设为 refutes 获得双向区分`,
      })
    }
  }
  // 规则 8（第五波）：症状信号模板——案件文本显式携带时序/渲染/环境交互语义时，
  // 追加 instrument/simulate 结构模板。coverage=0 排在文件候选之后，只在无文件
  // 候选时兜底为 primary；预算紧张（cheapOnly）时不发。占位符纪律同 NEEDLE：
  // 对账期望值与仿真断言由模型补全，模板只给构造法。
  drafts.push(...(cheapOnly ? [] : buildSignalDrafts(state, sortedLive)))
  if (drafts.length === 0) return EMPTY_RESULT

  drafts.sort((a, b) =>
    b.coverage - a.coverage
    || KIND_COST[a.kind] - KIND_COST[b.kind]
    || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  return {
    primary: drafts[0]!,
    alternates: drafts.slice(1, 1 + MAX_ALTERNATE_CANDIDATES),
    reuseObserveProbeId: null,
  }
}

/**
 * 规则 8 信号模板（对账式攻坚第五波）：案件 problem/anchor.ref 显式携带症状语义时，
 * 给出 instrument（插桩对账）/ simulate（仿真回放）结构模板。保守护栏：
 * - 同一案件已有同 kind 探针 → 不重复出模板（一个案件至多各一次）；
 * - coverage 固定 0——永远排在文件覆盖候选之后，只做兜底/备选；
 * - 占位符纪律：对账脚本标识、判定输出、仿真测试路径全部留白由模型补全。
 */
function buildSignalDrafts(state: ProblemAttackState, live: readonly AttackHypothesis[]): ProbeCandidate[] {
  const text = `${state.problem} ${state.anchor.ref}`
  const kindsPresent = new Set(state.probes.map(p => p.kind))
  const out: ProbeCandidate[] = []
  if (INSTRUMENT_SIGNAL.test(text) && !kindsPresent.has('instrument')) {
    out.push({
      target: state.anchor.ref,
      kind: 'instrument',
      expectation: { kind: 'command_output_matches', commandIncludes: NEEDLE_PLACEHOLDER, outputPattern: NEEDLE_PLACEHOLDER },
      perHypothesis: live.map(h => ({ hypothesisId: h.id, ifTrue: 'supports' as const })),
      coverage: 0,
      rationale: '症状含时序/渲染/缓存类信号——插桩对账：先独立推导期望值（公式/规格/参考实现），包装目标函数记录实际值，对账脚本输出 ✓/✗ 判定；commandIncludes 与 outputPattern 由你按脚本补全',
    })
  }
  if (SIMULATE_SIGNAL.test(text) && !kindsPresent.has('simulate')) {
    out.push({
      target: state.anchor.ref,
      kind: 'simulate',
      expectation: { kind: 'test_outcome', target: NEEDLE_PLACEHOLDER, expect: 'fail' },
      perHypothesis: live.map(h => ({ hypothesisId: h.id, ifTrue: 'supports' as const })),
      coverage: 0,
      rationale: '环境交互类症状——仿真回放：造最小环境模型（只建模与症状相关的子集）写成 RED 测试复现缺陷，修复后转 GREEN；测试路径由你定',
    })
  }
  return out
}

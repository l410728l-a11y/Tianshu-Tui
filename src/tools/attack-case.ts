import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import {
  MAX_ACTIVE_HYPOTHESES,
  MAX_ATTACK_TURNS,
  MAX_PROBES_PER_CASE,
  chooseDiscriminator,
  evidenceIdFor,
  minimalUserQuestion,
  survivingHypotheses,
  type AttackAnchor,
  type AttackScoreEvent,
  type EvidenceProducer,
  type ProbeExpectation,
  type ProbeHypothesisLink,
  type ProbeKind,
  type ProblemAttackState,
  type ProblemAttackStore,
} from '../agent/problem-attack-loop.js'
import { NEEDLE_PLACEHOLDER, proposeProbeCandidates } from '../agent/probe-candidates.js'

/**
 * attack_case — PAL 攻坚案件工具（计划 v2 Wave P2）。
 *
 * 模型显式宣告假设与判别探针的结构化入口。schema 即闸门：
 * 每条假设必须绑 targets，每个探针必须绑机器可判定的 expectation 谓词
 * 与 perHypothesis 效果方向——写不出判别方式的假设自然被挡在案件外。
 *
 * 鼓励机制：回执即奖励通道。谓词结算出信息 → 回执带加分明细
 * （淘汰假设 +3、复现 +1、并行委派 +2…），把"做探针/做排除/做复现/
 * 并行委派验证"变成被显式强化的行为。分数由 reducer 推导，模型自报不计分。
 *
 * CORE 常驻（2026-07-17，kernel 26→27）：攻坚场景在会话中期出现，EXTENDED
 * 中途挂载改 tool fingerprint = 200K 前缀全量重建（V4 创建 ¥3/M、高峰 ¥6/M）。
 * schema 字节稳定进冻结前缀，缓存零成本。故意不进星域 toolWhitelist——
 * 案件账本主控专属，worker 探针结果经 evidence_ref 回流。
 */

const DEFINITION: ToolDefinition = {
  name: 'attack_case',
  description:
    '疑难 bug 的攻坚案件账本：宣告竞争假设与判别探针，然后用证据结算探针谓词。当问题经受 2+ 次修复尝试仍未解决、或复现路径不清时使用。流程：open（绑定锚事实）→ hypothesize（2+ 条带 targets 的竞争解释）→ plan_probe（机器可判定的 expectation + 每条假设的 supports/refutes 方向）→ 用常规工具执行探针（或用 delegate_task 并行——并行探针有加分）→ observe（带 evidenceRef 结算谓词）。有效动作得分：有信息量的探针 +2，淘汰一条假设 +3（排除即进展），证实 +3，复现 +1，并行委派探针 +2，案件收敛 +5。分数只来自 reducer 推导的证据，回执会显示累计总分。status 显示假设看板；close 结案。',
  input_schema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['open', 'hypothesize', 'plan_probe', 'observe', 'status', 'close'],
        description: '案件操作。',
      },
      case_id: { type: 'string', description: '案件 id（除 open/status 外所有操作必填）。' },
      anchor: {
        type: 'object',
        description: 'open: 本案绑定的锚事实。无锚不开案。',
        properties: {
          kind: { type: 'string', enum: ['obligation', 'trace_step', 'failure_pattern', 'user_report'] },
          ref: { type: 'string', description: '如 obligation id、失败测试路径、错误签名、用户原话。' },
        },
        required: ['kind', 'ref'],
      },
      problem: { type: 'string', description: 'open: 一句话问题陈述。' },
      hypotheses: {
        type: 'array',
        description: 'hypothesize: 竞争解释。每条必须指明具体 targets（文件/符号）。',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            targets: { type: 'array', items: { type: 'string' } },
            user_fact: { type: 'boolean', description: '仅当假设源于用户刚提供的新事实时为 true。重开 needs_user 案件的必要条件；自己生成的猜测无法复活案件。' },
          },
          required: ['claim', 'targets'],
        },
      },
      probes: {
        type: 'array',
        description: 'plan_probe: 带机器可判定 expectation 的判别探针。',
        items: {
          type: 'object',
          properties: {
            hypothesis_ids: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['read', 'grep', 'lsp', 'micro_probe', 'targeted_test', 'baseline_diff', 'instrument', 'simulate', 'ask_user'], description: '探针类型。instrument = 包裹/测量目标，把实际值与独立推导的不变量交叉核对（经 command_output_matches 结算）。simulate = 在最小环境模型里重放场景（经 test_outcome / command_output_matches 结算）。' },
            target: { type: 'string', description: '探针的目标文件/测试/命令。' },
            expectation: {
              type: 'object',
              description:
                '机器可判定谓词。取其一：{kind:"pattern_found"|"pattern_absent", path, needle} | {kind:"test_outcome", target, expect:"pass"|"fail"} | {kind:"tool_error_class", tool, errorClass} | {kind:"command_output_matches", commandIncludes, outputPattern}。',
            },
            per_hypothesis: {
              type: 'array',
              description: '每条假设的效果方向。if_false 缺省为 neutral（缺席不等于反驳，除非该假设预测了存在）。',
              items: {
                type: 'object',
                properties: {
                  hypothesis_id: { type: 'string' },
                  if_true: { type: 'string', enum: ['supports', 'refutes', 'neutral'] },
                  if_false: { type: 'string', enum: ['supports', 'refutes', 'neutral'] },
                },
                required: ['hypothesis_id', 'if_true'],
              },
            },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['hypothesis_ids', 'kind', 'target', 'expectation', 'per_hypothesis'],
        },
      },
      probe_id: { type: 'string', description: 'observe: 要结算的探针。' },
      predicate_outcome: {
        type: 'string',
        enum: ['true', 'false', 'unobservable'],
        description: 'observe: expectation 谓词是否成立？unobservable = 探针已运行但谓词无法判定。',
      },
      evidence_ref: {
        type: 'string',
        description: 'observe: 证据指针——tool:<name>:<turn> | worker:<orderId> | obligation:<id>。true/false 必填。引用会与真实记录核验：伪造的 worker/obligation 引用会被拒绝；超出最近历史窗口的 tool 引用可结算状态但零分。',
      },
      resolution: { type: 'string', enum: ['converged', 'abandoned', 'resolved_externally'], description: 'close: 结案原因。' },
    },
    required: ['op'],
  },
}

/** H2 瘦身版证据验真器（bootstrap 对既有账本接线，不建第二套注册表）。 */
export interface AttackEvidenceVerifier {
  /** tool: 引用——该工具是否在最近工具历史窗口出现过（可带目标提示收窄）。 */
  toolRan(name: string, targetHint?: string): boolean
  /** obligation: 引用——义务账本中是否存在该 id。 */
  obligationExists(id: string): boolean
  /** H4-D4：worker 引用——该 orderId 是否已完成（不是仅"会话曾委派"）。 */
  workerCompleted(orderId: string): boolean
  /** P4 收束闸：targets 关联的未闭合义务 id（open/attempted）。close(converged)
   *  回执用它提示"先核销再交付"。可选——旧接线缺席时提示静默跳过。 */
  openObligationIdsForTargets?(targets: readonly string[]): string[]
}

export interface AttackCaseToolDeps {
  getStore: () => ProblemAttackStore | null
  /** 缺席（非主控上下文）→ tool: 引用按未验真降级，worker:/obligation: 硬拒。 */
  getVerifier?: () => AttackEvidenceVerifier | null
  /** 测试注入口；缺省读 RIVET_PAL 环境变量。 */
  getMode?: () => 'off' | 'shadow' | 'active'
}

/** H2 三路引用验真结果。 */
type EvidenceCheck =
  | { verdict: 'verified' }
  | { verdict: 'unverified' } // tool: 超窗——状态照常结算但零分
  | { verdict: 'invalid'; reason: string } // 伪造/格式错——硬拒

/**
 * evidence_ref 分路验真（H4-B：优先查 Evidence Registry，轻量验真器降级为 fallback）。
 *
 * H4-A 注册表优先路径：
 * - 对 ref 推导 evidenceId（producer+ref+caseId+probeId），查 registry；
 * - registry 命中 + scope 匹配 + status=available → consume → verified；
 * - registry 命中但 status=consumed → invalid（重复消费）；
 * - registry 命中但 status=expired → unverified（零分）；
 * - registry 未命中 → 降级到轻量验真器（H2 路径，向后兼容过渡期）。
 */
export function checkEvidenceRef(
  ref: string,
  scope: {
    caseId: string
    probeId: string
    /** 探针 target 路径（D5 回归修复：toolRan 的 targetHint 必须是路径，
     *  不能是 probeId 哈希——哈希永远匹配不上工具历史 target）。 */
    probeTarget?: string
  },
  store: ProblemAttackStore,
  verifier: AttackEvidenceVerifier | null,
): EvidenceCheck {
  // ── H4-B 注册表优先路径 ──
  const tryRegistry = (producer: EvidenceProducer): EvidenceCheck | null => {
    const evidenceId = evidenceIdFor(producer, ref, scope.caseId, scope.probeId)
    const record = store.resolveEvidence(evidenceId, scope)
    if (!record) return null // 未注册，降级
    if (record.status === 'consumed') {
      return { verdict: 'invalid', reason: `证据「${ref}」已被消费——每条证据只能结算一次探针` }
    }
    if (record.status === 'expired') {
      return { verdict: 'unverified' }
    }
    // 可用 → 消费并验证
    store.consumeEvidence(evidenceId)
    return { verdict: 'verified' }
  }

  if (ref.startsWith('worker:')) {
    const reg = tryRegistry('worker')
    if (reg) return reg
    // H4-D4：worker 引用需精确 orderId 已完成（不再仅 hasDelegated）
    const orderId = ref.slice('worker:'.length)
    if (!orderId) return { verdict: 'invalid', reason: 'worker 证据格式为 worker:<orderId>' }
    if (!verifier || !verifier.workerCompleted(orderId)) {
      return { verdict: 'invalid', reason: `worker 证据「${ref}」被拒：没有 orderId「${orderId}」的已完成 worker——请先经 delegate_task 派发并等待完成` }
    }
    return { verdict: 'verified' }
  }
  if (ref.startsWith('obligation:')) {
    const reg = tryRegistry('obligation')
    if (reg) return reg
    // 降级：轻量验真（H2 路径）
    const id = ref.slice('obligation:'.length)
    if (!verifier || !verifier.obligationExists(id)) {
      return { verdict: 'invalid', reason: `义务证据「${ref}」被拒：账本中无此义务` }
    }
    return { verdict: 'verified' }
  }
  if (ref.startsWith('tool:')) {
    const reg = tryRegistry('tool')
    if (reg) return reg
    // 降级：轻量验真（H2 路径）
    const name = ref.split(':')[1] ?? ''
    if (!name) return { verdict: 'invalid', reason: 'tool 证据格式为 tool:<name>[:<turn>]' }
    if (verifier && verifier.toolRan(name, scope.probeTarget)) return { verdict: 'verified' }
    return { verdict: 'unverified' }
  }
  return { verdict: 'invalid', reason: `evidence_ref「${ref}」被拒：须为 tool:<name>[:<turn>] | worker:<orderId> | obligation:<id>` }
}

// ─── 输入校验（schema 之上的结构闸门）──────────────────────────────

const EXPECTATION_KINDS = new Set(['pattern_found', 'pattern_absent', 'test_outcome', 'tool_error_class', 'command_output_matches'])

function parseExpectation(raw: unknown): ProbeExpectation | string {
  if (!raw || typeof raw !== 'object') return 'expectation 必须是对象'
  const e = raw as Record<string, unknown>
  const kind = e.kind
  if (typeof kind !== 'string' || !EXPECTATION_KINDS.has(kind)) {
    return `expectation.kind 必须是：${[...EXPECTATION_KINDS].join(', ')}`
  }
  const str = (k: string): string | null => (typeof e[k] === 'string' && (e[k] as string).trim() ? e[k] as string : null)
  switch (kind) {
    case 'pattern_found':
    case 'pattern_absent': {
      const path = str('path'); const needle = str('needle')
      if (!path || !needle) return `${kind} 需要 path + needle`
      return { kind, path, needle } as ProbeExpectation
    }
    case 'test_outcome': {
      const target = str('target'); const expect = e.expect
      if (!target || (expect !== 'pass' && expect !== 'fail')) return 'test_outcome 需要 target + expect(pass|fail)'
      return { kind, target, expect }
    }
    case 'tool_error_class': {
      const tool = str('tool'); const errorClass = str('errorClass') ?? str('error_class')
      if (!tool || !errorClass) return 'tool_error_class 需要 tool + errorClass'
      return { kind, tool, errorClass }
    }
    default: {
      const commandIncludes = str('commandIncludes') ?? str('command_includes')
      const outputPattern = str('outputPattern') ?? str('output_pattern')
      if (!commandIncludes || !outputPattern) return 'command_output_matches 需要 commandIncludes + outputPattern'
      return { kind: 'command_output_matches', commandIncludes, outputPattern }
    }
  }
}

// ─── 回执渲染（鼓励通道）──────────────────────────────────────────

function renderScore(scored: readonly AttackScoreEvent[], state: ProblemAttackState, store: ProblemAttackStore): string {
  if (scored.length === 0) return ''
  const total = scored.reduce((s, e) => s + e.points, 0)
  const detail = scored.map(s => `${s.kind} +${s.points}`).join(', ')
  const lines = [`得分 +${total}（${detail}）· 本案 ${state.score} 分 · 会话累计 ${store.totalScore()} 分`]
  if (scored.some(s => s.kind === 'hypothesis_refuted')) {
    lines.push('淘汰假设是硬进展——搜索空间收窄了，继续用判别探针压缩。')
  }
  if (scored.some(s => s.kind === 'reproduction')) {
    lines.push('复现成功——缺陷已经红起来，后续每步修复都有回归锚点。')
  }
  if (scored.some(s => s.kind === 'parallel_probe')) {
    lines.push('并行委派探针生效——主线没有被验证阻塞，这是对的做法。')
  }
  if (scored.some(s => s.kind === 'case_converged')) {
    lines.push('案件收敛：唯一幸存假设 + 证据链完整。带着 selectedHypothesis 去修复。')
  }
  return lines.join('\n')
}

// W3 升级出口的最小用户决策问题推导已搬家至 agent/problem-attack-loop.ts
// （遗产回收 W-A1）——store 快照与本工具回执共用同一实现，避免两处漂移。

export function renderEscalationPacket(state: ProblemAttackState): string[] {
  const excluded = state.hypotheses.filter(h => h.status === 'refuted')
  const surviving = survivingHypotheses(state)
  const tried = state.probes.filter(p => p.status !== 'planned')
  const lines: string[] = ['', '── 升级出口：请用户裁决 ──']
  if (excluded.length > 0) {
    lines.push('已排除：')
    for (const h of excluded) lines.push(`  ✗ ${h.claim}${h.evidenceRefs.length ? `（证据 ${h.evidenceRefs.join(', ')}）` : ''}`)
  }
  if (surviving.length > 0) {
    lines.push('幸存解释：')
    for (const h of surviving) lines.push(`  ? [${h.status}] ${h.claim}${h.evidenceRefs.length ? `（证据 ${h.evidenceRefs.join(', ')}）` : ''}`)
  }
  if (tried.length > 0) {
    lines.push('已试探针：')
    for (const p of tried) lines.push(`  · [${p.status}] ${p.kind}→${p.target}${p.evidenceRef ? `（${p.evidenceRef}）` : ''}`)
  }
  lines.push(`剩余预算：攻坚轮 ${Math.max(0, MAX_ATTACK_TURNS - state.activeAttackTurns)} · 探针位 ${Math.max(0, MAX_PROBES_PER_CASE - state.probes.length)}`)
  lines.push(`最小决策问题：${minimalUserQuestion(state, surviving)}`)
  lines.push('解锁方式：用户提供新事实后 hypothesize（user_fact: true），或 close（abandoned / resolved_externally）。')
  return lines
}

function renderBoard(state: ProblemAttackState, store?: ProblemAttackStore): string {
  const lines: string[] = [
    `case ${state.caseId} [${state.status}] 锚=${state.anchor.kind}:${state.anchor.ref}`,
    `问题：${state.problem}`,
    `预算：假设 ${state.hypotheses.filter(h => h.status === 'candidate' || h.status === 'inconclusive').length}/${MAX_ACTIVE_HYPOTHESES} 存活 · 探针 ${state.probes.length}/${MAX_PROBES_PER_CASE} · 攻坚轮 ${state.activeAttackTurns}/${MAX_ATTACK_TURNS} · 得分 ${state.score}`,
  ]
  for (const h of state.hypotheses) {
    lines.push(`  [${h.status}] ${h.id} ${h.claim}${h.evidenceRefs.length ? ` (证据 ${h.evidenceRefs.join(', ')})` : ''}`)
  }
  for (const p of state.probes) {
    lines.push(`  probe [${p.status}] ${p.id} ${p.kind}→${p.target}${p.evidenceRef ? ` (${p.evidenceRef})` : ''}`)
  }
  // W3：needs_user 优先出结构化升级包——预算饱和强制转入时可能仍有
  // planned 探针，但此状态下探针不可推进，探针建议只会误导。
  if (state.status === 'needs_user') {
    lines.push(...renderEscalationPacket(state))
    return lines.join('\n')
  }
  const next = chooseDiscriminator(state)
  if (next) {
    lines.push(`下一个判别探针建议：${next.id}（${next.kind}→${next.target}，风险 ${next.risk}）`)
    if (next.risk === 'low' && (next.kind === 'read' || next.kind === 'grep' || next.kind === 'lsp')) {
      lines.push('该探针只读低风险——可用 delegate_task 并行验证（不阻塞主线，出结果有并行加分）。')
    }
  } else if (store) {
    // P2 候选生成（L1）：无可选型的 planned 探针时才出草稿——与 L0 的
    // chooseDiscriminator 建议段互补，绝不同屏双声。草稿必须经 plan_probe
    // 落账，谓词占位符由模型补全（结构由机器选，语义由模型定）。
    const cands = proposeProbeCandidates(state, {
      availableEvidence: store.availableEvidenceFor(state.caseId),
    })
    if (cands.reuseObserveProbeId) {
      lines.push(`已有可用证据绑定探针 ${cands.reuseObserveProbeId}——直接 observe 结算它，不要新开探针。`)
    } else if (cands.primary) {
      const c = cands.primary
      lines.push(`候选探针草稿（须经 plan_probe 落账；${NEEDLE_PLACEHOLDER} 需替换为真实谓词）：`)
      lines.push(`  ${c.kind}→${c.target}（覆盖 ${c.coverage} 条存活假设）· ${c.rationale}`)
      lines.push(`  plan_probe 参数骨架：${JSON.stringify({
        hypothesis_ids: c.perHypothesis.map(l => l.hypothesisId),
        kind: c.kind,
        target: c.target,
        expectation: c.expectation,
        per_hypothesis: c.perHypothesis.map(l => ({ hypothesis_id: l.hypothesisId, if_true: l.ifTrue })),
      })}`)
      for (const alt of cands.alternates) {
        lines.push(`  备选：${alt.kind}→${alt.target}（覆盖 ${alt.coverage}）`)
      }
    }
  }
  return lines.join('\n')
}

function err(message: string): ToolResult {
  return { content: `attack_case: ${message}`, isError: true }
}

export function createAttackCaseTool(deps: AttackCaseToolDeps): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      // 8.6 fail-closed：PAL 关闭时工具不得变更任何状态（schema 仍常驻——
      // 工具定义随版本上车字节稳定，行为闸门在 execute 层）。
      const mode = deps.getMode?.() ?? (process.env.RIVET_PAL === 'off' || process.env.RIVET_PAL === '0' ? 'off' : 'shadow')
      if (mode === 'off') return err('PAL 层已禁用（RIVET_PAL=off）——不能更改任何案件状态。')
      const store = deps.getStore()
      if (!store) return err('当前上下文无攻坚层可用。')
      const input = params.input
      const op = input.op
      const turn = params.sessionTurnCount ?? 0

      switch (op) {
        case 'open': {
          const anchorRaw = input.anchor as Record<string, unknown> | undefined
          const kind = anchorRaw?.kind
          const ref = anchorRaw?.ref
          if (
            typeof kind !== 'string' || typeof ref !== 'string'
            || !['obligation', 'trace_step', 'failure_pattern', 'user_report'].includes(kind)
          ) {
            return err('open 需要 anchor {kind: obligation|trace_step|failure_pattern|user_report, ref}。没有锚事实就不开案。')
          }
          const problem = typeof input.problem === 'string' ? input.problem : ''
          // 8.3：obligation 锚必须指向义务账本里真实存在的 id——伪造锚开案
          // 会让后续整条案件建立在假事实上（验真器可用时强制）。
          if (kind === 'obligation') {
            const verifier = deps.getVerifier?.() ?? null
            if (verifier && !verifier.obligationExists(ref)) {
              return err(`锚义务「${ref}」在义务账本中不存在——用真实义务 id 或换其他锚类型。`)
            }
          }
          const anchor: AttackAnchor = { kind: kind as AttackAnchor['kind'], ref }
          const r = store.openCase(anchor, problem, turn)
          if (r.rejected) return err(r.rejected)
          return {
            content: [
              `案件已开：${r.state.caseId}`,
              `下一步：用 hypothesize 提出 ≥2 条竞争解释（每条必须绑 targets）。`,
              `单一假设直接验证也可，但竞争假设 + 判别探针的淘汰效率更高。`,
              `预算：假设 ≤${MAX_ACTIVE_HYPOTHESES} 存活 · 探针 ≤${MAX_PROBES_PER_CASE} · 攻坚轮 ≤${MAX_ATTACK_TURNS}。`,
            ].join('\n'),
            uiContent: `攻坚案件已开：${r.state.caseId}`,
            isError: false,
          }
        }

        case 'hypothesize': {
          const caseId = typeof input.case_id === 'string' ? input.case_id : ''
          if (!caseId) return err('hypothesize 需要 case_id')
          const raw = input.hypotheses
          if (!Array.isArray(raw) || raw.length === 0) return err('hypothesize 需要 hypotheses[]')
          const results: string[] = []
          for (const item of raw) {
            const h = item as Record<string, unknown>
            const claim = typeof h.claim === 'string' ? h.claim : ''
            const targets = Array.isArray(h.targets) ? h.targets.filter((t): t is string => typeof t === 'string') : []
            if (!claim.trim()) { results.push('rejected: 空 claim'); continue }
            if (targets.length === 0) { results.push(`rejected: 「${claim}」—— 假设必须绑定具体 targets（文件/符号），否则无法设计判别探针`); continue }
            const userFact = h.user_fact === true
            const r = store.apply({ type: 'hypothesis_added', caseId, turn, claim, targets, userFact })
            results.push(r.rejected ? `rejected: ${r.rejected}` : `added: ${r.state.hypotheses[r.state.hypotheses.length - 1]!.id} ${claim}`)
          }
          const state = store.getCase(caseId)
          return {
            content: [
              ...results,
              '',
              state ? renderBoard(state, store) : '',
              '下一步：plan_probe 为每对假设设计判别探针（谓词为真/假分别支持或反驳谁）。',
            ].join('\n'),
            uiContent: `攻坚假设：${results.length} 项`,
            isError: results.every(r => r.startsWith('rejected')),
          }
        }

        case 'plan_probe': {
          const caseId = typeof input.case_id === 'string' ? input.case_id : ''
          if (!caseId) return err('plan_probe 需要 case_id')
          const raw = input.probes
          if (!Array.isArray(raw) || raw.length === 0) return err('plan_probe 需要 probes[]')
          const results: string[] = []
          for (const item of raw) {
            const p = item as Record<string, unknown>
            const hypothesisIds = Array.isArray(p.hypothesis_ids) ? p.hypothesis_ids.filter((x): x is string => typeof x === 'string') : []
            const kind = typeof p.kind === 'string' ? p.kind as ProbeKind : 'read'
            const target = typeof p.target === 'string' ? p.target : ''
            if (!target.trim() || hypothesisIds.length === 0) { results.push('rejected: 探针需要 target + hypothesis_ids'); continue }
            const expectation = parseExpectation(p.expectation)
            if (typeof expectation === 'string') { results.push(`rejected: ${expectation}`); continue }
            const perRaw = Array.isArray(p.per_hypothesis) ? p.per_hypothesis : []
            const perHypothesis: ProbeHypothesisLink[] = []
            let linkError: string | null = null
            for (const l of perRaw) {
              const link = l as Record<string, unknown>
              const hid = typeof link.hypothesis_id === 'string' ? link.hypothesis_id : ''
              const ifTrue = link.if_true
              if (!hid || (ifTrue !== 'supports' && ifTrue !== 'refutes' && ifTrue !== 'neutral')) {
                linkError = 'per_hypothesis 条目需要 hypothesis_id + if_true(supports|refutes|neutral)'
                break
              }
              const ifFalse = link.if_false
              perHypothesis.push({
                hypothesisId: hid,
                ifTrue,
                ifFalse: ifFalse === 'supports' || ifFalse === 'refutes' || ifFalse === 'neutral' ? ifFalse : undefined,
              })
            }
            if (linkError) { results.push(`rejected: ${linkError}`); continue }
            const risk = p.risk === 'medium' || p.risk === 'high' ? p.risk : 'low'
            const r = store.apply({
              type: 'probe_planned', caseId, turn,
              probe: { hypothesisIds, kind, target, expectation, perHypothesis, risk },
            })
            results.push(r.rejected ? `rejected: ${r.rejected}` : `planned: ${r.state.probes[r.state.probes.length - 1]!.id} ${kind}→${target}`)
          }
          const state = store.getCase(caseId)
          const body = [...results, '', state ? renderBoard(state, store) : '']
          body.push('执行探针用常规工具（grep/run_tests/read…），结算用 observe 带 evidence_ref。低风险只读探针可 delegate_task 并行跑，不阻塞主线。')
          return {
            content: body.join('\n'),
            uiContent: `攻坚计划探针：${results.length} 项`,
            isError: results.every(r => r.startsWith('rejected')),
          }
        }

        case 'observe': {
          const caseId = typeof input.case_id === 'string' ? input.case_id : ''
          const probeId = typeof input.probe_id === 'string' ? input.probe_id : ''
          const outcome = input.predicate_outcome
          if (!caseId || !probeId) return err('observe 需要 case_id + probe_id')
          if (outcome !== 'true' && outcome !== 'false' && outcome !== 'unobservable') {
            return err('observe 需要 predicate_outcome(true|false|unobservable)')
          }
          const evidenceRef = typeof input.evidence_ref === 'string' ? input.evidence_ref : undefined

          // H4-B 引用验真：优先查 Evidence Registry（scope+消费），
          // 未注册降级到轻量验真器；unobservable 无需证据引用。
          let evidenceVerified = true
          if (outcome !== 'unobservable') {
            if (!evidenceRef) return err('可观测结果的 observe 需要 evidence_ref（tool:<name>[:<turn>] | worker:<orderId> | obligation:<id>）')
            const probeTarget = store.getCase(caseId)?.probes.find(p => p.id === probeId)?.target
            const check = checkEvidenceRef(evidenceRef, { caseId, probeId, probeTarget }, store, deps.getVerifier?.() ?? null)
            if (check.verdict === 'invalid') return err(check.reason)
            evidenceVerified = check.verdict === 'verified'
          }
          // 8.1 修复：并行加分只认真实委派信号（markDelegation 窗口，或已验真的
          // worker 引用——后者本身要求 hasDelegated）。字符串前缀不再是旁路。
          const viaDelegation = store.isWithinDelegationWindow(turn)
            || (evidenceVerified && Boolean(evidenceRef?.startsWith('worker:')))

          const r = store.apply({
            type: 'probe_observed', caseId, turn, probeId,
            predicateOutcome: outcome, evidenceRef, viaDelegation, evidenceVerified,
          })
          if (r.rejected) return err(r.rejected)
          const scoreText = renderScore(r.scored, r.state, store)
          const unverifiedNote = !evidenceVerified && outcome !== 'unobservable'
            ? '证据引用未能对工具历史验真（可能已超出窗口）——状态已结算但本次零分。用可核验的引用（真实工具执行 / worker 派发 / 义务 id）才计分。'
            : ''
          return {
            content: [scoreText, unverifiedNote, '', renderBoard(r.state, store)].filter(Boolean).join('\n'),
            uiContent: `攻坚观察：${probeId} → ${outcome}${r.scored.length ? ` (+${r.scored.reduce((s, e) => s + e.points, 0)})` : ''}`,
            isError: false,
          }
        }

        case 'status': {
          const caseId = typeof input.case_id === 'string' ? input.case_id : ''
          if (caseId) {
            const state = store.getCase(caseId)
            if (!state) return err(`未知案件：${caseId}`)
            return { content: renderBoard(state, store), uiContent: `攻坚状态：${caseId}`, isError: false }
          }
          const active = store.activeCases()
          if (active.length === 0) return { content: '当前无存活攻坚案件。', uiContent: '攻坚状态：无活跃案件', isError: false }
          return {
            content: active.map(c => renderBoard(c, store)).join('\n\n'),
            uiContent: `攻坚状态：${active.length} 个活跃案件`,
            isError: false,
          }
        }

        case 'close': {
          const caseId = typeof input.case_id === 'string' ? input.case_id : ''
          if (!caseId) return err('close 需要 case_id')
          const resolution = input.resolution === 'converged' || input.resolution === 'resolved_externally' ? input.resolution : 'abandoned'
          const r = store.apply({ type: 'case_closed', caseId, turn, resolution })
          if (r.rejected) return err(r.rejected)
          const lines = [`案件已关闭：${caseId}（${resolution}）· 本案得分 ${r.state.score} · 会话累计 ${store.totalScore()}`]
          // P4 收束闸（工具侧半边）：converged 收案时提示同 targets 的未闭合
          // 义务——假说收敛 ≠ 义务核销，交付前先把验证做实。只读提示不改义务。
          if (resolution === 'converged' && r.state.selectedHypothesisId) {
            const targets = r.state.hypotheses.find(h => h.id === r.state.selectedHypothesisId)?.targets ?? []
            const openIds = deps.getVerifier?.()?.openObligationIdsForTargets?.(targets) ?? []
            if (openIds.length > 0) {
              lines.push(`收敛假设的 targets 关联 ${openIds.length} 条未闭合义务（${openIds.slice(0, 3).join(', ')}${openIds.length > 3 ? ' …' : ''}）——假说收敛不等于验证完成，交付前先核销。`)
            }
          }
          return {
            content: lines.join('\n'),
            uiContent: `攻坚案件已关闭：${caseId}`,
            isError: false,
          }
        }

        default:
          return err(`未知 op：${String(op)}`)
      }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return false },
    isEnabled(): boolean { return true },
  }
}

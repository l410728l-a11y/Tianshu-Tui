import type { PostToolRuntimeHook, PostTurnRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import {
  MAX_EVIDENCE_AGE_TURNS,
  hasRemainingPlannedProbes,
  type AttackScoreEvent,
  type DiscriminatorProbe,
  type ProblemAttackStore,
} from '../problem-attack-loop.js'
import { proposeProbeCandidates } from '../probe-candidates.js'
import { appendMemoryEntry, countSimilarMemoryEntries } from '../../memory/unified-memory.js'

/**
 * PAL hook 双半边（计划 v2 Wave P2）。
 *
 * postTool 半边：
 *   - delegate_task / delegate_batch 派发 → 标记并行探针窗口（结算落窗内加分）。
 *   - 对存活案件的 planned/attempted 探针做**保守自动谓词结算**：只在工具事件
 *     能机器判定谓词时结算（test_outcome / tool_error_class / command_output_matches /
 *     pattern_found|absent 的高置信路径），不确定就不动——留给模型 observe 手动结算。
 *     重复结算被 reducer 幂等拒绝，双路径安全。
 *
 * postTurn 半边：
 *   - drainLog → telemetry（problem-attack-event，全量留痕）。
 *   - active 模式：本轮自动结算产生加分 → 经 advisory bus 发一条聚合鼓励
 *     （模型手动 observe 的加分已在工具回执里，不重复发声）。
 *
 * 鼓励纪律：分数只来自 reducer 推导；hook 不凭空造分，只是把自动结算
 * 挣到的分送回模型可见通道。shadow 模式零 submit。
 */

export type PalMode = 'off' | 'shadow' | 'active'

/** RIVET_PAL 闸门：'0'/'off' 关闭，'active' 开放鼓励 advisory，缺省 shadow。 */
export function palMode(env: NodeJS.ProcessEnv = process.env): PalMode {
  const raw = env.RIVET_PAL
  if (raw === 'off' || raw === '0') return 'off'
  if (raw === 'active') return 'active'
  return 'shadow'
}

const DELEGATE_TOOLS = new Set(['delegate_task', 'delegate_batch'])

/** 保守自动结算：能机器判定 → 返回 outcome；不确定 → null（不结算）。 */
export function settleProbeAgainstTool(
  probe: DiscriminatorProbe,
  tool: RuntimeToolEvent,
): 'true' | 'false' | null {
  const exp = probe.expectation
  const input = tool.input ?? {}

  switch (exp.kind) {
    case 'test_outcome': {
      if (tool.name !== 'run_tests') return null
      const target = typeof input.filter === 'string' ? input.filter
        : typeof input.target === 'string' ? input.target
        : tool.target ?? ''
      if (!target.includes(exp.target) && !exp.target.includes(target)) return null
      // 环境类失败不可判定测试结论（timeout/env_missing 等 ≠ 测试红）
      if (tool.failureClass === 'timeout' || tool.failureClass === 'env_missing' || tool.failureClass === 'missing_dep') return null
      // run_tests 工具本身执行成功才可判定测试结论；isError = 测试红
      const testsFailed = tool.isError === true
      const observed: 'pass' | 'fail' = testsFailed ? 'fail' : 'pass'
      return observed === exp.expect ? 'true' : 'false'
    }
    case 'tool_error_class': {
      if (tool.name !== exp.tool) return null
      if (!tool.isError) return 'false'
      return tool.failureClass === exp.errorClass ? 'true' : 'false'
    }
    case 'command_output_matches': {
      if (tool.name !== 'bash') return null
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd.includes(exp.commandIncludes)) return null
      const content = tool.resultContent
      if (typeof content !== 'string') return null
      try {
        return new RegExp(exp.outputPattern).test(content) ? 'true' : 'false'
      } catch {
        return content.includes(exp.outputPattern) ? 'true' : 'false'
      }
    }
    case 'pattern_found':
    case 'pattern_absent': {
      if (tool.name !== 'grep') return null
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      const path = typeof input.path === 'string' ? input.path
        : typeof input.glob === 'string' ? input.glob : ''
      // 高置信路径：grep 的 pattern 与谓词 needle 一致，且搜索范围覆盖谓词 path
      if (pattern !== exp.needle) return null
      if (path && !exp.path.includes(path) && !path.includes(exp.path)) return null
      const content = tool.resultContent ?? ''
      if (tool.isError) return null
      const found = content.trim().length > 0 && !/^no matches\b/i.test(content.trim())
      const predicate = exp.kind === 'pattern_found' ? found : !found
      return predicate ? 'true' : 'false'
    }
  }
}

export interface ProblemAttackHookDeps {
  store: ProblemAttackStore
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  mode?: PalMode
  /** telemetry 落盘（loop.telemetryWriter.write 桥）。 */
  writeTelemetry: (event: { kind: string } & Record<string, unknown>) => void
  /** H4-D3 持久化半边：本轮有攻坚活动时保存快照（loop-factory 桥到
   *  session meta）。缺席 = 不持久化（测试/无 persist 上下文）。 */
  persistSnapshot?: (snapshot: import('../problem-attack-loop.js').PalSnapshot) => void
  /** 虚空仓库 P0：项目根目录——收敛案件自动收割进 `<cwd>/.rivet/knowledge/memory.jsonl`。
   *  缺席 = 不收割（测试/无项目上下文）。 */
  cwd?: string
  /** 虚空仓库 P0：收割条目的 sessionId 溯源标记。 */
  sessionId?: string
}

export function createProblemAttackHooks(deps: ProblemAttackHookDeps): {
  postTool: PostToolRuntimeHook
  postTurn: PostTurnRuntimeHook
} {
  const mode = deps.mode ?? palMode()
  /** 本轮自动结算挣到的分（postTurn 聚合送回）。 */
  let autoScored: AttackScoreEvent[] = []

  const postTool: PostToolRuntimeHook = {
    phase: 'postTool',
    name: 'problem-attack-settle',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent) {
      if (mode === 'off') return
      const turn = ctx.snapshot.turn

      if (DELEGATE_TOOLS.has(tool.name) && !tool.isError) {
        deps.store.markDelegation(turn)
      }

      const active = deps.store.activeCases()
      if (active.length === 0) return
      for (const c of active) {
        for (const probe of c.probes) {
          if (probe.status !== 'planned' && probe.status !== 'attempted') continue
          const outcome = settleProbeAgainstTool(probe, tool)
          if (outcome === null) continue
          // H4-B：真实 producer 注册证据——自动结算的引用由 hook 构造，
          // 先入 registry 再结算，保证 scope 绑定（case+probe）可追溯。
          const evidenceRef = `tool:${tool.name}:${turn}`
          deps.store.registerEvidence({
            producer: 'tool',
            caseId: c.caseId,
            probeId: probe.id,
            turn,
            ref: evidenceRef,
          })
          const r = deps.store.apply({
            type: 'probe_observed',
            caseId: c.caseId,
            turn,
            probeId: probe.id,
            predicateOutcome: outcome,
            evidenceRef,
            viaDelegation: deps.store.isWithinDelegationWindow(turn),
            // 自动结算的引用由真实工具事件自构造——天然已验真
            evidenceVerified: true,
          })
          if (!r.rejected && r.scored.length > 0) {
            autoScored.push(...r.scored)
          }
        }
      }
    },
  }

  const postTurn: PostTurnRuntimeHook = {
    phase: 'postTurn',
    name: 'problem-attack-telemetry',
    run(ctx: RuntimeHookContext) {
      if (mode === 'off') return

      // H4-D2：自动过期——超出 TTL 的 available 证据标记为 expired
      // R1：过期发生轮显式传入（log 的 turn 保持注册轮语义）
      deps.store.expireEvidenceBefore(ctx.snapshot.turn - MAX_EVIDENCE_AGE_TURNS, ctx.snapshot.turn)

      // ── 虚空仓库 P0: PAL 收敛案件自动收割 → memory.jsonl ─────────────
      // 收敛结论（selectedHypothesis.claim）自动入知识库，无需 agent 在
      // learned 里手动重述。两道防线：harvestedCaseIds 守卫（防跨 turn /
      // 跨会话重复，随快照持久化——本段在 persistSnapshot 前执行，标记随
      // 本轮快照落盘）；写前 countSimilarMemoryEntries 相似去重（兜底：
      // agent 经 learned 重述同一结论时不双写）。shadow/active 均收割——
      // 这是持久化副作用，不是模型可见的信号注入。
      if (deps.cwd) {
        try {
          const unharvested = deps.store.convergedCasesSnapshot()
            .filter(c => !deps.store.isHarvested(c.caseId))
          for (const c of unharvested) {
            // 无论写没写都标记，防每 turn 反复相似度扫描
            deps.store.markHarvested(c.caseId)
            if (!c.claim) continue
            const text = `PAL 收敛案件 ${c.caseId}：${c.claim}`
            if (countSimilarMemoryEntries(deps.cwd, text) > 0) continue
            appendMemoryEntry(deps.cwd, {
              text,
              kind: 'verified_pattern',
              confidence: 0.95,
              source: 'agent-crafted',
              status: 'verified',
              evidence: c.evidenceRefs.length > 0 ? c.evidenceRefs.join(', ') : undefined,
              sessionId: deps.sessionId,
              tags: ['pal-converged', `case:${c.caseId}`],
              transferableTo: ['all'],
              topic: c.targets[0],
            })
          }
        } catch { /* best-effort：收割失败不阻断 turn */ }
      }

      const applied = deps.store.drainLog()
      const evidenceEvents = deps.store.drainEvidenceLog()

      // H4-D3 保存半边：本轮有任何攻坚/证据活动才写快照（无 PAL 活动的
      // 会话不产生 meta 写放大）。
      if (deps.persistSnapshot && (applied.length > 0 || evidenceEvents.length > 0)) {
        try {
          deps.persistSnapshot(deps.store.exportSnapshot())
        } catch { /* best-effort：持久化失败不阻断 turn */ }
      }
      for (const a of applied) {
        deps.writeTelemetry({
          kind: 'problem-attack-event',
          turn: ctx.snapshot.turn,
          mode,
          eventType: a.event.type,
          caseId: a.event.caseId,
          probeId: a.event.probeId ?? null,
          rejected: a.rejected ?? null,
          scored: a.scored.map(s => ({ kind: s.kind, points: s.points })),
          version: a.version,
        })
      }

      // H4-C：证据注册表事件留痕（注册/解析/消费/拒绝）
      for (const e of evidenceEvents) {
        deps.writeTelemetry({
          kind: 'problem-attack-evidence',
          turn: ctx.snapshot.turn,
          mode,
          action: e.action,
          evidenceId: e.evidenceId,
          producer: e.producer,
          ref: e.ref,
          caseId: e.caseId,
          probeId: e.probeId,
          evidenceTurn: e.turn,
          scopeMatch: e.scopeMatch ?? null,
          rejectReason: e.rejectReason ?? null,
        })
      }

      // P2 telemetry：候选生成器 shadow 留痕——只对"无未结算探针"的搜索态
      // 案件评估（有 planned 时回执的 L0 建议已覆盖，候选层不发声不留痕）。
      // 纯观测：不 submit、不改 state，供 P2 验收统计候选质量。
      for (const c of deps.store.activeCases()) {
        if (c.status !== 'probing' && c.status !== 'forming') continue
        if (hasRemainingPlannedProbes(c)) continue
        const cands = proposeProbeCandidates(c, {
          availableEvidence: deps.store.availableEvidenceFor(c.caseId),
        })
        if (!cands.primary && !cands.reuseObserveProbeId) continue
        deps.writeTelemetry({
          kind: 'probe-candidate',
          turn: ctx.snapshot.turn,
          mode,
          caseId: c.caseId,
          reuseObserveProbeId: cands.reuseObserveProbeId,
          primary: cands.primary
            ? { kind: cands.primary.kind, target: cands.primary.target, coverage: cands.primary.coverage }
            : null,
          alternates: cands.alternates.length,
        })
      }

      // 鼓励通道：自动结算挣到的分聚合送回（手动 observe 的分已在工具回执）。
      // shadow 只落 telemetry；active 才 submit——"名义 shadow 实际影响模型"是反证项。
      if (autoScored.length > 0 && mode === 'active') {
        const total = autoScored.reduce((s, e) => s + e.points, 0)
        const kinds = [...new Set(autoScored.map(s => s.kind))].join(', ')
        deps.advisoryBus.submit({
          key: 'attack-auto-score',
          priority: 0.4,
          category: 'encouragement',
          tier: 'informational',
          content: `攻坚层自动结算：探针谓词已由本轮工具输出核销，+${total} 分（${kinds}）。判别探针在起作用——用 attack_case status 查看假设板与下一个建议探针。`,
          ttl: 1,
        })
      }
      autoScored = []
    },
  }

  return { postTool, postTurn }
}

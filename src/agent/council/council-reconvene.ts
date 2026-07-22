// 波间自动复议 —— 织命议事会 Phase 3（Norns：断线时召回纺线人）。
//
// wave-gate 失败时，按契约 provenance（UnifiedTaskNode.metadata.proposedBy）
// 只召回提案席位 + 平衡柱做轻量复议：席位隔离会话（走既有 delegateBatch
// worker 通道）、主会话纯追加（复议结果以 markdown 段落追加，不重写历史）。
// 复议产出是 advisory 修订建议——契约修订本身仍是主控决策点
// （revisePlanSeal 豁免协议），自动复议绝不静默改写密封契约。

import { runCouncil, type CouncilDeps } from './council-orchestrator.js'
import { pillarOf } from './council-routing.js'
import type { CouncilSeat } from './council-routing.js'
import type { CouncilDraft } from './council-plan.js'

/** 复议召回所需的最小任务形状（来自失败波的 UnifiedTaskNode）。 */
export interface ReconveneTaskRef {
  id: string
  title: string
  detail: string
  /** 提案血缘（metadata.proposedBy）：席位 authority 或 'draft'。 */
  proposedBy?: string
}

/**
 * 按 provenance 选择召回席位：
 *  - 失败波任务的提案席位（proposedBy，'draft' 不算——草案来自主控，无席可召）
 *  - 加平衡柱席位（合成裁决职能，复议必到）
 *  - 无血缘可循时回退召回原班前 3 席（轻量上限，不重开全席会诊）
 */
export function selectReconveneSeats(
  tasks: readonly ReconveneTaskRef[],
  originalSeats: readonly CouncilSeat[],
): CouncilSeat[] {
  const proposers = new Set(
    tasks.map(t => t.proposedBy).filter((p): p is string => Boolean(p) && p !== 'draft'),
  )
  const recalled = originalSeats.filter(s => proposers.has(s.authority))
  // 无血缘可循 → 回退原班前 3 席（轻量上限）；有血缘才追加平衡柱合成席。
  if (recalled.length === 0) return originalSeats.slice(0, 3)
  const balance = originalSeats.find(s => pillarOf(s.authority) === 'balance')
  if (balance && !recalled.some(s => s.authority === balance.authority)) {
    recalled.push(balance)
  }
  return recalled
}

/** 组装复议草案：目标带门禁失败证据，条目为失败波任务（detail 附血缘）。 */
export function buildReconveneDraft(opts: {
  objective: string
  wave: number
  failures: readonly string[]
  tasks: readonly ReconveneTaskRef[]
}): CouncilDraft {
  const failureBlock = opts.failures.length > 0
    ? `门禁失败证据：\n${opts.failures.map(f => `- ${f}`).join('\n')}`
    : '门禁失败（无结构化失败项，见波执行输出）'
  return {
    objective: [
      `波间复议 — ${opts.objective}`,
      `wave ${opts.wave + 1} 验证门禁未通过。${failureBlock}`,
      '任务：诊断失败根因，对下列任务给出修订建议（缩范围/补验证/改依赖/砍任务均可）。',
      '这是复议不是重规划——只动与失败相关的条目。',
    ].join('\n'),
    items: opts.tasks.map(t => ({
      id: t.id,
      title: t.title,
      detail: `${t.detail}${t.proposedBy ? `（提案：${t.proposedBy}）` : ''}`,
    })),
  }
}

export interface WaveReconveneInput {
  objective: string
  wave: number
  failures: readonly string[]
  tasks: readonly ReconveneTaskRef[]
  originalSeats: readonly CouncilSeat[]
  abortSignal?: AbortSignal
}

/**
 * 执行一次轻量复议：召回席位 → runCouncil（复用解析/重试/法定人数机制）→
 * 渲染 advisory markdown 段。复议自身失败绝不阻断波结果（返回失败留痕行）。
 */
export async function runWaveReconvene(
  input: WaveReconveneInput,
  deps: CouncilDeps,
): Promise<string[]> {
  const seats = selectReconveneSeats(input.tasks, input.originalSeats)
  const header = `## 波间复议（自动召回：${seats.map(s => s.authority).join(' · ')}）`
  // 队列按 authority 派生 key 去重（首轮会诊已占用 `council:seat-<authority>`）——
  // 复议派发追加 `-reconvene` 后缀绕开去重，结果上剥回后缀让 runCouncil 正常绑席。
  const reconveneDeps: CouncilDeps = {
    ...deps,
    delegateBatch: async (requests, policy, signal, onProgress) => {
      const suffixed = requests.map(r => ({ ...r, parentTurnId: `${r.parentTurnId}-reconvene` }))
      const run = await deps.delegateBatch(suffixed, policy, signal, onProgress)
      return {
        ...run,
        results: run.results.map(r => ({ ...r, workOrderId: r.workOrderId.replace(/-reconvene$/, '') })),
        ...(run.workerModels
          ? { workerModels: run.workerModels.map(m => ({ ...m, workOrderId: m.workOrderId.replace(/-reconvene$/, '') })) }
          : {}),
      }
    },
  }
  try {
    const draft = buildReconveneDraft(input)
    const plan = await runCouncil(
      { draft, seats: [...seats], ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) },
      reconveneDeps,
    )
    const lines = [header, '']
    for (const c of plan.contributions.filter(c => (c.round ?? 1) === 1)) {
      lines.push(`### ${c.authority}`, c.summary || '_（无摘要）_', '')
    }
    lines.push(
      '复议建议为 advisory——采纳修订需主控裁定：修改契约后走 `revisePlanSeal` 豁免协议复封，再以 `team_orchestrate({ objective, fromWave })` 续跑。',
    )
    return lines
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [header, '', `⚠ 复议流会：${msg} —— 请人工诊断门禁失败项后修订契约续跑。`]
  }
}

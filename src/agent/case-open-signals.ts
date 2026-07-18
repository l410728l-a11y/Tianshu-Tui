/**
 * Case-open signals — PAL 开案入口信号聚合（第四波 W1）。
 *
 * 把散落在各机制里的"卡住形状"事实聚合成带稳定锚的开案信号，作为
 * CvmVectorInput 的纯输入扩展喂给 CV3-open。设计约束：
 *
 * - 纯函数：无 IO、无 Date.now()、无随机——相同输入产生相同信号序列
 *   （顺序确定，锚 ref 稳定，CV3 文案/遥测字节稳定）。
 * - 只聚合、不发声：开案建议是 CV3 的单声道职责，本模块绝不 submit。
 * - obligation 源只取 high + blocked：open/attempted 的 high 义务会命中
 *   evaluator 第一层 gate-blocked 提前返回，信号永远到不了 CV3；blocked
 *   态既表达"试过且失败"又不触 gate，语义恰好是开案形状。
 * - plan trace 无 steps 时 plan-blocked 源自然缺席（不报错）——这是
 *   ④c 反证的核心教训：不写 todo 的会话不能依赖 trace 存在。
 */

import type { AttackAnchor } from './problem-attack-loop.js'
import type { ConvergenceResult } from './convergence-detector.js'
import type { ObligationStore } from './evidence-obligation.js'
import type { PlanExecutionTrace } from './plan-execution-trace.js'
import type { WaveGateRecord } from './wave-gate.js'

export type CaseOpenSignalSource =
  | 'regression-bisect'
  | 'dead-end-file'
  | 'edit-failure'
  | 'convergence-abort'
  | 'wave-gate'
  | 'plan-blocked'
  | 'obligation-high'

export interface CaseOpenSignal {
  /** 稳定锚事实——直接可进 attack_case open 的 anchor 参数。 */
  anchor: AttackAnchor
  source: CaseOpenSignalSource
  /** 一句话问题描述（进 open 骨架的 problem 提示）。 */
  summary: string
}

/** plan trace 尾部连续 blocked 阈值——低于此不构成开案信号。 */
export const PLAN_BLOCKED_STREAK_THRESHOLD = 2

export interface CaseOpenSignalInput {
  /** render 前的 AdvisoryBus.peekPendingKeys() 只读快照。 */
  pendingAdvisoryKeys: readonly string[]
  obligations: ObligationStore
  /** 执行 trace；null 或无 steps 时 plan-blocked 源缺席。 */
  planTrace: PlanExecutionTrace | null
  /** 最近一次 wave-gate 评估记录；undefined = 本会话未跑过门禁。 */
  waveGate: WaveGateRecord | undefined
  /** 遗产回收 W-A2：convergence 硬熔断事实。引用 ConvergenceResult 类型字段
   *  （非手写 inline）保编译期同步；undefined/null = 本轮无 convergence 结果。 */
  convergenceAbort?: Pick<ConvergenceResult, 'shouldAbort' | 'abortCause'> | null
}

/**
 * 聚合开案信号。输出顺序固定：failure_pattern 专用 hook 信号
 * （regression-bisect → dead-end-file → edit-failure 按路径字典序 →
 * convergence-abort）→ blocked high 义务（按 id 字典序）→
 * plan trace blocked streak → wave-gate 失败。空数组 = 无开案形状。
 */
export function collectCaseOpenSignals(input: CaseOpenSignalInput): CaseOpenSignal[] {
  const signals: CaseOpenSignal[] = []

  if (input.pendingAdvisoryKeys.includes('regression-bisect')) {
    signals.push({
      anchor: { kind: 'failure_pattern', ref: 'regression-bisect' },
      source: 'regression-bisect',
      summary: '回归语义 + 多轮只读诊断空转——基线对照定位比继续正向排查更快',
    })
  }
  if (input.pendingAdvisoryKeys.includes('dead-end-file')) {
    signals.push({
      anchor: { kind: 'failure_pattern', ref: 'dead-end-file' },
      source: 'dead-end-file',
      summary: '同一文件反复修改无进展——锚定形状，需要竞争解释而非继续改',
    })
  }

  // 遗产回收 W-A2：同文件连续编辑失败。advisory key 带动态后缀
  // （edit-failure-recovery:<filePath>），需前缀过滤而非精确匹配。
  // 多文件同时卡死 → 每文件独立信号（各文件卡死原因独立：行号漂移 vs
  // 权限 vs 语法，CV3-open 骨架需要具体路径），按 filePath 字典序保确定性。
  const editFailureKeys = input.pendingAdvisoryKeys
    .filter(k => k.startsWith('edit-failure-recovery:'))
    .slice()
    .sort()
  for (const key of editFailureKeys) {
    const filePath = key.slice('edit-failure-recovery:'.length)
    signals.push({
      anchor: { kind: 'failure_pattern', ref: key },
      source: 'edit-failure',
      summary: `文件 ${filePath} 连续编辑失败——卡死原因需要竞争解释（行号漂移/内容陈旧/语法），先探针再改`,
    })
  }

  // 遗产回收 W-A2：convergence 硬熔断——比 L2 停滞更强的卡死证据。
  // 按 abortCause 区分建议：no-tool → 工具权限/定义与任务不匹配；
  // score → 策略本身失效，换方向/换模型。
  if (input.convergenceAbort?.shouldAbort) {
    const cause = input.convergenceAbort.abortCause ?? 'score'
    signals.push({
      anchor: { kind: 'failure_pattern', ref: `convergence-abort:${cause}` },
      source: 'convergence-abort',
      summary: cause === 'no-tool'
        ? '连续无工具输出触发硬熔断——检查工具权限/工具定义是否与任务匹配，或任务本身缺可执行入口'
        : '收敛分数触发硬熔断——当前策略持续无进展，需要竞争解释与判别探针而非继续同路径',
    })
  }

  const blockedHigh = input.obligations.obligations
    .filter(o => o.risk === 'high' && o.state === 'blocked')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const ob of blockedHigh) {
    signals.push({
      anchor: { kind: 'obligation', ref: ob.id },
      source: 'obligation-high',
      summary: `高风险义务受阻：${ob.claim.slice(0, 80)}`,
    })
  }

  const trace = input.planTrace
  if (trace && trace.steps.length > 0) {
    let streak = 0
    let lastBlockedStepId: string | null = null
    for (let i = trace.history.length - 1; i >= 0; i--) {
      const r = trace.history[i]!
      if (r.status !== 'blocked') break
      streak++
      if (lastBlockedStepId === null) lastBlockedStepId = r.stepId
    }
    if (streak >= PLAN_BLOCKED_STREAK_THRESHOLD && lastBlockedStepId !== null) {
      signals.push({
        anchor: { kind: 'trace_step', ref: lastBlockedStepId },
        source: 'plan-blocked',
        summary: `计划步骤连续 ${streak} 轮 blocked——工具反复失败，路径可能选错`,
      })
    }
  }

  if (input.waveGate && !input.waveGate.passed) {
    const failed = input.waveGate.checks
      .filter(c => c.status === 'failed' || (c.status === 'unverifiable' && c.blocking === true))
      .map(c => c.command)
    signals.push({
      anchor: { kind: 'failure_pattern', ref: `wave-${input.waveGate.wave}-gate-failed` },
      source: 'wave-gate',
      summary: `波 ${input.waveGate.wave} 门禁未过：${failed.slice(0, 3).join('; ').slice(0, 120)}`,
    })
  }

  return signals
}

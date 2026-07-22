import type { CompactTier } from './types.js'
import { tierForRatio } from './compact-policy.js'

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  fastGrowth: boolean
  suggestion?: 'task_decomposition'
  ratio: number
  growthRate: number
  /** CVM overhead: fraction of context consumed by CVM injections (0–1) */
  cvmOverheadRatio: number
  /** Should CVM throttle its injections to reduce overhead? */
  shouldThrottleCvm: boolean
  /** v3：相对压力 — 当前 ratio 相对于历史 p90 的归一化值 (0-1)。
   *  tokenHistory < 5 条时为 undefined。下游可用此替代绝对阈值 0.5 判定高压。 */
  pressureRelative?: number
}

/** Minimum ratio delta between consecutive checks to flag fast growth. */
const FAST_GROWTH_THRESHOLD = 0.15

/** CVM overhead threshold: throttle when CVM injections exceed 5% of context. */
const CVM_OVERHEAD_THRESHOLD = 0.05
/** CVM overhead ceiling: hard stop at 8% — skip all non-essential injections. */
const CVM_OVERHEAD_CEILING = 0.08

/** 90th percentile of a non-empty number array. */
function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.9)
  return sorted[Math.min(idx, sorted.length - 1)]!
}

/**
 * W2-B1: egress metering source tags. Every injected request byte is charged
 * at exactly ONE egress (no double counting):
 *   - projection / ephemeral / tool-context — cognitive prep (appendixDelta
 *     block semantics: charged only on byte change)
 *   - advisory-appendix — AdvisoryBus rendered block (same block semantics)
 *   - system-reminder — bus-drained SR appended to the session tail (K1
 *     append-only: charged once per append)
 *   - runtime-payload — runtime hook injectUserMessage payloads (K1
 *     append-only: charged once per append)
 *   - control-appendix — control-plane dynamic appendix (Wave 4, active mode
 *     only; own BlockChargeTracker — the same byte is NEVER also charged to
 *     advisory-appendix)
 */
export type CvmInjectionSource =
  | 'projection'
  | 'ephemeral'
  | 'tool-context'
  | 'advisory-appendix'
  | 'system-reminder'
  | 'runtime-payload'
  | 'control-appendix'

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ turn: number; tokens: number }> = []
  /** Accumulated CVM-injected token estimate across this session. */
  private cvmTokenAccumulator = 0
  /** W2-B1: per-source breakdown — values are CUMULATIVE session tokens.
   *  Invariant: sum over sources === cvmTokenAccumulator. */
  private cvmBySource = new Map<CvmInjectionSource, number>()

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    const tier = tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)

    // ── Growth rate: ratio delta since last check ──
    const prevRatio = this.tokenHistory.length > 0
      ? (this.tokenHistory[this.tokenHistory.length - 1]!.tokens / this.contextWindow)
      : ratio
    const growthRate = ratio - prevRatio
    const fastGrowth = growthRate >= FAST_GROWTH_THRESHOLD

    // ── Relative pressure: current ratio vs historical p90 ──
    // 绝对阈值 0.5 在 ctxRatio 均值 ~10% 时永远不触发（见计划二节）。
    // 相对压力以近期历史为基线，当前 ratio 超过 p90 时 pressureRelative → 1.0。
    const historyRatios = this.tokenHistory.map(h => h.tokens / this.contextWindow)
    const pressureRelative = historyRatios.length >= 5
      ? Math.min(1, ratio / Math.max(p90(historyRatios), 0.01))
      : undefined

    // Record for next comparison
    this.tokenHistory = [...this.tokenHistory, { turn: currentTurn, tokens: estimatedTokens }].slice(-20)

    // ── CVM overhead ──
    const cvmOverheadRatio = this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0

    const shouldCompact = tier > 0

    return {
      tier,
      shouldCompact,
      thrashing,
      fastGrowth,
      suggestion: thrashing && shouldCompact ? 'task_decomposition' : undefined,
      ratio,
      growthRate,
      cvmOverheadRatio,
      shouldThrottleCvm: cvmOverheadRatio >= CVM_OVERHEAD_THRESHOLD,
      pressureRelative,
    }
  }

  /**
   * Record CVM-injected tokens for overhead tracking.
   *
   * W6（2026-07-11）计费口径 = 增量字节：appendixDelta 下字节恒定块入场
   * 付一次、稳态零重发，调用方（turn-step-producer）只在块内容变化时计费。
   * 旧口径每轮全额计费高估 ~10x，长会话必然越过阈值、误熄镜面。
   *
   * Overhead accumulates until compact — history rewrite drops the injected
   * blocks from context, so compaction-controller calls resetCvmOverhead().
   * If the ratio exceeds thresholds, the next check() signals shouldThrottleCvm.
   */
  recordCvmInjection(estimatedTokens: number, source: CvmInjectionSource = 'projection'): void {
    this.cvmTokenAccumulator += estimatedTokens
    this.cvmBySource.set(source, (this.cvmBySource.get(source) ?? 0) + estimatedTokens)
  }

  /** W2-B1: cumulative per-source injection tokens (telemetry breakdown). */
  getCvmInjectionBySource(): Readonly<Partial<Record<CvmInjectionSource, number>>> {
    return Object.fromEntries(this.cvmBySource)
  }

  /** Reset CVM overhead counter (e.g., after checkpoint-resume). */
  resetCvmOverhead(): void {
    this.cvmTokenAccumulator = 0
    this.cvmBySource.clear()
  }

  getCvmOverheadRatio(): number {
    return this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0
  }

  isCvmThrottling(): boolean {
    return this.getCvmOverheadRatio() >= CVM_OVERHEAD_THRESHOLD
  }

  isCvmThrottlingCeiling(): boolean {
    return this.getCvmOverheadRatio() >= CVM_OVERHEAD_CEILING
  }

  recordCompaction(turn: number): void {
    this.compactionTurns = [...this.compactionTurns, turn].slice(-10)
  }

  getCompactionTurns(): number[] {
    return [...this.compactionTurns]
  }

  private detectThrashing(currentTurn: number): boolean {
    return this.compactionTurns.filter(turn => currentTurn - turn <= 4).length >= 3
  }
}

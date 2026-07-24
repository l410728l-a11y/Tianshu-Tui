/**
 * Domain Lesson Precipitation — extract lessons from worker results (V3 Component B-write).
 *
 * Called after coordinator completes a delegation. Inspects worker result
 * evidence to extract domain-specific lessons, then deposits them into
 * DomainKnowledgeStore.
 *
 * Mirrors dream.ts distillation pattern: high-gate (only high-confidence
 * evidence), but operates per-domain rather than per-session.
 *
 * Lesson kind mapping (from spec §3.3):
 *   - defect_pattern:  failure-classifier categorized failures
 *   - invariant:       codebase constraints discovered during execution
 *   - adversarial_input: inputs that caused errors or unexpected behavior
 *   - selection_rule:  trade-off decisions and their outcomes
 *   - reframe:         perspective shifts discovered during exploration
 */

import type { WorkerResult } from './work-order.js'
import type { DomainKnowledgeStore, DomainLessonKind } from './domain-knowledge-store.js'
import { starDomainRegistry } from './star-domain-registry.js'

/** Input for precipitation */
export interface PrecipitateInput {
  domainId: string
  results: WorkerResult[]
  /** Task objective for context extraction */
  objective: string
}

// ─── Types ──────────────────────────────────────────────────────

interface ExtractedLesson {
  kind: DomainLessonKind
  text: string
  evidence: string
}

// ─── Quality gate ────────────────────────────────────────────────

/**
 * Quality gate: reject mechanically-extracted lessons that carry no reusable insight.
 * Minimum effective length of 30 ensures the lesson conveys a non-trivial judgment.
 * CJK chars carry roughly double the information density of ASCII, so they
 * count as 2 — 15 个汉字与 30 个英文字符表达量相当。
 */
function effectiveLength(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  return text.length + cjkCount
}

function isHighValueLesson(lesson: ExtractedLesson): boolean {
  return effectiveLength(lesson.text) >= 30
}

// ─── Blocked reason signal extraction ───────────────────────────

interface BlockedSignal {
  /** Regex for blocked reason in worker summary — matches both Chinese and English */
  pattern: RegExp
  /** Human-readable reason label for lesson text */
  reason: string
  kind: DomainLessonKind
}

// NOTE: \b is ASCII-word-boundary only — it does NOT work around CJK chars
// (/\b超时\b/.test('执行超时') === false). English keywords keep \b to avoid
// substring false matches ("microscope" ≠ "scope"); Chinese keywords are
// multi-char terms matched bare — CJK has no word boundaries to anchor on.
const BLOCKED_SIGNALS: BlockedSignal[] = [
  // Permission / scope violations
  {
    pattern: /\b(?:scope|out.of.scope|outside|not allowed|permission denied|access denied|forbidden|unauthorized|not permitted|restricted)\b|超出范围|不在范围|权限不足|没有权限|无权|不允许|禁止操作|拒绝访问|未授权|越权/i,
    reason: '权限/范围限制',
    kind: 'adversarial_input',
  },
  // Approval gates (tool requires human approval)
  {
    pattern: /\b(?:gated|requires? approval|requires? explicit|requires? manual)\b|需要审批|人工审批|需人工|需手动|被拦截|被阻止|审批卡|审批未通过|未经批准/i,
    reason: '需人工审批',
    kind: 'adversarial_input',
  },
  // Tool / resource unavailable
  {
    pattern: /\b(?:not available|not found|unsupported|unavailable|not installed|missing tool)\b|不可用|找不到|不支持|未安装|工具缺失|工具不存在|未配置/i,
    reason: '工具不可用',
    kind: 'adversarial_input',
  },
  // Timeout / circuit open
  {
    pattern: /\b(?:timeout|timed out|circuit open|deadline exceeded|too slow)\b|超时|熔断|断路器|执行中断|连接中断/i,
    reason: '超时/熔断',
    kind: 'adversarial_input',
  },
]

/**
 * Extract a blocked lesson if the worker summary matches a known blocking reason.
 * Uses word-boundary regex (Chinese + English) to avoid substring false matches.
 * Returns at most one lesson — first matching signal wins.
 */
function extractBlockedLesson(result: WorkerResult, objective: string): ExtractedLesson | null {
  const errMsg = result.summary

  for (const signal of BLOCKED_SIGNALS) {
    if (signal.pattern.test(errMsg)) {
      const detail = errMsg.split('\n')[0]?.slice(0, 100) ?? errMsg.slice(0, 100)
      return {
        kind: signal.kind,
        text: `${signal.reason}触发: ${detail}`,
        evidence: `objective="${objective.slice(0, 80)}"`,
      }
    }
  }

  // No known signal matched but the summary is substantial enough to record
  if (effectiveLength(errMsg) > 30) {
    const detail = errMsg.split('\n')[0]?.slice(0, 100) ?? errMsg.slice(0, 100)
    return {
      kind: 'adversarial_input',
      text: `执行受阻: ${detail}`,
      evidence: `objective="${objective.slice(0, 80)}"`,
    }
  }

  return null
}

// ─── Lesson extraction rules ────────────────────────────────────

/** Extract lessons from a single worker result */
function extractLessonsFromResult(result: WorkerResult, objective: string): ExtractedLesson[] {
  const candidates: ExtractedLesson[] = []

  // 1. Failure patterns → defect_pattern
  if (result.status === 'failed') {
    const errMsg = result.summary ?? 'unknown failure'
    const rootCause = errMsg.split('\n')[0]?.slice(0, 150) ?? errMsg.slice(0, 150)
    candidates.push({
      kind: 'defect_pattern',
      text: `此类任务失败模式: ${rootCause}`,
      evidence: `objective="${objective.slice(0, 80)}" summary="${errMsg.slice(0, 100)}"`,
    })
  }

  // 2. Blocked results → adversarial_input (word-boundary regex matching)
  if (result.status === 'blocked') {
    const lesson = extractBlockedLesson(result, objective)
    if (lesson) candidates.push(lesson)
  }

  return candidates.filter(isHighValueLesson)
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Precipitate domain lessons from worker results.
 *
 * Extracts structured lessons from result evidence and deposits them
 * into the domain knowledge store. Non-blocking (deposits are debounced).
 *
 * @returns number of lessons deposited
 */
export function precipitateDomainLessons(
  store: DomainKnowledgeStore,
  input: PrecipitateInput,
): number {
  // Validate domain exists in registry
  if (!starDomainRegistry.has(input.domainId)) return 0

  let count = 0
  for (const result of input.results) {
    const lessons = extractLessonsFromResult(result, input.objective)
    for (const lesson of lessons) {
      store.deposit({
        domainId: input.domainId,
        kind: lesson.kind,
        text: lesson.text,
        evidence: lesson.evidence,
      })
      count++
    }
  }
  return count
}

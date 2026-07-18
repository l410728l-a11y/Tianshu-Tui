/**
 * Steer intent classifier — deterministic labels for mid-run user guidance.
 *
 * Pure functions only (no I/O). Used by SteerBuffer at push time so drain()
 * can tag messages and attach a single action tip for the drained subset.
 *
 * Known W1 limitation: ack matches stop the scan, so
 * 「好的，但换个思路…」→ ack (redirect signal swallowed). Documented; revisit
 * if ack-then-redirect appears frequently in W3 observation.
 */

export type SteerIntent = 'halt' | 'redirect' | 'question' | 'augment' | 'ack' | 'guidance'

export interface SteerIntentResult {
  intent: SteerIntent
  reason: string
}

/** Cap scan length — objectives beyond this are truncated before matching (ReDoS guard). */
export const MAX_STEER_CLASSIFY_CHARS = 200

/** Lower rank = higher urgency for action-tip selection. */
export const STEER_INTENT_RANK: Record<SteerIntent, number> = {
  halt: 0,
  redirect: 1,
  question: 2,
  augment: 3,
  ack: 4,
  guidance: 5,
}

export const STEER_ACTION_TIPS: Record<Exclude<SteerIntent, 'guidance'>, string> = {
  halt: '立即停下当前动作，等用户明确后再继续',
  redirect: '当前方向被否定——先复述你理解的新方向再动手',
  question: '先回答问题；除非答案要求，不改变当前任务方向',
  augment: '登记为追加项，完成当前步骤后处理，不打断主线',
  ack: '用户确认当前方向，按原计划继续',
}

// ── Regex bank (each anchored; no bare substring matches) ──────────
// Chinese uses (?<!CJK)...(?!CJK) as a word boundary; English uses \b.

/** Whole-phrase halt commands (short). Source: plan Wave 1 halt word list. */
const HALT_RE = /^(停|先停|别动|暂停|stop|wait|hold\s+on)\s*[.。!！…]*$/i

/**
 * Redirect / negation. Multi-char phrases are unique enough to include();
 * short 「不对/错了」keep CJK boundaries to avoid 「不对劲」.
 * Source: plan Wave 1 redirect word list.
 */
const REDIRECT_RE =
  /换个思路|方向不对|不是这个|(?<![\u4e00-\u9fff])不对(?![\u4e00-\u9fff])|(?<![\u4e00-\u9fff])错了(?![\u4e00-\u9fff])|\b(?:wrong|not\s+that)\b/i

/** Question words. Source: plan Wave 1 question list. Longest first (为什么 ⊃ 什么). */
const QUESTION_WORD_RE =
  /为什么|怎么|(?<![为])什么|(?:吗|呢)\s*$|\b(?:why|how|what)\b/i

/** Trailing question mark (CJK or ASCII). Elevates to question before redirect. */
const TRAILING_Q_RE = /[?？]\s*$/

/**
 * Imperative / task verbs — blocks bare question; required for augment.
 * Multi-char verbs as phrase includes; English \b-anchored.
 */
const IMPERATIVE_RE =
  /修复|实现|改一下|加个|删掉|继续修|继续改|(?<![\u4e00-\u9fff])[改修做写删加](?=[\u4e00-\u9fff\s]|$)|(?<![\u4e00-\u9fff])修(?![\u4e00-\u9fff])|\b(?:fix|add|remove|implement|change|update|delete|write|build)\b/i

/**
 * Augment markers. Multi-char markers as phrase includes.
 * 「也」requires separators to avoid matching inside other words.
 * Source: plan Wave 1 augment list.
 */
const AUGMENT_RE =
  /顺便|另外|再加|还有|同时|(?:^|[\s,，。；;])也(?=[\s,，。；;.!！？?]|$)/i

/** Whole-phrase ack (no other content). Source: plan Wave 1 ack list. */
const ACK_RE = /^(继续|好的|可以|ok|okay|go\s+ahead|没问题)\s*[.。!！…]*$/i

/**
 * Classify a steer message into one intent. Empty/whitespace → guidance.
 * Scan uses only the first {@link MAX_STEER_CLASSIFY_CHARS} characters.
 */
export function classifySteerIntent(text: string): SteerIntentResult {
  const trimmed = text.trim()
  if (!trimmed) return { intent: 'guidance', reason: 'empty' }

  const sample = trimmed.slice(0, MAX_STEER_CLASSIFY_CHARS)

  // 1. halt
  if (HALT_RE.test(sample)) {
    return { intent: 'halt', reason: 'halt-phrase' }
  }

  // 1b. Trailing ?/？ → question track BEFORE redirect
  // (「不对吗？」must be question, not redirect — plan anti-proof matrix.)
  if (TRAILING_Q_RE.test(sample)) {
    return { intent: 'question', reason: 'trailing-question-mark' }
  }

  // 2. redirect
  if (REDIRECT_RE.test(sample)) {
    return { intent: 'redirect', reason: 'redirect-phrase' }
  }

  // 3. question (words, no trailing mark required)
  if (QUESTION_WORD_RE.test(sample) && !IMPERATIVE_RE.test(sample)) {
    return { intent: 'question', reason: 'question-word' }
  }

  // 4. augment: marker + imperative shape
  if (AUGMENT_RE.test(sample) && IMPERATIVE_RE.test(sample)) {
    return { intent: 'augment', reason: 'augment-imperative' }
  }

  // 5. ack — whole short phrase only (「继续修复登录」fails ACK_RE)
  if (ACK_RE.test(sample)) {
    return { intent: 'ack', reason: 'ack-phrase' }
  }

  // 6. guidance fallback
  return { intent: 'guidance', reason: 'fallback' }
}

/** Highest-urgency intent in a set (for drain action tip). */
export function highestSteerIntent(intents: readonly SteerIntent[]): SteerIntent {
  let best: SteerIntent = 'guidance'
  for (const intent of intents) {
    if (STEER_INTENT_RANK[intent] < STEER_INTENT_RANK[best]) best = intent
  }
  return best
}

export function actionTipForIntent(intent: SteerIntent): string | null {
  if (intent === 'guidance') return null
  return STEER_ACTION_TIPS[intent]
}

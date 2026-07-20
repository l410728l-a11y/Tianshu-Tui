/**
 * Session title extraction from the first user message.
 *
 * Mirrors goal-criteria.ts: a side-path cheap-model call that derives a short
 * session title from the user's first message (à la ChatGPT/Cursor). Never
 * enters the main session prefix, fails open to "no title" so the main run is
 * never blocked by extraction failure. Caller is responsible for double-checking
 * `!record.title` after the await (the user may have set one manually meanwhile).
 *
 * Module boundary: this file holds only pure extraction logic + types. The
 * cheap-client factory + completion-adapter are reused from goal-criteria.ts
 * (buildCheapClient / completionFromClient) — callers import those directly.
 */

/**
 * Generic completion: (system, user) → assistant text. Injectable so the
 * extraction logic stays unit-testable without constructing a real client.
 * Same shape as goal-criteria.ts's CompletionFn (intentionally duplicated
 * for module independence; can be lifted to a shared util later).
 */
export type CompletionFn = (system: string, user: string, signal?: AbortSignal) => Promise<string>

/** Max input chars fed to the model — keeps the prompt cheap on long first messages. */
const MAX_INPUT_CHARS = 800

/** Hard cap on title length. */
const MAX_TITLE_CHARS = 40

const TITLE_SYSTEM = `You generate a concise session title (<=40 chars) from the user's first message in a coding assistant session.

Rules:
- Output ONLY the title text. No quotes, no markdown, no explanation.
- <=40 characters. Truncate gracefully if the natural title would exceed it.
- Use the same language as the user's message (Chinese in → Chinese out, English in → English out).
- Imperative or noun phrase, not a full sentence ("加排序按钮" not "用户想要加一个排序按钮").
- Strip pleasantries ("帮我", "请", "能不能", "can you") and meta talk ("这个任务", "需求是").
- No trailing punctuation.`

/** Build the user turn for title extraction. Exported for testing/transparency. */
export function buildTitleUser(firstMessage: string): string {
  const truncated = firstMessage.length > MAX_INPUT_CHARS ? firstMessage.slice(0, MAX_INPUT_CHARS) : firstMessage
  return `First message:\n${truncated}\n\nGenerate a session title (<=40 chars, same language as the message).`
}

/**
 * Clean the raw model output into a usable title. Tolerant of surrounding
 * quotes / code fences / "标题:" prefixes / extra whitespace. Returns null
 * when nothing usable remains.
 */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim()
  // Strip one layer of wrapping quotes (single / double / CJK corner brackets).
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('「') && t.endsWith('」')) ||
    (t.startsWith('“') && t.endsWith('”'))
  ) {
    t = t.slice(1, -1).trim()
  }
  // Strip a possible "标题:" / "Title:" prefix.
  t = t.replace(/^(title|标题)\s*[:：]\s*/i, '')
  // Collapse to a single line.
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim()
  return t || null
}

/**
 * Extract a short session title from the first user message. Always resolves:
 * on any error or empty/invalid output it returns null (caller leaves the
 * title unset, UI falls back to sessionId slice).
 */
export async function extractSessionTitle(
  firstMessage: string,
  complete: CompletionFn,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const raw = await complete(TITLE_SYSTEM, buildTitleUser(firstMessage), signal)
    return cleanTitle(raw)
  } catch {
    return null
  }
}

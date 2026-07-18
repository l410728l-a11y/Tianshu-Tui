/**
 * Architecture guards — CI-level source-code pattern scanning.
 *
 * Turns design constraints into red/green tests. Inspired by grok-build's
 * guard.rs (compile-time API ban via test scan).
 *
 * Each guard scans src/ for forbidden patterns. When a new violation is
 * introduced, the test fails with a clear message pointing to the file.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(process.cwd(), 'src')

/** Recursively collect .ts files under a directory. */
function collectTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

interface Violation {
  file: string
  line: number
  content: string
}

/** Scan for a regex pattern across source files, returning violations. */
function scanPattern(
  files: string[],
  pattern: RegExp,
  whitelist: string[] = [],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    if (whitelist.some(w => file.includes(w))) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('') || trimmed.startsWith('/*')) return
      if (pattern.test(line)) {
        violations.push({ file: relative(SRC_ROOT, file), line: i + 1, content: trimmed })
      }
    })
  }
  return violations
}

const allSrcFiles = collectTsFiles(SRC_ROOT)

describe('architecture guards', () => {
  test('no direct process.stdout.write outside LiveEngine', () => {
    const violations = scanPattern(
      allSrcFiles,
      /process\.stdout\.write\s*\(/,
      ['/tui/engine/', '/__tests__/'],
    )
    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} direct process.stdout.write call(s) outside LiveEngine:\n` +
        violations.map(v => `  ${v.file}:${v.line}`).join('\n'),
    )
  })

  test('spawn calls without windowsHide (threshold check)', () => {
    // Best-effort scan: flag spawn/spawnSync that lack windowsHide:true
    // in the 10-line window after the call. Allows detached+stdio:ignore.
    const violations: Violation[] = []
    for (const file of allSrcFiles) {
      if (file.includes('/__tests__/')) continue
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.includes('import ')) return
        if (!/(?:^|[^\w.])(?:spawn|spawnSync)\s*\(/.test(trimmed)) return
        const window = lines.slice(i, Math.min(i + 10, lines.length)).join('\n')
        const hasHide = /windowsHide\s*:\s*true/.test(window)
        const isDetachedIgnore = /detached\s*:\s*true/.test(window) && /stdio.*ignore/.test(window)
        if (!hasHide && !isDetachedIgnore) {
          violations.push({ file: relative(SRC_ROOT, file), line: i + 1, content: trimmed })
        }
      })
    }
    // Baseline: internal sync spawnSync calls (platform.ts, resolved-env.ts, etc.)
    // Guard prevents NEW long-running spawn calls without windowsHide from being added.
    assert.ok(
      violations.length <= 25,
      `Spawn guard: ${violations.length} violations (baseline 25, new additions must add windowsHide):\n` +
        violations.map(v => `  ${v.file}:${v.line}`).join('\n'),
    )
  })
})

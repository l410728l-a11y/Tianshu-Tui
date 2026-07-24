/**
 * Integration test: cloneGitSource mirror auto-fallback with REAL git clone.
 *
 * Unlike github-mirror-fallback.test.ts (which injects a fake cloneFn), this
 * test drives the production code path end-to-end: cloneGitSource →
 * cloneWithMirrorFallback → cloneWithFallback → real `git clone` subprocess.
 *
 * Strategy (fully offline, no network):
 *  1. Create a real local git repo in the system tmp dir (git init + commit).
 *  2. Monkey-patch GITHUB_MIRRORS.gitcode.template to point at that local repo
 *     via file:// — so when fallback picks gitcode, the real `git clone` hits
 *     the local repo instead of gitcode.com.
 *  3. Control loadConfig().mirrors via RIVET_CONFIG_PATH (loadConfig has no
 *     cache, re-reads disk every call — see layered-config.test.ts precedent).
 *  4. Call cloneGitSource('https://github.com/test/repo.git'). The direct
 *     attempt to github.com fails fast (short timeout), fallback to gitcode
 *     succeeds against the local repo.
 *
 * Why integration (not unit): the unit test cannot verify that the production
 * wiring (cloneGitSource → cloneWithMirrorFallback → cloneWithFallback) actually
 * invokes a real `git clone` with the correct URL. This test closes that gap.
 */
import { describe, test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { cloneGitSource } from '../../git-source.js'
import { GITHUB_MIRRORS } from '../../../tools/mirror-env.js'
import { clearMirrorMemory } from '../../../tools/github-mirror-fallback.js'

// ── fixtures ───────────────────────────────────────────────────────

let workdir: string
let originRepo: string
let savedTemplate: string
let savedConfigPath: string | undefined

/**
 * Write a config.json with the given mirrors block and point RIVET_CONFIG_PATH
 * at it. Returns a cleanup fn. loadConfig re-reads on every call (no cache),
 * so each test gets an isolated config.
 */
function withConfig(mirrors: Record<string, unknown>): () => void {
  const cfgPath = join(workdir, `config-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(cfgPath, JSON.stringify({ mirrors }))
  const prev = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = cfgPath
  return () => {
    if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prev
    try { rmSync(cfgPath, { force: true }) } catch { /* best-effort */ }
  }
}

before(() => {
  workdir = mkdtempSync(join(tmpdir(), 'rivet-mirror-fallback-int-'))
  originRepo = join(workdir, 'origin')
  mkdirSync(originRepo, { recursive: true })

  // Bootstrap a real local git repo.
  execSync('git init -q', { cwd: originRepo })
  execSync('git config user.email t@t', { cwd: originRepo })
  execSync('git config user.name test', { cwd: originRepo })
  writeFileSync(join(originRepo, 'package.json'), JSON.stringify({ name: 'fake-mirror-repo' }) + '\n')
  writeFileSync(join(originRepo, 'index.js'), "module.exports = {}\n")
  execSync('git add -A', { cwd: originRepo })
  execSync('git commit -q -m init', { cwd: originRepo })

  // Monkey-patch gitcode mirror to point at the local repo.
  // GITHUB_MIRRORS is a mutable `export const` object — direct prop assignment
  // works. We restore the original in after().
  savedTemplate = GITHUB_MIRRORS.gitcode.template
  GITHUB_MIRRORS.gitcode.template = `file://${originRepo}`
})

after(() => {
  // Strict restore — failure here would pollute other test suites.
  GITHUB_MIRRORS.gitcode.template = savedTemplate
  try { rmSync(workdir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

beforeEach(() => {
  clearMirrorMemory()
  savedConfigPath = process.env.RIVET_CONFIG_PATH
})

afterEach(() => {
  if (savedConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
  else process.env.RIVET_CONFIG_PATH = savedConfigPath
})

// ── tests ──────────────────────────────────────────────────────────

describe('cloneGitSource mirror fallback (real git clone, offline)', () => {
  test('direct github.com fails → gitcode (local) succeeds, files present', async () => {
    // autoFallback on, short timeout so the doomed github.com direct attempt
    // fails fast instead of hanging on DNS.
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 3,
      fallbackMemoryMinutes: 10,
    })
    try {
      const result = await cloneGitSource('https://github.com/test/repo.git')
      assert.ok(result.sourcePath, 'sourcePath returned')
      // Real clone happened — the local repo's files are present.
      assert.ok(existsSync(join(result.sourcePath, 'package.json')), 'package.json in clone')
      assert.match(result.commit, /^[0-9a-f]{40}$/, 'commit SHA captured')
      result.cleanup()
      // Idempotent cleanup.
      result.cleanup()
      // sourcePath removed after cleanup.
      assert.ok(!existsSync(result.sourcePath), 'temp dir cleaned up')
    } finally {
      restoreConfig()
    }
  })

  test('memory hit → second clone skips direct, only attempts gitcode', async () => {
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 3,
      fallbackMemoryMinutes: 10,
    })
    try {
      // First clone seeds memory via fallback (direct fails, gitcode succeeds).
      const r1 = await cloneGitSource('https://github.com/test/repo.git')
      r1.cleanup()

      // Second clone: memory should hit, direct github.com NOT attempted.
      // We detect "did direct get attempted" indirectly: if direct were
      // attempted with a 3s timeout, the second clone would take ≥3s (waiting
      // for github.com to time out). Memory hit means it goes straight to
      // gitcode (local, sub-second). So we assert the second clone is fast.
      const start = Date.now()
      const r2 = await cloneGitSource('https://github.com/test/repo.git')
      const elapsed = Date.now() - start
      r2.cleanup()
      // Memory path skips the direct attempt entirely → should be well under
      // the 3s direct timeout. 2000ms is a generous upper bound (local clone
      // + process spawn is typically <500ms).
      assert.ok(elapsed < 2000, `memory-hit clone should skip direct (<2s), took ${elapsed}ms`)
    } finally {
      restoreConfig()
    }
  })

  test('autoFallback=false → direct fails, no mirror attempted, throws', async () => {
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: false,
      fallbackTimeoutSec: 3,
    })
    try {
      await assert.rejects(
        cloneGitSource('https://github.com/test/repo.git'),
        (err: unknown) => {
          // autoFallback=false path re-throws the direct clone error as-is
          // (not the "All clone attempts failed" aggregate).
          const msg = err instanceof Error ? err.message : String(err)
          assert.ok(!msg.includes('All clone attempts'), 'should not aggregate-error when autoFallback off')
          return true
        },
      )
    } finally {
      restoreConfig()
    }
  })

  test('non-github URL (file://) → bypasses fallback, direct clone', async () => {
    // file:// is not a github URL → isGithubUrl false → no fallback path.
    // Should clone the local origin directly, regardless of mirror config.
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 3,
    })
    try {
      const result = await cloneGitSource(`file://${originRepo}`)
      assert.ok(result.sourcePath, 'sourcePath returned')
      assert.ok(existsSync(join(result.sourcePath, 'package.json')), 'package.json in clone')
      result.cleanup()
    } finally {
      restoreConfig()
    }
  })
})

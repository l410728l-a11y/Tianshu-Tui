/**
 * Git source — clone a plugin from an arbitrary git URL into a temp dir.
 *
 * Used by installPlugin when source.kind === 'git'. Validates the URL scheme
 * + ref safety, then runs `git clone --depth 1 [--branch ref] -- url target`
 * via the unified spawn-git entrypoint (resolves the git executable + layers
 * the GUI-launch PATH recovery env). Returns the cloned path + a cleanup
 * callback the installer MUST invoke (try/finally) to avoid temp-dir leaks.
 *
 * Why a dedicated module: keeps the clone/validate logic testable in isolation
 * (no npm install / cpSync coupling) and reusable for future "plugin upgrade"
 * (re-pull) flows.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileGit } from '../tools/spawn-git.js'
import { isSafeGitRef } from '../tools/import-resource.js'

/** Schemes accepted for plugin git URLs. `file://` is allowed for local dev
 *  (e.g. cloning a sibling repo); plain paths should go through kind:'local'. */
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git+ssh:', 'git+https:', 'git+http:', 'file:'])

/** Validate a git URL. Accepts:
 *  - `https://host/...`, `http://host/...`
 *  - `git@host:owner/repo.git` (SCP-style ssh — normalized below)
 *  - `ssh://...`, `git+ssh://...`, `git+https://...`
 *  - `file:///abs/path`
 *  Rejects: other schemes, empty, non-git URLs without a recognizable git host shape. */
export function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return false

  // SCP-style: git@github.com:owner/repo.git (no scheme, starts with user@host:path)
  // This is the most common ssh shorthand — accept if it has the shape.
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[\w./-]+\.git(?:\/?|\#.*)$/.test(trimmed)) return true

  // URL-form: must parse and have an allowed scheme.
  try {
    const parsed = new URL(trimmed)
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false
    // git+ssh:// / ssh:// need a host; git+https:// / https:// need a host too.
    if (!parsed.hostname && parsed.protocol !== 'file:') return false
    return true
  } catch {
    return false
  }
}

export interface CloneResult {
  /** Absolute path to the cloned working tree (caller passes to installFromLocal). */
  sourcePath: string
  /** Resolved commit SHA at HEAD of the clone (for origin metadata). */
  commit: string
  /** Invoke after install (or on failure) to remove the temp clone. Idempotent. */
  cleanup: () => void
}

export class GitCloneError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message)
    this.name = 'GitCloneError'
  }
}

/**
 * Clone a git URL into a fresh temp directory. Shallow clone (--depth 1) to
 * minimize transfer. If `ref` is given, pass `--branch <ref>` (works for
 * branches, tags, or detached commit SHAs that git can resolve).
 *
 * Throws `GitCloneError` on validation failure or clone error (with stderr
 * attached so the caller can surface a useful message).
 */
export function cloneGitSource(url: string, ref?: string): Promise<CloneResult> {
  return new Promise((resolve, reject) => {
    if (!isValidGitUrl(url)) {
      return reject(new GitCloneError(`Invalid git URL: ${url}`))
    }
    if (ref !== undefined && ref !== '') {
      if (!isSafeGitRef(ref)) {
        return reject(new GitCloneError(`Invalid git ref: ${ref}`))
      }
    }

    const target = mkdtempSync(join(tmpdir(), 'rivet-plugin-'))
    const args = ['clone', '--depth', '1']
    const effectiveRef = ref && ref.trim().length > 0 ? ref.trim() : undefined
    if (effectiveRef) args.push('--branch', effectiveRef)
    args.push('--', url.trim(), target)

    execFileGit(args, { timeout: 120_000 }, async (err, _stdout, stderr) => {
      if (err) {
        // Best-effort cleanup of the empty/partial temp dir before rejecting.
        try { rmSync(target, { recursive: true, force: true }) } catch { /* best-effort */ }
        const hint = stderr ? stderr.slice(0, 500) : (err as Error).message
        return reject(new GitCloneError(`Clone failed: ${hint}`, stderr ?? undefined))
      }
      // Capture HEAD commit for origin metadata. Non-fatal if this fails.
      let commit = ''
      try {
        commit = await readHeadCommit(target)
      } catch { /* commit is best-effort metadata */ }

      let cleaned = false
      resolve({
        sourcePath: target,
        commit,
        cleanup: () => {
          if (cleaned) return
          cleaned = true
          try { rmSync(target, { recursive: true, force: true }) } catch { /* best-effort */ }
        },
      })
    })
  })
}

/** Read HEAD commit SHA from a cloned working tree (git rev-parse HEAD). */
function readHeadCommit(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileGit(['rev-parse', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

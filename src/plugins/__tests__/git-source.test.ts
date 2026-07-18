/**
 * git-source tests — URL/ref validation + local clone (no network).
 *
 * The clone test creates a real bare-ish git repo in a temp dir (git init +
 * commit), then clones it via cloneGitSource using a file:// URL. This keeps
 * the test offline, fast, and deterministic — no dependency on github.com
 * being reachable or the test machine having SSH keys.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { isValidGitUrl, cloneGitSource, GitCloneError } from '../git-source.js'

describe('isValidGitUrl', () => {
  test('accepts standard https/github URLs', () => {
    assert.equal(isValidGitUrl('https://github.com/owner/repo.git'), true)
    assert.equal(isValidGitUrl('https://gitlab.com/team/proj.git'), true)
    assert.equal(isValidGitUrl('https://example.com/a/b'), true)
  })

  test('accepts SCP-style ssh shorthand (git@host:owner/repo.git)', () => {
    assert.equal(isValidGitUrl('git@github.com:owner/repo.git'), true)
    assert.equal(isValidGitUrl('git@gitlab.com:team/proj.git'), true)
  })

  test('accepts ssh:// and git+ssh:// / git+https:// schemes', () => {
    assert.equal(isValidGitUrl('ssh://git@github.com/owner/repo.git'), true)
    assert.equal(isValidGitUrl('git+ssh://git@github.com/owner/repo.git'), true)
    assert.equal(isValidGitUrl('git+https://github.com/owner/repo.git'), true)
  })

  test('accepts file:// URLs (local dev)', () => {
    assert.equal(isValidGitUrl('file:///tmp/local-repo'), true)
  })

  test('rejects empty / non-string / too-long', () => {
    assert.equal(isValidGitUrl(''), false)
    assert.equal(isValidGitUrl('   '), false)
    assert.equal(isValidGitUrl('a'.repeat(3000)), false)
  })

  test('rejects non-git schemes', () => {
    assert.equal(isValidGitUrl('ftp://example.com/repo'), false)
    assert.equal(isValidGitUrl('javascript:alert(1)'), false)
    assert.equal(isValidGitUrl('not a url at all'), false)
  })

  test('rejects malformed ssh shorthand (no .git, no host)', () => {
    // Missing the owner/repo.git shape — looks like an email, not a git remote.
    assert.equal(isValidGitUrl('user@host'), false)
  })
})

describe('cloneGitSource (offline via local file:// repo)', () => {
  let workdir: string
  let originRepo: string

  before(() => {
    workdir = mkdtempSync(join(tmpdir(), 'rivet-git-source-test-'))
    originRepo = join(workdir, 'origin')
    mkdirSync(originRepo, { recursive: true })
    // Bootstrap a real git repo with a plugin-shaped package.json.
    execSync('git init -q', { cwd: originRepo })
    execSync('git config user.email t@t', { cwd: originRepo })
    execSync('git config user.name test', { cwd: originRepo })
    writeFileSync(join(originRepo, 'package.json'), JSON.stringify({
      name: 'test-plugin-src',
      tianshu: { name: 'test-plugin', version: '1.0.0', description: 'x', entry: 'index.js', tools: [{ name: 't', description: 'd' }] },
    }) + '\n')
    writeFileSync(join(originRepo, 'index.js'), "module.exports = {}\n")
    execSync('git add -A', { cwd: originRepo })
    execSync('git commit -q -m init', { cwd: originRepo })

    // A branch for ref testing
    execSync('git branch feature', { cwd: originRepo })
  })

  after(() => {
    try { rmSync(workdir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  test('clones a file:// URL into a temp dir and reads HEAD commit', async () => {
    const result = await cloneGitSource(`file://${originRepo}`)
    assert.ok(result.sourcePath, 'sourcePath returned')
    assert.ok(result.commit, 'commit SHA captured')
    assert.match(result.commit, /^[0-9a-f]{40}$/, 'commit is a 40-char SHA')
    // The cloned dir has the plugin file.
    assert.ok(existsSync(join(result.sourcePath, 'package.json')), 'package.json present in clone')
    result.cleanup()
    // Idempotent cleanup: a second call is a no-op.
    result.cleanup()
  })

  test('clones a specific branch via ref', async () => {
    const result = await cloneGitSource(`file://${originRepo}`, 'feature')
    assert.ok(existsSync(join(result.sourcePath, 'package.json')))
    result.cleanup()
  })

  test('rejects an invalid URL with GitCloneError', async () => {
    await assert.rejects(
      () => cloneGitSource('not-a-url'),
      (err: unknown) => {
        assert.ok(err instanceof GitCloneError, 'GitCloneError type')
        assert.match((err as Error).message, /Invalid git URL/)
        return true
      },
    )
  })

  test('rejects an unsafe ref (option injection attempt)', async () => {
    await assert.rejects(
      // --upload-pack=... would be parsed as an option if not rejected.
      () => cloneGitSource(`file://${originRepo}`, '--upload-pack=evil'),
      (err: unknown) => {
        assert.ok(err instanceof GitCloneError)
        assert.match((err as Error).message, /Invalid git ref/)
        return true
      },
    )
  })

  test('surfaces clone failure (nonexistent repo) with stderr', async () => {
    await assert.rejects(
      () => cloneGitSource(`file://${join(workdir, 'does-not-exist')}`),
      (err: unknown) => {
        assert.ok(err instanceof GitCloneError)
        assert.match((err as Error).message, /Clone failed/)
        return true
      },
    )
  })
})

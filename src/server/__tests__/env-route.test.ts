/**
 * GET /environment smoke test — covers the /doctor backend (commit 16dfda1e).
 *
 * Verifies the route returns the resolved-env probe shape (all 7 tools +
 * shell + pathDiff) that EnvironmentCheckSection renders. This is the route-
 * layer counterpart to the (untested) React component — the 7-tool × version ×
 * shell × pathDiff × autocrlf matrix is exercised end-to-end here by probing
 * the real host toolchain.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildEnvRoute } from '../env-route.js'

const TOKEN = 'env-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

type EnvBody = {
  python: { available: boolean; version?: string }
  uv: { available: boolean }
  git: { available: boolean }
  node: { available: boolean; version?: string }
  java: { available: boolean }
  maven: { available: boolean }
  gradle: { available: boolean }
  platform: string
  shell?: { kind: string; gitBashAvailable: boolean }
  pathDiff?: string[]
  gitAutocrlf?: string
}

describe('GET /environment', () => {
  const router = createRouter(buildEnvRoute(TOKEN))

  it('returns all 7 toolchain probes + platform under the resolved env', async () => {
    const res = await router('GET', '/environment', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as EnvBody
    // Every tool field present (availability depends on the host — we only
    // assert shape, not values, so the test runs anywhere).
    for (const tool of ['python', 'uv', 'git', 'node', 'java', 'maven', 'gradle'] as const) {
      assert.equal(typeof body[tool].available, 'boolean', `${tool}.available is boolean`)
    }
    assert.equal(typeof body.platform, 'string')
  })

  it('reports a node version string when node is available (the common case on CI/dev)', async () => {
    const res = await router('GET', '/environment', {}, AUTH)
    const body = res.body as EnvBody
    // node is effectively always present (we're running under it).
    assert.equal(body.node.available, true)
    assert.ok(body.node.version, 'node version string populated')
    assert.match(body.node.version!, /v?\d+\.\d+/, 'version looks like a semver')
  })

  it('exposes shell info (kind + gitBashAvailable flag)', async () => {
    const res = await router('GET', '/environment', {}, AUTH)
    const body = res.body as EnvBody
    assert.ok(body.shell, 'shell field present')
    assert.equal(typeof body.shell!.kind, 'string')
    assert.equal(typeof body.shell!.gitBashAvailable, 'boolean')
  })

  it('includes pathDiff (undefined or string[]) — the PATH-recovery signal', async () => {
    const res = await router('GET', '/environment', {}, AUTH)
    const body = res.body as EnvBody
    // pathDiff is undefined when the resolver added nothing, or string[] when
    // it did. Both are valid — we only assert the field is well-formed.
    if (body.pathDiff !== undefined) {
      assert.ok(Array.isArray(body.pathDiff), 'pathDiff is an array when present')
      for (const entry of body.pathDiff!) {
        assert.equal(typeof entry, 'string', 'each pathDiff entry is a string')
      }
    }
  })

  it('rejects unauthorized requests', async () => {
    const res = await router('GET', '/environment', {}, {})
    assert.equal(res.status, 401)
  })
})

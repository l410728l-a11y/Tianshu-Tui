import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest } from '../manifest.js'

const VALID_MANIFEST = {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'A test plugin',
  entry: 'dist/index.js',
  tools: [{ name: 'hello', description: 'Say hello' }],
  permissions: { fs: true },
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const result = parseManifest(VALID_MANIFEST)
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.manifest.name, 'test-plugin')
      assert.equal(result.manifest.version, '1.0.0')
      assert.equal(result.manifest.entry, 'dist/index.js')
      assert.equal(result.manifest.tools[0]!.name, 'hello')
    }
  })

  it('rejects manifest with missing required fields', () => {
    const result = parseManifest({ name: 'test' })
    assert.ok(!result.ok)
    if (!result.ok) {
      assert.ok(result.errors.length > 0)
      assert.ok(result.errors.some(e => e.includes('version') || e.includes('description') || e.includes('entry') || e.includes('tools')))
    }
  })

  it('rejects manifest with empty tools array', () => {
    const result = parseManifest({ ...VALID_MANIFEST, tools: [] })
    assert.ok(!result.ok)
  })

  it('rejects manifest with invalid tool descriptor', () => {
    const result = parseManifest({ ...VALID_MANIFEST, tools: [{ name: '', description: 'x' }] })
    assert.ok(!result.ok)
  })

  it('rejects manifest with missing entry', () => {
    const { entry, ...noEntry } = VALID_MANIFEST
    const result = parseManifest(noEntry)
    assert.ok(!result.ok)
  })

  it('rejects manifest with non-string entry', () => {
    const result = parseManifest({ ...VALID_MANIFEST, entry: 123 })
    assert.ok(!result.ok)
  })

  it('accepts manifest with optional minCoreVersion', () => {
    const result = parseManifest({ ...VALID_MANIFEST, minCoreVersion: '2.0.0' })
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.manifest.minCoreVersion, '2.0.0')
    }
  })

  it('accepts manifest with optional skills array', () => {
    const result = parseManifest({ ...VALID_MANIFEST, skills: ['skills/design-prototype'] })
    assert.ok(result.ok)
    if (result.ok) {
      assert.deepEqual(result.manifest.skills, ['skills/design-prototype'])
    }
  })

  it('rejects manifest with empty skills path string', () => {
    const result = parseManifest({ ...VALID_MANIFEST, skills: [''] })
    assert.ok(!result.ok)
  })

  it('rejects manifest with non-string skills entries', () => {
    const result = parseManifest({ ...VALID_MANIFEST, skills: [123] })
    assert.ok(!result.ok)
  })

  it('accepts manifest with optional hooks array', () => {
    const result = parseManifest({
      ...VALID_MANIFEST,
      hooks: [{ event: 'preTurn', script: 'hooks/pre.sh' }, { event: 'postTool', script: 'hooks/post.sh', timeoutMs: 3000 }],
    })
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.manifest.hooks?.length, 2)
      assert.equal(result.manifest.hooks?.[0]?.event, 'preTurn')
      assert.equal(result.manifest.hooks?.[1]?.timeoutMs, 3000)
    }
  })

  it('rejects manifest with invalid hook event', () => {
    const result = parseManifest({ ...VALID_MANIFEST, hooks: [{ event: 'bogusEvent', script: 'x.sh' }] })
    assert.ok(!result.ok)
  })

  it('rejects manifest with hook missing script', () => {
    const result = parseManifest({ ...VALID_MANIFEST, hooks: [{ event: 'preTurn' }] } as Record<string, unknown>)
    assert.ok(!result.ok)
  })

  it('accepts manifest with optional commands array', () => {
    const result = parseManifest({ ...VALID_MANIFEST, commands: ['commands/deploy.md', 'commands/'] })
    assert.ok(result.ok)
    if (result.ok) {
      assert.deepEqual(result.manifest.commands, ['commands/deploy.md', 'commands/'])
    }
  })

  it('rejects null/undefined input', () => {
    assert.ok(!parseManifest(null).ok)
    assert.ok(!parseManifest(undefined).ok)
  })
})

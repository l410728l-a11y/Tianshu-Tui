import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getFetchConfig, setFetchConfig, getSearchConfig, setSearchConfig } from '../manager.js'

describe('fetch config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-fetch-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getFetchConfig returns defaults when unset', () => {
    const cfg = getFetchConfig()
    assert.equal(cfg.timeoutMs, 15000)
    assert.equal(cfg.maxResponseBytes, 10485760)
    assert.equal(cfg.maxRedirects, 5)
    assert.equal(cfg.userAgent, 'Tianshu/1.0 (terminal coding agent)')
    assert.equal(cfg.extractMainContent, true)
  })

  it('persists custom timeout and round-trips', () => {
    const r = setFetchConfig({ timeoutMs: 30000 })
    assert.equal(r.timeoutMs, 30000)
    assert.equal(loadConfig().fetch.timeoutMs, 30000)
    assert.equal(getFetchConfig().timeoutMs, 30000)
  })

  it('merge: partial update preserves other fields', () => {
    setFetchConfig({ timeoutMs: 30000 })
    const r = setFetchConfig({ userAgent: 'TestAgent/2.0' })
    assert.equal(r.timeoutMs, 30000, 'timeoutMs should survive partial update')
    assert.equal(r.userAgent, 'TestAgent/2.0')
  })

  it('persists multiple fields at once', () => {
    const r = setFetchConfig({ timeoutMs: 10000, extractMainContent: false, userAgent: 'MyBot/1.0' })
    assert.equal(r.timeoutMs, 10000)
    assert.equal(r.extractMainContent, false)
    assert.equal(r.userAgent, 'MyBot/1.0')
  })

  it('empty/whitespace string clears optional fields', () => {
    setFetchConfig({ userAgent: 'MyBot/1.0' })
    const cleared = setFetchConfig({ userAgent: '' })
    // Clearing a field with a schema default resets it to the default, not undefined
    assert.equal(cleared.userAgent, 'Tianshu/1.0 (terminal coding agent)', 'should revert to default')
  })

  it('empty object is a no-op (not an error on the server route layer)', () => {
    const before = getFetchConfig()
    const r = setFetchConfig({})
    assert.deepEqual(r, before)
  })
})

describe('search config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-search-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getSearchConfig returns defaults when unset', () => {
    const cfg = getSearchConfig()
    assert.deepEqual(cfg.backends, ['bing', 'duckduckgo'])
    assert.equal(cfg.timeoutMs, 15000)
    assert.equal(cfg.braveApiKeyEnv, 'BRAVE_API_KEY')
    assert.equal(cfg.tavilyApiKeyEnv, 'TAVILY_API_KEY')
  })

  it('persists custom backends and round-trips', () => {
    const r = setSearchConfig({ backends: ['duckduckgo'] })
    assert.deepEqual(r.backends, ['duckduckgo'])
    assert.deepEqual(loadConfig().search.backends, ['duckduckgo'])
    assert.deepEqual(getSearchConfig().backends, ['duckduckgo'])
  })

  it('merge: partial update preserves other fields', () => {
    setSearchConfig({ backends: ['duckduckgo'] })
    const r = setSearchConfig({ timeoutMs: 30000 })
    assert.deepEqual(r.backends, ['duckduckgo'], 'backends should survive partial update')
    assert.equal(r.timeoutMs, 30000)
  })

  it('persists region when set', () => {
    const r = setSearchConfig({ region: 'zh-CN' })
    assert.equal(r.region, 'zh-CN')
  })

  it('empty/whitespace string clears optional fields', () => {
    setSearchConfig({ region: 'zh-CN' })
    const cleared = setSearchConfig({ region: '' })
    // Region is optional; clearing it resets to '' (matches NetworkConfig.proxy pattern)
    assert.equal(cleared.region, '')
    assert.equal(loadConfig().search.region, undefined)
  })

  it('empty object is a no-op', () => {
    const before = getSearchConfig()
    const r = setSearchConfig({})
    assert.deepEqual(r, before)
  })
})

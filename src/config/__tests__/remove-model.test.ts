import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const prevHome = process.env.RIVET_HOME
let home: string

before(() => {
  home = mkdtempSync(join(tmpdir(), 'rivet-remove-model-test-'))
  process.env.RIVET_HOME = home
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    provider: { default: 'deepseek', providers: {} },
  }, null, 2) + '\n')
})

after(() => {
  if (prevHome === undefined) delete process.env.RIVET_HOME
  else process.env.RIVET_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe('removeModel', () => {
  it('throws when trying to remove the last model from a provider', async () => {
    const { setupProvider, removeModel, loadConfig } = await import('../manager.js')

    // Add a single custom model to deepseek preset
    setupProvider({
      providerName: 'deepseek',
      model: { id: 'my-only-model', contextWindow: 128000, maxTokens: 64000 },
    })

    // Remove all preset models to leave only one
    let cfg = loadConfig()
    const models = cfg.provider.providers['deepseek']!.models
    for (const m of [...models]) {
      if (m.id === 'my-only-model') continue
      if (models.length <= 1) break
      removeModel('deepseek', m.id)
      cfg = loadConfig()
      const updated = cfg.provider.providers['deepseek']!.models
      if (updated.length <= 1) break
    }

    // Now should have exactly 1 model
    cfg = loadConfig()
    const finalModels = cfg.provider.providers['deepseek']!.models
    assert.equal(finalModels.length, 1)

    // Removing the last model should throw
    assert.throws(
      () => removeModel('deepseek', finalModels[0]!.id),
      /Cannot remove the last model/,
    )

    // The model should still be there
    cfg = loadConfig()
    assert.equal(cfg.provider.providers['deepseek']!.models.length, 1)
  })

  it('successfully removes a model when provider has more than one', async () => {
    const { setupProvider, removeModel, loadConfig } = await import('../manager.js')

    // Ensure deepseek has at least 2 models by adding a custom one
    setupProvider({
      providerName: 'deepseek',
      model: { id: 'extra-model', contextWindow: 128000, maxTokens: 64000 },
    })

    const cfg = loadConfig()
    const count = cfg.provider.providers['deepseek']!.models.length
    assert.ok(count >= 2, `Expected >= 2 models, got ${count}`)

    removeModel('deepseek', 'extra-model')

    const after = loadConfig()
    const stillHas = after.provider.providers['deepseek']!.models.some(m => m.id === 'extra-model')
    assert.ok(!stillHas, 'extra-model should have been removed')
  })

  it('throws when modelId does not exist', async () => {
    const { removeModel } = await import('../manager.js')
    assert.throws(
      () => removeModel('deepseek', 'nonexistent-model-id'),
      /not found/,
    )
  })
})

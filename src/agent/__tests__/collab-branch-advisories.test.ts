/**
 * W3 分支消费 advisory — selectCollabAdvisories 纯决策矩阵 + AdvisoryBus 四跳
 * （触发/去重/让位/送达）。反证锚点（计划 Wave 3 过门条件）：
 * 新功能不触发 D、活跃 PAL 案件不重复、CV3 同轮让位、A 与低置信提示不重复。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectCollabAdvisories, type CollabAdvisoryInput } from '../collab-branch-advisories.js'
import { AdvisoryBus } from '../advisory-bus.js'

function base(over: Partial<CollabAdvisoryInput> = {}): CollabAdvisoryInput {
  return {
    branches: [],
    contractId: 'c1',
    lowConfidenceRendered: false,
    planMode: false,
    palActiveCases: 0,
    convergenceEmitted: false,
    alignFiredContracts: new Set(),
    ...over,
  }
}

describe('selectCollabAdvisories — A 前置对齐', () => {
  it('branches 含 A 且高置信 → 选中，key 带契约 id', () => {
    const d = selectCollabAdvisories(base({ branches: ['A'] }))
    assert.equal(d.selected.length, 1)
    assert.equal(d.selected[0]!.branch, 'A')
    assert.equal(d.selected[0]!.key, 'collab:align:c1')
    assert.equal(d.selected[0]!.tier, 'informational')
    assert.deepEqual(d.suppressed, [])
  })

  it('A + 低置信对齐提示已渲染 → 抑制（只保留一个对齐提示）', () => {
    const d = selectCollabAdvisories(base({ branches: ['A'], lowConfidenceRendered: true }))
    assert.equal(d.selected.length, 0)
    assert.deepEqual(d.suppressed, [{ branch: 'A', reason: 'low-confidence-advisory-covers-alignment' }])
  })

  it('A 每契约至多一次（已触发过的契约被抑制，新契约仍可触发）', () => {
    const fired = new Set(['collab:align:c1'])
    const again = selectCollabAdvisories(base({ branches: ['A'], alignFiredContracts: fired }))
    assert.equal(again.selected.length, 0)
    assert.deepEqual(again.suppressed, [{ branch: 'A', reason: 'already-fired-for-contract' }])
    const fresh = selectCollabAdvisories(base({ branches: ['A'], contractId: 'c2', alignFiredContracts: fired }))
    assert.equal(fresh.selected.length, 1)
  })
})

describe('selectCollabAdvisories — D 诊断优先', () => {
  it('branches 含 D 且环境干净 → 选中（operational，优先级高于 A）', () => {
    const d = selectCollabAdvisories(base({ branches: ['D'] }))
    assert.equal(d.selected.length, 1)
    assert.equal(d.selected[0]!.branch, 'D')
    assert.equal(d.selected[0]!.tier, 'operational')
    assert.match(d.selected[0]!.content, /RED/)
  })

  it('D 在 plan mode 下抑制（不干扰计划期）', () => {
    const d = selectCollabAdvisories(base({ branches: ['D'], planMode: true }))
    assert.equal(d.selected.length, 0)
    assert.deepEqual(d.suppressed, [{ branch: 'D', reason: 'plan-mode-active' }])
  })

  it('D 在活跃 PAL 案件下抑制（不重复开案）', () => {
    const d = selectCollabAdvisories(base({ branches: ['D'], palActiveCases: 2 }))
    assert.equal(d.selected.length, 0)
    assert.deepEqual(d.suppressed, [{ branch: 'D', reason: 'pal-case-active' }])
  })

  it('新功能/无分支 → 什么都不触发', () => {
    const d = selectCollabAdvisories(base({ branches: [] }))
    assert.equal(d.selected.length, 0)
    assert.equal(d.suppressed.length, 0)
  })
})

describe('selectCollabAdvisories — CV3 单声源让位', () => {
  it('convergence 相邻轮已发射 → A/D 一律让位（yielded 可测）', () => {
    const d = selectCollabAdvisories(base({ branches: ['A', 'D'], convergenceEmitted: true }))
    assert.equal(d.selected.length, 0)
    assert.deepEqual(d.suppressed, [
      { branch: 'A', reason: 'yielded-to-convergence' },
      { branch: 'D', reason: 'yielded-to-convergence' },
    ])
  })

  it('convergence 未发射 → 不让位', () => {
    const d = selectCollabAdvisories(base({ branches: ['A', 'D'] }))
    assert.equal(d.selected.length, 2)
  })
})

describe('AdvisoryBus 四跳（触发→去重→让位→送达）', () => {
  it('选中的 advisory 真实 submit 后渲染送达', () => {
    const bus = new AdvisoryBus()
    const d = selectCollabAdvisories(base({ branches: ['A', 'D'] }))
    for (const spec of d.selected) bus.submit(spec)
    const rendered = bus.render()
    assert.match(rendered, /天权·对齐/)
    assert.match(rendered, /瑶光·诊断/)
    const ledger = bus.drainLedger()
    assert.equal(ledger.submitted, 2)
  })

  it('让位分支不进 bus（suppressed 永不 submit）', () => {
    const bus = new AdvisoryBus()
    const d = selectCollabAdvisories(base({ branches: ['A', 'D'], convergenceEmitted: true }))
    for (const spec of d.selected) bus.submit(spec)
    const rendered = bus.render()
    assert.equal(rendered.includes('天权·对齐'), false)
    assert.equal(rendered.includes('瑶光·诊断'), false)
    assert.equal(bus.drainLedger().submitted, 0)
  })
})

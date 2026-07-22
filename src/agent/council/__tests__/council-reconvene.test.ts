import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectReconveneSeats, buildReconveneDraft, runWaveReconvene, type ReconveneTaskRef } from '../council-reconvene.js'
import type { CouncilSeat } from '../council-routing.js'
import type { CouncilDeps } from '../council-orchestrator.js'
import type { WorkerResult } from '../../work-order.js'
import { deriveStableWorkOrderId } from '../../coordinator.js'

const FIVE_SEATS: CouncilSeat[] = [
  { authority: 'pojun' },
  { authority: 'tianji' },
  { authority: 'tianquan' },
  { authority: 'huagai' },
  { authority: 'yaoguang' },
]

function task(id: string, proposedBy?: string): ReconveneTaskRef {
  return { id, title: `t-${id}`, detail: `d-${id}`, ...(proposedBy ? { proposedBy } : {}) }
}

describe('selectReconveneSeats — provenance 召回', () => {
  it('按 proposedBy 召回提案席位 + 平衡柱', () => {
    const seats = selectReconveneSeats([task('T1', 'pojun'), task('T2', 'tianquan')], FIVE_SEATS)
    assert.deepEqual(seats.map(s => s.authority).sort(), ['pojun', 'tianquan', 'yaoguang'])
  })

  it('proposedBy=draft 不算血缘；全 draft → 回退原班前 3 席', () => {
    const seats = selectReconveneSeats([task('T1', 'draft'), task('T2')], FIVE_SEATS)
    assert.deepEqual(seats.map(s => s.authority), ['pojun', 'tianji', 'tianquan'])
  })

  it('平衡柱本身是提案席时不重复召回', () => {
    const seats = selectReconveneSeats([task('T1', 'yaoguang')], FIVE_SEATS)
    assert.deepEqual(seats.map(s => s.authority), ['yaoguang'])
  })

  it('原班无平衡柱（默认三席）→ 只召回提案席', () => {
    const defaultSeats: CouncilSeat[] = [{ authority: 'tianquan' }, { authority: 'tianfu' }, { authority: 'tianxuan' }]
    const seats = selectReconveneSeats([task('T1', 'tianfu')], defaultSeats)
    assert.deepEqual(seats.map(s => s.authority), ['tianfu'])
  })
})

describe('buildReconveneDraft — 复议草案', () => {
  it('objective 带 wave 序号与门禁失败证据；条目带提案血缘', () => {
    const draft = buildReconveneDraft({
      objective: 'refactor loop',
      wave: 1,
      failures: ['npm test — 3 failed', 'tsc --noEmit (scoped) — TS2345'],
      tasks: [task('T1', 'pojun')],
    })
    assert.match(draft.objective, /wave 2/)
    assert.match(draft.objective, /npm test — 3 failed/)
    assert.match(draft.objective, /复议不是重规划/)
    assert.equal(draft.items.length, 1)
    assert.match(draft.items[0]!.detail, /提案：pojun/)
  })
})

describe('runWaveReconvene — 轻量复议执行', () => {
  // 模拟真实 coordinator：workOrderId 从请求 parentTurnId 稳定化派生——
  // 复议请求带 -reconvene 后缀时，返回的 id 也带后缀（验证剥离逻辑）。
  function contribResult(parentTurnId: string, authority: string): WorkerResult {
    return {
      workOrderId: deriveStableWorkOrderId(parentTurnId) ?? 'wo_unstable',
      status: 'passed',
      summary: `${authority} done`,
      findings: [],
      artifacts: [{ kind: 'note', title: 'seat-contribution', content: JSON.stringify({ authority, summary: `${authority}-建议缩范围`, additions: [], risks: [], challenges: [], alternatives: [] }) }],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
    }
  }

  it('复议产出 advisory markdown：席位建议 + 豁免协议指引，不改契约；派发带 -reconvene 后缀绕队列去重', async () => {
    const dispatched: string[] = []
    const parentTurnIds: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        for (const r of reqs) { dispatched.push(r.authority); parentTurnIds.push(r.parentTurnId) }
        return { results: reqs.map(r => contribResult(r.parentTurnId, r.authority)) }
      },
      now: () => 1,
    }
    const lines = await runWaveReconvene({
      objective: 'refactor loop',
      wave: 0,
      failures: ['npm test — 1 failed'],
      tasks: [task('T1', 'pojun')],
      originalSeats: FIVE_SEATS,
    }, deps)
    assert.deepEqual(dispatched.sort(), ['pojun', 'yaoguang'], '只召回提案席+平衡柱')
    assert.ok(parentTurnIds.every(id => id.endsWith('-reconvene')), '复议派发必须带 -reconvene 后缀（绕开 authority 去重）')
    const md = lines.join('\n')
    assert.match(md, /波间复议/)
    assert.match(md, /pojun-建议缩范围/)
    assert.match(md, /revisePlanSeal/)
  })

  it('复议自身流会 → 返回留痕行，绝不抛错阻断波结果', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async () => ({ results: [] }),
      now: () => 1,
    }
    const lines = await runWaveReconvene({
      objective: 'x', wave: 0, failures: [], tasks: [task('T1', 'pojun')], originalSeats: FIVE_SEATS,
    }, deps)
    assert.match(lines.join('\n'), /复议流会/)
  })
})

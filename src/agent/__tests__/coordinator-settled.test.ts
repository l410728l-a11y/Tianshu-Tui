/**
 * DelegationCoordinator: onWorkerSettled（per-worker settle 即时回调）契约测试。
 *
 * 背景：worker 终态事件此前只在整批 resolve 后统一发——最快的 worker 也要等
 * 最慢的兄弟 settle 才在子代理面板变 ✓，elapsed 无限累计。onWorkerSettled
 * 在每个 worker 到达终态的当下即发（含失败兜底与依赖阻塞清扫路径）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator } from '../coordinator.js'
import type { WorkerSessionRun } from '../worker-session.js'
import type { WorkerResult } from '../work-order.js'
import type { ModelCapabilityCard } from '../../model/capability.js'

function createCoordinator(runWorker: () => Promise<WorkerSessionRun>): DelegationCoordinator {
  const config = {
    baseToolRegistry: {
      get: () => undefined,
      list: () => [],
      filter: () => ({ get: () => undefined, list: () => [] }),
    } as any,
    modelCards: [] as ModelCapabilityCard[],
    maxWorkers: 2,
    runtimeFactory: () => ({}) as any,
    runWorker,
  }
  return new DelegationCoordinator(config)
}

const passingRunWorker = async () => ({
  result: {
    workOrderId: 'test',
    status: 'passed' as const,
    summary: 'done',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified' as const,
  },
}) as unknown as WorkerSessionRun

function req(id: string, objective: string, extra: Record<string, unknown> = {}) {
  return {
    parentTurnId: `p-${id}`,
    objective,
    kind: 'code_search' as const,
    profile: 'code_scout' as const,
    // dedupeKey = kind + scope.files——每个请求用独立文件避免队列去重。
    scope: { files: [`src/${id}.ts`] },
    ...extra,
  }
}

const TERMINAL = new Set(['passed', 'failed', 'blocked', 'escalated'])

describe('DelegationCoordinator: onWorkerSettled', () => {
  it('每个 worker settle 时各触发一次，携带终态结果', async () => {
    const coordinator = createCoordinator(passingRunWorker)
    const settled: WorkerResult[] = []
    const run = await coordinator.delegateBatch(
      [
        req('a1', 'search for authentication middleware implementation details'),
        req('a2', 'search for database migration scripts and schema definitions'),
      ],
      'primary_decides',
      undefined,
      undefined,
      r => { settled.push(r) },
    )
    assert.strictEqual(run.status, 'completed')
    assert.strictEqual(settled.length, 2, `每个 worker 恰好 settle 一次，got ${settled.length}`)
    for (const r of settled) {
      assert.ok(TERMINAL.has(r.status), `settle 结果必须是终态，got ${r.status}`)
      assert.ok(r.workOrderId.length > 0, 'settle 结果带 workOrderId')
    }
  })

  it('worker 抛错兜底路径同样触发（degraded 结果）', async () => {
    const coordinator = createCoordinator(async () => { throw new Error('upstream exploded') })
    const settled: WorkerResult[] = []
    const run = await coordinator.delegateBatch(
      [req('a3', 'search for retry backoff jitter handling in the api client layer')],
      'primary_decides',
      undefined,
      undefined,
      r => { settled.push(r) },
    )
    // delegateOrder 内部有 retry/降级兜底——无论哪条路径，settle 都必须恰好一次且为终态。
    assert.ok(run.results.length >= 1)
    assert.strictEqual(settled.length, 1, `失败兜底路径 settle 恰好一次，got ${settled.length}`)
    assert.ok(TERMINAL.has(settled[0]!.status), `兜底结果必须是终态，got ${settled[0]!.status}`)
  })

  it('onWorkerSettled 缺省时不影响批执行', async () => {
    const coordinator = createCoordinator(passingRunWorker)
    const run = await coordinator.delegateBatch(
      [req('a4', 'search for configuration schema validation across the config module')],
      'primary_decides',
    )
    assert.strictEqual(run.status, 'completed')
  })
})

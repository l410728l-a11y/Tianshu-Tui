import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  declaredVerificationCommands,
  reconcileVerificationCommands,
  formatVerificationReconcileReport,
} from '../verification-reconcile.js'
import type { TaskLedgerEvent } from '../task-ledger.js'

function verificationEvent(
  command: string,
  status: 'passed' | 'failed' | 'blocked',
  meta?: Record<string, unknown>,
): TaskLedgerEvent {
  return { type: 'verification', timestamp: Date.now(), command, status, meta }
}

test('declaredVerificationCommands 跨任务去重保序', () => {
  const cmds = declaredVerificationCommands({
    tasks: [
      { verification: ['npx tsc --noEmit', 'npx tsx --test a.test.ts'] },
      { verification: ['npx  tsc   --noEmit'] }, // 空白差异视为同一条
      { verification: undefined },
      { verification: ['npm run lint'] },
    ] as never,
  })
  assert.deepEqual(cmds, ['npx tsc --noEmit', 'npx tsx --test a.test.ts', 'npm run lint'])
})

test('reconcile: 通过/失败/blocked/未跑四态', () => {
  const declared = ['npx tsc --noEmit', 'npx tsx --test a.test.ts', 'npx tsx --test b.test.ts', 'npm run lint']
  const ran = [
    verificationEvent('npx tsc --noEmit', 'passed', { passed: 0, failed: 0 }),
    verificationEvent('npx tsx --test a.test.ts', 'failed', { passed: 3, failed: 2 }),
    verificationEvent('npx tsx --test b.test.ts', 'blocked', { blockedReason: 'timeout' }),
  ]
  const items = reconcileVerificationCommands(declared, ran)
  assert.deepEqual(items.map(i => i.status), ['passed', 'failed', 'blocked', 'not_run'])
  assert.equal(items[1]!.detail, '3 pass 2 fail')
  assert.equal(items[2]!.detail, 'timeout')
})

test('reconcile: 后跑覆盖先跑（失败后重跑通过 → passed）', () => {
  const items = reconcileVerificationCommands(
    ['npx tsx --test a.test.ts'],
    [
      verificationEvent('npx tsx --test a.test.ts', 'failed'),
      verificationEvent('npx tsx --test a.test.ts', 'passed', { passed: 12, failed: 0 }),
    ],
  )
  assert.equal(items[0]!.status, 'passed')
  assert.equal(items[0]!.detail, '12 pass 0 fail')
})

test('reconcile: 扩集运行命中声明命令（互为包含匹配）', () => {
  const items = reconcileVerificationCommands(
    ['npx tsx --test a.test.ts'],
    [verificationEvent('npx tsx --test a.test.ts b.test.ts', 'passed', { passed: 20, failed: 0 })],
  )
  assert.equal(items[0]!.status, 'passed')
})

test('reconcile: resolvedCommand 参与匹配', () => {
  const items = reconcileVerificationCommands(
    ['npm test'],
    [verificationEvent('run_tests', 'passed', { resolvedCommand: 'npm test', passed: 5, failed: 0 })],
  )
  assert.equal(items[0]!.status, 'passed')
})

test('format: 全绿单行带过', () => {
  const lines = formatVerificationReconcileReport([
    { command: 'npx tsc --noEmit', status: 'passed' },
  ])
  assert.equal(lines.length, 2)
  assert.match(lines[1]!, /全部有通过记录/)
})

test('format: 缺口逐条列出并含披露与死循环分诊提示', () => {
  const lines = formatVerificationReconcileReport([
    { command: 'npx tsc --noEmit', status: 'passed' },
    { command: 'npx tsx --test a.test.ts', status: 'blocked', detail: 'timeout' },
    { command: 'npm run lint', status: 'not_run' },
  ])
  const text = lines.join('\n')
  assert.match(text, /2 条未核销/)
  assert.match(text, /⏱ npx tsx --test a\.test\.ts — blocked（timeout）——跑了但没跑完/)
  assert.match(text, /∅ npm run lint — 无运行记录/)
  assert.match(text, /与虚报同罪/)
  assert.match(text, /死循环/)
})

test('format: 零声明命令返回空（不渲染空段落）', () => {
  assert.deepEqual(formatVerificationReconcileReport([]), [])
})

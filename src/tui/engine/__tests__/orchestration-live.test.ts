/**
 * 编排 live 交互测试（app 级，经真实 stdin 序列 + mock stdout）：
 *
 *  1. 委派工具终态 → scrollback 出现「完成沉淀卡」（◆ 子代理组 · N/M 通过）。
 *  2. team currentWave 推进 → scrollback 提交 wave 完成时间线行，重复推送去重。
 *  3. ask_user_question 面板：含选项自动可开、数字键快选（单选直接提交、
 *     多选切换 + Enter 确认）、无选项不弹面板。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { encodeTeamPanelModel, type TeamPanelModel } from '../../team-panel-model.js'
import type { DelegationActivity } from '../../../tools/types.js'

class MockOut {
  columns = 100
  rows = 40
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 40, modelName: 'test',
  })
  app.start()
  return { app, out, stdin }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

const act = (workOrderId: string, status: DelegationActivity['status'], extra: Partial<DelegationActivity> = {}): DelegationActivity => ({
  workOrderId,
  parentToolId: 'tool-1',
  profile: 'reviewer',
  status,
  ...extra,
})

test('委派工具终态：scrollback 提交完成沉淀卡', () => {
  const { app, out } = makeApp()
  const onActivity = app.callbacks.onDelegationActivity!
  app.callbacks.onToolUse('tool-1', 'delegate_batch', { tasks: [{}, {}] })
  onActivity(act('w1', 'running'))
  onActivity(act('w2', 'running'))
  onActivity(act('w1', 'passed', { progressLine: 'found 3 issues', toolUseCount: 20, tokenCount: 253_200 }))
  onActivity(act('w2', 'passed', { progressLine: 'clean', toolUseCount: 17, tokenCount: 220_100 }))

  out.clear()
  app.callbacks.onToolResult('tool-1', 'delegate_batch', 'delegate_batch: 2/2 passed', false)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('◆ 子代理组'), `settle card committed: ${plain.slice(-400)}`)
  assert.ok(plain.includes('2/2 通过'), 'aggregate passed count')
  assert.ok(plain.includes('审查 #1') && plain.includes('审查 #2'), 'per-worker rows')
  assert.ok(plain.includes('— found 3 issues'), 'summary tail')
})

const teamModelAt = (currentWave: number): TeamPanelModel => ({
  mode: 'standard',
  currentWave,
  totalWaves: 2,
  dispatched: 3,
  blocked: [],
  waves: [
    { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: '' },
    { id: 'wave-2', taskIds: ['t3'], risk: 'low', reason: '' },
  ],
  tasks: [
    { id: 't1', title: 'a', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't2', title: 'b', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't3', title: 'c', authority: 'pojun', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'low', files: [], status: currentWave > 0 ? 'running' : 'waiting' },
  ],
})

test('team wave 推进：提交时间线行且重复推送去重', () => {
  const { app, out } = makeApp()
  app.callbacks.onToolUse('tc', 'team_orchestrate', { objective: 'x' })
  // 初始面板（wave 1 在跑）：不提交任何时间线行。
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(0)), undefined)
  assert.ok(!stripAnsi(out.chunks.join('')).includes('wave 1/2 完成'), 'wave 进行中不提交')

  // 推进到 wave 2（currentWave 0-based = 1）→ 提交 wave 1 完成行。
  out.clear()
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(1)), undefined)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('✓ wave 1/2 完成 · 2/2 任务'), `wave line committed: ${plain.slice(-300)}`)

  // 同一 currentWave 重复推送 → 去重，不再提交。
  out.clear()
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(1)), undefined)
  assert.ok(!stripAnsi(out.chunks.join('')).includes('wave 1/2 完成'), '重复推送被去重')
})

test('ask 面板：单选数字键快选直接提交答案', () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => app.buildAskChoicePanelData() })
  let submitted: string | undefined
  app.onSubmit(text => { submitted = text })
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Pick one', options: ['Alpha', 'Beta'], allowMultiple: false }],
  })
  assert.ok(app.pendingAskFlow, '面板流已建立')

  stdin.dataHandler!('2') // 数字键 2 → Beta
  assert.equal(submitted, 'Beta', '数字键直选第 2 项并提交')
  assert.equal(app.pendingAskFlow, undefined, '提交后流清理')
})

test('ask 面板：多选数字键切换 + Enter 确认', () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => app.buildAskChoicePanelData() })
  const submitted: string[] = []
  app.onSubmit(text => { submitted.push(text) })
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Pick many', options: ['X', 'Y', 'Z'], allowMultiple: true }],
  })

  stdin.dataHandler!('1') // 切换 X
  assert.equal(submitted.length, 0, '多选切换不提交')
  stdin.dataHandler!('3') // 切换 Z
  assert.equal(submitted.length, 0, '多选切换不提交')
  stdin.dataHandler!('\r') // Enter 确认
  assert.equal(submitted.length, 1, 'Enter 后提交一次')
  assert.ok(submitted[0]!.includes('X') && submitted[0]!.includes('Z'), `多选答案含 X 与 Z: ${submitted[0]}`)
  assert.ok(!submitted[0]!.includes('Y'), '未选 Y')
})

test('ask 面板：无选项问题不弹面板', () => {
  const { app } = makeApp()
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Free text?', options: [], allowMultiple: false }],
  })
  assert.equal(app.pendingAskFlow, undefined, '无选项 → 不建立面板流（走输入框作答）')
})

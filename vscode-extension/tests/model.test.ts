import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialChatState, reduceEvent, type ChatState } from '../webview-ui/src/model.ts'

function feed(events: Array<{ type: string; data: Record<string, unknown> }>): ChatState {
  let state = initialChatState
  let seq = 0
  for (const e of events) {
    state = reduceEvent(state, { seq: ++seq, ts: seq, type: e.type, data: e.data })
  }
  return state
}

test('连续 text_delta 并入同一 assistant 气泡', () => {
  const s = feed([
    { type: 'user', data: { text: '你好' } },
    { type: 'text_delta', data: { text: '天' } },
    { type: 'text_delta', data: { text: '枢' } },
  ])
  assert.equal(s.items.length, 2)
  assert.deepEqual(s.items[1], { kind: 'assistant', text: '天枢' })
})

test('tool_result 分块按 id 追加到对应 tool 卡', () => {
  const s = feed([
    { type: 'tool_use', data: { id: 't1', name: 'bash', input: { command: 'ls' } } },
    { type: 'text_delta', data: { text: 'x' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'a\n' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'b' } },
  ])
  const tool = s.items[0]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind === 'tool') {
    assert.equal(tool.result, 'a\nb')
    assert.equal(tool.isError, false)
  }
})

test('审批 required/resolved 按 requestId 配对并维护 pending 计数', () => {
  const s1 = feed([
    { type: 'approval_required', data: { requestId: 'r1', toolName: 'bash', input: { command: 'rm x' } } },
  ])
  assert.equal(s1.pendingApprovals, 1)
  const s2 = reduceEvent(s1, { seq: 9, ts: 9, type: 'approval_resolved', data: { requestId: 'r1', decision: 'deny' } })
  assert.equal(s2.pendingApprovals, 0)
  const card = s2.items[0]
  if (card?.kind === 'approval') assert.equal(card.decision, 'deny')
  else assert.fail('expected approval card')
})

test('未知事件类型透传忽略（向后兼容）', () => {
  const s = feed([
    { type: 'text_delta', data: { text: 'hi' } },
    { type: 'some_future_event', data: { anything: true } },
  ])
  assert.equal(s.items.length, 1)
})

test('text_delta 中插入 tool 后新 delta 开新气泡', () => {
  const s = feed([
    { type: 'text_delta', data: { text: '前' } },
    { type: 'tool_use', data: { id: 't1', name: 'read_file', input: {} } },
    { type: 'text_delta', data: { text: '后' } },
  ])
  assert.equal(s.items.length, 3)
  assert.deepEqual(s.items[2], { kind: 'assistant', text: '后' })
})

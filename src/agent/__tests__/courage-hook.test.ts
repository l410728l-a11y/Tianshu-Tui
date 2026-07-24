import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldTriggerCourage } from '../hooks/courage-hook.js'

describe('CourageHook', () => {
  it('triggers on failed tool signals', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'tsc', status: 'failed' },
    ], 0.3), true)
  })

  // B2/M9（2026-07-23 信号互扰治理）：成功调用的 target 文本不再计险。
  // 结果词（error/fail/…）出现在文件路径、grep pattern、bash 命令文本里
  // 均为噪音——风险的 ground truth 是 status==='failed'。
  it('does NOT trigger on risky words in a successful call target (B2/M9)', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'Type error in foo.ts', status: 'success' },
    ], 0.3), false)
  })

  it('does NOT trigger on successful reads of files named after failures (B2/M9 原始事故形状)', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'read_file', target: 'src/agent/failure-classifier.ts', status: 'success' },
      { tool: 'read_file', target: 'src/agent/hooks/error-diagnosis-hook.ts', status: 'success' },
      { tool: 'grep', target: 'not found', status: 'success' },
    ], 0.5), false)
  })

  it('does not trigger on success', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'npm test', status: 'success' },
    ], 0.3), false)
  })

  it('does not trigger on empty history', () => {
    assert.equal(shouldTriggerCourage([], 0.5), false)
  })
})

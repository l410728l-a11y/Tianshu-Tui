import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { buildRuntimeSnapshot } from '../loop-factory.js'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * W0 生命周期装配回归（2026-07-21 courageThreshold 事故）：
 *
 * runtimeHooks pipeline 在 AgentLoop 构造期创建，而 sessionDomain 的绑定
 * （main.ts 钉域 / bindSessionDomain）发生在构造之后。历史事故：loop-factory
 * 在构造期对 sessionDomain?.courageThreshold 求值成数字快照 → hook 闭包
 * 永远拿 0.5，12 域差异化值全部失效——且「同轮构造即绑定」的测试全绿。
 *
 * 本测试钉的是真实时序：先构造完整 AgentLoop（域 undefined）→ 之后
 * setSessionDomain → 断言 courage 判定用的是域值而非缺省 0.5。两个方向：
 * - 高阈值域（瑶光 0.8）：风险比 2/3 用陈旧 0.5 会触发、用 0.8 不触发
 * - 低阈值域（破军 0.25）：风险比 1/3 用陈旧 0.5 不触发、用 0.25 触发
 * 两方向都过 = 装配点必然是活引用。若有人把 loop-factory 改回快照或
 * 死 getter，此测试变红。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-courage-wiring-'))

function textOnlyClient(text = 'done'): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: textOnlyClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

type ToolHistoryEntry = { tool: string; status: 'success' | 'failed'; target: string }

async function runPreTurnWithHistory(agent: AgentLoop, turn: number, history: ToolHistoryEntry[]): Promise<void> {
  const snapshot = buildRuntimeSnapshot(agent, { turn, recentToolHistory: history })
  await agent.runtimeHooks.runPreTurn(createRuntimeHookContext(snapshot, {
    injectUserMessage: () => {},
  }))
}

describe('courage threshold lifecycle wiring (construct → bind domain)', () => {
  it('domain bound AFTER pipeline construction drives the courage predicate (both directions)', async () => {
    const agent = makeAgent()
    // 构造完成、域未绑定——真实生产时序（main.ts 钉域在 agent 创建之后）。
    assert.equal(agent.getSessionDomain(), undefined)

    // 方向一：高阈值域。风险比 2/3 ≈ 0.667——陈旧缺省 0.5 会触发，瑶光 0.8 不触发。
    agent.setSessionDomain({
      id: 'yaoguang', name: '瑶光', volatileBlock: '', motto: '', courageThreshold: 0.8,
    })
    await runPreTurnWithHistory(agent, 1, [
      { tool: 'bash', status: 'failed', target: 'tsc' },
      { tool: 'bash', status: 'failed', target: 'npm test' },
      { tool: 'read_file', status: 'success', target: 'a.ts' },
    ])
    assert.ok(!agent.advisoryBus.peekPendingKeys().includes('courage'),
      '瑶光 0.8 下风险比 0.667 不应触发——若触发说明装配点仍在用陈旧缺省 0.5')

    // 方向二：低阈值域。风险比 1/3 ≈ 0.333——陈旧缺省 0.5 不触发，破军 0.25 触发。
    agent.setSessionDomain({
      id: 'pojun', name: '破军', volatileBlock: '', motto: '', courageThreshold: 0.25,
    })
    await runPreTurnWithHistory(agent, 2, [
      { tool: 'bash', status: 'failed', target: 'tsc' },
      { tool: 'read_file', status: 'success', target: 'a.ts' },
      { tool: 'read_file', status: 'success', target: 'b.ts' },
    ])
    assert.ok(agent.advisoryBus.peekPendingKeys().includes('courage'),
      '破军 0.25 下风险比 0.333 应触发——不触发说明域切换未被 courage 消费（快照/死 getter 回归）')
  })
})

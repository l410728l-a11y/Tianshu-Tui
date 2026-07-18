import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveCollabBranches,
  type CollabBranch,
} from '../collab-branches.js'
import {
  buildHeuristicRetrievalRoute,
  normalizeRetrievalRoute,
  renderIntentRetrievalRoute,
  renderLowConfidenceIntentAdvisory,
} from '../intent-retrieval-route.js'
import type { TaskContract } from '../../context/task-contract.js'

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: 'task-1-test',
    objective: '测试协作路径',
    scope: { mentionedFiles: [] },
    constraints: [],
    successCriteria: [],
    status: 'exploring',
    createdAtTurn: 1,
    updatedAtTurn: 1,
    isActionable: true,
    ...overrides,
  }
}

describe('deriveCollabBranches', () => {
  it('maps diagnostic, security, architecture, fuzzy, and exploration signals', () => {
    const diagnostic = deriveCollabBranches({
      taskKinds: ['bug_fix'],
      sanitizedText: '修复登录回归',
      confidence: 0.75,
      taskContract: contract(),
    })
    assert.ok(diagnostic.branches.includes('D'))

    const security = deriveCollabBranches({
      taskKinds: ['security_safety'],
      sanitizedText: '检查权限边界',
      confidence: 0.75,
      taskContract: contract(),
    })
    assert.ok(security.branches.includes('C'))

    const architecture = deriveCollabBranches({
      taskKinds: ['architecture_design'],
      sanitizedText: '设计整体架构',
      confidence: 0.75,
      taskContract: contract({ scope: { mentionedFiles: ['src/agent/a.ts', 'src/agent/b.ts'] } }),
    })
    assert.ok(architecture.branches.includes('B'))

    const fuzzy = deriveCollabBranches({
      taskKinds: ['new_feature'],
      sanitizedText: '看看这个计划，优化一下',
      confidence: 0.55,
      taskContract: contract(),
    })
    assert.ok(fuzzy.branches.includes('A'))

    const exploration = deriveCollabBranches({
      taskKinds: ['codebase_overview'],
      sanitizedText: '盘点废弃模块',
      confidence: 0.75,
      taskContract: contract(),
    })
    assert.ok(exploration.branches.includes('E'))
  })

  it('does not activate fuzzy, diagnostic, or exploration branches for social idle', () => {
    const result = deriveCollabBranches({
      taskKinds: ['social_idle'],
      sanitizedText: '你好',
      confidence: 0.3,
      taskContract: contract({ isActionable: false }),
    })
    assert.deepEqual(result.branches, [])
    assert.deepEqual(result.reasons, [])
  })

  it('is deterministic and preserves the declared branch order', () => {
    const input = {
      taskKinds: ['security_safety', 'architecture_design'] as const,
      sanitizedText: '设计安全权限架构并检查风险',
      confidence: 0.65,
      taskContract: contract({ scope: { mentionedFiles: ['src/a.ts', 'src/b.ts'] } }),
    }
    const first = deriveCollabBranches(input)
    const second = deriveCollabBranches(input)
    assert.deepEqual(first, second)
    assert.deepEqual(first.branches, ['B', 'C'])
  })
})

describe('RetrievalRoute collaboration branches', () => {
  it('exposes heuristic branches on the route', () => {
    const route = buildHeuristicRetrievalRoute({ userMessage: '修复登录回归' })
    assert.ok(route.collabBranches?.includes('D'))
    assert.ok(route.branchReasons?.length)
  })

  it('unions LLM branches with heuristic branches instead of replacing them', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['new_feature'],
      directions: [],
      confidence: 0.9,
      branches: ['C'] satisfies CollabBranch[],
    }, { userMessage: '修复登录回归' })

    assert.ok(route.collabBranches?.includes('C'))
    assert.ok(route.collabBranches?.includes('D'))
  })

  it('keeps the legacy XML byte-for-byte shape when no branches exist', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['usage_question'],
      directions: [{ source: 'codebase', priority: 'must', query: '查 API', reason: '用法' }],
      antiAnchorNote: '不要锚定',
      confidence: 0.8,
      fallbackUsed: false,
    })
    const rendered = renderIntentRetrievalRoute(route)
    assert.doesNotMatch(rendered, /collab|协作路径/)
  })

  it('renders a deterministic escaped branch summary for high-confidence routes', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['security_safety'],
      directions: [{ source: 'codebase', priority: 'must', query: '查 <权限>', reason: '边界 & 安全' }],
      confidence: 0.9,
      branches: ['C'] satisfies CollabBranch[],
    }, { userMessage: '检查权限' })
    const rendered = renderIntentRetrievalRoute(route)
    assert.match(rendered, /<collaboration-path>骨干\+C<\/collaboration-path>/)
    assert.doesNotMatch(rendered, /查 <权限>/)
    assert.match(rendered, /边界 &amp; 安全/)
  })

  it('maps exploration signals to E without activating social advisory branches', () => {
    const exploration = normalizeRetrievalRoute({
      taskKinds: ['codebase_overview'],
      directions: [],
      confidence: 0.8,
    }, { userMessage: '盘点废弃模块' })
    assert.ok(exploration.collabBranches?.includes('E'))
    const social = buildHeuristicRetrievalRoute({ userMessage: '你好' })
    assert.deepEqual(social.collabBranches, [])
  })

  it('preserves branches in the low-confidence advisory instead of silently dropping them', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['new_feature'],
      directions: [],
      confidence: 0.55,
      branches: ['A'] satisfies CollabBranch[],
    }, { userMessage: '优化一下' })
    const rendered = renderLowConfidenceIntentAdvisory(route)
    assert.match(rendered, /协作路径: 骨干\+A/)
  })
})

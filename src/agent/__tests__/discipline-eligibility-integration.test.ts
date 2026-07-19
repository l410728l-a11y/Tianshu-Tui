/**
 * DisciplineEligibility 端到端集成测试
 *
 * 不 mock 中间层——从真实用户输入出发，经 classifyTurnMode → extractTaskContract →
 * deriveDisciplineEligibility，再到各消费方（TDD gate / plan advisor / collab branches
 * / dispatcher），验证完整管线的资格分层语义。
 *
 * 覆盖场景：
 * 1. 解释/分析/社交/概念 — 不被误判为工程任务
 * 2. 工程任务（修复/重构/实现）— 正确启用 TDD + 派发 + plan 建议
 * 3. 明示否定词（只解释/不修改）— 降级为只读
 * 4. 空 taskKinds 安全网 — ≥2 代码文件时保守升级
 * 5. chat → 全 false 闭合
 * 6. followUp → 轻量投影
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTurnMode, extractTaskContract } from '../../context/task-contract.js'
import { deriveDisciplineEligibility, detectProblemSignal, type DisciplineEligibility } from '../discipline-eligibility.js'
import { checkTddGate, type TddGateInput } from '../tdd-gate.js'
import { shouldSuggestPlanMode } from '../plan-mode-advisor.js'
import { deriveCollabBranches, type CollabBranchInput } from '../collab-branches.js'
import type { IntentTaskKind } from '../intent-retrieval-route.js'

// ── 辅助：模拟 intent router 输出（不调用真实 LLM）───────────────────
// 这些映射来自 intent-retrieval-route 的分类逻辑——不是 mock，是规格的重述。
// 真实 intent router 在语义上等价于这些规则。

function simulateTaskKinds(userInput: string): IntentTaskKind[] {
  const lower = userInput.toLowerCase()
  const kinds: IntentTaskKind[] = []

  // 工程语义
  if (/修复|fix|bug|修.*bug|改.*错|修.*错/.test(lower)) kinds.push('bug_fix')
  if (/重构|refactor|重写|rewrite|重新.*写/.test(lower)) kinds.push('refactor')
  if (/实现|implement|新增|添加.*功能|add.*feature|开发/.test(lower)) kinds.push('new_feature')
  if (/优化|optimize|性能|performance/.test(lower) && !/解释|分析|说明/.test(lower)) kinds.push('performance_diagnosis')

  // 只读语义
  if (/解释|explain|说明|describe|分析|analyze|代码.*意思|这段.*什么|这个.*什么/.test(lower) && !kinds.length) {
    kinds.push('code_explanation')
  }
  if (/怎么用|用法|how.*use|使用.*方法/.test(lower)) kinds.push('usage_question')
  if (/审查|review|检查.*代码|审计|audit/.test(lower)) kinds.push('review_audit')
  if (/搜索|search|找.*文件|grep|查找/.test(lower)) kinds.push('codebase_overview')

  // 社交
  if (/你好|hi|hello|hey|谢谢|thanks|再见|bye/.test(lower) && !kinds.length) kinds.push('social_idle')

  return kinds
}

function e2e(input: string) {
  const turnMode = classifyTurnMode(input, undefined)
  const contract = extractTaskContract(input, 1)
  const taskKinds = simulateTaskKinds(input)
  const explicitNoMutation = /不要修改|只解释|只分析|不要改|别改|不修改/.test(input)
  const mentionedFiles = input.match(/[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java)/g) ?? []
  const eligibility = deriveDisciplineEligibility({
    turnMode,
    taskKinds,
    explicitNoMutation,
    mentionedCodeFileCount: new Set(mentionedFiles.map(f => f.replace(/^.*\//, ''))).size,
    problemSignal: detectProblemSignal(input),
  })
  return { turnMode, contract, taskKinds, eligibility, explicitNoMutation }
}

// ── 场景测试 ──────────────────────────────────────────────────

describe('DisciplineEligibility E2E 管线', () => {
  // ── 1. 解释/分析类不被误判为工程 ──
  describe('解释/分析 → light 或 evidence', () => {
    it('代码解释 → light（不触发 TDD、不派发）', () => {
      const { eligibility } = e2e('解释 src/agent/loop.ts 的主要逻辑和作用')
      assert.equal(eligibility.requiresCodeVerification, false, '解释不应需要代码验证')
      assert.equal(eligibility.requiresEngineeringDiscipline, false)
      assert.equal(eligibility.canDispatch, false)
      assert.equal(eligibility.canSuggestPlan, false)
      assert.equal(eligibility.projectionMode, 'light')
    })

    it('用法问答 → light', () => {
      const { eligibility } = e2e('怎么用 delegate_task 派发子任务？')
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.canDispatch, false)
      assert.equal(eligibility.projectionMode, 'light')
    })

    it('概念问答 → light', () => {
      const { eligibility } = e2e('噪音是什么意思')
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.canDispatch, false)
      assert.equal(eligibility.responseActionable, true)
    })
  })

  // ── 2. 工程任务 → engineering ──
  describe('工程任务 → engineering（TDD + 派发 + plan）', () => {
    it('修复 bug → engineering', () => {
      const { eligibility } = e2e('修复 src/agent/loop.ts 中消息顺序不一致的 bug')
      assert.equal(eligibility.requiresCodeVerification, true)
      assert.equal(eligibility.requiresEngineeringDiscipline, true)
      assert.equal(eligibility.canSuggestPlan, true)
      assert.equal(eligibility.canDispatch, true)
      assert.equal(eligibility.projectionMode, 'engineering')
    })

    it('重构 → engineering', () => {
      const { eligibility } = e2e('重构 stream-client 的连接管理逻辑')
      assert.equal(eligibility.requiresCodeVerification, true)
      assert.equal(eligibility.requiresEngineeringDiscipline, true)
      assert.equal(eligibility.canSuggestPlan, true)
      assert.equal(eligibility.canDispatch, true)
    })

    it('实现新功能 → engineering', () => {
      const { eligibility } = e2e('实现 agent 主循环的 speculative decoding 支持')
      assert.equal(eligibility.requiresCodeVerification, true)
      assert.equal(eligibility.requiresEngineeringDiscipline, true)
    })
  })

  // ── 3. 明示否定词 → 降级 ──
  describe('明示否定词（只解释/不修改）→ 降级为只读', () => {
    it('"只解释" → 降级为 light', () => {
      const { eligibility } = e2e('只解释 src/agent/loop.ts 的架构，不要修改')
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.requiresEngineeringDiscipline, false)
      assert.equal(eligibility.canSuggestPlan, false)
      assert.equal(eligibility.canDispatch, false)
      assert.ok(['light', 'evidence'].includes(eligibility.projectionMode))
    })

    it('"只分析不修改" → 降级', () => {
      const { eligibility } = e2e('分析 src/tools/delegate-batch.ts 的性能瓶颈，不要改代码')
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.canDispatch, false)
    })
  })

  // ── 4. 空 taskKinds 安全网 ──
  describe('空 taskKinds 安全网', () => {
    it('≥2 代码文件 + 空种类 → 保守升级为 engineering', () => {
      const input = '处理 src/agent/coordinator.ts 和 src/agent/loop.ts 的问题'
      const eligibility = deriveDisciplineEligibility({
        turnMode: 'task',
        taskKinds: [], // intent router 漏判
        mentionedCodeFileCount: 2,
      })
      assert.equal(eligibility.requiresCodeVerification, true, '安全网：2 文件应升级')
      assert.equal(eligibility.requiresEngineeringDiscipline, true)
      assert.equal(eligibility.projectionMode, 'engineering')
    })

    it('0 文件 + 空种类 → 保守降级为 light', () => {
      const eligibility = deriveDisciplineEligibility({
        turnMode: 'task',
        taskKinds: [],
        mentionedCodeFileCount: 0,
      })
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.projectionMode, 'light')
    })
  })

  // ── 5. chat → 全 false ──
  describe('chat → 全 false 闭合', () => {
    it('你好 → 全 false', () => {
      const { eligibility, turnMode } = e2e('你好')
      assert.equal(turnMode, 'chat')
      assert.equal(eligibility.responseActionable, false)
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.requiresEngineeringDiscipline, false)
      assert.equal(eligibility.canSuggestPlan, false)
      assert.equal(eligibility.canDispatch, false)
      assert.equal(eligibility.projectionMode, 'none')
    })

    it('谢谢 → social 降级为 light', () => {
      // classifyTurnMode 将"谢谢，做得很好"归为 task（文本够长），
      // 但 simulateTaskKinds 识别 social_idle → 资格推导走无种类分支。
      const { eligibility } = e2e('谢谢，做得很好')
      assert.equal(eligibility.requiresCodeVerification, false, 'social 不应触发 TDD')
      assert.equal(eligibility.canDispatch, false, 'social 不应派发')
      assert.equal(eligibility.projectionMode, 'light')
    })
  })

  // ── 6. followUp → 轻量 ──
  describe('followUp → 轻量投影', () => {
    it('简短追问 — 无活跃合同时归为 task，不触发 plan', () => {
      // classifyTurnMode 无 activeContract 时 "能再详细一点吗" → task
      const { eligibility } = e2e('能再详细一点吗')
      assert.equal(eligibility.responseActionable, true)
      // 无活跃 contract → 不触发 plan 建议
      assert.equal(eligibility.canSuggestPlan, false)
    })
  })

  // ── 7. 审查/审计 → evidence ──
  describe('审查/审计 → evidence', () => {
    it('代码审查 → evidence（不 TDD，可 evidence review）', () => {
      const { eligibility } = e2e('审查 src/agent/tdd-gate.ts 的测试覆盖')
      assert.equal(eligibility.requiresCodeVerification, false)
      assert.equal(eligibility.requiresEngineeringDiscipline, false)
      assert.equal(eligibility.allowsEvidenceReview, true)
      assert.equal(eligibility.projectionMode, 'evidence')
    })
  })
})

// ── 消费方集成：eligibility → 各下游门控 ──

describe('E2E: eligibility → 消费方门控', () => {
  it('TDD gate — 解释输入不触发，修复输入触发', () => {
    const explain = e2e('解释 src/agent/loop.ts 的架构')
    const fix = e2e('修复 src/agent/loop.ts 的消息顺序 bug')

    const explainGate = checkTddGate({
      filesRead: new Set(['src/agent/loop.ts']),
      filesModified: new Set<string>(),
      requiresCodeVerification: explain.eligibility.requiresCodeVerification,
    })
    const fixGate = checkTddGate({
      filesRead: new Set(['src/agent/loop.ts']),
      filesModified: new Set(['src/agent/loop.ts']),
      requiresCodeVerification: fix.eligibility.requiresCodeVerification,
    })

    assert.equal(explainGate, null, '解释不应触发 TDD 提示')
    assert.ok(fixGate, '修复必须触发 TDD 提示')
  })

  it('plan advisor — 工程任务可建议，解释任务不可', () => {
    const engineering = e2e('重构 src/tools/delegate-batch.ts 的任务派发逻辑')
    const explain = e2e('解释 src/tools/delegate-batch.ts 的工作原理')

    const engSuggest = shouldSuggestPlanMode({
      turnMode: engineering.turnMode,
      contract: engineering.contract,
      eligibility: engineering.eligibility,
      methodology: 'full',
      depthLayer: 'system',
      planModeState: 'off',
      suggestedContractIds: new Set(),
    })
    const expSuggest = shouldSuggestPlanMode({
      turnMode: explain.turnMode,
      contract: explain.contract,
      eligibility: explain.eligibility,
      methodology: 'full',
      depthLayer: 'system',
      planModeState: 'off',
      suggestedContractIds: new Set(),
    })

    assert.equal(engSuggest.suggest, true, '工程任务应建议 plan mode')
    assert.equal(expSuggest.suggest, false, '解释任务不应建议 plan mode')
  })

  it('collab branches — 工程任务可派发，解释任务不可', () => {
    const engineering = e2e('修复 src/agent/discipline-eligibility.ts 的逻辑漏洞')
    const explain = e2e('分析 src/agent/discipline-eligibility.ts 的实现')

    const engBranches = deriveCollabBranches({
      taskKinds: engineering.taskKinds,
      eligibility: engineering.eligibility,
      sanitizedText: '修复 src/agent/discipline-eligibility.ts 的逻辑漏洞',
      confidence: 0.9,
      taskContract: engineering.contract,
    })
    const expBranches = deriveCollabBranches({
      taskKinds: explain.taskKinds,
      eligibility: explain.eligibility,
      sanitizedText: '分析 src/agent/discipline-eligibility.ts 的实现',
      confidence: 0.9,
      taskContract: explain.contract,
    })

    assert.ok(engBranches.branches.length > 0, '工程任务应有协作文')
    assert.equal(expBranches.branches.length, 0, '解释任务不应有协作文')
  })
})

// ── 回归守卫：已知判别矩阵全覆盖 ──

describe('E2E 回归守卫', () => {
  const cases: Array<{ input: string; expected: Partial<DisciplineEligibility> & { turnMode?: string } }> = [
    { input: '你好', expected: { turnMode: 'chat', requiresCodeVerification: false, projectionMode: 'none' } },
    { input: '解释 loop.ts', expected: { turnMode: 'task', requiresCodeVerification: false, canDispatch: false } },
    { input: '修复 loop.ts 的 bug', expected: { turnMode: 'task', requiresCodeVerification: true, canDispatch: true } },
    { input: '重构 stream-client', expected: { turnMode: 'task', requiresCodeVerification: true, canSuggestPlan: true } },
    { input: '只解释 loop.ts，不要改', expected: { requiresCodeVerification: false, canDispatch: false } },
    // 以下 5 例补全文档声称的 10 输入矩阵
    { input: '怎么用 delegate_task 派发子任务？', expected: { requiresCodeVerification: false, canDispatch: false, projectionMode: 'light' } },
    { input: '审查 src/agent/loop.ts 的并发安全', expected: { requiresCodeVerification: false, allowsEvidenceReview: true, projectionMode: 'evidence' } },
    { input: '优化 src/api/client.ts 的重试性能', expected: { requiresEngineeringDiscipline: true, requiresCodeVerification: false, canDispatch: true } },
    // 安全网：intent router 漏判（无 kind 关键词）但提到 ≥2 代码文件 → 保守升级工程
    { input: 'src/agent/loop.ts 和 src/agent/evidence.ts 之间的数据流', expected: { requiresCodeVerification: true, projectionMode: 'engineering' } },
    // 空种类且无文件 → 保守减负，不升级为工程
    { input: '这个设计你怎么看', expected: { requiresCodeVerification: false, projectionMode: 'light' } },
    // 窗口 1 修复：单文件 + 问题信号（"有点怪"）→ 安全网升级工程
    { input: 'src/auth.ts 的登录逻辑有点怪', expected: { requiresCodeVerification: true, projectionMode: 'engineering' } },
    // 单文件纯解释（无信号词）→ 保持 light，不误升级
    { input: '解释 src/auth.ts 的登录逻辑', expected: { requiresCodeVerification: false, projectionMode: 'light' } },
  ]

  for (const c of cases) {
    it(`"${c.input}" → ${JSON.stringify(c.expected)}`, () => {
      const { eligibility, turnMode } = e2e(c.input)
      if (c.expected.turnMode) assert.equal(turnMode, c.expected.turnMode)
      if (c.expected.requiresCodeVerification !== undefined) assert.equal(eligibility.requiresCodeVerification, c.expected.requiresCodeVerification)
      if (c.expected.canDispatch !== undefined) assert.equal(eligibility.canDispatch, c.expected.canDispatch)
      if (c.expected.canSuggestPlan !== undefined) assert.equal(eligibility.canSuggestPlan, c.expected.canSuggestPlan)
      if (c.expected.requiresEngineeringDiscipline !== undefined) assert.equal(eligibility.requiresEngineeringDiscipline, c.expected.requiresEngineeringDiscipline)
      if (c.expected.allowsEvidenceReview !== undefined) assert.equal(eligibility.allowsEvidenceReview, c.expected.allowsEvidenceReview)
      if (c.expected.projectionMode) assert.equal(eligibility.projectionMode, c.expected.projectionMode)
    })
  }
})

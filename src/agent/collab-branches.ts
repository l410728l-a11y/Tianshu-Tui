import type { TaskContract } from '../context/task-contract.js'
import type { DisciplineEligibility } from './discipline-eligibility.js'
import type { IntentTaskKind } from './intent-retrieval-route.js'

/** 协作流分支：A 对齐、B 守门、C 安全、D 诊断、E 勘探。 */
export type CollabBranch = 'A' | 'B' | 'C' | 'D' | 'E'

export interface CollabBranchInput {
  readonly taskKinds: readonly IntentTaskKind[]
  /** 已完成上下文关联、编号脱敏和语义富化的文本。 */
  readonly sanitizedText: string
  readonly confidence: number
  readonly taskContract?: TaskContract
  /** 统一资格对象——为 undefined 时回退到 taskContract?.isActionable */
  readonly eligibility?: DisciplineEligibility
}

export interface CollabBranchResult {
  branches: CollabBranch[]
  reasons: string[]
}

export const COLLAB_BRANCH_ORDER: readonly CollabBranch[] = ['A', 'B', 'C', 'D', 'E']

const BRANCH_REASON: Record<CollabBranch, string> = {
  A: '需求存在模糊信号或分类置信度偏低，先完成认知对齐。',
  B: '任务涉及多文件架构/重构范围，先经过计划与回归守门。',
  C: '任务包含安全、权限或边界信号，先经过天府守卫。',
  D: '任务属于缺陷或性能诊断，先取证再规划或修改。',
  E: '任务属于代码库勘探/盘点，先召回贪狼勘探方法。',
}

// 来源：实施计划“模糊词表（优化一下/改改/看看）”
// /Users/banxia/.cursor/plans/自适应协作流采纳_bdea8336.plan.md:104；
// 具体匹配片段沿用该计划及当前基线输入“看看这个计划，优化一下”。
const FUZZY_REQUEST_RE = /优化(?:一下|下)?|改改|改一下|看看(?:这个|下)?(?:计划|代码|项目)?/i

// 来源：现有勘探触发器 src/agent/turn-step-producer.ts 的贪狼关键词，匹配"勘探/盘点/考古/半接/休眠/死代码"等真实文本。
// W3 起单一持有：E 分支判定与 buildTanlangExplorationAdvisory 共用本实现。
export const EXPLORATION_SIGNAL_RE = /勘探|盘点|考古|半接|休眠|架构审计|死代码|孤儿代码|技术债盘|dead.?code|archaeolog/i

const MAX_BRANCHES = COLLAB_BRANCH_ORDER.length

export function reasonForCollabBranch(branch: CollabBranch): string {
  return BRANCH_REASON[branch]
}

export function normalizeCollabBranches(value: unknown): CollabBranch[] {
  if (!Array.isArray(value)) return []
  const accepted = new Set<CollabBranch>()
  for (const item of value) {
    if (typeof item !== 'string' || !COLLAB_BRANCH_ORDER.includes(item as CollabBranch)) continue
    accepted.add(item as CollabBranch)
  }
  return COLLAB_BRANCH_ORDER.filter(branch => accepted.has(branch)).slice(0, MAX_BRANCHES)
}

export function deriveCollabBranches(input: CollabBranchInput): CollabBranchResult {
  // eligibility.canDispatch === false 时显式抑制；缺省则回退启发式——路由构建
  // 期 eligibility 尚不存在（它由 route.taskKinds 推导，是 egg-before-hen），
  // 缺省 fail-closed 会杀死全部启发式分支。真正的派发愿门禁在 dispatcher-hook
  // （有 eligibility，fail-closed + 缺省遥测）。
  const nonActionable = input.eligibility?.canDispatch === false
  if (input.taskKinds.includes('social_idle') || nonActionable) {
    return { branches: [], reasons: [] }
  }

  const branches = new Set<CollabBranch>()
  if (input.confidence < 0.6 || FUZZY_REQUEST_RE.test(input.sanitizedText)) {
    branches.add('A')
  }

  const hasScaleSignal = (input.taskContract?.scope.mentionedFiles.length ?? 0) >= 2
  if ((input.taskKinds.includes('architecture_design') || input.taskKinds.includes('refactor')) && hasScaleSignal) {
    branches.add('B')
  }
  if (input.taskKinds.includes('security_safety')) branches.add('C')
  if (input.taskKinds.includes('bug_fix') || input.taskKinds.includes('performance_diagnosis')) branches.add('D')
  if (input.taskKinds.includes('codebase_overview') && EXPLORATION_SIGNAL_RE.test(input.sanitizedText)) {
    branches.add('E')
  }

  const ordered = COLLAB_BRANCH_ORDER.filter(branch => branches.has(branch))
  return {
    branches: ordered,
    reasons: ordered.map(reasonForCollabBranch),
  }
}

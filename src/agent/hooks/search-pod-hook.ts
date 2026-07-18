import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

/**
 * search-pod-hook — 检索 POD 语义 shadow 观察（风暴遗产回收 W-B）。
 *
 * 理念来源：SAR 搜救的 POD（Probability of Detection）——"搜过 ≠ 排除"。
 * 主控 grep 一次没搜到就宣布"代码库中不存在 X"，但该查询可能是低检出力的
 * （正则写错、路径限定过窄、AST 模式对形状敏感、语义查询离题）。
 *
 * Shadow-only 纪律：本 hook 零 prompt 注入、零 advisory、零 advisoryBus
 * 调用——只落 telemetry 行供离线分析。先用数据回答"低 POD 空结果后主控
 * 宣布排除的频率是否值得干预"，有数据再设计回执提示（晋升条件见
 * .rivet/plans/pal-风暴遗产回收-设计.md）。
 *
 * 分类判据必须确定性：同输入同分类，无时间/随机因素——纯函数可单测。
 */

export type SearchPodQueryClass = 'high-pod' | 'low-pod'

export interface SearchPodRow {
  event: 'search-pod'
  tool: string
  /** high-pod = 查询检出力高，空结果 ≈ 可信排除；low-pod = 空结果 ≠ 排除。 */
  queryClass: SearchPodQueryClass
  emptyResult: boolean
  turn: number
  /** semantic_search 专属：top 结果分数（低质量结果事件填充）。 */
  topScore?: number
}

export interface SearchPodHookDeps {
  record: (row: SearchPodRow) => void
}

/** 观察的检索工具集合。 */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ast_grep', 'semantic_search'])

/** semantic_search 低质量结果阈值：top score 低于此值时空手率高、误排除
 *  风险中等。0.3 取自 embedding 余弦相似度的经验低水位——多数 provider 的
 *  "弱相关"落在 0.2-0.4 区间；待有校准数据后可从 provider 侧推导替换。 */
export const SEMANTIC_LOW_SCORE_THRESHOLD = 0.3

/** 正则元字符（grep pattern 判别用）——含任意一个即视为正则查询。 */
const REGEX_META = /[\\^$.|?*+()[\]{}]/

/**
 * 纯分类器：给定检索工具事件，返回应记录的 POD 行（不含 turn），
 * 或 null（非检索工具 / 非可记录事件——结果非空且质量高不记录）。
 */
export function classifySearchPod(tool: RuntimeToolEvent): Omit<SearchPodRow, 'turn'> | null {
  if (!SEARCH_TOOLS.has(tool.name) || !tool.success || tool.isError) return null
  const content = tool.resultContent ?? ''
  const input = tool.input ?? {}

  if (tool.name === 'grep') {
    if (!content.includes('No matches found')) return null
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : ''
    const literal = input['literal'] === true || !REGEX_META.test(pattern)
    const scoped = typeof input['path'] === 'string' || typeof input['glob'] === 'string'
    // 高检出力 = 字面量查询 + 全库搜——空结果 ≈ 可信排除。
    return { event: 'search-pod', tool: 'grep', queryClass: literal && !scoped ? 'high-pod' : 'low-pod', emptyResult: true }
  }

  if (tool.name === 'glob') {
    if (!content.includes('No files found matching pattern')) return null
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : ''
    const scoped = typeof input['path'] === 'string'
    // 简单文件名模式（无目录段或仅 **/ 前缀）+ 全库搜 = 高检出力。
    const simple = !pattern.replace(/^\*\*\//, '').includes('/')
    return { event: 'search-pod', tool: 'glob', queryClass: simple && !scoped ? 'high-pod' : 'low-pod', emptyResult: true }
  }

  if (tool.name === 'ast_grep') {
    // AST 模式对代码形状敏感（缩进/换行即可从匹配变不匹配）——空结果一律
    // 视为低检出力，不存在"可信排除"的 ast_grep 空结果。
    if (!/^0 match\(es\)/.test(content)) return null
    return { event: 'search-pod', tool: 'ast_grep', queryClass: 'low-pod', emptyResult: true }
  }

  // semantic_search 三级判据：
  //   绝对空 → embedding 召回有限，空结果 ≠ 全库无相关 → low-pod 记录；
  //   top score < 阈值 → 低质量结果，中等误排除风险 → low-pod 记录（带分数）；
  //   非空且高分 → 搜到了只是非目标，不记录。
  if (content.includes('No matches for:')) {
    return { event: 'search-pod', tool: 'semantic_search', queryClass: 'low-pod', emptyResult: true }
  }
  const scoreMatch = /\(score (\d+\.\d+)\)/.exec(content)
  if (scoreMatch) {
    const topScore = Number(scoreMatch[1])
    if (topScore < SEMANTIC_LOW_SCORE_THRESHOLD) {
      return { event: 'search-pod', tool: 'semantic_search', queryClass: 'low-pod', emptyResult: false, topScore }
    }
  }
  return null
}

export function createSearchPodHook(deps: SearchPodHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'search-pod',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const row = classifySearchPod(tool)
      if (!row) return
      deps.record({ ...row, turn: ctx.snapshot.turn })
    },
  }
}

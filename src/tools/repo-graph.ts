import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

interface RepoGraphInput {
  from_file: string
  max_tokens?: number
  mode?: 'graph' | 'impact'
}

const DEFINITION: ToolDefinition = {
  name: 'repo_graph',
  description: `查询代码图，找出与给定文件存在结构关联的文件和符号。

### 模式
- **graph**（默认）：按调用/导入距离排序，返回带导出符号的相关文件排名。
- **impact**：返回改动该文件的爆炸半径——哪些文件依赖它、需要跑哪些测试。

### 何时使用
- 读完文件后，查它依赖什么、什么依赖它
- 编辑前，评估改动的爆炸半径（用 mode: "impact"）
- 沿结构连接在陌生代码中导航
- 编辑后，确认需要跑哪些测试（用 mode: "impact"）

### 工作原理
图随你读/写文件增量构建。读过的文件越多，图越完整。`,
  input_schema: {
    type: 'object',
    properties: {
      from_file: { type: 'string', description: '要查关联代码的文件路径（相对项目根）' },
      max_tokens: { type: 'number', default: 2000, description: '响应的 token 预算（控制返回多少文件）' },
      mode: { type: 'string', enum: ['graph', 'impact'], default: 'graph', description: '查询模式："graph" 查相关文件，"impact" 做爆炸半径分析' },
    },
    required: ['from_file'],
  },
}

export function createRepoGraphTool(getIndexer: () => MeridianIndexer | null): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const indexer = getIndexer()
      if (!indexer) {
        return { content: 'Meridian graph not initialized. Read some files first to build the index.', isError: true }
      }

      const input = params.input as unknown as RepoGraphInput
      const mode = input.mode ?? 'graph'

      if (mode === 'impact') {
        return executeImpact(indexer, input.from_file)
      }

      const result = await indexer.query(input.from_file, { maxTokens: input.max_tokens ?? 2000 })

      if (result.entries.length === 0) {
        return { content: `No graph data for \`${input.from_file}\`. Read the file first to index it.` }
      }

      const lines: string[] = [
        `## Code Graph from \`${input.from_file}\``,
        `Index: ${result.graphSize} files, ${result.totalSymbols} symbols`,
        '',
      ]

      for (const entry of result.entries) {
        lines.push(`### ${entry.filePath} (score: ${entry.score.toFixed(2)})`)
        for (const sym of entry.symbols) {
          const prefix = sym.kind === 'function' ? 'ƒ' : sym.kind === 'class' ? '◆' : sym.kind === 'interface' || sym.kind === 'type' ? '◇' : '•'
          lines.push(`  ${prefix} ${sym.name} L${sym.line}`)
        }
        lines.push('')
      }

      const content = lines.join('\n')
      return { content: content.length > 15000 ? content.slice(0, 15000) + '\n...(truncated)' : content }
    },
    requiresApproval() { return false },
    isConcurrencySafe() { return true },
    isEnabled() { return true },
  }
}

function executeImpact(indexer: MeridianIndexer, filePath: string): ToolResult {
  const result = indexer.impact([filePath])

  if (result.totalImpact === 0 && result.tests.length === 0) {
    return { content: `No known dependents for \`${filePath}\`. The graph may need more files indexed.` }
  }

  const lines: string[] = [
    `## Impact Analysis: \`${filePath}\``,
    `Total impacted: ${result.totalImpact} files`,
    '',
  ]

  if (result.direct.length > 0) {
    lines.push(`### Direct dependents (${result.direct.length})`)
    for (const f of result.direct) lines.push(`- ${f}`)
    lines.push('')
  }

  if (result.transitive.length > 0) {
    lines.push(`### Transitive dependents (${result.transitive.length})`)
    for (const f of result.transitive.slice(0, 20)) lines.push(`- ${f}`)
    if (result.transitive.length > 20) lines.push(`- ...(${result.transitive.length - 20} more)`)
    lines.push('')
  }

  if (result.tests.length > 0) {
    lines.push(`### Tests to run (${result.tests.length})`)
    for (const f of result.tests) lines.push(`- ${f}`)
    lines.push('')
  }

  return { content: lines.join('\n') }
}

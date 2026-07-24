import type { Tool, ToolCallParams } from './types.js'
import { ensureSemanticIndex } from '../search/semantic-index.js'
import { createEmbeddingProvider } from '../search/embedding-provider.js'

/** 空结果标记——search-pod-hook 靠 includes 识别；改文案必须与 hook 同步。 */
export const SEMANTIC_SEARCH_NO_MATCHES_MARKER = '未找到匹配：'

export const SEMANTIC_SEARCH_TOOL: Tool = {
  definition: {
    name: 'semantic_search',
    description: `按语义搜索代码库。配置了 embedding provider 时，混合使用 BM25（词法）与 embedding 向量检索（RRF 融合）；离线时降级为纯 BM25。

当 grep/glob 无法按概念找到代码（如 "authentication middleware"、"session persistence"）时使用。
结果疑似过期时，用 /index 或设 rebuild: true 重建索引。`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或关键词查询' },
        limit: { type: 'integer', description: '最大结果数（默认 10）' },
        rebuild: { type: 'boolean', description: '搜索前强制重建索引' },
      },
      required: ['query'],
    },
  },

  async execute(params: ToolCallParams) {
    const query = String(params.input.query ?? '').trim()
    if (!query) {
      return { content: '错误：需要提供 query', isError: true }
    }

    const limit = Math.min(Number(params.input.limit) || 10, 25)
    const idx = ensureSemanticIndex(params.cwd, createEmbeddingProvider())

    const fmt = (hits: Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>) =>
      hits.map(h => `${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${h.text.slice(0, 300)}`)

    if (params.input.rebuild === true) {
      const stats = idx.rebuild()
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `索引已重建（${stats.indexed} 个文件）。${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}` }
      }
      return { content: `索引已重建（${stats.indexed} 个文件，${backend}）。前 ${hits.length} 条匹配：\n\n${fmt(hits).join('\n\n---\n\n')}` }
    }

    // Auto-incremental update when stale (lazy refresh)
    if (idx.isStale()) {
      const update = idx.incrementalUpdate()
      const note = update.fallbackRebuild
        ? `（全量重建：${update.reindexed} 个文件）`
        : `（${update.reindexed} 个已变更，${update.removed} 个已移除）`
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `索引已刷新${note}。${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}` }
      }
      return { content: `索引已刷新${note}（${backend}）。前 ${hits.length} 条匹配：\n\n${fmt(hits).join('\n\n---\n\n')}` }
    }

    const { hits, backend } = await idx.searchHybrid(query, limit)
    if (hits.length === 0) {
      return { content: `${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}\n可尝试 rebuild: true 或运行 /index` }
    }
    return { content: `前 ${hits.length} 条匹配（${backend}）：\n\n${fmt(hits).join('\n\n---\n\n')}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

import { stat, readFile } from 'node:fs/promises'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { ArtifactCorruptionError, MAX_RANGE_LINES } from '../artifact/store.js'
import { COMPACT_HISTORY_TOOL, buildRecallMarker } from '../compact/recall-marker.js'
import { computeModelReadCap } from './model-read-cap.js'
import { validatePath } from './path-validate.js'
import { getFileReadMtime } from './read-file.js'

/** Maximum raw artifact file size to read into memory (2MB).
 *  Larger files cause memory pressure and stall on repeated read_section
 *  attempts — the model should use grep or targeted bash commands instead. */
const MAX_RAW_BYTES = 2 * 1024 * 1024

/**
 * Hard floor on read_section output. Matches the legacy default before
 * window-aware sizing — small (<200K) windows still get this.
 *
 * Background: read_section was written when read_file capped at 8 K, so 8 K
 * here was symmetric. Now read_file scales to ~200 K on a 1 M window, but
 * read_section was still hardcoded to 8 K — so when prune redirected the
 * model to "use read_section to recover", it could only recover 8 K of a 60 K
 * file, leaving the model visibly stuck (model self-reported "results are
 * being truncated to 8030 chars max").
 *
 * read_section now uses the same window-aware budget as read_file/grep.
 */
const LEGACY_MAX_SECTION_CHARS = 8000

/**
 * Parse section ID like "L100-L200" or "100-200" into [start, end] line numbers.
 * Returns null if not a line-range format.
 */
function parseLineRange(sectionId: string): { start: number; end: number } | null {
  const match = sectionId.match(/^L?(\d+)-L?(\d+)$/i)
  if (!match) return null
  const start = parseInt(match[1]!, 10)
  const end = parseInt(match[2]!, 10)
  if (start < 1 || end < start) return null
  return { start, end }
}

/**
 * Parse character range like "c0-c5000" into [start, end] offsets.
 * Returns null if not a char-range format.
 */
function parseCharRange(range: string): { start: number; end: number } | null {
  const match = range.match(/^c(\d+)-c(\d+)$/i)
  if (!match) return null
  const start = parseInt(match[1]!, 10)
  const end = parseInt(match[2]!, 10)
  if (start < 0 || end < start) return null
  return { start, end }
}

/**
 * Extract a section from raw content by line range or char range.
 */
function extractSection(rawContent: string, sectionId: string): string {
  const lineRange = parseLineRange(sectionId)
  if (lineRange) {
    const lines = rawContent.split('\n')
    const startIdx = lineRange.start - 1
    const endIdx = Math.min(lineRange.end, lines.length)
    if (startIdx >= lines.length) {
      return `[区段 ${sectionId} 超出范围 — 文件共 ${lines.length} 行]`
    }
    return lines.slice(startIdx, endIdx).join('\n')
  }

  const charRange = parseCharRange(sectionId)
  if (charRange) {
    const start = Math.min(charRange.start, rawContent.length)
    const end = Math.min(charRange.end, rawContent.length)
    return rawContent.slice(start, end)
  }

  return `[无效的区段格式：${sectionId}。行范围用 "L100-L200"，字符范围用 "c0-c5000"]`
}

export const READ_SECTION_TOOL: Tool = {
  definition: {
    name: 'read_section',
    description: `从之前保存的 artifact 或磁盘上的活动文件中读取指定区段。

### 用法
- 用于加载消息历史中被摘要化的 artifact 输出的细节
- 或配合 file_path 恢复本会话早前读过的文件内容（例如 read-ref 引用之后）
- 需要 artifactId 或 file_path——至少提供一个
- 支持行范围（L100-L200）和字符范围（c0-c5000）

### 示例
好：read_section(artifactId="abc123", section="L1-L500")
好：read_section(artifactId="abc123", section="c0-c50000")
好：read_section(file_path="src/tools/bash.ts", section="L100-L200")`,
    input_schema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          description: '先前 tool_result 中的 artifact ID',
        },
        file_path: {
          type: 'string',
          description: '磁盘上活动文件的路径。用于 read-ref 引用之后恢复内容。路径会校验是否位于项目目录内。',
        },
        section: {
          type: 'string',
          description: '要读取的区段："L100-L200" 表示第 100-200 行，"c0-c5000" 表示字符范围',
        },
      },
      required: ['section'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const { artifactId, file_path, section } = params.input as {
      artifactId?: string
      file_path?: string
      section: string
    }

    if (!section) {
      return {
        content: '错误：需要提供 section',
        isError: true,
      }
    }

    const lineRange = parseLineRange(section)
    const charRange = parseCharRange(section)
    if (!lineRange && !charRange) {
      return {
        content: `错误：无效的区段格式：${section}。行范围用 "L100-L200"，字符范围用 "c0-c5000"。`,
        isError: true,
      }
    }

    // ── file_path branch: read from live file (B3) ──
    if (file_path && !artifactId) {
      try {
        const canonical = validatePath(params.cwd, file_path)

        // Staleness check: warn if file mtime differs from last read_file
        const lastMtime = getFileReadMtime(canonical, params.sessionId)
        let stalenessNote = ''
        if (lastMtime !== null) {
          try {
            const currentMtime = (await stat(canonical)).mtimeMs
            if (currentMtime !== lastMtime) {
              stalenessNote = `\n⚠ 文件自上次 read_file 后已变更（mtime 不匹配）。以下内容为当前磁盘版本，可能与上文不一致。\n`
            }
          } catch { /* file may not exist — handled below */ }
        }

        // Guard against multi-MB files
        let _rawSize = 0
        try { _rawSize = (await stat(canonical)).size } catch { /* handled below */ }
        if (_rawSize > MAX_RAW_BYTES) {
          return {
            content: `错误：文件 ${canonical} 过大（${(_rawSize / 1024 / 1024).toFixed(1)}MB > ${MAX_RAW_BYTES / 1024 / 1024}MB 上限）。请用 grep 或 bash 配合 head/tail 直接查看。`,
            isError: true,
          }
        }

        const rawContent = await readFile(canonical, 'utf-8')
        const sectionContent = extractSection(rawContent, section)

        const cap = computeModelReadCap({
          contextWindow: params.contextWindow,
          providerProfile: params.providerProfile,
        })
        const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)
        const truncated = sectionContent.length > maxChars
          ? sectionContent.slice(0, maxChars) + `\n... [已截断至 ${maxChars} 字符]`
          : sectionContent

        return {
          content: stalenessNote ? stalenessNote + truncated : truncated,
          rawPath: canonical,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: `错误：读取文件失败：${message}`,
          isError: true,
        }
      }
    }

    // ── artifactId branch: existing behavior ──
    if (!artifactId) {
      return {
        content: '错误：需要提供 artifactId 或 file_path',
        isError: true,
      }
    }

    const artifactStore = params.artifactStore
    if (!artifactStore) {
      return {
        content: '错误：当前会话未配置 artifactStore',
        isError: true,
      }
    }

    const artifact = artifactStore.get(artifactId)
    if (!artifact) {
      return {
        content: `错误：未找到 Artifact ${artifactId}——可能已被清理或从未创建。请用原始工具（bash/read_file/grep）重新生成输出。`,
        isError: true,
        errorKind: 'probe_miss',
      }
    }

    // Compact-history recall fast path: long-thread archives routinely exceed the
    // 2MB in-memory ceiling below, which would make their own catalog entries
    // un-recallable. For a line range, stream just the requested lines (no whole
    // file in memory, no 2MB gate). char ranges + normal artifacts fall through.
    if (artifact.tool === COMPACT_HISTORY_TOOL && lineRange) {
      try {
        const ranged = await artifactStore.readLineRange(artifactId, lineRange.start, lineRange.end)
        if (ranged === null) {
          return {
            content: `错误：未找到 Artifact ${artifactId}。`,
            isError: true,
            errorKind: 'probe_miss',
          }
        }
        if (ranged.content.length === 0 && lineRange.start > ranged.totalLines) {
          return {
            content: `[区段 ${section} 超出范围 — artifact 共 ${ranged.totalLines} 行]`,
            isError: false,
          }
        }
        const cap = computeModelReadCap({
          contextWindow: params.contextWindow,
          providerProfile: params.providerProfile,
        })
        const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)
        let body = ranged.content.length > maxChars
          ? ranged.content.slice(0, maxChars) + `\n... [已截断至 ${maxChars} 字符]`
          : ranged.content
        if (ranged.capped) {
          body += `\n... [范围已限制为 ${MAX_RANGE_LINES} 行 — 请缩小范围分页读取]`
        }
        return {
          content: `${buildRecallMarker(artifactId, section)}\n${body}`,
          rawPath: artifact.rawPath,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: `错误：读取 artifact ${artifactId} 失败：${message}`,
          isError: true,
        }
      }
    }

    try {
      // Guard against reading multi-MB raw files into memory.
      let _rawSize = 0
      try { _rawSize = (await stat(artifact.rawPath)).size } catch { /* file may not exist */ }
      if (_rawSize > MAX_RAW_BYTES) {
        return {
          content: `错误：Artifact ${artifactId} 原始文件过大（${(_rawSize / 1024 / 1024).toFixed(1)}MB > 2MB 上限）。请对原始输出用 grep，或用 bash 配合 head/tail 直接查看。`,
          isError: true,
        }
      }

      const rawContent = await artifactStore.readRaw(artifactId)
      if (rawContent === null) {
        return {
          content: `错误：Artifact ${artifactId} 的原始文件在磁盘上缺失（${artifact.rawPath}）。可能已被清理。请用原始工具重新生成输出。`,
          isError: true,
          errorKind: 'probe_miss',
        }
      }
      const sectionContent = extractSection(rawContent, section)

      // Window-aware cap: 1M window allows ~200K, 64K window stays at 8K.
      // Without this, prune-then-recover paths gave the model only 8K back —
      // see LEGACY_MAX_SECTION_CHARS comment.
      const cap = computeModelReadCap({
        contextWindow: params.contextWindow,
        providerProfile: params.providerProfile,
      })
      const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)

      const truncated = sectionContent.length > maxChars
        ? sectionContent.slice(0, maxChars) + `\n... [已截断至 ${maxChars} 字符]`
        : sectionContent

      // Tag recalls of compacted-history blocks so the NEXT compaction can
      // collapse this recalled content back to a pointer (recall-eviction)
      // instead of re-archiving it verbatim and accumulating storage.
      const content = artifact.tool === COMPACT_HISTORY_TOOL
        ? `${buildRecallMarker(artifactId, section)}\n${truncated}`
        : truncated

      return {
        content,
        rawPath: artifact.rawPath,
      }
    } catch (err) {
      if (err instanceof ArtifactCorruptionError) {
        return {
          content: `错误：Artifact ${artifactId} 磁盘数据已损坏（SHA-256 不匹配）。请重新读取源内容。`,
          isError: true,
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: `错误：读取 artifact ${artifactId} 失败：${message}`,
        isError: true,
      }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

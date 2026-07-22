import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { LspManager } from './manager.js'

function resolveParams(input: Record<string, unknown>): { filePath: string; line: number; column: number } | string {
  const filePath = input.file_path as string | undefined
  if (!filePath || typeof filePath !== 'string') return 'Missing required parameter: file_path'
  const line = input.line as number | undefined
  if (typeof line !== 'number' || line < 1) return 'Missing or invalid parameter: line (must be >= 1)'
  const column = input.column as number | undefined
  if (typeof column !== 'number' || column < 0) return 'Missing or invalid parameter: column (must be >= 0)'
  return { filePath, line, column }
}

export function createGotoDefinitionTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_goto_definition',
      description:
        '跳转到给定文件位置符号的定义。返回定义的文件路径、行号和列号。用于理解函数、类、变量或类型的定义位置。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '包含该符号的源文件路径' },
          line: { type: 'number', description: '符号所在行号（从 1 开始）' },
          column: { type: 'number', description: '符号所在列号（从 0 开始）' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.gotoDefinition(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No definition found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} definition(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsDefinition()
    },
  }
}

export function createFindReferencesTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_find_references',
      description:
        '查找给定文件位置符号的所有引用。返回符号被使用的文件路径、行号和列号列表。用于理解修改函数、类或变量的影响范围。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '包含该符号的源文件路径' },
          line: { type: 'number', description: '符号所在行号（从 1 开始）' },
          column: { type: 'number', description: '符号所在列号（从 0 开始）' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.findReferences(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No references found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} reference(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsReferences()
    },
  }
}

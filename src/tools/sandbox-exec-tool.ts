import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { sandboxExec } from './sandbox-exec.js'

const SANDBOX_EXEC_DEFINITION = {
  name: 'sandbox_exec',
  description: [
    '在隔离的 Node.js 子进程中执行 JavaScript 代码。',
    '适用于只需要最终结果、不需要中间输出的数据处理。',
    '示例：解析 JSON 文件并提取单个字段、计算聚合统计、转换列表。',
    '环境变量已剥离（无法访问密钥）；cwd 为项目根目录。',
    '输出默认截断到 8000 字符。超时默认 3 秒。',
    '禁止用于：文件编辑（用 edit_file）、shell 命令（用 bash）、长耗时任务。',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string' as const,
        description: '要执行的 JavaScript 代码。用 console.log 把结果返回到上下文。',
      },
      timeout_ms: {
        type: 'number' as const,
        description: '可选超时时间（毫秒）。默认 3000。',
      },
      max_output_chars: {
        type: 'number' as const,
        description: '可选输出截断上限。默认 8000。',
      },
    },
    required: ['code'],
  },
}

export const SANDBOX_EXEC_TOOL: Tool = {
  definition: SANDBOX_EXEC_DEFINITION,
  async execute(params: ToolCallParams): Promise<ToolResult> {
    const code = String(params.input.code ?? '')
    if (!code.trim()) {
      return {
        content: '[sandbox_exec] 错误：代码为空',
        isError: true,
      }
    }
    const timeoutMs = typeof params.input.timeout_ms === 'number' ? params.input.timeout_ms : 3000
    const maxOutputChars = typeof params.input.max_output_chars === 'number' ? params.input.max_output_chars : 8000

    const result = await sandboxExec(code, {
      timeoutMs,
      maxOutputChars,
      cwd: params.cwd,
    })

    const isError = result.exitCode !== 0
    const header = `[sandbox_exec] 退出码=${result.exitCode}`
    const body = isError
      ? `${header}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : `${header}\n${result.stdout}`

    return { content: body, isError }
  },
  requiresApproval(): boolean { return true },
  isConcurrencySafe(): boolean { return true },
  isEnabled(): boolean { return true },
}

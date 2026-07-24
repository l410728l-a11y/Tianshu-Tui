import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type DocumentFormat = 'txt' | 'md' | 'html' | 'doc'

export interface CreateDocumentInput {
  destination_path?: string
  title?: string
  content?: string
  format?: DocumentFormat
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inferDocumentFormat(destinationPath: string, explicit?: DocumentFormat): DocumentFormat {
  if (explicit) return explicit
  const ext = extname(destinationPath).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.doc') return 'doc'
  return 'txt'
}

function renderPlainText(title: string | undefined, content: string): string {
  return title ? `${title}\n\n${content}` : content
}

function renderMarkdown(title: string | undefined, content: string): string {
  if (!title) return content
  if (content.trimStart().startsWith('#')) return content
  return `# ${title}\n\n${content}`
}

function renderHtmlDocument(title: string | undefined, content: string): string {
  const safeTitle = escapeHtml(title ?? 'Document')
  const body = content
    .split(/\r?\n/)
    .map(line => line.trim().length === 0 ? '<p>&nbsp;</p>' : `<p>${escapeHtml(line)}</p>`)
    .join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.6; margin: 40px; }
h1 { color: #0f172a; }
p { margin: 0 0 0.75em; }
</style>
</head>
<body>
${title ? `<h1>${safeTitle}</h1>\n` : ''}${body}
</body>
</html>
`
}

export function renderDocument(input: CreateDocumentInput): { content: string; format: DocumentFormat } {
  const destinationPath = input.destination_path ?? ''
  const format = inferDocumentFormat(destinationPath, input.format)
  const content = input.content ?? ''
  switch (format) {
    case 'txt': return { format, content: renderPlainText(input.title, content) }
    case 'md': return { format, content: renderMarkdown(input.title, content) }
    case 'html': return { format, content: renderHtmlDocument(input.title, content) }
    case 'doc': return { format, content: renderHtmlDocument(input.title, content) }
  }
}

export async function createDocument(input: CreateDocumentInput): Promise<{ path: string; bytes: number; format: DocumentFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path 为必填项')
  }
  if (typeof input.content !== 'string') throw new Error('content 为必填项')
  const rendered = renderDocument(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_DOCUMENT_TOOL: Tool = {
  definition: {
    name: 'create_document',
    description: `在外部或项目路径创建基础用户文档。

初版范围：纯文本、Markdown、HTML，以及 Word 可打开的 .doc（以 .doc 扩展名保存的 HTML 文档）。用 export_file/open_path 处理原始二进制资产或打开结果。

示例：
Good: create_document(destination_path="~/Desktop/report.doc", title="报告", content="摘要...")
Good: create_document(destination_path="H:\\zhuomian\\白嫖gpt\\notes.md", content="# 笔记\\n...")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: '目标文件路径。可在项目之外。' },
        title: { type: 'string', description: '可选文档标题。' },
        content: { type: 'string', description: '文档正文。' },
        format: { type: 'string', enum: ['txt', 'md', 'html', 'doc'], description: '可选输出格式。默认由文件扩展名推断。' },
      },
      required: ['destination_path', 'content'],
    },
  },

  async execute(params) {
    try {
      const result = await createDocument(params.input as CreateDocumentInput)
      return { content: `已创建 ${result.format} 文档（${result.bytes} 字节）：${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `错误：${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type PdfFormat = 'html'

export type PageSize = 'A4' | 'Letter'

export interface CreatePdfInput {
  destination_path?: string
  content?: string
  title?: string
  orientation?: 'portrait' | 'landscape'
  pageSize?: PageSize
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PAGE_SIZE_CSS: Record<PageSize, string> = {
  A4: '210mm 297mm',
  Letter: '8.5in 11in',
}

function renderPdfHtml(input: CreatePdfInput): string {
  const title = input.title ?? 'Document'
  const content = input.content ?? ''
  const orientation = input.orientation ?? 'portrait'
  const pageSize = input.pageSize ?? 'A4'
  const pageSizeValue = PAGE_SIZE_CSS[pageSize]

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }

@page {
  size: ${pageSizeValue} ${orientation};
  margin: 20mm 18mm;
}

body {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  font-size: 12pt;
  line-height: 1.7;
  color: #1e293b;
  max-width: ${orientation === 'landscape' ? '240mm' : '170mm'};
  margin: 0 auto;
  padding: 20mm 0;
}

h1 { font-size: 1.75rem; margin: 0 0 0.5em; color: #0f172a; page-break-after: avoid; }
h2 { font-size: 1.35rem; margin: 1.2em 0 0.4em; color: #334155; page-break-after: avoid; }
h3 { font-size: 1.15rem; margin: 1em 0 0.3em; color: #475569; page-break-after: avoid; }
p { margin: 0 0 0.75em; orphans:3; widows:3; }
ul, ol { margin: 0 0 0.75em; padding-left: 1.5em; }
li { margin-bottom: 0.25em; }
pre {
  background: #f1f5f9; border:1px solid #e2e8f0; border-radius:6px;
  padding:12px 16px; font-size:0.85rem; overflow-x:auto;
  page-break-inside:avoid;
}
code { font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace; font-size:0.9em; }
table { border-collapse:collapse; width:100%; margin:0.75em 0; }
th, td { border:1px solid #cbd5e1; padding:6px 10px; text-align:left; }
th { background:#f8fafc; font-weight:600; }
.page-break { page-break-after:always; break-after:page; }

@media print {
  body { padding:0; margin:0; }
}
</style>
</head>
<body>
${content}
</body>
</html>
`
}

export function renderPdf(input: CreatePdfInput): { content: string; format: PdfFormat } {
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new Error('content 为必填项')
  }
  return { format: 'html', content: renderPdfHtml(input) }
}

export async function createPdf(input: CreatePdfInput): Promise<{ path: string; bytes: number; format: PdfFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path 为必填项')
  }
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new Error('content 为必填项')
  }
  const rendered = renderPdf(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_PDF_TOOL: Tool = {
  definition: {
    name: 'create_pdf',
    description: `创建打印就绪的 HTML 文档，含专业排版和 @page 规则。在任何浏览器中打开并打印为 PDF（Ctrl+P / Cmd+P → 另存为 PDF）。

支持 A4 和 Letter 纸张大小、纵向和横向。内容为原始 HTML——使用标准 HTML 标签组织结构。

用 open_path 在默认浏览器中打开结果，然后打印为 PDF。

示例：
Good: create_pdf(destination_path="~/Desktop/report.html", title="Q4 报告", content="<h1>Q4 报告</h1><p>营收增长 15%...</p>")
Good: create_pdf(destination_path="~/Desktop/invoice.html", title="发票 #42", content="<table>...</table>", pageSize="Letter")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: '目标文件路径。应以 .html 结尾。可在项目之外。在浏览器中打开后打印为 PDF。' },
        title: { type: 'string', description: '文档标题（显示在浏览器标题栏）。' },
        content: { type: 'string', description: 'HTML 正文内容。使用标准 HTML 标签（h1-h3、p、ul、ol、table、pre、code、div.page-break）。' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: '页面方向。默认：portrait。' },
        pageSize: { type: 'string', enum: ['A4', 'Letter'], description: '@page CSS 的纸张大小。默认：A4。' },
      },
      required: ['destination_path', 'content'],
    },
  },

  async execute(params) {
    try {
      const result = await createPdf(params.input as CreatePdfInput)
      return { content: `已创建可打印的 ${result.format} 文档（${result.bytes} 字节）：${result.path}\n\n在浏览器中打开并打印为 PDF（Cmd+P → 存储为 PDF）。` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `错误：${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

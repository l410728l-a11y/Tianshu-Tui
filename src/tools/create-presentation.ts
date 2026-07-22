import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type PresentationFormat = 'ppt'

export interface PresentationSlide {
  title?: string
  content?: string
}

export interface CreatePresentationInput {
  destination_path?: string
  title?: string
  slides?: PresentationSlide[]
  theme?: 'light' | 'dark'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderSlideHtml(slide: PresentationSlide, index: number, theme: 'light' | 'dark'): string {
  const bg = theme === 'dark' ? '#0f172a' : '#f8fafc'
  const fg = theme === 'dark' ? '#e2e8f0' : '#1e293b'
  const accent = theme === 'dark' ? '#38bdf8' : '#2563eb'
  const mutedFg = theme === 'dark' ? '#94a3b8' : '#64748b'

  const titleHtml = slide.title
    ? `<h1 style="font-size:2.25rem;margin:0 0 0.5em;color:${accent};font-weight:700">${escapeHtml(slide.title)}</h1>`
    : ''

  const contentHtml = slide.content
    ? `<div style="font-size:1.25rem;line-height:1.8;color:${fg}">${escapeHtml(slide.content)
        .split(/\r?\n\r?\n/)
        .map(p => p.trim().length === 0 ? '' : `<p style="margin:0 0 1em">${p.replace(/\r?\n/g, '<br>')}</p>`)
        .join('\n')}</div>`
    : ''

  const pageNum = `<div style="position:absolute;bottom:24px;right:40px;font-size:0.875rem;color:${mutedFg}">${index + 1}</div>`

  return `<section style="
  position:relative;
  width:100vw;max-width:960px;min-height:100vh;
  display:flex;flex-direction:column;justify-content:center;
  padding:60px 80px;box-sizing:border-box;
  background:${bg};color:${fg};
  page-break-after:always;
  break-after:page;
">
${titleHtml}
${contentHtml}
${pageNum}
</section>`
}

function renderPresentationHtml(input: CreatePresentationInput): string {
  const title = input.title ?? 'Presentation'
  const theme = input.theme ?? 'light'
  const slides = input.slides ?? []
  const bg = theme === 'dark' ? '#0f172a' : '#f8fafc'
  const fg = theme === 'dark' ? '#e2e8f0' : '#1e293b'

  const slidesHtml = slides.map((s, i) => renderSlideHtml(s, i, theme)).join('\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  background:${bg}; color:${fg};
  display:flex; flex-direction:column; align-items:center;
}
@media print {
  body { background:white; }
  section { page-break-after:always; break-after:page; }
}
</style>
</head>
<body>
${slidesHtml}
</body>
</html>
`
}

export function renderPresentation(input: CreatePresentationInput): { content: string; format: PresentationFormat } {
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    throw new Error('slides must be a non-empty array')
  }
  return { format: 'ppt', content: renderPresentationHtml(input) }
}

export async function createPresentation(input: CreatePresentationInput): Promise<{ path: string; bytes: number; format: PresentationFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  const rendered = renderPresentation(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_PRESENTATION_TOOL: Tool = {
  definition: {
    name: 'create_presentation',
    description: `创建演示文稿（幻灯片），以 .ppt 扩展名保存的 HTML 文件。可在任何浏览器中打开。

每张幻灯片是一个全屏区域，含标题和内容。用于演示、幻灯片组和可视化摘要。

用 open_path 在默认浏览器中打开结果。

示例：
Good: create_presentation(destination_path="~/Desktop/deck.ppt", title="Q4 回顾", slides=[{title:"概览", content:"关键结果..."}, {title:"下一步", content:"1. 发布\\n2. 迭代"}])
Good: create_presentation(destination_path="~/Desktop/dark-deck.ppt", title="路演", slides=[{title:"问题", content:"..."}], theme="dark")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: '目标文件路径。应以 .ppt 或 .html 结尾。可在项目之外。' },
        title: { type: 'string', description: '可选演示文稿标题（显示在浏览器标题栏和 HTML title 中）。' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '幻灯片标题。' },
              content: { type: 'string', description: '幻灯片正文。用 \\n 换行，双 \\n\\n 分段。' },
            },
          },
          description: '按顺序排列的幻灯片。每张有标题和内容。',
        },
        theme: { type: 'string', enum: ['light', 'dark'], description: '颜色主题。默认：light。' },
      },
      required: ['destination_path', 'slides'],
    },
  },

  async execute(params) {
    try {
      const result = await createPresentation(params.input as CreatePresentationInput)
      return { content: `Created ${result.format} presentation with slides (${result.bytes} bytes): ${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

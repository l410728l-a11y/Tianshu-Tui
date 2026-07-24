import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type ImageFormat = 'svg'

export interface CreateImageInput {
  destination_path?: string
  svg?: string
  width?: number
  height?: number
}

function inferImageFormat(destinationPath: string): ImageFormat {
  const ext = extname(destinationPath).toLowerCase()
  if (ext === '.svg') return 'svg'
  return 'svg'
}

function extractSvgInner(raw: string): string {
  const stripped = raw.trim()
  // If already a full <svg>...</svg> document, return as-is
  if (/^<svg\b/i.test(stripped)) return stripped
  // If wrapped in markdown code fence, strip it
  const fenceMatch = stripped.match(/```(?:svg)?\r?\n([\s\S]*?)\r?\n```/)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  return stripped
}

function wrapSvg(inner: string, width?: number, height?: number): string {
  let attrs = 'xmlns="http://www.w3.org/2000/svg"'
  if (width !== undefined) attrs += ` width="${width}"`
  if (height !== undefined) attrs += ` height="${height}"`
  if (width !== undefined && height !== undefined) {
    attrs += ` viewBox="0 0 ${width} ${height}"`
  }
  return `<svg ${attrs}>\n${inner}\n</svg>\n`
}

export function renderImage(input: CreateImageInput): { content: string; format: ImageFormat } {
  const raw = input.svg ?? ''
  if (raw.trim().length === 0) throw new Error('svg 内容为必填项')
  const inner = extractSvgInner(raw)
  const svg = /^<svg\b/i.test(inner) ? inner + '\n' : wrapSvg(inner, input.width, input.height)
  return { format: 'svg', content: svg }
}

export async function createImage(input: CreateImageInput): Promise<{ path: string; bytes: number; format: ImageFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path 为必填项')
  }
  if (typeof input.svg !== 'string' || input.svg.trim().length === 0) {
    throw new Error('svg 为必填项')
  }
  const rendered = renderImage(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_IMAGE_TOOL: Tool = {
  definition: {
    name: 'create_image',
    description: `从 SVG 标记创建 SVG 图片文件。

SVG 内容可以是完整 <svg>...</svg> 文档、原始 SVG 内部元素，或 markdown 代码块。用于 logo、图表、示意图、插画等各种矢量图形。

用 open_path 在 OS 默认查看器中打开生成的图片。

示例：
Good: create_image(destination_path="~/Desktop/logo.svg", svg="<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\"><circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" fill=\\"#38bdf8\\"/></svg>")
Good: create_image(destination_path="~/Desktop/chart.svg", svg="<rect x=\\"10\\" y=\\"20\\" width=\\"30\\" height=\\"40\\" fill=\\"#818cf8\\"/>", width=200, height=120)`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: '目标文件路径。应以 .svg 结尾。可在项目之外。' },
        svg: { type: 'string', description: 'SVG 标记——完整 <svg> 文档、内部 SVG 元素，或 markdown 代码块均可。' },
        width: { type: 'number', description: '可选的 SVG 元素 width 属性。' },
        height: { type: 'number', description: '可选的 SVG 元素 height 属性。' },
      },
      required: ['destination_path', 'svg'],
    },
  },

  async execute(params) {
    try {
      const result = await createImage(params.input as CreateImageInput)
      return { content: `已创建 ${result.format} 图片（${result.bytes} 字节）：${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `错误：${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

import type { Tool, ToolCallParams } from '../types.js'
import { fetchCauseDetail } from '../../api/error-classifier.js'
import { httpFetchGuarded, type HttpFetchDeps, type HttpFetchOptions } from '../net/http-fetch.js'
import { SSRFError } from '../net/ssrf.js'
import { decodeBody, extractMainContent, htmlToMarkdown } from './extract.js'
import { fetchViaJina, isJinaQualityHeuristic } from './jina-fetch.js'

export interface FetchDeps extends HttpFetchDeps {}
export interface WebFetchOptions extends HttpFetchOptions {
  extractMainContent?: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10_485_760
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = 'Tianshu/1.0 (terminal coding agent)'
const DEFAULT_EXTRACT_MAIN = true

const BINARY_CONTENT_TYPE_PREFIXES = [
  'image/',
  'application/pdf',
  'application/octet-stream',
  'video/',
  'audio/',
  'font/',
]

/** HTTP 状态码会留在文案里并命中 classifyFailure 的 api_error 正则——结构字段先行。 */
function httpApiErrorKind(status: number): 'api_error' | undefined {
  if (status === 429 || status === 500 || status === 502 || status === 503) return 'api_error'
  return undefined
}

// No explicit `fetch` here: leaving it undefined lets httpFetchGuarded use the
// real (undici) global fetch AND engage connection pinning against DNS
// rebinding. `lookup` also defaults inside httpFetchGuarded to node:dns.
const defaultDeps: FetchDeps = {}

export function createWebFetchTool(deps: FetchDeps = defaultDeps, opts: WebFetchOptions = {}): Tool {
  const options = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
  }
  const extractMainContentEnabled = opts.extractMainContent ?? DEFAULT_EXTRACT_MAIN

  return {
    definition: {
      name: 'web_fetch',
      description: `抓取 URL 内容并以文本返回。适合阅读文档、API 参考或 issue 页面。
		返回转换为纯文本的页面内容（已剥离 HTML 标签）。内容截断至约 50K 字符。
		因发起网络请求，需要用户审批。`,
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的 URL',
          },
        },
        required: ['url'],
      },
    },

    async execute(params: ToolCallParams) {
      const rawUrl = params.input.url as string

      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return { content: `无效 URL：${rawUrl}`, isError: true }
      }

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `不支持的协议：${url.protocol}。仅允许 http 和 https。`, isError: true }
      }

      try {
        const { status, contentType, bytes } = await httpFetchGuarded(rawUrl, deps, options)

        if (status >= 400) {
          const errorKind = httpApiErrorKind(status)
          return {
            content: `HTTP ${status}：${rawUrl}`,
            isError: true,
            ...(errorKind ? { errorKind } : {}),
          }
        }

        const contentTypeLower = contentType.toLowerCase()
        if (BINARY_CONTENT_TYPE_PREFIXES.some(prefix => contentTypeLower.includes(prefix))) {
          return {
            content: `二进制内容（${contentType}）不会以文本返回。请使用 import_resource 下载此 URL。`,
            isError: true,
          }
        }

        const body = decodeBody(bytes, contentType)

        let content: string
        let via: string = ''
        if (contentTypeLower.includes('text/html')) {
          const html = extractMainContentEnabled ? extractMainContent(body) : body
          content = await htmlToMarkdown(html)
          // Quality heuristic: if local extraction looks bad (short, JS-only page),
          // fall back to Jina Reader which server-renders + strips noise.
          if (isJinaQualityHeuristic(content)) {
            const jinaResult = await fetchViaJina(rawUrl, deps, options)
            if (jinaResult) {
              content = jinaResult.markdown
              via = '（经 Jina Reader）'
            }
          }
        } else {
          content = body
        }

        return { content: `URL：${rawUrl}\n状态：${status}\n内容长度：${bytes.length}${via}\n\n${content}` }
      } catch (err) {
        if (err instanceof SSRFError) {
          return { content: err.message, isError: true }
        }
        const message = err instanceof Error ? err.message : String(err)
        const detail = fetchCauseDetail(err)
        const full = detail ? `${message}: ${detail}` : message
        // 外部错误文本可能仍含 timeout/ECONNRESET 等英文模式——中文前缀+变量，可不打标。
        return { content: `抓取失败 ${rawUrl}：${full}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const WEB_FETCH_TOOL: Tool = createWebFetchTool()

/**
 * assistant 消息 Markdown 渲染：marked 解析 + highlight.js 代码高亮 + DOMPurify 消毒。
 *
 * 流式期间上层保持纯文本，消息完成后才走这里（避免逐帧重排）；因此本模块
 * 只需处理完整 markdown 文档，无需增量解析。
 */
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value
      return `<pre class="hljs"><code>${highlighted}</code></pre>`
    },
  },
})

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false })
  return DOMPurify.sanitize(raw, {
    // webview CSP 已禁外源脚本，这里再收一道：剥掉一切可执行面
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload'],
  })
}

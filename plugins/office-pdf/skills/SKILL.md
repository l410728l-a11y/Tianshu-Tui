---
name: office-pdf
description: 生成与读取 PDF 文档（报告、合同、交付文档）——原生 pdfkit 渲染，自动解析系统 CJK 字体支持中文，支持 heading/paragraph/table/code/list 内容块与页码页脚
triggers: [pdf, PDF, 报告, 合同, 文档, 导出, 交付, report, contract, document, 白皮书]
---

# Office PDF（PDF 生成与读取）

参考 anthropics/skills（Apache 2.0）提炼，适配天枢 `office-pdf` 插件。

## 何时使用

- 需要交付**正式文档**：报告、合同、方案书、白皮书、发票式单据
- 用户明确要求 PDF 格式导出
- 只需快速读内容时用 `pdf_read` 抽取现有 PDF 文本进上下文

不需要 PDF 时别用——纯 Markdown 交付更轻。

## CJK 字体行为（重要）

- 内容含中文/日文/韩文字符时，插件**自动按平台候选列表解析系统字体**（macOS PingFang/Hiragino、Windows 雅黑/黑体/宋体、Linux Noto Sans CJK/文泉驿）
- 找不到任何候选字体时会**显式警告**（"未找到 CJK 字体"），不会静默产出乱码——看到警告要告知用户，并建议安装 Noto Sans CJK 或改用英文交付
- 代码块始终用 Courier（等宽），CJK 字体只作用于正文/标题/表格/列表

## 内容块速查

| 块 | 字段 | 说明 |
|----|------|------|
| `heading` / `h1` | `text` | 16pt 章节标题 |
| `h2` / `h3` | `text` | 14/12pt 子标题 |
| `paragraph` / `text` | `text` | 10pt 正文，两端对齐 |
| `table` | `headers`, `rows` | 带边框表格，均分列宽 |
| `code` | `text` | Courier 8pt 代码块 |
| `list` | `items`, `ordered?` | `•` 或 `1.` 编号，悬挂缩进 |

其他参数：`title`（文档标题）、`page_numbers: true`（页脚居中页码，中文内容自动用"第 X 页 / 共 Y 页"，否则 "Page X of Y"）。

## 生成纪律

1. **大文档先列大纲**：超过 3 个章节时，先把 heading 结构列给用户确认，再一次生成——避免反复重写整个 content 数组
2. **结构化优先**：能用 table 呈现的数据不写成段落；能用 list 的不写成流水句
3. **生成后自查**：用 `pdf_read` 读回产出，确认中文渲染正常、章节完整、无占位符残留（lorem / xxxx / TODO）
4. **页码是加分项**：正式交付文档默认带 `page_numbers: true`

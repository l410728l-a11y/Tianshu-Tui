---
name: office-ppt
description: PowerPoint 演示文稿生成纪律 — 用 pptx_create/pptx_read 产出有设计感、零 AI 味的 .pptx（PPT、幻灯片、deck、演讲稿、汇报）
triggers: [ppt, pptx, 幻灯片, 演示文稿, deck, slides, 演讲, presentation, 汇报, 课件]
---

# Office PPT（演示文稿生成）

设计纪律改编自 anthropics/skills 的 pptx skill（Apache 2.0），适配本插件的 `pptx_create` / `pptx_read` 工具。

## 设计纪律

### 1. 配色主导原则

- 一个主色占 60–70% 视觉面积，1–2 个辅助色，再加一个锐利的点缀色（accent）——不要平均分配。
- 不要默认蓝。先想主题气质（暖橙？墨绿？单色灰？），蓝是最后的选择。
- 用 `theme` 参数统一注入：`{ titleColor, textColor, bgColor, accentColor, fontFace }`，全 deck 一致。

### 2. 每页必须有视觉元素

图（image slide）、图表（chart slide）、图标、色块——至少其一。**拒绝纯 title + bullets 的页面**，那是 AI 味的直接来源。

### 3. 布局要变化

- 交替使用 two-column、table、chart、大数字 callout、对比栏，不要连续三页同一布局。
- body 一律左对齐；只有标题可以居中（且仅 title/section 页）。

### 4. 字号对比

- 标题 36–44pt bold（本工具默认标题 36–40pt）。
- 正文 14–16pt。
- 说明/来源/脚注 10–12pt，用 muted 色（accentColor）。

### 5. 标题下绝不加装饰线

标题下方画一条装饰横线是 AI 生成 deck 的头号标志。用留白或底色区块来分隔层级，不用线。

### 6. 低对比是大忌

浅底浅字、深底深字都禁止。正文与背景的对比度必须清晰可读——拿不准就用深字浅底。

### 7. 交付前自查（必做）

生成后必须用 `pptx_read` 读回自查：

- 内容完整性：每页标题/正文是否齐全，页数是否符合预期。
- 占位符残留：搜索 lorem、xxxx、TBD、TODO、「待补充」——发现一个修一个。

口头说「内容应该没问题」不算交付。

## 工具速查

| 工具 | 何时用 |
|------|--------|
| `pptx_create` | 从 slide 定义生成 .pptx；slide type: `title` / `section` / `content` / `two-column` / `image` / `table` / `chart`；每个 slide 可带 `notes` 写演讲备注 |
| `pptx_read` | 读回 .pptx 文本（`include_notes: true` 连备注一起读），用于自查与改写现有 deck |

## 其他经验

- 演讲备注（notes）写给讲者看的提示，不要把幻灯片正文复制一遍。
- chart slide 数据结构：`{ type: 'chart', chart: 'bar'|'line'|'pie', data: [{ name, labels: [...], values: [...] }] }`；饼图只传一个 series。
- 大 deck 先列大纲（每页一句话标题 + 视觉元素类型）再生成，避免中途返工。

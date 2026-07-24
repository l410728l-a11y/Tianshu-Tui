# VS Code / Cursor 插件端 P0–P4 迭代记录（2026-07-17 ~ 2026-07-23）

> 产品功能视角的阶段复盘。打包/发布/部署的操作资产见
> [`docs/VSCODE-EXTENSION-RELEASE.md`](../VSCODE-EXTENSION-RELEASE.md)。
> 代码位置：`vscode-extension/`（Apache 2.0 开源侧，随 sync 进公开仓）。

## 产品定位

把天枢内核（`rivet serve` sidecar）以原生体验嵌进 VS Code / Cursor：
插件内**不实现任何 agent 逻辑**，一切智能在 sidecar；插件只做生命周期管理、
座舱 UI、编辑器融合。与 CLI / 桌面端共用同一内核与 `~/.rivet` 数据，会话互通。

## 阶段演进

### P0 — 骨架首刀（`ecc5dcfa`）

- sidecar 启动器：spawn `rivet serve` + token 鉴权 + 健康检查
- REST + SSE 客户端：断线按 lastSeq 自动重连（`/stream?since=N` 尾部重放）
- Webview 座舱：会话列表/创建、流式对话、工具卡、审批卡（webview 不直连
  sidecar，一切经 extension host 桥——规避 CSP/CORS，token 不进 webview）

### P1 — 编辑器融合（`7e4231ed`）

- 变更审查视图：相对任务基线的工作树 diff（`/git/working-tree` + `file-base`），
  点击开原生双栏 diff
- 回滚到 checkpoint（预览 + confirmationToken 二段式）
- `@file` 提及（server 侧 gitignore 过滤 + 相关度排序）、拖拽文件、
  编辑器右键「发送到天枢」、行内编辑（Ctrl+Shift+K）
- 模型/星域选择器、todo 面板、ask_user_question 结构化提问卡

### P2 — 客户端工具委托 E4（`ed47ab9d` + 审查修复 `3f984e7e`）

内核把工具「落地」委托给客户端，agent 编辑呈现为原生体验：

- `apply_edit`：WorkspaceEdit 落盘 + diff 装饰 + CodeLens 接受/拒绝
- `terminal_exec`：可见终端执行（Shell Integration 抓 exitCode/输出）
- fail-back：客户端失败/超时回退内核本地执行，agent 不卡死
- 协议协商：`X-Tianshu-Protocol: 1` 头；能力注册绑 SSE clientId，断流自动清除

### P3 — 生态收尾（`e2d2c88f` + 审查修复 `5ca97011`，v0.2.0）

- 上架资格：icon / README（市场文案）/ CHANGELOG / LICENSE / galleryBanner
- 双市场 CI：`.github/workflows/vscode-extension.yml`（build + smoke +
  release 触发四平台 runtime bundle + vsce/ovsx publish）
- SCM 融合：`rivet -p` 无头模式生成提交语，填入 SCM 输入框
- 状态栏：sidecar 状态 / 会话运行 / 待批数（bell 高亮）
- **自包含运行时（E2 ②级自举）**：无 CLI 机器上自动下载
  `tianshu-runtime-<ver>-<platform>-<arch>.tar.gz`（含独立 Node），
  sha256 校验 + 多端点（CF Worker 镜像 → GitHub Release）

### P4 — 首发体验冲刺（`535521f0`，v0.3.0）

- **RUNTIME_VERSION 对齐**（发版硬阻塞）：esbuild 注入改读根仓 package.json
  （内核版本），修复扩展版本≠runtime tag 导致的首启自举 404
- **首启零终端配置**：无可用 API key 时座舱内 Setup 引导卡——provider 预设
  下拉（DeepSeek/GLM/MiniMax/SiliconFlow…）+ 自定义 OpenAI 兼容端点 + key
  输入；走内核既有 `/config/providers*` REST（桌面 Settings 同款），保存后
  复核生效再放行；key 只经宿主桥一次性提交，不进 webview 状态
- **断线自愈**：sidecar 崩溃退避自动重拉（1s/3s/9s 上限 3 次，稳定 60s 计数
  清零）；SSE 断线座舱显示「连接断开，重连中…」
- **座舱可读性**：assistant 消息 Markdown + 代码高亮（marked + dompurify +
  hljs common，流式保持纯文本、完成后渲染，避免逐帧重排）；审批模式选择器
  （手动/自动·安全/自动接受）；Plan 审批卡（plan_draft 起草指示 +
  plan_submitted 出卡 + 正文按需拉取 + 批准/驳回闭环）

## 功能面全景（v0.3.0）

| 面 | 能力 |
|----|------|
| 会话 | 创建/切换/流式/插话（SteerBuffer）/中止/恢复，与 CLI 数据互通 |
| 编辑落地 | E4 原生 diff + CodeLens 接受/拒绝；可见终端执行 |
| 审查 | 变更审查树 + 双栏 diff + checkpoint 回滚 |
| 输入 | @file 提及、拖拽、发送选区、行内编辑 Ctrl+Shift+K |
| 引导 | 首启 Setup 卡（provider + key 零终端配置） |
| 审批 | 审批卡、审批模式选择器、Plan 审批卡闭环 |
| 渲染 | Markdown + 代码高亮、思考过程折叠、todo 面板 |
| SCM | 提交语生成（scm/title 按钮） |
| 运维 | 状态栏、崩溃自动重拉、SSE 自动重连、内核日志通道 |
| 自举 | 三级 CLI 探测：settings cliPath → PATH → 自包含运行时下载 |

## 当前状态与遗留（2026-07-23）

- v0.3.0 vsix 已打包，**尚未在任何市场发布**
- 发布阻塞：GitHub 账户 billing 锁定 → Actions 全停（CI 发布链路不可用）；
  备选为全本地发布路径（见发布手册）
- `runtime-v2.20.1` Release 只有 darwin-arm64 资产；其余三平台待 CI 或对应机器
- P4 代码在 dev 仓 `pro/p1-mission-identity` 分支（`535521f0`），待随分支合入
  main 后再 sync 公开仓（2026-07-23 曾提前推送公开仓，已 revert 退回 P3 状态）
- 明确不做（下一轮）：图片粘贴、会话搜索/归档、token/成本显示、walkthrough、
  SSE 增量重放/虚拟化、FIM 行内补全（依赖内核 D16）、VS Code Marketplace 发布

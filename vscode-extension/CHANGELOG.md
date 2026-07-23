# Changelog

## 0.2.0 — 2026-07-21

P2 客户端工具委托（E4）+ P3 生态收尾。

- **原生编辑审查**：agent 写文件时编辑器实时出红绿 diff 装饰，CodeLens 逐文件「接受 / 拒绝」；拒绝会恢复原内容并把结构化结果回传 agent
- **可见终端执行**：bash 命令在名为「天枢」的真实终端执行（Shell Integration 回传 exitCode 与输出）；不支持 Shell Integration 的环境自动退回内核本地执行
- **行内编辑**：`Cmd/Ctrl+Shift+K` 选区 + 指令 → agent 编辑经原生 diff 通路落地
- **拖拽 @file**：拖文件进座舱输入框自动生成 `@file:` 提及
- **协议版本协商**：`X-Tianshu-Protocol` 响应头；旧内核自动禁用委托能力（fail-back 到内核本地执行，agent 永不因 UI 掉线卡死）
- **自包含运行时**：PATH 上没有 rivet CLI 时自动下载运行时包（sha256 校验，境内镜像 + GitHub 双端点），全新机器零依赖首启
- **状态栏**：sidecar / 会话运行态实时指示，待审批数警示，点击直达座舱
- **SCM 提交语**：源代码管理标题栏一键生成中文提交语（`rivet -p` headless 通路，不建持久会话）
- 上架资格：市场图标、CHANGELOG、LICENSE、README 市场文案

## 0.1.0 — 2026-07-20

首个可用版本（P0 + P1）。

- **sidecar 启动器**：探测 rivet CLI → spawn `rivet serve`（127.0.0.1 + 随机 Bearer token，每工作区一实例）
- **座舱 webview**：消息流（流式回复 / 思考折叠 / 工具卡）、审批卡、运行中 steer 插话、todo/plan 卡片、模型与星域切换、结构化提问卡
- **会话管理**：列表 / 新建 / 续跑；SSE 断线按 seq 重放续接；会话数据与 CLI / 桌面端共享（`~/.rivet/`），跨端可续
- **变更审查**：TreeView 列出任务基线以来的文件变更，VS Code 原生双栏 diff，双步确认回滚
- **编辑器集成**：工具结果点击跳转文件；@file 提及补全；右键「发送到天枢」（选区带行号）

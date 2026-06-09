> [English](README.md)

# 天枢 (Tianshu)

一个全功能的终端编程智能体运行时——智能上下文管理、多模型协调、DeepSeek V4 前缀缓存优化、结构化审查纪律、可扩展工具架构。

基于 **TypeScript strict** + **Ink 6 (React TUI)** + 流式 API 构建。约 15 万行源码，520+ 测试文件。

## 为什么做天枢

大多数 AI 编程助手把上下文当作桶——装满就溢出，然后盲目压缩。天枢把上下文当作**结构化、可缓存的资源**：

- **前缀缓存命中率高达 99.6%**——通过冻结/易变提示词分层、基于 SHA-256 指纹的漂移检测和自适应压缩阈值，在 DeepSeek V4 的 1M 上下文窗口上实现
- **跨回合验证**——每项代码改动在提交前都要经过追踪、测试和交付门禁；"测试通过"是底线，不是天花板
- **多模型 Worker 委派**——生成独立上下文的无界面 worker，自适应模型路由，4 种聚合策略
- **结构化审查纪律**——内置对抗性验证、路径边界检查和复杂规格的数据流验证

## 特性

### 核心智能体循环
- 回合制 LLM → 工具 → 观察 → 决策循环，带收敛检测和死循环逃逸
- 每项目 Git 检查点 + 回滚，基于快照的文件级撤销
- 证据追踪、失败分类和交付门禁（阻止未验证的变更）

### 上下文与缓存
- **冻结 + 易变提示词分层**——系统提示词冻结以最大化缓存复用；项目状态、Git 状态和声明是易变的
- **渐进式压缩**——微压缩（回合安全截断）、智能压缩（响应式回合选择）和压力监控
- **Artifact 持久化**——大型工具输出写入磁盘，仅压缩摘要进入上下文

### 工具集（49 个工具）
| 类别 | 工具 |
|------|------|
| **文件 I/O** | read_file, edit_file, write_file, glob, grep, diff |
| **执行** | bash, run_tests, sandbox_exec |
| **Git** | git（status, diff, log, stash, commit）, undo |
| **导航** | repo_map, inspect_project, related_tests, repo_graph |
| **知识** | recall, remember, plan_submit, delegate_task |
| **网络** | web_fetch（HTML→Markdown，SSRF 安全） |
| **元工具** | todo, deliver_task, hash_edit, apply_patch |

### 多模型支持
- OpenAI 兼容提供商（DeepSeek、任何 OpenAI API 端点）
- Anthropic Claude 支持
- Codex OAuth 设备流
- 感知提供商的压缩和缓存策略

### 终端界面（Ink 6 / React）
- 流式响应渲染，代码围栏同步
- 斜杠命令：`/compact`、`/rollback`、`/debug cache`、`/sessions`、`/resume`
- 通过 `.rivet/commands/` 自定义斜杠命令
- 会话持久化和恢复

### 验证与审查
- **审查纪律**——四条强制规则：禁止同上下文自我审批、修复前生成对抗性验证器、对触及文件运行既有测试、对无证据的"绿声明"执行失败关闭
- **交付门禁**——`deliver_task` 检查证据、影响文件和测试结果后才允许提交
- **路径边界审查**——对路径遍历、分类正确性和失败关闭安全性的结构化检查

## 快速开始

```bash
# 安装和构建
npm install && npm run build

# 设置 API Key（任选一种）
export DEEPSEEK_API_KEY=sk-xxx          # 环境变量
rivet config set-key deepseek sk-xxx    # CLI（保存到 ~/.rivet/config.json）

# 启动
node dist/main.js
# 或全局安装后：
npm install -g && rivet
```

### 无界面模式

```bash
# 单次提示，文本输出，无 TUI
rivet -p "解释 src/agent/loop.ts"

# JSON 输出，用于脚本集成
rivet -p "列出所有 TODO 注释" --json
```

## 架构

```
src/
├── agent/         204 个模块 — 核心循环、委派、验证、交付门禁、
│                  收敛检测、worker 会话、协调器、审查纪律
├── api/           多提供商客户端（DeepSeek, OpenAI, Anthropic, Codex）、
│                  流式处理、重试引擎、提供商注册表
├── prompt/        系统提示词引擎 — 冻结层 + 易变上下文 + XML 协议 +
│                  缓存诊断 + SHA-256 指纹
├── tools/         49 个工具实现 + 注册表 + 审批门禁
├── tui/           94 个 Ink 6 / React 组件 — 流式渲染、控制面板、斜杠命令
├── compact/       上下文压缩 — 微压缩、智能压缩、阈值
├── cache/         前缀缓存管理 — 命中诊断、幽灵注册表、自适应阈值
├── context/       认知账本、声明、压力监控、会话记忆、群体感知
├── repo/          代码分析 — 导入图、符号索引、上下文包
├── config/        多层配置：默认 → ~/.rivet → 项目 → 会话覆盖
├── artifact/      大输出持久化，支持 read_section 恢复
├── auth/          API 密钥存储、OAuth 设备流、令牌管理
├── hooks/         前/后工具钩子、用户提示钩子、通知钩子
├── mcp/           MCP 外部工具集成
└── model/         模型能力卡、路由指标、任务类型推断
```

## 配置

### 模型提供商

详见 [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md)（DeepSeek、OpenAI、Anthropic、自定义端点）。

### 项目指令

在项目根目录放置 `.rivet.md` 文件，其内容会自动注入为项目上下文：

```markdown
# 项目指令
- 使用 pnpm，不用 npm
- 提交前所有测试必须通过
- 遵循约定式提交格式
```

### 自定义斜杠命令

在 `.rivet/commands/` 目录下定义命令：

```bash
mkdir -p .rivet/commands
echo '审查这段代码的问题并给出修复建议：
$ARGUMENTS' > .rivet/commands/review.md
```

### 审批模式

```bash
rivet config set-approval auto-safe                     # 推荐 — 智能风险评估
rivet config set-approval dangerously-skip-permissions  # 仅限可信环境
```

### 会话持久化

会话保存到 `~/.rivet/sessions/`。重启后按 `r` 恢复，按任意键开始新会话。

### 自动检查点

天枢在每个回合首次修改文件前自动创建 Git 检查点：
- `/rollback` — 预览将被丢弃的内容
- `/rollback confirm` — 恢复到检查点

## 开发

```bash
npm run typecheck    # tsc --noEmit（strict 模式 + noUncheckedIndexedAccess）
npm run test         # node:test + assert/strict，520+ 测试文件
npm run build        # tsup 构建
npm run dev          # 监听模式
```

### 代码约定

- TypeScript strict 模式，`noUncheckedIndexedAccess: true`
- 数据不用 class — 使用 `interface` + 纯对象
- async/await + try-catch，不用裸 Promise 链
- 工具返回 `ToolResult { content, isError?, rawPath?, uiContent? }`
- 测试文件镜像源码：`src/agent/foo.ts` → `src/agent/__tests__/foo.test.ts`

## 文档

| 文档 | 说明 |
|------|------|
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | 模型提供商配置指南 |
| [`docs/dangerously-skip-permissions.md`](docs/dangerously-skip-permissions.md) | 权限跳过说明与安全边界 |
| [`docs/meridian-architecture.md`](docs/meridian-architecture.md) | Meridian DB 架构（跨会话学习存储） |
| [`docs/review-discipline.md`](docs/review-discipline.md) | 结构化代码审查规则体系 |
| [`docs/WINDOWS-INSTALL.md`](docs/WINDOWS-INSTALL.md) | Windows 安装与 Shell 兼容性指南 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南 |
| [`config.example.toml`](config.example.toml) | 示例 TOML 配置文件 |

## 统计

| 指标 | 数值 |
|------|------|
| TypeScript 源文件 | ~1,050 |
| 测试文件 | 520+ |
| 源码行数 | ~150K |
| 工具实现 | 49 |
| Agent 模块 | 204 |
| TUI 组件 | 94 |
| 依赖数 | 10 |

## 许可证

[Apache-2.0](LICENSE)

Copyright 2025-2026 Tianshu Contributors

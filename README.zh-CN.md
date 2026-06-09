# 天枢 (Tianshu)

一个拥有智能上下文管理、多模型协调和 DeepSeek V4 前缀缓存优化的终端编程智能体。

基于 TypeScript、Ink 6 (React TUI) 和流式 API 构建。

## 特性

- **前缀缓存优化** — 在 DeepSeek V4 的 1M 上下文窗口上实现高达 99.6% 的缓存命中率
- **多模型协调** — Worker 委派与自适应模型路由
- **上下文管理** — 渐进式压缩、锚点注册表和压力监控
- **审查与验证** — 内置审查规则，支持复杂规格的数据流验证
- **终端界面** — 支持斜杠命令、会话持久化和自动检查点的 TUI
- **工具集** — Bash、文件编辑、grep、glob、git、测试运行器、网页抓取等

## 快速开始

```bash
npm install && npm run build

# 设置 API Key
export DEEPSEEK_API_KEY=sk-xxx
# 或者：rivet config set-key deepseek sk-xxx

# 启动
node dist/main.js
# 全局安装后：
rivet
```

## 常用命令

```bash
npx tsc --noEmit                                  # 类型检查
npm exec -- tsx --test src/**/__tests__/*.test.ts # 运行测试
npm run build                                      # 构建
npm run dev                                        # 监听模式
```

## 架构

```
src/
├── agent/     核心智能体循环、委派、验证、交付门禁
├── api/       API 客户端（DeepSeek、OpenAI 兼容）、流式处理
├── prompt/    系统提示词引擎（冻结层 + 易变层）
├── tools/     工具实现与注册
├── tui/       Ink 6 / React 终端 UI
├── compact/   上下文压缩策略
├── cache/     前缀缓存管理
├── repo/      代码仓库分析
├── config/    多层配置管理
└── artifact/  大输出持久化
```

## 配置

### 模型提供商

详见 `docs/user-guide-provider-config.md`。

### 项目指令

在项目根目录放置 `.rivet.md` 文件，其内容会自动作为项目上下文注入。

### 自定义斜杠命令

在 `.rivet/commands/` 目录下定义命令：

```bash
mkdir -p .rivet/commands
echo '审查这段代码的问题：
$ARGUMENTS' > .rivet/commands/review.md
```

### 审批模式

```bash
rivet config set-approval auto-safe                     # 推荐模式
rivet config set-approval dangerously-skip-permissions  # 仅限可信环境
```

## 开发

```bash
npm run typecheck   # 类型检查
npm run test        # 运行全部测试 (node:test + assert/strict)
npm run build       # 构建 (tsup)
npm run dev         # 监听模式
```

## 文档

- `docs/user-guide-provider-config.md` — 模型提供商配置指南
- `docs/dangerously-skip-permissions.md` — 权限跳过说明
- `docs/meridian-architecture.md` — Meridian DB 架构
- `docs/review-discipline.md` — 代码审查规则体系

## 许可证

MIT

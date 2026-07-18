# 2026-07-17 — command-filters 扩展：git log/diff + npm/pnpm test（rtk 策略内生化）

## 背景

rtk 卸载后，其最高频的输出压缩族需由自家过滤器承接。`command-filters.ts`
原仅覆盖 3 族（tsc / node --test / git status），本次参照 rtk 源码移植
（`git.rs:333 compact_diff`、`git.rs:553 filter_log_output`、`vitest_cmd.rs`、
`npm_cmd.rs`），纪律与既有过滤器一致：**小输出返回 null、只删不编、
丢内容必留 omitted 标记、原文经 rawPath/ArtifactStore 恒可恢复**。

## 新增三族（`src/tools/command-filters.ts`）

### git log（`/^git\s+log\b/`，≤30 行不过滤）

- `--oneline/--pretty/--format`：行宽截断 120 + 40 条上限 `[+N commits omitted]`
- 默认格式：按 commit 块压缩——保留 `commit`/`Date:` 行 + 最多 3 行 message，
  剥 `Author:` 行、空行、`Signed-off-by:`/`Co-authored-by:` trailer；15 commit 上限
- `-p/--patch` 路由到 diff 过滤器

### git diff / git show（`/^git\s+(diff|show)\b/`，≤40 行不过滤）

- 移植 compact_diff：保留文件名头 + `@@` hunk 头（含函数上下文）+ 变更行 +
  hunk 内上下文；剥 `index`/`mode`/`similarity`/`\ No newline` 行
- 每 hunk 上限 60 行 `... (N lines truncated)`；每文件尾附 `+A -R` 计数；
  总上限 300 行
- preamble（git show commit 头 / --stat 块）只保留首个文件前 4 行——
  修掉移植初版 index 行泄漏（手测抓获）

### test runners（npm/pnpm/yarn/bun test、vitest/jest 直跑，≤15 行不过滤）

- 通用剥噪：`> pkg@ver` 生命周期头、`npm WARN/notice`、`pnpm WARN`
- 成功：只留统计行（Test Files/Tests/ℹ/Duration）+ 合成 `✓ N passed` 头
- 失败：保留失败块（FAIL/✕/×/not ok/● + 断言详情窗口 5 行）+ 统计行，
  丢通过项、coverage 表、npm ERR! 前言

## 验证

- 12 个新用例（command-filters.test.ts）：三族各自的压缩/剥除/阈值 null/路由
- **真实输出手测**：本仓 `git log -20`（246→60 行）、`git diff HEAD~5 --stat -p`
  （344→183 行，index 泄漏修复复核 PASS）
- 注：全仓 `npm run typecheck` 当前被并发会话的进行中改动（resolved-env /
  user-hooks-runner / anti-interactive-env.test）阻断，与本批无关

## 遗留

- docker/kubectl/aws 等族未覆盖（按需续扩）
- vitest/jest 的 JSON reporter 路径未做（我们不改写命令，无法强制
  `--reporter=json`；文本解析已覆盖常规输出）

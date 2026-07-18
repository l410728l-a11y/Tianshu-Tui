# 2026-07-17 — rtk 健康探针：损坏 rtk 不再污染 bash 工具结果

## 背景（session f1bde946 事故 + 4df36bcd 前科）

用户报告"工具输出有问题，上层目录经常主控查不到"。日志 `f1bde946` 显示：
主控连续 `ls /Users/banxia/app/deepseek-tui/` 都得到 `(empty)`，进而断定
grok-build 仓库不存在——但随后 `git clone` 报"目标路径已存在且非空"，自相矛盾。

**根因链**：

1. `src/tools/bash.ts` 的 `rtkRewrite` 对每条 bash 命令无条件调
   `rtk rewrite <cmd>`（用户机器装有 rtk 0.36.0 即触发），`ls …` 被改写为
   `rtk ls …` 后执行。
2. 该机的 rtk **未装 hook**（`rtk init -g`），过滤引擎损坏：实测
   `rtk ls <含标记文件的目录>` 也返回字面量 `(empty)`、exit=0。
3. 模型把 `(empty)` 当成真实 `ls` 结果 → 断定目录不存在 → 可能进一步
   重写用户文件（4df36bcd 前科）。此前修复（header 显示实际执行命令）
   只解决"看得见"，没解决"信结果"。

## 修复（`src/tools/bash.ts`）

- **端到端健康探针**（进程级一次性）：首次 rewrite 前——`rtk --version`
  探测二进制存在性；存在则 `rtk ls` 一个含 `rivet-rtk-marker` 的临时目录，
  输出必须含标记名才判 `ok`。
- **判定缓存**：`ok` 才放行 rewrite；`broken`（探针失败）整个进程停用重写，
  命令原生执行；`missing`（无 rtk）静默透传不打扰。
- **一次性告警**：判 broken 时 stderr 输出修复指引（`rtk init -g` 修复 /
  `RIVET_RTK=0` 静默）——TUI 内经 output-guard 成为 ⚠ 静态行。
- **kill switch**：`RIVET_RTK=0` 直接停用（零探针零告警）。
- 测试注入点：`__setRtkExecForTests` / `__rtkRewriteForTests`。

## 验证

- 新增 4 用例（broken 停用+告警一次+探针不重复 / healthy 放行 / missing 静默 /
  kill switch 零调用），bash.test.ts 33/33、相关 3 文件 24/24、typecheck 干净。
- **本机真实 rtk（损坏态）端到端验证**：探针失败 → 告警一次 →
  `ls -la …` 原样透传，f1bde946 失败模式闭环。

## 遗留

- 探针只覆盖 `rtk ls`（最高危命令族）；rtk 其他代理（git/find/grep）若单独
  损坏不在探测范围——但 `ls` 是目录事实的根基，覆盖它即消除最灾难性误判。
- 用户在端侧跑 `rtk init -g` 装好 hook 后，rtk 重写自动恢复（下次进程启动
  探针即过）。

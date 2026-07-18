# 2026-07-17 — bash 结果装配兜底：装配异常不再假死 120s

## 背景（session 22d00a37 误诊复盘）

另一会话报告"bash 执行通道不通"：所有命令（含 `echo test`）统一在 120s 超时，
模型诊断为"spawn 阶段卡住"。

**实际根因**：并发会话带 typecheck 红重建 dist（13:04），混构 chunk 里
`applyCommandFilter` 引用了不存在的符号。命令本身**正常执行完毕**，但
`finish()` → `buildResult()` 装配结果时抛 `ReferenceError`——异常从 child
close 事件处理器逃逸**不会**变成 promise rejection，`execute()` 永不 settle，
只能等管线 120s 看门狗报出误导性的 "Tool bash timed out after 120s"。
"timeout 参数无效"也是同一机制（那是管线看门狗，非 bash 内部 timeout）。

## 修复（`src/tools/bash.ts`）

- `finish()` 给 `await buildResult(...)` 包 try/catch：装配异常降级为带根因的
  工具结果——含错误消息、真实退出码、输出尾部（≤2000 字符），并明确标注
  "这不是命令失败，是 rivet 组装输出时出错"，杜绝模型二次误诊。
- 降级结果抽为导出纯函数 `buildAssemblyFailureResult`（契约可测）；
  异常同时写 debugLog。

## 教训（多会话纪律）

并发会话**带 typecheck 红重建 dist 并投入使用**是本次事故源头：
- 重建 dist 前必须 typecheck 绿；
- 他人正在跑的 dist 不要在热代码期重建/替换。

## 验证

- 新增 2 用例（降级结果契约：含根因/退出码/尾部、不伪装成命令失败；
  空输出标注），bash.test.ts 35/35、typecheck 干净。
- dist 经 13:42 重建后 headless 全链路（`rivet -p` → bash echo）验证正常。

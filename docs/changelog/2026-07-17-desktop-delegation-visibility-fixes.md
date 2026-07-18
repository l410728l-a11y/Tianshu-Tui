# 2026-07-17 — 子代理展示层修复：桌面端信息闭环

## 背景

探查确认桌面端子代理面板 6 处断链 + 1 处死代码（TUI 侧链路完整，未动）：

1. 「汇入主会话」按钮因 `onAdopt` 未接线永远不渲染（`WorkspaceSurface` 渲染
   `DelegationOverlay` 时漏传）。
2. `emitDelegationActivity` 丢弃 `toolUseCount`/`tokenCount`/`eventKind`/`eventDetail`
   ——`DelegationActivity` 字段齐全、mapper 已发出，桌面端运行中半黑盒。
3. worker blocked/failed 无 toast、header badge 不显示 attention 计数。
4. `WorkerResult.failureReason`（9 类）只喂模型，UI 只有 "blocked" 标签。
5. 桌面 `elapsedMs` 按事件时刻算好，无事件期间静止。
6. `DelegationPill.tsx` 全仓无 import，死代码。

## 改动

### 服务端（字段透传，无行为变更）

- `src/tools/types.ts`：`DelegationActivity` 补 `failureReason?: string`
  （string 避免 tools→agent 反向依赖）。
- `src/server/session-manager.ts`：`DelegateActivityUpdate` 补 5 个可选字段；
  `emitDelegationActivity` 透传 counters/eventKind/eventDetail（过 `redactText`）/failureReason。
- 三处终态事件补 `failureReason`：`delegate-task.ts` / `delegate-batch.ts` / `team-orchestrate.ts`。
- `src/server/serve-agent.ts`（用户派发路径）：running 回调改用共享的
  `createDelegationActivityMapper`，与 agent 路径统一拿到计数与事件镜像；终态补 `failureReason`。

### 桌面端

- **汇入主会话闭环**：`WorkspaceSurface` 接 `onAdopt`（写 `setComposerDraft` + 关面板）；
  `ThreadView` 新增 draft sync effect——外部写 draft 才镜像进本地 input，同值不 set，
  打字/IME 无干扰。
- **reducer**（`event-reducer.ts` delegation case）：counters max 合并（乱序回放不倒退）；
  `failureReason` 透传；`eventKind==='text'` 的 detail 滚动累加进 `textPreview`（尾部 400 字符）。
- **终态 toast**：`WorkspaceSurface` 新增 watcher，仅在 `running`→终态跳变时发 sonner
  toast（带 profile + failureReason，action 点开面板）；回放/重连 prev 为空天然免疫。
- **header badge**：`attention > 0` 时显示 `⚠N` 并加 warning 样式。
- **DelegationTree / DelegationSurface**：运行中行显示 `{n} 工具 · x tok` 计数 +
  textPreview 预览行；blocked/failed 行显示 failureReason 标签；详情侧栏补工具数 /
  token / 失败原因 / 输出预览；`useNowWhileRunning` 1s tick + `liveElapsedMs`
  （server elapsedMs + now − updatedAt）让 elapsed 走字。
- **死代码**：删 `DelegationPill.tsx` + pill CSS（保留共享的 `dp-pulse` keyframes 与
  `.deleg-origin`）+ 两语言 `pill.hint` 键。
- **i18n**：zh-CN/en 新增 `failure.*`（9 键）/`toast.*`（6 键）/计数与详情键。

## 测试

- `src/server/__tests__/session-manager.test.ts`：新增 counters/eventKind/failureReason
  透传用例（T4 段）。
- `desktop/src/state/__tests__/event-reducer.test.ts`：counters max 合并、failureReason、
  textPreview 滚动截断 3 个用例。
- `desktop/src/components/__tests__/delegation-summary.test.ts`：`liveElapsedMs` 3 个纯函数用例。

## 验证

- 根仓 `npm run typecheck` 干净；desktop `npm run typecheck` 干净。
- `desktop npm run check:i18n` 通过。
- server 相关 3 个测试文件 76/77——唯一失败 `PlusMenu: listModels flags current`
  经 HEAD 临时 worktree 复跑确认**为既有失败**（与本批无关，疑似读真实用户配置
  导致 current 标记漂移，待单独排查）。
- desktop 相关 3 个测试文件 85/85 全绿。

## 遗留

- worker 工具事件带参数（文件路径/命令进 `eventDetail`）——动 agent 核心事件源 +
  redact 设计，单独评审。
- 桌面端 worker 完整转录查看（需新 server 路由读 `worker-*.jsonl`）。
- `PlusMenu: listModels` 既有失败根因待查。
- 手测路径（DelegateDialog 派单 → 计数走字 → toast → 汇入）未在真机跑过。

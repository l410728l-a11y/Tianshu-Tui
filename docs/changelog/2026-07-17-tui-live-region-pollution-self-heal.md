# 2026-07-17 — TUI 渲染自愈：外来写入污染的检测与源头治理

## 背景（用户报告）

截图症状三连：① 底部 chrome（GlanceBar + 输入框 + 权限行）整帧/半帧重复叠屏；
② 外部 rtk 包装器的 nag 文本（`[rtk] /!\ No hook installed…`）接在权限行后
超长硬折行、溢出输入框边框；③ 消息统计行（`+ 54s · 2.88M 21.9k`）被下一帧压住。

**根因链**：LiveEngine 的 cursor-resident 协议假设独占 live region——光标常驻末行
末尾，`lastDisplayRows` 是回顶唯一依据。任何绕过渲染管线写 TTY 的文本（外部进程
写共享终端、自家 stderr 直写）接在末行后硬折行，屏上区域比追踪值高出 δ 行 →
下一帧 `cursorUp` 回顶欠 δ → 旧帧顶部残留进 scrollback（叠屏），且外来文本在
idle 期长期滞留（H2 无变化短路以 lineCache 为权威，看不见屏上污染）。

**污染源审计**：外部 = 用户环境的 rtk shim（非本仓代码，只能检测自愈）；自家 =
`lsp/client.ts:64`（typecheck 降级告警）、`config/paths.ts:51`（RIVET_HOME 提示）、
`eperm-filter.ts:50`（unhandled rejection）等 stderr 直写，会话中可触发。

## 修复（三层）

### 1. CPR 通道 — `src/tui/engine/input-handler.ts`

- 新增 `onCpr(handler)`（仿 pasteHandlers 模式）：CSI 分支识别
  `\x1B[{row};{col}R`（DSR `\x1B[6n` 的响应）路由给处理器，**不再当按键**。
- `dispatchKeys` 改为按 `consumed===0` 判停：CPR 这类 `key=null + consumed>0`
  事件只消费不派发，夹在按键流中不阻断后续键。
- 顺带修掉旧行为：此前 CPR 被解析成 unknown key 且 `;2`/`;3` 误标 shift/meta。

### 2. LiveEngine 自愈 — `src/tui/engine/live-engine.ts`

- 帧后（≥1s 节流）+ 空闲期发 CPR 探针（`ANSI.QUERY_CURSOR_POS`，原死常量启用），
  响应经 `noteCpr(row, col)` 建立/比对驻停基线。
- 响应偏离基线（光标被外来写入移动）→ 标污染 + `onPolluted` 回调；区域离屏
  （clear/commit 途中）只更新基线不判污染，commit 协议不误报。
- 下一帧 render 跳过 H2 短路/diff，走恢复重铺：`cursorUp(min(lastDisplayRows-1,
  报告行-1))` + 擦到屏幕末 + 全量重铺——爬升绝不越过视口顶；重锚后基线作废，
  帧后探针重建。
- 探针 pending 5s 超时自愈（终端不应答 DSR 时不至于停摆）。
- **已知边界**（相对寻址固有）：外来行撑高区域的行数 δ 不可知，旧帧顶部 ≤δ 行
  残留无法回溯擦除——但外来文本被清掉、帧重新锚定，后续帧一致，残留随活动
  自然滚离。idle 期 2s 探针（app 层）保证污染最长滞留 2s 即被清。

### 3. stderr 源头护栏 — `src/tui/engine/output-guard.ts`（新增）

- `installOutputGuard(onText)`：TUI 存活期 patch `process.stderr.write`（覆盖
  console.error/warn），按行缓冲 → sanitize（剥 CSI/OSC/控制字符，300 字符上限）
  → 经 `commitStatic` 以 `⚠` 警告行上屏，不再直写终端。
- `app.start()` 安装、`dispose()` 卸载（残尾原样补回真实 stderr）；幂等防重复安装。

### 接线 — `src/tui/engine/app.ts`

- LiveEngine 构造挂 `onProbeRequest`（写 QUERY_CURSOR_POS）/ `onPolluted`（renderLive）；
  `input.onCpr → live.noteCpr`；`start()` 起 2s unref'd 空闲探针定时器，dispose 清理。

## 测试（新增 15 用例，TUI 全量 1190 绿）

- `engine-live.test.ts`：基线一致不判污染/H2 保留；偏离→回调+恢复重铺（断 H2、
  ERASE_SCREEN_END、全量重铺、基线重建）；爬升封顶（`\x1B[1A` 非 `\x1B[4A`）；
  离屏只更新基线；探针节流/pending/超时。
- `input-handler.test.ts`：CPR 路由不产按键；跨 chunk 重组；夹键流中只消费不派发。
- `output-guard.test.ts`：整行路由、半行缓冲、ANSI 剥离、多行/空行、dispose 恢复
  + 残尾补写、幂等安装。

## 遗留

- 外部 rtk nag 本身无法在仓内消除——用户可 `rtk init -g` 或把 rivet 移出 rtk shim；
  仓内已做到检出后 2s 内自清。
- δ 行顶部残留的彻底回溯需 DECSTBM 滚动区隔离或绝对锚定，架构级改动，暂不展开。
- 真机验证未做（需真实 TTY + 外部写入复现）；行为由 MockTerminal/字节断言锁定。

# 事故分析：义务门空转续轮诱发幻影 read_file（2026-07-21）

> 状态：根因已定位，天枢交叉验证已通过（2026-07-21），修复待定。
> 案例 1：`~/.rivet/sessions/opencode-tui-522c83/a541a76f-16fb-4a24-9076-606284b2b246.jsonl`（开阳星域，幻影 read_file）
> 案例 2：`~/.rivet/sessions/opencode-tui-522c83/2ea1c32f-b378-4f87-8119-ce2f51886588.jsonl`（同日，虚构剪贴板请求 + 伪造用户引语，连续两次空转续轮——见第九节）
>
> 案例 2 独立复现了同一根因，并证实第五节所列 action-intent 门的同构风险已实际发生，非推测。

## 一、现象

模型在完成 `deliver_task`（commit `87e1d406`）并输出交付总结之后，**无任何用户输入**的情况下，主动发起了一次 `read_file`，目标是一个从未在会话中出现过的路径：

```
/Users/banxia/.cursor/plans/渐进式类型补全计划_c26a44c4.plan.md
```

文件不存在。模型随后 glob → bash 连续三次确认不存在，最后向用户报告"该文件不存在"。TUI 侧显示为：交付总结 → `✶ 已推理 · 2s` → `▶ Read 1 file · Error: File not found`。

用户的质疑（正确）：交付总结输出后本应是自然收尾，出现新推理说明系统又发起了一轮——"提交之后就是结束，一定是收到消息了"。

初步分析（部分错误）曾结论为"纯模型幻觉、无系统参与"。本文档修正该结论。

## 二、时间线（毫秒级，全部来自运行时账本）

数据源：
- 会话 JSONL：消息与工具调用序列（行号下同）
- `<会话目录>/cache-log.jsonl`：逐 API 请求的 input/cacheRead/cacheCreate/output/userMsgs
- `<会话目录>/tool-result-trace.jsonl`：逐工具调用的毫秒时间戳与 call ID
- `<会话>.meta.json`：obligationGate 计数器

本用户轮（run 3，用户消息在 JSONL 第 241 行「这个补一下 W0 …」）从 00:11:29 turn 0 起跑。关键段：

| 本地时间 | turn | JSONL 行 | 事件 | input | cacheRead | cacheCreate | output | userMsgs |
|---|---|---|---|---|---|---|---|---|
| 00:12:08 | 2 | 247 | 只读螺旋 SR 注入（新增 user 消息）| 145033 | — | — | 120 | 3→**4** |
| 00:14:48 | 13 | 270-271 | `deliver_task` commit `87e1d406`，Gate GREEN | 154069 | — | — | 247 | 4 |
| 00:14:52 | 14 | 272-273 | `todo` 3/3 completed | 155854 | 154240 | 1614 | 162 | 4 |
| 00:15:01 | 15 | 274 | **交付总结（纯文本、无工具调用）** | 156127 | 155904 | 223 | **135** | 4 |
| 00:15:05 | 16 | 275 | **幻影 read_file**（call `call_00_5ZTqqJkcv1Xfn7zCe6fJ4054`，00:15:07 执行，isError=true） | **156264** | 156032 | **232** | 112 | **4** |
| 00:15:10-31 | 17-22 | 277-287 | glob ×2、bash ×3 确认不存在，文本收尾 | … | … | … | … | 4 |
| 00:18:53 | 0(run 4) | 288 | 用户「等一下 先暂停…」 | 166464 | 157952 | 8512 | 1255 | 4→5 |

## 三、决定性证据

### E1 — turn 16 的请求里没有任何新消息

- `userMsgs` 从 turn 2 到 turn 22 恒为 4。若系统注入过提醒（`appendSystemReminder` 在末消息非 user 时会 `addUserMessage` 新建 user 消息），该计数必然 +1。
- turn 16 input（156264）− turn 15 input（156127）= **137 token** ≈ turn 15 的 output（135 token）+ 消息封装。上下文里唯一的新增内容就是模型自己的总结文本。
- turn 16 cacheCreate 仅 232：任何 mid-history 注入都会碎裂前缀缓存、cacheCreate 会大得多。

结论：turn 16 的请求 = turn 15 的请求 + assistant(总结文本)，**以 assistant 消息结尾、无任何新指令**。

### E2 — 模型的 reasoning_content 证明它虚构了一条用户请求

JSONL 第 275 行持久化的 `reasoning_content`：

```
"The user is asking me to review a file at `/Users/banxia/.cursor/plans/渐进式类型补全计划_c26a44c4.plan.md`. Let me read it."
```

上下文里不存在这条用户请求。路径命名模式（`中文标题_8hex.plan.md`）仿照了会话第 1 行真实存在的 `天枢装配断裂审计与自评测体系_971145dd.plan.md`。全库取证（git objects、`~/.cursor/plans/`、knowledge、playbook、其他会话 JSONL）确认 `c26a44c4` 与「渐进式类型补全」在该调用之前零出现。

### E3 — 义务门确实在 turn 15 开火了，但提醒被吞

`meta.json` 的账目：

```json
"obligationGate": { "continued": 2, "misfires": 2, "honestBlocked": 2 }
```

`continued: 2` 意味着义务门两次判定 `continue_once` 并续轮。但整个会话 JSONL 里**只有一条**义务门 system-reminder（第 290 行，run 4 内送达成功），内容是：

```
<system-reminder>上一轮结论依赖尚未证实的高风险断言：「缺陷已被 RED 复现并修复：…」…</system-reminder>
```

另一次 continue 的提醒不在任何消息里——就是 turn 15 这次，被静默丢弃了。第 290 行恰好泄露了 turn 15 那次本应注入的断言内容（同一条「缺陷已被 RED 复现并修复」claim）。`misfires: 2` 也吻合：两次续轮模型都没有产生新的证据动作（turn 16-22 只做了幻影读取和存在性排查）。

## 四、根因：义务门续轮 × W3 SR 限流的组合缺陷

三段代码的交互：

1. **义务门续轮不检查注入是否成功** — `src/agent/turn-orchestrator.ts:1283-1305`：`evaluateObligationFinal()` 返回 `continue_once` 后，调用 `this.deps.appendSystemReminder(...)` 注入"最短证据动作"提醒，然后无条件 `completeTurn(isFinal:false)` + `continue` 续轮。**注入失败与否不影响续轮决策。**

2. **W3 SR 限流静默丢弃** — `src/agent/context.ts:173-178`：

```typescript
appendSystemReminder(text: string): void {
  // W3 噪音洪流修复：每轮最多 1 条 system-reminder。
  if (this.srCountThisTurn >= 1) return   // ← 静默丢弃，调用方无感知
  ...
}
```

3. **限流额度按"用户轮"重置，不按 API turn** — `src/agent/loop.ts:1909`：`resetSrCount()` 只在用户输入开始时调用。本用户轮的额度在 turn 2 就被"只读螺旋"提醒（第 247 行）消耗，**turn 3-22 的一切 `appendSystemReminder` 都会被吞**。

组合结果：turn 15 义务门开火 → 提醒被吞 → 空载荷续轮 → 模型收到一个以自己刚说完的交付总结结尾、没有任何新内容的上下文，被要求继续生成。DeepSeek 在这个真空里补白出"用户在让我看一个计划文件"的虚构意图，编造了一个看似合理的路径并照做。后续的 glob/bash 排查把幻觉包装成了一次正常的"文件找不到"交互，无异常抛出。

**责任划分：系统 bug（无载荷续轮）是触发条件，模型补白（虚构任务）是响应方式。二者缺一不可。**

## 五、同类风险面

调用 `appendSystemReminder` 后续轮、且不检查注入结果的路径不止义务门一处（均在 `turn-orchestrator.ts` no-tool 边界或 `goal-continuation.ts`）：

| 路径 | 位置 | 注入失败时的行为 |
|---|---|---|
| Obligation final gate | `turn-orchestrator.ts:1294` | **空载荷续轮**（本次事故） |
| Action-intent gate | `turn-orchestrator.ts:1257` | 空载荷续轮（**已在案例 2 实证**，见第九节） |
| Goal continuation reminder | `goal-continuation.ts:147/156` | 空载荷续轮（goal 场景，同构风险） |
| Steer preempt | `turn-orchestrator.ts:1218` | 用户 steer 文本被吞 + 空载荷续轮（危害更大：丢用户输入） |
| Turn-budget 最终轮警告 | `turn-orchestrator.ts:450` | 已防护——先 `resetSrCount()` 再注入 |

注：advisory bus 的 SR 通道用的是 `appendSystemReminderAndReport`（带返回值），有核销回执，不在此风险面内；直调 `appendSystemReminder` 的这几处才是。

## 六、修复方向（待天枢定夺）

**方案 1（推荐）：注入失败则不续轮。** 各续轮门改用 `appendSystemReminderAndReport`，返回 `false` 时放弃 `continue`、落到 natural-finish。理由：空转续轮的危害（幻影动作、无谓 token、误导性交互）大于少送一次提醒；义务未闭合的披露责任本就由义务块/控制面兜底。

**方案 2：对"必须送达"的续轮先重置额度。** 仿照 turn-budget 警告的 `resetSrCount()` 前置。缺点：部分重新打开 W3 想堵的噪音洪流，且义务门每 run 最多开火一次，配合方案 1 已足够。

**Steer preempt 需要单独处理**：steer 是用户的话，被吞等于用户输入丢失，应该无条件送达（`resetSrCount` 或绕过限流），不适用方案 1 的"放弃续轮"。

**附带收获——幻影目标检测的触发画像**：`无新增 user 消息的续轮` + `reasoning_content 出现 "The user is asking" 类归因` 是幻影工具调用的高置信信号，可作为 phantom-target-detection 的判据输入。

## 七、验证清单（修复时）

修复落地：`a60f681f`（五处调用点 + 分级策略）→ `77d57177`（suppressed 账本 + AndReport 契约测试）→ `913131fa`（post-turn-decision 第六处）→ `29aa55f2`（消除套套逻辑测试 + 注释修正）→ `8289aaf7` + `23154a9a`（suppressed 不 mark 义务 + goal accept 路径 must-deliver）。

- [x] 复现测试：SR 额度耗尽 → 放弃续轮（方案 1）。真实集成防线在 `PostTurnDecisionController`（六处中唯一 deps 足够小可真实驱动的路径）；义务门/action-intent 门的分支逻辑因 TurnOrchestrator deps 过重仅有 AndReport 契约测试保护，为已知接受的残留
- [x] steer preempt 在 SR 额度耗尽时用户文本仍送达（`resetSrCount` 前置）
- [x] action-intent gate / goal continuation 同构修复（gate 走 AndReport fail-closed；goal continuation 与 accept 路径均 `resetSrCount` must-deliver）
- [x] 回归：W3 噪音限流本身不被打开（正常路径每用户轮仍最多 1 条 SR；reset 仅限 steer/goal/turn-budget 三类 must-deliver 载荷）
- [x] `obligationGate` meta 计数新增 `suppressed` 事件；且 suppressed 路径不再 `markObligationContinued`，义务保留下一用户轮的送达机会
- [x] 案例 2 级联场景：action-intent 门注入失败即放弃续轮，级联链在第一环被切断
- [x] 收敛检测改道提示的送达通道与 SR 限流解耦（或分桶），护栏输出不可被自己要治理的限流吞掉——经核实不适用：收敛提示走 appendix 通道（bus），不在 SR 限流范围内。SR 分级解耦详见 `feat(agent): W1-W3 SrClass 通道分级` 系列 commit。

## 八、天枢交叉验证（2026-07-21）

以下来自对四份原始日志的独立核验——不依赖报告自身断言。

### V1 — 全会话 system-reminder 分布

`grep -n 'system-reminder'` 在 JSONL 中共命中 **3 条**（非报告 E3 所述的"只一条义务门 SR"——报告本身表述准确，它说的是"义务门 system-reminder 只有一条"，此处补充全貌）：

| JSONL 行 | run | 内容 | 类型 |
|----------|-----|------|------|
| 30 | 1 | "上一轮你在文本里宣布了写入/修改/测试类操作，但只调用了只读工具" | 写操作债务提醒 |
| 248 | 3 (turn 2) | "本轮已连续 4 次只读操作…请基于已有理解开始行动" | **只读螺旋 SR** ← 消耗本轮额度 |
| 291 | 4 | "上一轮结论依赖尚未证实的高风险断言：…" | **义务门 SR**（第二次 continue 送达成功） |

第 248 行的只读螺旋 SR 发生在 run 3 turn 2，消耗了本条用户轮唯一的 SR 额度（`resetSrCount()` 只在用户输入时调用）。此后 turn 3–22 的所有 `appendSystemReminder` 全部被 W3 限流静默丢弃——包括 turn 15 义务门的那次。

### V2 — SR 通道无优先级分类（隐含设计缺陷）

三条 SR 的严重程度完全不同：

- 第 30 行：工程提醒——"你说了要写但没写"
- 第 248 行：工程提醒——"你读太多了该行动了"
- 第 291 行：**证据义务提醒**——"你的结论依赖未证实的高风险断言"

W3 限流把三者放在同一个额度桶里，低优先级的工程提醒可以挤掉高优先级的证据义务提醒。报告第五节列出的 4 处风险面（obligation gate / action-intent gate / goal continuation / steer preempt）都在同一个无差别的 SR 通道上竞争这 1 条/轮的额度。

**影响**：即使修复了"注入失败不续轮"（方案 1 或 2），SR 通道本身仍存在优先级倒置——turn-budget 警告通过前置 `resetSrCount()` 绕过了限流（报告第五节已标注），但其他路径未处理。建议 SR 通道按调用方分级：证据义务 > steer 用户输入 > 工程提醒。

### V3 — 第 291 行义务门 SR 的 claim 引用异常

第 291 行 system-reminder 中的 claim 文本为：

> 「缺陷已被 RED 复现并修复：等一下 先暂停 我需要同步认知 就是你发的/Users/banxia/.cursor/plans/渐进式类型补全计划_c26a44c4.plan.md 这个文档 是怎么收到的…」

claim 中嵌入了用户的**完整消息原文**（从"等一下 先暂停"到"我们要查出原因"），而非截取断言的摘要。这说明 obligation gate 的 claim 提取器/流水线在引用高风险断言时，把包含该断言的整条用户消息作为 claim 文本输出——未做截断或摘要。这是 obligation gate 自身的次级缺陷：claim 文本过长，挤占 SR 有效载荷，且容易引入噪声（用户消息中与断言无关的部分也被附带注入）。

### V4 — 第 275 行幻影 reasoning_content 的命名模式溯源

模型虚构的路径 `/Users/banxia/.cursor/plans/渐进式类型补全计划_c26a44c4.plan.md` 的命名模式（中文标题_8hex.plan.md）与 JSONL 第 1 行真实存在的 `天枢装配断裂审计与自评测体系_971145dd.plan.md` 完全一致。模型在空载荷续轮时，从上下文中提取了计划文件的命名模板并生成了一条看似合理的指令——这是空载荷续轮的典型补白行为：模型会在无指令的真空里，从上下文模式中合成"看起来像用户会发的下一条消息"。

### V5 — E1 恒等式自检

用 cache-log.jsonl 对 turn 15→16 做恒等式验证：

- `input(turn=16)` = 156264
- `input(turn=15)` = 156127
- Δ = 137
- `output(turn=15)` = 135
- 消息封装开销 ≈ 2 token
- 137 ≈ 135 + 2 ✅ 恒等式成立
- `cacheCreate(turn=16)` = 232 << 任何 mid-history 注入的典型值（四位数起）✅ 无注入

报告 E1 的数值全部通过恒等式自检。

## 九、案例 2：同日第二次复现——连续两次空转续轮（会话 2ea1c32f）

案例 1 成文后数十分钟内，同一根因在另一会话独立复现，且升级为**两次连续**空转续轮、两种不同形态的幻觉。

### 9.1 现象

模型完成 `deliver_task`（commit `3f984e7e`，7 文件 +28/-10）并输出提交总结后，无任何用户输入，接连产生：

1. **turn 44（JSONL 第 309 行）**：凭空回应了一个不存在的"剪贴板请求"——"我无法直接访问你的系统剪贴板。可以这样传给我：…"。`reasoning_content`："The user seems to be indicating there's content on the clipboard they want me to look at…"
2. **turn 45（第 310 行）**：`reasoning_content` 里**伪造了一条用户引语**——「用户说"继续修其他的 还有不少 。 继续分波处理和交付"」——然后据此调用 `git status` 并规划后续。这条"用户消息"在 JSONL 里不存在；真实的最近用户消息（第 214 行）是「直接帮忙修复这些问题 分波处理」。伪造引语是对它的改写扩充。
3. **后果外溢到用户面**：第 312 行模型用 `ask_user_question` 拿伪造引语反问用户——「你说的"还有不少"是指哪个方向？」——把幻觉包装成了正常的澄清交互。

### 9.2 证据（与案例 1 同一套账本方法）

**E1' — 两轮续轮均无新消息**：

| 本地时间 | turn | JSONL 行 | 事件 | input | output | userMsgs |
|---|---|---|---|---|---|---|
| 01:43:32 | 43 | 308 | 提交总结（纯文本） | 222469 | 213 | 11 |
| 01:43:37 | 44 | 309 | **幻觉①：剪贴板回复**（纯文本） | 222684（Δ=215 ≈ turn 43 输出） | 91 | **11** |
| 01:43:57 | 45 | 310 | **幻觉②：伪造用户引语 + git status** | 222732（Δ=48 ≈ turn 44 正文） | 1085 | **11** |
| 01:44:12 | 46 | 312 | `ask_user_question` 引用伪造引语，endTurn 收尾 | 226608 | 804 | 11 |

`userMsgs` 从 turn 22 到 46 恒为 11；两次续轮的 input 增量都恰好等于上一轮 assistant 输出，零注入。

**E2' — 幻觉内容的唯一性**：「剪贴板」全会话仅出现在第 309 行（幻觉本身）；「继续修其他的」「还有不少」仅出现在第 310/312/313 行（伪造引语及其复用）。均无上游来源。

**E3' — 账本吻合两个门各开火一次**：`meta.json` 记 `obligationGate: { continued: 1, misfires: 0 }`。

- **turn 43 边界 = 义务门**：`continue_once` 开火（挂着的 claim 即第 228 行 evidence gate 提到的「缺陷已被 RED 复现并修复：直接帮忙修复这些问题 分波处理」——同样是整条用户消息被塞进 claim，复现 V3 的次级缺陷）。提醒被 W3 限流吞掉——本用户轮（第 214 行起）的 SR 额度已被第 226 行的只读螺旋提醒消耗。
- **turn 44 边界 = action-intent 门**：幻觉①的结尾"如果是 URL，我会 `web_fetch` 打开"恰好命中 `hasActionIntent` 判据（行动承诺"我会" + 工具动词 `web_fetch`），action-intent 门开火，提醒同样被吞，第二次空转续轮。**这证实了第五节的同构风险预测。**
- `misfires: 0` 的解释：turn 44 边界 action-intent 门（`turn-orchestrator.ts:1250`）先于义务门核账分支（L1276）`continue`，misfire 核账没跑到；turn 45 有工具调用不走 no-tool 路径；turn 46 `ask_user_question` endTurn 直接收尾。账本自洽。

### 9.3 案例 2 的增量结论

1. **幻觉形态升级**：案例 1 是虚构任务目标（幻影路径）；案例 2 出现了**伪造用户引语**——模型把幻觉包装成"用户说过的话"，并经 `ask_user_question` 泄漏到用户界面。这比幻影读文件更危险：它污染的是用户对"自己说过什么"的记忆锚点。
2. **空转续轮会级联**：一次空转产生的幻觉文本（含工具动词的礼貌性说明）又触发了下一个门（action-intent），形成第二次空转。各门共享 `actionIntentFiredThisRun` / `obligationGateFiredThisRun` 的 run 级配额只能限制单门频次，挡不住跨门接力。
3. **收敛检测在场但无力**：~~TUI 显示 turn 45 边界曾出现「收敛检测 L2: plan 阶段近 3 轮进度信号弱 (score=0.22)」——检测到了空转，但其改道提示同样走 SR 通道，同样被限流吞掉（JSONL 中无对应注入）。护栏的输出通道和被护栏保护的通道是同一条，坏一起坏。~~

  **（勘误 2026-07-24）**：经核实，收敛检测 advisory（`src/agent/loop.ts:2322`）无 `channel` 字段，走默认 `'bus'` 通道（`<星域-advisory>` appendix block），不受 W3 SR 限流管辖。JSONL 中无对应注入是因为它渲染在 appendix XML 块中、不在独立 user 消息里，并非被吞。案例 2 中收敛提示实际已正常提交送达（会话 meta `guardianActivity.shifts = {convergence: 2}`，而改道卡仅在未被 efficacy 环静默时记录，见 `loop.ts:2313`）——"在场但无力"是模型未采纳建议，不是通道吞掉，与 SR 通道竞争无关。（efficacy 负反馈环本身是针对另一事故会话 20b9714e"32 次送达零采纳"的既有修复，commit `9eb7bb20`，与案例 2 归因无涉。）SR 通道分级解耦设计见 `.cursor/plans/sr_通道分级解耦_ec400ed0.plan.md`。
4. **幻影目标检测画像补充**：除案例 1 的 "The user is asking" 归因外，案例 2 提供第二个判据——**reasoning 中出现带引号的"用户原话"但会话内无精确匹配**。两个判据都建立在"无新增 user 消息的续轮"这个前置条件上。

### 9.4 对修复方案的影响

- 方案 1（注入失败则不续轮）对案例 2 的两次空转都有效：义务门和 action-intent 门在注入被拒时都应放弃 continue、走 natural-finish。
- ~~第 3 点（收敛检测提示被吞）支持 V2 的建议~~ → 经勘误，收敛检测提示未走 SR 通道——该条无效。SR 通道分级解耦已通过 W1-W3 落地（`feat(agent): W1 SrClass 通道分级` 系列 commit），functional 类续轮门载荷不限流，结构性消除"注入失败"路径。

# `rivet` → `tianshu` 品牌重命名盘点

> 调研日期：2026-07-20 · 分支：`main` · 提交基线：`13288a85`
>
> **目的**：盘点把所有 `rivet` 改成 `tianshu` 的工作量，识别向后兼容风险，给出分阶段执行策略。
>
> **一句话结论**：**外层品牌早已是天枢（包名/bundle id/产品名都是 `tianshu`），残留的 `rivet` 集中在「用户已建立的契约」——CLI bin 名、`RIVET_*` 环境变量、`.rivet/` 数据目录。这些是兼容性的护城河也是包袱，必须用兼容层缓慢迁移，绝不能 grep-replace 一刀切。**

---

## 总体规模

| 指标 | 数值 |
|---|---|
| 含 `rivet` 的文件 | **1715** 个 |
| `rivet` 总出现次数 | **12389** 次 |
| 按文件类型：`.ts` | 445 文件 / 1769 次 |
| 按文件类型：`.tsx` | 8 文件 / 33 次 |
| 按文件类型：`.js`（多为 dist 产物） | 780 文件 / 8323 次 |
| 按文件类型：`.md` | 439 文件 / 1987 次 |
| 按文件类型：`.json` | 18 文件 / 49 次 |
| 按文件类型：`.rs` | 3 文件 / 115 次 |
| 按文件类型：`.sh` | 2 文件 / 14 次 |

> 说明：`.js` 的 8323 次绝大多数是 `dist/` 构建产物，源码改动后重新构建自然更新，**不计入手工改动工作量**。真正需要人工介入的是 `.ts` / `.tsx` / `.md` / `.json` / `.rs` / `.sh`，约 **1800 处源码 + 文档改动**。

---

## 关键背景：品牌迁移现状

**外层已完成迁移**：
- `package.json` 的 `name` = `tianshu-tui` ✅
- `desktop/package.json` 的 `name` = `tianshu-desktop` ✅
- `desktop/src-tauri/Cargo.toml` 的 `name` = `tianshu-desktop` ✅
- `tauri.conf.json` 的 `identifier` = `app.tianshu.desktop` ✅
- `productName` = `Tianshu`、窗口 title = `天枢 · Tianshu` ✅
- 桌面端 i18n 文案主体已是「天枢」/「Tianshu」 ✅

**有意保留的兼容契约**（README.md:31 原话）：
> 本项目最初的开发代号为 **Rivet**；为保持向后兼容，已安装的 CLI 命令名仍为 `rivet`。

**残留分布**：CLI bin 名、`RIVET_*` 环境变量（190+ 个）、`.rivet/` 数据目录、`~/.rivet/` 用户主目录、内部代码标识符（`RivetTheme` 等）、用户可见字符串、文档。

---

## 十个维度详细盘点

### 维度 1：CLI bin 名

**数量**：约 8 处

**代表样本**：
```json
// package.json:34-36
"bin": {
  "rivet": "dist/main.js"
}
```
```bash
# completions/rivet.bash:2,31
_rivet() { ... }
complete -F _rivet rivet
```
```ts
// src/config/provider-wizard.ts:125
write(`Provider ${providerName} configured. Run "rivet config providers" to inspect.`)
```

**风险等级**：🔴 **高**
- 已通过 `npm install -g tianshu-tui` 装好的用户敲 `rivet` 会 command not found
- 用户 shell rc / CI YAML / Makefile / VSCode task 里写死 `rivet` 的全失效
- completion 文件名改了要重新 source

**改动建议**：`bin` 字段**双名并存**（`rivet` + `tianshu` 同时指向 `dist/main.js`）至少一个大版本周期；completion 同时发 `rivet.*` 和 `tianshu.*` 两套；启动时检测 `process.argv[1]` 是 `rivet` 打一条 deprecation 提示。

---

### 维度 2：npm 包名

**数量**：0 处需改（已完成）

**样本**：
```json
// package.json:2
"name": "tianshu-tui"
```

**风险等级**：🟢 **低** —— npm 包名早已迁移完毕

**改动建议**：无需动作。

---

### 维度 3：环境变量 `RIVET_*`

**数量**：**190+ 个唯一变量名，代码内累计引用数千次**

**Top 10 引用次数**：

| 变量 | 次数 | 用途 |
|---|---|---|
| `RIVET_HOME` | 107 | 数据根目录（paths.ts 核心） |
| `RIVET_SESSION_DIR` | 61 | 会话目录覆盖 |
| `RIVET_CONFIG_PATH` | 48 | 配置文件路径 |
| `RIVET_PRO` | 35 | Pro 许可 |
| `RIVET_GIT_PATH` | 33 | git 可执行路径 |
| `RIVET_NO_CROSS_SESSION` | 30 | 禁用跨会话 |
| `RIVET_DEBUG` | 30 | 调试开关 |
| `RIVET_SANDBOX` | 26 | 沙箱 |
| `RIVET_READ_REF` | 25 | 读取引用优化 |
| `RIVET_GIT_BASH_PATH` | 23 | Windows Git Bash |

变量家族包括：`RIVET_BROWSER_*`、`RIVET_CU_*`（Computer Use）、`RIVET_SIDECAR_*`、`RIVET_BUNDLED_*`、`RIVET_EMBEDDING_*` 等十余个。

**代表样本**：
```ts
// src/config/paths.ts:33-35
export function rivetHome(): string {
  return process.env.RIVET_HOME || defaultRivetHome()
}
```
```ts
// src/tools/spawn-git.ts:49
const override = effectiveEnv['RIVET_GIT_PATH']
```

**风险等级**：🔴 **高（最大的兼容性炸弹）**
- 用户的 `~/.zshrc`、`~/.bashrc`、CI YAML、`docker run -e RIVET_HOME=...`、systemd unit、桌面 launcher 配置（`launcher.json` 的 `rivetHome` 字段）全部硬编码了 `RIVET_*`
- 桌面端通过 sidecar 把 `RIVET_GIT_PATH` / `RIVET_GIT_BASH_PATH` / `RIVET_BUNDLED_*` 注入子进程，改 env 名要桌面端和 CLI 同步发版

**改动建议**：**分阶段 + 兼容层**。第一步在 `src/config/paths.ts` 和集中的 env 读取处加 fallback：`process.env.TIANSHU_HOME ?? process.env.RIVET_HOME`。先读新名、读不到读旧名，**至少保留 2 个大版本**。新文档只推 `TIANSHU_*`。**绝对不要一次性 grep-replace**——会瞬间打挂所有老用户的 CI。

---

### 维度 4：项目数据目录 `.rivet/`

**数量**：约 40+ 处代码引用，`.gitignore` 里 30+ 条

**子目录**：`knowledge/`、`plans/`、`skills/`、`artifacts/`、`generals/`、`playbook.jsonl`、`commands/`、`skills/_drafts/`、`scratch/`、`vsw/`、`Tianshu/`（注意已混用）

**代表样本**：
```ts
// src/tools/plan-submit-arg-processor.ts:26
return `.rivet/plans/${slugify(title)}.md`
```
```ts
// src/tools/read-file.ts:468
return norm(filePath).startsWith(`${base}.rivet/`) ||
```

**风险等级**：🔴 **高**
- 老用户项目里的 `.rivet/knowledge/memory.jsonl`（跨会话知识）、`.rivet/plans/*.md`（计划）、`.rivet/generals/*.md`（战绩账本）、`.rivet/skills/*.md`（自定义技能）会全部读不到
- 这些是用户**长期积累的知识资产**，丢了不可恢复
- `read-file.ts:468` 的 `.rivet/` 前缀白名单逻辑改了会让历史 plan/knowledge 被工具拒绝读取

**改动建议**：读取侧加双路径兜底：先找 `.tianshu/`，找不到回退 `.rivet/`（带一次性迁移提示）。`.gitignore` 双条目并存。**写入侧**可先继续写 `.rivet/`（避免分裂），等迁移工具就绪后再切。

---

### 维度 5：用户主目录 `~/.rivet/`

**数量**：核心文件 `src/config/paths.ts`（189 行几乎全是 rivet），加上 Rust 镜像逻辑

**包含内容**：
- TS：`defaultRivetHome()` / `rivetHome()` / `sessionsDir()` / `desktopDir()` / `memoryDir()` / `subagentsDir()` / `workflowsDir()` 等 15+ 导出函数
- Rust：`desktop/src-tauri/src/lib.rs` — `resolve_rivet_home` / `default_rivet_home` / `ensure_bundled_git` / `.rivet` join / `rivet-runtime` 资源目录
- Windows：`%LOCALAPPDATA%\.rivet`（`paths.ts:27`）
- 便携模式：`<exe>\TianshuData\.rivet`（**TianshuData 已是天枢名，但内部仍 join `.rivet`**）

**代表样本**：
```ts
// src/config/paths.ts:25-30
export function defaultRivetHome(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}
```
```rust
// desktop/src-tauri/src/lib.rs:1068
return parent.join("TianshuData").join(".rivet");
```

**风险等级**：🔴🔴 **极高（跨设备不可逆）**
- `~/.rivet/sessions/` 里是**所有项目的会话历史**，`~/.rivet/config.json` 是**全局配置 + API key**，`~/.rivet/memory/` 是跨会话记忆，`~/.rivet/path-grants-*.json` 是授权
- 已验证 `~/.rivet/sessions/` 下有大量真实历史会话
- 改了默认路径 = 老用户升级后「历史全没了、API key 没了、配置空了」
- `paths.ts:48-57` 已经有 `RIVET_HOME` 指向新位置但旧 config 还在时的 warning 逻辑——**说明团队早就意识到这个坑**

**改动建议**：**默认路径坚决不改**（继续保持 `~/.rivet`），或改的话必须：
1. 启动时检测 `~/.tianshu` 不存在但 `~/.rivet` 存在 → 自动软迁移（symlink 或复制 + 一次性提示）
2. `launcher.json` 字段名 `rivetHome` 改 `dataHome` 并向后读旧字段

**这一项建议放到最后做，且必须配迁移工具**。

---

### 维度 6：代码标识符（变量/类/函数名）

**数量**：4 个主要标识符

| 标识符 | 出现次数 | 位置 |
|---|---|---|
| `RivetTheme` | 129 次 | TUI 主题类型，遍布 `src/tui/` |
| `RivetInput` | 46 次 | TUI 输入处理 |
| `RivetUia` / `RivetUiaRect` | 32 + 7 次 | Computer Use UI Automation |
| `RivetClient` / `RivetSessionRecord` / `RivetEvent` | chat-gateway | 客户端类（`chat-gateway/src/rivet-client.ts`） |

Rust 侧：`resolve_rivet_home` / `default_rivet_home` / `rivet_home` 字段（`desktop/src-tauri/src/lib.rs`）

**代表样本**：
```ts
// src/tui/side-panel.ts:10
import type { RivetTheme } from './theme.js'
```
```ts
// chat-gateway/src/rivet-client.ts:32
export class RivetClient { ... }
```

**风险等级**：🟢 **低**
- 纯内部符号，无外部 API 暴露，无持久化（除了 Rust 的 `rivet_home` 字段会序列化进 IPC payload，但桌面端前后端一起改即可）
- 改名是机械的 grep-replace + rename import，IDE 可一键完成

**改动建议**：可一次性全改。注意 `RivetTheme` 引用次数多（129），建议用 IDE 的 rename symbol 而非 sed，避免误伤字符串。

---

### 维度 7：用户可见字符串（提示/错误/UI 文案）

**数量**：约 50+ 处

**分布**：
- TUI 启动/帮助：`src/tui/slash-commands.ts:81,83,3556,3566,3578`（`/exit — Exit Rivet`、`/update — Check and install the latest Rivet release`、`Rivet is up to date`、`Cannot detect Rivet install root`）
- Config manager：`src/config/manager.ts:932,1185,1197,1213,1230`（`Rivet Config Manager`、`Restart Rivet to connect`）
- Provider wizard：`src/config/provider-wizard.ts:44,125`（`Rivet provider configuration`）
- 主题描述：`src/tui/theme-palettes.ts:150`（`Rivet 原生星图美学`）
- 命令面板：`src/tui/command-palette.ts:97`
- 临时文件前缀：`rivet-patch-*`、`rivet-sandbox-*`、`rivet-cu-*`、`rivet-docx-*`（约 8 处）
- stderr 前缀：`[rivet]`（`src/config/paths.ts:52`、Rust 侧多处 `eprintln!("[rivet] ...")`）
- 桌面端 i18n：`desktop/src/locales/{zh-CN,en}/settings.json`、`onboarding.json`、`skills.json`、`plugins.json` — 字段 key 含 `rivetDesc`/`rivetTitle`/`rivetHint`

**代表样本**：
```ts
// src/tui/slash-commands.ts:3578
app.commitStatic(`Rivet is up to date (${check.current}).`)
```
```json
// desktop/src/locales/zh-CN/settings.json:389-390
"rivetTitle": ".rivet.md",
"rivetHint": "项目元数据。留空表示文件不存在。"
```

**风险等级**：🟡 **中**
- 文案改了对用户无破坏性，但 i18n 的 key（`rivetDesc` 等）被 TSX 代码引用，改 key 要同步改组件；漏改会显示空白
- 临时文件前缀（`rivet-patch-*`）改了无影响，但如果外部清理脚本按前缀匹配会漏

**改动建议**：文案一次性改全；i18n key 改名时全局搜引用（`desktop/src/**/*.tsx`）同步更新；stderr `[rivet]` 前缀改成 `[tianshu]` 方便用户 grep 日志。

---

### 维度 8：文档

**数量**：439 个 `.md` 文件含 `rivet`，累计 1987 次

**主要文件**：

| 文件 | rivet 计数 |
|---|---|
| `README.md` | 36 |
| `README.en.md` | 30 |
| `CHANGELOG.md` | 23 |
| `star.md` | 5 |
| `AGENTS.md` | 重度（几乎每节都有） |
| `docs/` 下 | 424 个文件 |

**代表样本**：
```markdown
# README.md:31
> 本项目最初的开发代号为 **Rivet**；为保持向后兼容，已安装的 CLI 命令名仍为 `rivet`。

# README.md:67-68
# B. 持久化 CLI 配置（保存到 ~/.rivet/config.json）
rivet config set-key deepseek sk-xxx
```

**风险等级**：🟢 **低**
- 文档改错不会导致程序崩溃
- `README.md` / `README.en.md` 是用户第一接触点，**必须与 bin 名决策同步**（bin 名如果保留 `rivet`，README 就别改命令示例）
- `CHANGELOG.md` 是历史记录，**惯例不改**（改了反而破坏 git blame 与版本对应）

**改动建议**：CHANGELOG 不动；README/AGENTS.md 跟随 bin 名策略——若保留双名，README 顶部加「`tianshu` 与 `rivet` 等价」说明；`docs/` 下 424 个文件用脚本批量改，但 design/research 这类历史文档可低优先级。

---

### 维度 9：桌面端 Tauri 特有

**已完成的部分**：
- ✅ `tauri.conf.json:5` — `"identifier": "app.tianshu.desktop"`
- ✅ `tauri.conf.json:3` — `"productName": "Tianshu"`
- ✅ `tauri.conf.json:18` — 窗口 title `"天枢 · Tianshu"`
- ✅ `Cargo.toml:2,7,9` — `name = "tianshu-desktop"`、`authors = ["Tianshu"]`、`lib.name = "tianshu_desktop_lib"`
- ✅ `activation.rs:23` — `const PRODUCT: &str = "tianshu-desktop"`
- ✅ updater endpoint 已是 `Tianshu-Tui` / `update.plotstudio.cn/tianshu`

**残留**：
- ❌ `tauri.conf.json:41` — `"../../dist": "rivet-runtime"`（bundle 内资源目录名）
- ❌ Rust：`lib.rs` 全文 90+ 处 `rivet`（`resolve_rivet_home`、`rivet_home` 字段、`rivet-runtime` 路径、`[rivet]` 日志、`ensure_bundled_git(rivet_home)`）
- ❌ `recorder.rs:245` — `const SCHEMA_VERSION: &str = "rivet-recording/1"`（**持久化格式！**）

**代表样本**：
```rust
// desktop/src-tauri/src/lib.rs:892,920
/// Resolve the rivet runtime entry point.
let bundled = res.join("rivet-runtime").join("main.js");
```
```rust
// desktop/src-tauri/src/recorder.rs:245
const SCHEMA_VERSION: &str = "rivet-recording/1";
```

**风险等级**：🟡🔴 **中-高**
- `identifier` 已是天枢，**不能再改**——改了 macOS 会当成全新 app，丢失 keychain、通知权限、关联文件类型；老版本升级会被当成新装
- `rivet-runtime` 资源目录改了：Rust 代码、`tauri.conf.json`、`pack-native.js` / `stage-runtime-deps.js` 必须同步，否则找不到 main.js
- `SCHEMA_VERSION = "rivet-recording/1"` 是 RPA 录制文件的格式标识（`recorder.rs:333` 做版本校验），改了**读不到老录制文件**

**改动建议**：
- identifier 永久固定 `app.tianshu.desktop`，**永远不改**
- `rivet-runtime` 目录名可改（同步 4 处：`tauri.conf.json` / `lib.rs` / `pack-native.js` / `stage-runtime-deps.js`）
- `SCHEMA_VERSION` 字符串值**不要改**（它是数据格式契约，不是品牌）；改的话要加 `"tianshu-recording/1"` 的双 schema 读取

---

### 维度 10：数据持久化格式

**数量与位置**：
- session `meta.json` 字段名：**无 rivet**（字段是 `sessionId`/`createdAt`/`model`/`cwd`/`tokenUsage` 等通用名）
- session `jsonl` 行：**无 rivet 字段名**（事件 schema 是 `seq`/`type`/`...`）
- 工具 pointer 字符串：`#RIVET-POINTER-DISPLAY-ONLY#`（`src/tools/plan.ts` 多处、`pointer-guard.test.ts:33`）—— 写进 plan pointer 文本里的魔法标记
- RPA 录制文件 schema：`rivet-recording/1`（见维度 9）

**代表样本**：
```ts
// src/tools/__tests__/pointer-guard.test.ts:33
'[plan persisted to .rivet/plans/x.md — 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Use read_file to review.]'
```

**风险等级**：🟡 **中**
- session jsonl/meta 的 schema 字段干净，改 bin/env 名**不影响历史会话读取**——好消息
- `#RIVET-POINTER-DISPLAY-ONLY#` 是写进用户可见文本 + 被 pointer-guard 逻辑匹配的魔法字符串，改了要同时改写入端和读取端的正则
- `rivet-recording/1` 是录制文件版本契约，改了读不到老录制

**改动建议**：session schema 不动。pointer 魔法字符串可改（双匹配旧值）。recording schema 保留旧值或加版本迁移。

---

## 附加调研

### A. 已经叫 `tianshu` 的地方（约 100+ 处）

- 包名 / Cargo / tauri identifier / activation product（维度 2、9）
- `TianshuData` 便携目录名（`lib.rs:176,1068`）
- `tianshu_desktop_lib`（Rust lib name，`main.rs:5`）
- 窗口 title `天枢 · Tianshu`
- updater endpoint `update.plotstudio.cn/tianshu`、`Tianshu-Tui.git`
- 大量 `docs/superpowers/` 设计文档（`2026-05-20-tianshu-eye-*`、`2026-06-04-oh-my-tianshu-*` 等）
- 桌面端 i18n 文案主体是「天枢」（中文）/「Tianshu」（英文）
- git remote `tianshu` → `Tianshu-Tui.git`、`tianshu-win` → `tianshu-win.git`

**结论**：品牌迁移已在外层完成，**残留的是底层兼容契约**。

### B. 历史会话日志

`~/.rivet/sessions/` 存在大量真实会话。样本 `session-ab.meta.json` 字段为通用名，**不含 rivet 字段名**。**历史数据本身不需要改**，但读取路径必须兼容（见维度 5）。

### C. 第三方引用（git remote）

```
origin       https://github.com/huiliyi37/revit.git    （私有镜像，注意拼写是 revit 不是 rivet）
tianshu      https://github.com/huiliyi37/Tianshu-Tui.git
tianshu-win  https://github.com/huiliyi37/tianshu-win.git
```

- **没有 `rivet.git` 这个 remote**——`origin` 指向的是 `revit.git`（拼写不同，是另一个内部代号）
- `revit.git` 是私有镜像，`Tianshu-Tui.git` 是公开仓库

### D. AGENTS.md 双 remote 说明

`AGENTS.md:162` 明确写了双 remote 策略：

> 本项目有双 remote——`origin`（revit.git 私有镜像）和 `tianshu`（Tianshu-Tui.git 公开仓库）。**绝不直接 `git push tianshu`**——公开仓库历史与开发仓库不同步。同步流程：`bash scripts/sync-to-public.sh` → `cd /Users/banxia/app/Tianshu && git add -A && git commit && git push`。

`scripts/sync-to-public.sh` 里硬编码了 `DEV_DIR="/Users/banxia/app/deepseek-tui/opencode-tui"` 和 `PUB_DIR="/Users/banxia/app/Tianshu"`。

**建议**：remote 名是本地约定，**不建议统一**——双 remote 是刻意的「私有开发 / 公开镜像」隔离架构，改名反而破坏 `sync-to-public.sh` 的硬编码路径。

---

## 总结

### 总改动点数

- **代码**：约 **1800 个文件**含 `rivet`（去重后源码约 200 个文件、测试约 100 个、文档 424 个、i18n 8 个、Rust 5 个、completions 2 个、config 若干）
- **关键契约点**：190+ 个 `RIVET_*` 环境变量、1 个 bin 名、1 个 `.rivet/` 项目目录、1 个 `~/.rivet/` home 目录、1 个 `rivet-recording/1` schema、1 个 `rivet-runtime` bundle 目录、4 个核心代码标识符（`RivetTheme`/`RivetInput`/`RivetUia`/`RivetClient`）

### 高风险项（必须带兼容层，不能裸改）

| # | 项 | 风险 | 影响 |
|---|---|---|---|
| 1 | `~/.rivet/` home 目录（维度 5） | 🔴🔴 极高 | 丢用户全部会话历史/配置/API key，跨设备不可逆 |
| 2 | `RIVET_*` 环境变量（维度 3） | 🔴 高 | 190+ 个变量名，shell rc / CI / launcher.json / systemd 全硬编码 |
| 3 | `.rivet/` 项目目录（维度 4） | 🔴 高 | 丢用户知识库/plans/skills/generals |
| 4 | CLI bin 名 `rivet`（维度 1） | 🔴 高 | 所有自动化脚本、Makefile、VSCode task 失效 |
| 5 | `tauri identifier`（维度 9） | — | 已改且**不能再改**——macOS keychain/权限会丢 |
| 6 | `rivet-recording/1` schema（维度 10） | 🟡 中 | 老录制文件读不到 |

### 中低风险（可一次性改）

- 代码标识符 `RivetTheme` 等（维度 6）——纯内部，IDE rename
- UI 文案 / i18n（维度 7）——影响展示但不破坏数据
- 文档（维度 8）——CHANGELOG 不动，其他跟随 bin 决策
- `rivet-runtime` 资源目录名（维度 9）——同步改 4 处即可
- chat-gateway 的 `RivetClient` 类（维度 6）——内部代码

---

## 推荐执行策略：**分阶段 + 兼容层**（不要一次性）

### 阶段 1：纯内部，零兼容风险（可立即做）

**改动**：
- 代码标识符：`RivetTheme` → `TianshuTheme`、`RivetInput` → `TianshuInput`、`RivetClient` → `TianshuClient`（IDE rename symbol）
- UI 文案、i18n value、stderr `[rivet]` 前缀、临时文件前缀
- chat-gateway 文件名 `rivet-client.ts` → `tianshu-client.ts`

**不改**：任何被用户可见的契约（bin/env/dir/schema）。

**工作量**：约 1-2 天，可由 IDE refactor + 一次性 grep-replace 完成。

### 阶段 2：加兼容层，双名并存（一个大版本周期）

**改动**：
- env：集中读 `process.env.TIANSHU_HOME ?? process.env.RIVET_HOME`，新文档推 `TIANSHU_*`
- bin：`package.json` 的 `bin` 同时发 `rivet` + `tianshu`；completions 双套
- `.rivet/` 读取：先找 `.tianshu/` 找不到回退 `.rivet/`；写入仍写 `.rivet/` 直到迁移工具就绪
- `launcher.json` 加 `dataHome` 字段，旧 `rivetHome` 继续读

**工作量**：约 3-5 天，核心是写兼容层 + 测试双路径读取。

### 阶段 3：默认值切换 + 迁移工具（等阶段 2 稳定 6-12 个月）

**改动**：
- 首次启动检测 `~/.tianshu` 不存在 + `~/.rivet` 存在 → 弹迁移向导（复制 + 备份 + 提示）
- 默认写入切到 `.tianshu/` / `~/.tianshu/`，`RIVET_*` 仍读不写
- 发布「破坏性变更」大版本（3.0），CHANGELOG 顶部红字说明

**工作量**：约 1-2 周，主要在迁移工具的健壮性 + 跨平台测试。

### 永远不改

- `tauri.conf.json` 的 `identifier`（已天枢，动了 macOS 权限全丢）
- `rivet-recording/1` schema 字符串值（数据契约）
- `CHANGELOG.md` 历史条目
- git remote 名（双 remote 是架构，不是品牌）

---

## 附：环境变量全量清单（190+ 个）

> 以下是仓库内出现的所有 `RIVET_*` 变量名，按字母排序。迁移时需逐个评估是否加 `TIANSHU_*` 别名。

```
RIVET_ACTIVATION_DEV_BYPASS     RIVET_AMBIGUOUS_WIDTH          RIVET_ANTI_ANCHORING_MCTS
RIVET_APPENDIX_DELTA            RIVET_APPLY_PATCH_VERIFY       RIVET_ASCII_UI
RIVET_AST_EDIT_VERIFY           RIVET_AST_EXCLUDE              RIVET_ASYNC_COPILOT
RIVET_BROWSER_ALLOWLIST         RIVET_BROWSER_DEBUG            RIVET_BROWSER_URL
RIVET_BUND                      RIVET_BUNDLED_BUSYBOX          RIVET_BUNDLED_GIT_DIR
RIVET_BUNDLED_PLUGINS_DIR       RIVET_BUNDLED_SKILLS_DIR       RIVET_CLAIM_AUDIT
RIVET_COMPUTER_USE              RIVET_COMPUTER_USE_AUTOMOUNT   RIVET_CONFIG_PATH
RIVET_CONTROL_PLANE             RIVET_CPU_POOL                 RIVET_CROSS_SESSION_INJECT
RIVET_CU_CDP                    RIVET_CU_CDP_URL               RIVET_CU_COM
RIVET_CU_FEEDBACK               RIVET_CU_HOST                  RIVET_CVM_VECTOR
RIVET_DEAD_END_DETECTOR         RIVET_DEB                      RIVET_DEBU
RIVET_DEBUG                     RIVET_DEBUG_ORPHAN             RIVET_DEBUG_RAW_SSE
RIVET_DEBUG_RENDER              RIVET_DEBUG_TELEMETRY          RIVET_DEBUG_TOOL_INPUT
RIVET_DEBUG_TOOL_STREAM         RIVET_DEFAULT_CWD              RIVET_DESKTOP_DIR
RIVET_DESKTOP_SESSION_DIR       RIVET_DIR                      RIVET_EDIT_SMART_ROUTING
RIVET_EFFORT_ROUTING            RIVET_EMBEDDING_               RIVET_EMBEDDING_API_KEY
RIVET_EMBEDDING_BASE_URL        RIVET_EMBEDDING_MODEL          RIVET_EMBEDDING_TIMEOUT
RIVET_ENV_END__                 RIVET_ENV_START__              RIVET_ESBUILD_LOAD_TIMEOUT
RIVET_EXTERNAL_CLAIM_TRACKING   RIVET_FETCH_PIN                RIVET_FILES
RIVET_FORCE_RECOVERY_CLI        RIVET_FRAME_TELEMETRY          RIVET_GATE_BLOCK_GUARD
RIVET_GENERAL_LEDGER_REMINDER   RIVET_GIT_                     RIVET_GIT_BASH_PATH
RIVET_GIT_CLEAR_GUARD           RIVET_GIT_PATH                 RIVET_HEAD_SENTINEL_
RIVET_HOME                      RIVET_HOOK_EVENT               RIVET_HYPERLINKS
RIVET_IDLE_COMPACTION           RIVET_IDLE_COMPACTION_MS       RIVET_IDLE_COMPACTION_RATIO
RIVET_IMPORT_RESOURCE           RIVET_INPUT                    RIVET_INTENT_ANCHOR
RIVET_INTENT_ANCHOR_STALE       RIVET_INTENT_ANCHOR_TURNS      RIVET_JOB_MAX_MS
RIVET_LANGUAGE_ANCHOR           RIVET_LEAVE_MARK               RIVET_MCP_LOG_BYTES
RIVET_MCP_OAUTH_CLIENT_ID       RIVET_MCP_RECONNECT            RIVET_MD_CACHE_MAX
RIVET_MD_CACHE_TTL_MS           RIVET_MD_PATH                  RIVET_MD_TEMPLATE
RIVET_MEMORY_LIMIT_BYTES        RIVET_MISTAKE_NOTEBOOK         RIVET_NEW_SESSION
RIVET_NOTIFY_BELL               RIVET_NO_AUTO_RESUME           RIVET_NO_CROSS_SESSION
RIVET_NO_EMBEDDINGS             RIVET_NO_S                     RIVET_NO_SANDBOX
RIVET_NO_UPDATE_CHECK           RIVET_OAUTH_TIMEOUT            RIVET_OUTPUT_SANITIZE
RIVET_PAL                       RIVET_PARENT_PID               RIVET_PLAN_MODE_SUGGEST
RIVET_PLAYBOOK                  RIVET_PLAYBOOK_INJECT          RIVET_PORT
RIVET_PRO                       RIVET_PROBE_TRACKING           RIVET_PY_SYNTAX_TIMEOUT
RIVET_READ_REF                  RIVET_REASONING_SPIRAL_GUARD   RIVET_REGRESSION_BISECT
RIVET_RELIABILITY_OVERRIDE      RIVET_RENDER_VERIFY            RIVET_REPO_GRAPH
RIVET_RESUME                    RIVET_RESUME_ID                RIVET_REVIEW_DISCIPLINE
RIVET_RTK                       RIVET_RUNTIME_DIRS             RIVET_RUNTIME_ENV
RIVET_SAND                      RIVET_SANDBOX                  RIVET_SANDBOX_WRITABLE
RIVET_SEARCH_POD                RIVET_SERV                     RIVET_SERVER_TOKEN
RIVET_SERVE_TIMING              RIVET_SESSION_DIR              RIVET_SESSION_ID
RIVET_SIDECAR_CMD               RIVET_SIDECAR_ENTRY            RIVET_SIDECAR_HEAP_MB
RIVET_TAIL_SENTINEL_            RIVET_TDD_GATE                 RIVET_TELEMETRY_LITE
RIVET_TERSE                     RIVET_TEST                     RIVET_TEST_MISSING_KEY
RIVET_TEST_MISSING_KEY_         RIVET_TEST_MISSING_KEY__       RIVET_TEST_NODE_PUBKEY_B
RIVET_TEST_NODE_TOKEN           RIVET_TEST_PRESENCE_GATE       RIVET_TOKEN
RIVET_TOOL_NAME                 RIVET_TOOL_PRESET              RIVET_TURN
RIVET_TURN_BUDGET_WARN          RIVET_TYPECHECK_GATE           RIVET_TYPECHECK_REPO_WIDE
RIVET_USE_                      RIVET_USE_POWERSHELL           RIVET_VERSION
RIVET_VSW                       RIVET_WAVE_GATE                RIVET_WORKER_WRITE_GATE
RIVET_WRAPUP_ANXIETY_GUARD      RIVET_WRITE_OVERWRITE_GUARD    RIVET_WRITE_PROBE
```

> 注：部分带尾随下划线的（如 `RIVET_ENV_START__`、`RIVET_HEAD_SENTINEL_`）是哨兵标记而非配置变量，迁移时无需加别名。

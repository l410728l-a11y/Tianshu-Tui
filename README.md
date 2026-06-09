> [中文文档](README.zh-CN.md)

# Tianshu (天枢)

A full-featured terminal coding agent runtime — intelligent context management, multi-model coordination, DeepSeek V4 prefix cache optimization, structured review disciplines, and extensible tool architecture.

Built with **TypeScript strict** + **Ink 6 (React TUI)** + streaming API. ~150K lines of source code, 520+ test files.

## Why Tianshu

Most AI coding assistants treat context as a bucket — fill it until it overflows, then compress blindly. Tianshu treats context as a **structured, cacheable resource**:

- **Prefix cache hit rate up to 99.6%** on DeepSeek V4's 1M context window through frozen/volatile prompt layering, SHA-256 fingerprint-based drift detection, and adaptive compaction thresholds
- **Cross-turn verification** — every code change is tracked, tested, and delivery-gated before commit; "tests pass" is the floor, not the ceiling
- **Multi-model worker delegation** — spawn isolated headless workers with independent context, adaptive model routing, and 4 aggregation policies
- **Structured review disciplines** — built-in adversarial verification, path boundary checks, and dataflow verification for complex specs

## Features

### Core Agent Loop
- Turn-based LLM → tool → observe → decide cycle with convergence detection and doom-loop escape
- Per-project git checkpoint + rollback, file-level undo via snapshot rewind
- Evidence tracking, failure classification, and delivery gate (blocks unverified changes)

### Context & Cache
- **Frozen + Volatile prompt layering** — system prompt is frozen for maximum cache reuse; project state, git status, and claims are volatile
- **Progressive compaction** — micro-compact (round-safe truncation), smart compact (reactive round selection), and pressure monitoring
- **Artifact persistence** — large tool output goes to disk, only compressed summary enters context

### Tool Suite (49 tools)
| Category | Tools |
|----------|-------|
| **File I/O** | read_file, edit_file, write_file, glob, grep, diff |
| **Execution** | bash, run_tests, sandbox_exec |
| **Git** | git (status, diff, log, stash, commit), undo |
| **Navigation** | repo_map, inspect_project, related_tests, repo_graph |
| **Knowledge** | recall, remember, plan_submit, delegate_task |
| **Web** | web_fetch (HTML→Markdown, SSRF-safe) |
| **Meta** | todo, deliver_task, hash_edit, apply_patch |

### Multi-Model Support
- OpenAI-compatible provider (DeepSeek, any OpenAI API endpoint)
- Anthropic Claude support
- Codex OAuth device flow
- Provider-aware compaction and cache strategies

### Terminal UI (Ink 6 / React)
- Streaming response rendering with code fence sync
- Slash commands: `/compact`, `/rollback`, `/debug cache`, `/sessions`, `/resume`
- Custom slash commands via `.rivet/commands/`
- Session persistence and restore

### Verification & Review
- **Review Discipline** — four enforced rules: no self-approval, spawn adversarial verifier before fix, run existing tests on touched files, fail-closed on green claims without evidence
- **Delivery Gate** — `deliver_task` checks evidence, impacted files, and test results before allowing commit
- **Path Boundary Review** — structured checks for path traversal, classification correctness, and fail-closed security

## Quick Start

```bash
# Install and build
npm install && npm run build

# Set API key (pick one)
export DEEPSEEK_API_KEY=sk-xxx          # env var
rivet config set-key deepseek sk-xxx    # CLI (saved to ~/.rivet/config.json)

# Launch
node dist/main.js
# or globally:
npm install -g && rivet
```

### Headless Mode

```bash
# Single prompt, text output, no TUI
rivet -p "explain src/agent/loop.ts"

# JSON output for scripting
rivet -p "list all TODO comments" --json
```

## Architecture

```
src/
├── agent/         204 modules — core loop, delegation, verification, delivery gate,
│                  convergence detection, worker sessions, coordinator, review discipline
├── api/           Multi-provider clients (DeepSeek, OpenAI, Anthropic, Codex),
│                  streaming, retry engine, provider registry
├── prompt/        System prompt engine — frozen layer + volatile context + XML protocol +
│                  cache diagnostics + SHA-256 fingerprint
├── tools/         49 tool implementations + registry + approval gating
├── tui/           94 Ink 6 / React components — streaming, cockpit, slash commands
├── compact/       Context compression — micro-compact, smart compact, thresholds
├── cache/         Prefix cache management — hit diagnostics, ghost registry, adaptive thresholds
├── context/       Cognitive ledger, claims, pressure monitor, session memory, stigmergy
├── repo/          Code analysis — import graph, symbol index, context bundles
├── config/        Multi-layer: defaults → ~/.rivet → project → session overlay
├── artifact/      Large output persistence with read_section recovery
├── auth/          API key store, OAuth device flow, token management
├── hooks/         Pre/post tool hooks, user prompt hooks, notification hooks
├── mcp/           MCP external tool integration
└── model/         Model capability cards, routing metrics, task type inference
```

## Configuration

### Provider Setup

See [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) for detailed provider configuration (DeepSeek, OpenAI, Anthropic, custom endpoints).

### Project Instructions

Place a `.rivet.md` file in your project root. Its contents are automatically injected as project context:

```markdown
# Project Instructions
- Use pnpm, not npm
- All tests must pass before committing
- Follow conventional commit format
```

### Custom Slash Commands

Define commands in `.rivet/commands/`:

```bash
mkdir -p .rivet/commands
echo 'Review this code for bugs and suggest fixes:
$ARGUMENTS' > .rivet/commands/review.md
```

### Approval Modes

```bash
rivet config set-approval auto-safe                     # recommended — smart risk assessment
rivet config set-approval dangerously-skip-permissions  # trusted workspaces only
```

### Session Persistence

Sessions are saved to `~/.rivet/sessions/`. On restart, press `r` to restore or any key to start fresh.

### Auto-Checkpoint

Tianshu automatically creates a git checkpoint before the first file modification each turn:
- `/rollback` — preview what would be discarded
- `/rollback confirm` — restore to checkpoint

## Development

```bash
npm run typecheck    # tsc --noEmit (strict mode + noUncheckedIndexedAccess)
npm run test         # node:test + assert/strict, 520+ test files
npm run build        # tsup bundle
npm run dev          # watch mode
```

### Code Conventions

- TypeScript strict mode, `noUncheckedIndexedAccess: true`
- No classes for data — use `interface` + plain objects
- Async/await with try-catch, never bare Promise chains
- Tools return `ToolResult { content, isError?, rawPath?, uiContent? }`
- Test files mirror source: `src/agent/foo.ts` → `src/agent/__tests__/foo.test.ts`

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | Provider setup guide (DeepSeek, OpenAI, Anthropic) |
| [`docs/dangerously-skip-permissions.md`](docs/dangerously-skip-permissions.md) | Permission bypass details and safety boundaries |
| [`docs/meridian-architecture.md`](docs/meridian-architecture.md) | Meridian DB architecture (cross-session learning store) |
| [`docs/review-discipline.md`](docs/review-discipline.md) | Structured code review discipline system |
| [`docs/WINDOWS-INSTALL.md`](docs/WINDOWS-INSTALL.md) | Windows installation and shell compatibility guide |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines |
| [`config.example.toml`](config.example.toml) | Example TOML configuration file |

## Statistics

| Metric | Value |
|--------|-------|
| TypeScript source files | ~1,050 |
| Test files | 520+ |
| Source lines | ~150K |
| Tool implementations | 49 |
| Agent modules | 204 |
| TUI components | 94 |
| Dependencies | 10 |

## License

[Apache-2.0](LICENSE)

Copyright 2025-2026 Tianshu Contributors

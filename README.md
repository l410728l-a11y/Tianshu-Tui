# Tianshu (天枢)

A terminal coding agent with intelligent context management, multi-model coordination, and DeepSeek V4 prefix cache optimization.

Built with TypeScript, Ink 6 (React TUI), and streaming API support.

## Features

- **Prefix Cache Optimization** — Up to 99.6% cache hit rate on DeepSeek V4's 1M context window
- **Multi-Model Coordination** — Worker delegation with adaptive routing across models
- **Context Management** — Progressive compaction, anchor registry, and pressure monitoring
- **Review & Verification** — Built-in review disciplines with dataflow verification for complex specs
- **TUI** — Terminal UI with slash commands, session persistence, and auto-checkpoint
- **Tool Suite** — Bash, file editing, grep, glob, git, test runner, web fetch, and more

## Quick Start

```bash
npm install && npm run build

# Set API key
export DEEPSEEK_API_KEY=sk-xxx
# or: rivet config set-key deepseek sk-xxx

# Run
node dist/main.js
# or after npm install -g:
rivet
```

## Commands

```bash
npx tsc --noEmit                                  # typecheck
npm exec -- tsx --test src/**/__tests__/*.test.ts # run tests
npm run build                                      # bundle
npm run dev                                        # watch mode
```

## Architecture

```
src/
├── agent/     Core agent loop, delegation, verification, delivery gate
├── api/       API clients (DeepSeek, OpenAI-compatible), streaming
├── prompt/    System prompt engine (frozen + volatile layers)
├── tools/     Tool implementations and registry
├── tui/       Ink 6 / React terminal UI
├── compact/   Context compression strategies
├── cache/     Prefix cache management
├── repo/      Code repository analysis
├── config/    Multi-layer configuration
└── artifact/  Large output persistence
```

## Configuration

### Provider Setup

See `docs/user-guide-provider-config.md` for detailed provider configuration.

### Project Instructions

Place a `.rivet.md` file in your project root. Its contents are automatically included as context.

### Custom Slash Commands

Define commands in `.rivet/commands/`:

```bash
mkdir -p .rivet/commands
echo 'Review this code for bugs:
$ARGUMENTS' > .rivet/commands/review.md
```

### Approval Modes

```bash
rivet config set-approval auto-safe                     # recommended
rivet config set-approval dangerously-skip-permissions  # trusted workspaces only
```

## Documentation

- `docs/user-guide-provider-config.md` — Provider setup guide
- `docs/dangerously-skip-permissions.md` — Permission bypass details
- `docs/meridian-architecture.md` — Meridian DB architecture
- `docs/review-discipline.md` — Code review discipline system

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run test        # Run all tests (node:test + assert/strict)
npm run build       # tsup bundle
npm run dev         # Watch mode
```

## License

MIT

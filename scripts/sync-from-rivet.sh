#!/usr/bin/env bash
# sync-from-rivet.sh — Sync allowed paths from rivet (internal) to Tianshu (public)
#
# Usage:
#   ./scripts/sync-from-rivet.sh              # dry run (preview)
#   ./scripts/sync-from-rivet.sh --apply       # actually sync + commit
#   ./scripts/sync-from-rivet.sh --apply --push # sync + commit + push
#
# Design:
#   - Only whitelisted paths are copied
#   - Tianshu-own files (README, LICENSE, CONTRIBUTING, CI, etc.) are never overwritten
#   - Each sync creates a single commit with the rivet HEAD hash in the message
#
# Whitelist (what gets synced):
#   src/           — all source code + tests
#   package.json   — dependencies and scripts
#   tsconfig.json  — TypeScript config
#   tsup.config.ts — build config
#   scripts/       — utility scripts
#   prompts/       — tool prompt templates
#   patches/       — dependency patches
#   completions/   — shell completions
#   benchmark/     — benchmark tasks

set -euo pipefail

RIVET_DIR="/Users/banxia/app/deepseek-tui/opencode-tui"
TIANSHU_DIR="/Users/banxia/app/Tianshu"
APPLY=false
PUSH=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --push)  PUSH=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Verify both repos exist
if [ ! -d "$RIVET_DIR/.git" ]; then echo "ERROR: $RIVET_DIR is not a git repo"; exit 1; fi
if [ ! -d "$TIANSHU_DIR/.git" ]; then echo "ERROR: $TIANSHU_DIR is not a git repo"; exit 1; fi

RIVET_HEAD=$(cd "$RIVET_DIR" && git rev-parse --short HEAD)
RIVET_SUBJECT=$(cd "$RIVET_DIR" && git log -1 --format='%s')

echo "=== Sync from rivet ($RIVET_HEAD: $RIVET_SUBJECT) ==="

# Paths to sync (relative to repo root)
SYNC_PATHS=(
  src/
  scripts/
  prompts/
  patches/
  completions/
  benchmark/
  package.json
  tsconfig.json
  tsup.config.ts
)

# Paths that are Tianshu-own and must NOT be overwritten
# (These are maintained separately in the public repo)
# README.md README.zh-CN.md LICENSE CONTRIBUTING.md .github/ docs/ config.example.toml

RSYNC_ARGS=(
  --archive
  --delete              # remove files in dst that don't exist in src
  --verbose
  --exclude='.DS_Store'
  --exclude='node_modules'
  --exclude='dist'
)

if [ "$APPLY" = false ]; then
  RSYNC_ARGS+=(--dry-run)
  echo "--- DRY RUN (use --apply to actually sync) ---"
fi

for path in "${SYNC_PATHS[@]}"; do
  src="$RIVET_DIR/$path"
  if [ -e "$src" ]; then
    echo "  $path"
    rsync "${RSYNC_ARGS[@]}" "$src" "$TIANSHU_DIR/$path"
  else
    echo "  SKIP $path (not found in rivet)"
  fi
done

if [ "$APPLY" = false ]; then
  echo ""
  echo "=== Preview complete. Run with --apply to sync. ==="
  exit 0
fi

# Re-sync package-lock.json if it changed (npm install may be needed)
if ! diff -q "$RIVET_DIR/package-lock.json" "$TIANSHU_DIR/package-lock.json" >/dev/null 2>&1; then
  echo "  package-lock.json changed, copying..."
  cp "$RIVET_DIR/package-lock.json" "$TIANSHU_DIR/package-lock.json"
fi

cd "$TIANSHU_DIR"

# Check if anything actually changed
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "=== No changes to sync ==="
  exit 0
fi

# Stage and commit
git add -A
git commit -m "sync: from rivet ${RIVET_HEAD} — ${RIVET_SUBJECT}"

echo ""
echo "=== Synced and committed ==="
git log -1 --oneline

if [ "$PUSH" = true ]; then
  git push
  echo "=== Pushed to origin ==="
fi

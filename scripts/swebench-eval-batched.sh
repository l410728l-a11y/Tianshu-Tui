#!/bin/bash
# Batch SWE-bench evaluation with Colima cleanup between batches.
# Runs 10 predictions per batch, then deletes the Colima VM to reclaim disk.
#
# Usage:
#   bash scripts/swebench-eval-batched.sh
#
# Resumable: skips batches whose log directory already exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BATCH_DIR="/tmp/swebench-batches"
BATCH_SIZE=10
TIMEOUT_PER_BATCH=14400  # 4 hours per batch of 10

cd "$PROJECT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

cleanup_colima() {
  log "Cleaning up Colima..."
  colima stop 2>/dev/null || true
  colima delete --force 2>/dev/null || true
  # Remove the leftover disk image to reclaim space immediately
  rm -rf "$HOME/.colima/_lima/_disks/colima"
  log "Colima cleanup done. Disk space:"
  df -h /System/Volumes/Data | tail -1
}

start_colima() {
  log "Starting Colima (disk 60GB)..."
  colima start --vm-type vz --vz-rosetta --disk 60 --cpu 4 --memory 8 2>&1 | tail -10
}

# Discover batches
batches=("$BATCH_DIR"/batch-*)
total_batches=${#batches[@]}
log "Found $total_batches batches under $BATCH_DIR"

for i in "${!batches[@]}"; do
  batch_file="${batches[$i]}"
  batch_num=$(printf "%02d" "$i")
  run_id="tianshu-batch-$batch_num"
  log_dir="logs/run_evaluation/$run_id"

  log "========================================"
  log "Batch $batch_num / $total_batches: $batch_file"
  log "========================================"

  # Skip if already evaluated
  if [ -d "$log_dir" ]; then
    completed=$(find "$log_dir/tianshu-agent-v1" -name 'run_instance.log' 2>/dev/null | wc -l | tr -d ' ')
    if [ "$completed" -eq "$BATCH_SIZE" ]; then
      log "Batch $batch_num already complete ($completed/$BATCH_SIZE). Skipping."
      continue
    fi
    log "Batch $batch_num partially complete ($completed/$BATCH_SIZE). Re-running."
  fi

  # Retry loop for this batch (helps with transient network/SSL errors)
  max_attempts=3
  attempt=0
  while true; do
    attempt=$((attempt + 1))

    # Make sure Colima is fresh
    cleanup_colima
    start_colima

    # Run evaluation for this batch
    log "Running evaluation for batch $batch_num (RUN_ID=$run_id, attempt $attempt/$max_attempts)..."
    set +e
    timeout "$TIMEOUT_PER_BATCH" env RUN_ID="$run_id" bash "$SCRIPT_DIR/swebench-eval.sh" "$batch_file" \
      >"/tmp/swebench-batch-$batch_num.log" 2>&1
    exit_code=$?
    set -e

    # SWE-bench harness may non-zero-exit during the reporting phase (e.g. SSL
    # errors while fetching requirements from raw.githubusercontent.com) even
    # though every instance has already finished. Treat the batch as complete
    # if we have a run_instance.log for every prediction.
    completed=$(find "$log_dir/tianshu-agent-v1" -name 'run_instance.log' 2>/dev/null | wc -l | tr -d ' ')
    if [ "$completed" -eq "$BATCH_SIZE" ]; then
      log "Batch $batch_num instances complete ($completed/$BATCH_SIZE). Harness exit code was $exit_code."
      if [ "$exit_code" -ne 0 ]; then
        log "⚠️  Report-phase failure recorded; see /tmp/swebench-batch-$batch_num.log"
      fi
      break
    fi

    if [ "$exit_code" -ne 0 ]; then
      log "Batch $batch_num attempt $attempt exited with code $exit_code ($completed/$BATCH_SIZE instances logged)."
      if [ "$attempt" -lt "$max_attempts" ]; then
        log "Retrying batch $batch_num after short pause..."
        sleep 10
        continue
      fi
      log "Tail of harness output:"
      tail -30 "/tmp/swebench-batch-$batch_num.log" || true
      cleanup_colima
      exit 1
    fi

    # Should not reach here, but treat as complete if no error
    break
  done

  # Cleanup immediately after batch
  cleanup_colima
  log "Batch $batch_num done. Moving to next batch."
done

log "All batches processed."

#!/usr/bin/env bash
# run-projects.sh
# Usage:
#   ./run-projects.sh           -> runs both services in background
#   ./run-projects.sh aws       -> runs only AWS-transciber
#   ./run-projects.sh cluley    -> runs only Cluley-clone
# Logs written to ./logs/aws.log and ./logs/cluley.log
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$ROOT_DIR/AWS-transciber/bd"
CLULEY_DIR="$ROOT_DIR/Cluley-clone"
LOG_DIR="$ROOT_DIR/logs"

mkdir -p "$LOG_DIR"
: > "$LOG_DIR/aws.log"
: > "$LOG_DIR/cluley.log"
# Commands to run
AWS_CMD="npm run dev --no-color"
CLULEY_CMD="npm run dev --no-color"

pids=()

function start_aws() {
  echo "Starting AWS-transciber (in $AWS_DIR) -> $LOG_DIR/aws.log"
  cd "$AWS_DIR"
  # run in background and redirect stdout/stderr to log
  ( $AWS_CMD >> "$LOG_DIR/aws.log" 2>&1 ) &
  pids+=($!)
  cd "$ROOT_DIR"
}

function start_cluley() {
  echo "Starting Cluley-clone (in $CLULEY_DIR) -> $LOG_DIR/cluley.log"
  cd "$CLULEY_DIR"
  ( $CLULEY_CMD >> "$LOG_DIR/cluley.log" 2>&1 ) &
  pids+=($!)
  cd "$ROOT_DIR"
}

function stop_all() {
  echo
  echo "Stopping children pids: ${pids[*]:-none}"
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
    fi
  done
  # give them a moment, then force kill if still alive
  sleep 1
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" || true
    fi
  done
  exit 0
}

trap stop_all SIGINT SIGTERM EXIT

case "${1:-}" in
  aws)
    start_aws
    ;;
  cluley)
    start_cluley
    ;;
  "" )
    start_aws
    start_cluley
    ;;
  *)
    echo "Unknown arg: $1"
    echo "Usage: $0 [aws|cluley]"
    exit 2
    ;;
esac

echo "Started. Tailing logs (press Ctrl+C to stop)..."
# Tail both logs in a simple loop (so container exits when user ^C)
# If you prefer separate terminals, see the alternatives below.
tail -F "$LOG_DIR/aws.log" "$LOG_DIR/cluley.log" &
TAIL_PID=$!
pids+=($TAIL_PID)

# wait on background jobs
wait

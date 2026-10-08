#!/usr/bin/env bash
#
# watch_loop.sh - continuous wrapper around run_once.sh.
#
# Loops forever: run one full cycle, then sleep LOOP_INTERVAL_MIN minutes, repeat.
# After each cycle it prints a rolling summary read from history.csv (total runs,
# total signals, how many were fork-confirmed REAL vs MIRAGE, best real net seen, and
# the time span covered). Traps SIGINT/SIGTERM to exit cleanly with a final summary.
#
# Resumable + nohup-safe: each cycle uses a fresh timestamped RUN_ID and appends to the
# shared history.csv and results dir, so stopping and restarting just continues the
# series. Safe to launch under nohup:  nohup bash harness/watch_loop.sh >> harness/loop.out 2>&1 &
#
# SAFETY: measurement only. Delegates all chain access to the read-only watcher + the
# fork simulation in run_once.sh. NEVER broadcasts a transaction, holds keys, or funds.
#
# Environment:
#   RPC_URL            (required) passed through to run_once.sh.
#   LOOP_INTERVAL_MIN  minutes to sleep between cycles, default 60.
#   RUN_MINUTES        watcher minutes per cycle, default 30 (see run_once.sh).
#   TOP_N              firing blocks to fork-confirm per cycle, default 3.
#   MAX_CYCLES         optional cap on cycles (default 0 = run forever). Useful for tests.
#   HARNESS_DIR/RESULTS_DIR/POOLS_CONFIG/HISTORY_CSV - same as run_once.sh.
#
set -uo pipefail

unset NODE_OPTIONS || true

HARNESS_DIR="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HISTORY_CSV="${HISTORY_CSV:-$HARNESS_DIR/history.csv}"
LOOP_INTERVAL_MIN="${LOOP_INTERVAL_MIN:-60}"
MAX_CYCLES="${MAX_CYCLES:-0}"

export HARNESS_DIR HISTORY_CSV

log() { echo "watch_loop: $*"; }

final_summary() {
  echo ""
  echo "============================================================"
  echo "watch_loop: stopping - final rolling summary:"
  node "$HARNESS_DIR/make_report.mjs" summarize "$HISTORY_CSV" 2>/dev/null || true
  echo "============================================================"
}

STOP=0
on_signal() { log "signal received; will stop after the current cycle settles."; STOP=1; }
trap 'on_signal' INT TERM
trap 'final_summary' EXIT

[ -n "${RPC_URL:-}" ] || { log "ERROR: RPC_URL is not set. export RPC_URL=<Arbitrum RPC> first."; exit 1; }

log "starting continuous loop. interval ${LOOP_INTERVAL_MIN} min. history: $HISTORY_CSV"
log "stop with Ctrl+C (foreground) or: kill \$(pgrep -f watch_loop.sh)"

cycle=0
while :; do
  cycle=$((cycle + 1))
  log "=== cycle $cycle starting ==="
  # Run one cycle. We do NOT let a single failed cycle kill the loop (set -e is off);
  # run_once.sh fails loudly and the loop continues to the next interval.
  if bash "$HARNESS_DIR/run_once.sh"; then
    log "cycle $cycle complete."
  else
    rc=$?
    log "cycle $cycle FAILED (exit $rc). See the run's logs under results/. Continuing."
  fi

  # Print the rolling summary after every cycle.
  echo ""
  node "$HARNESS_DIR/make_report.mjs" summarize "$HISTORY_CSV" 2>/dev/null || true
  echo ""

  if [ "$STOP" = "1" ]; then log "stop requested - exiting loop."; break; fi
  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    log "reached MAX_CYCLES=$MAX_CYCLES - exiting loop."; break
  fi

  log "sleeping ${LOOP_INTERVAL_MIN} min before the next cycle (Ctrl+C to stop)..."
  # Sleep in short slices so a SIGINT is noticed promptly.
  slept=0
  total=$((LOOP_INTERVAL_MIN * 60))
  while [ "$slept" -lt "$total" ]; do
    [ "$STOP" = "1" ] && break
    sleep 5
    slept=$((slept + 5))
  done
  if [ "$STOP" = "1" ]; then log "stop requested during sleep - exiting loop."; break; fi
done

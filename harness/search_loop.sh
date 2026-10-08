#!/usr/bin/env bash
#
# search_loop.sh - continuous wrapper around the smarter autonomous search.
#
# Loops forever: run one adaptive search cycle (node harness/search_once.mjs), then
# sleep LOOP_INTERVAL_MIN minutes, repeat. Each cycle picks a small adaptive BATCH of
# markets from the watchlist, scans them read-only (throttled + 429 backoff), updates
# the persistent scoreboard, appends to gaps_history.csv, and prints the ranked
# top-gaps research table. When a cycle surfaces a shape-CONFIRMABLE threshold crossing
# (a REAL + scalable candidate), a loud ALERT banner is printed.
#
# Resumable + nohup-safe: the scoreboard + gaps_history.csv persist across cycles, so
# stopping and restarting just continues the series. Launch under nohup:
#   nohup bash harness/search_loop.sh >> harness/search_loop.out 2>&1 &
#
# SAFETY: measurement only. Delegates all chain access to the read-only scanner. NEVER
# broadcasts a transaction, holds keys, or funds anything. A cycle that hits rate limits
# degrades gracefully (the scanner backs off) and the loop prints a message, not a crash.
#
# Environment:
#   ARBITRUM_RPC_URL / BASE_RPC_URL  per-chain RPC URLs (named by the watchlist's
#                                    rpc_env). At least ONE must be set.
#   RPC_URL            optional convenience: if set and a per-chain var is unset, it is
#                      exported to BOTH per-chain vars so a single endpoint still runs.
#   LOOP_INTERVAL_MIN  minutes to sleep between cycles, default 10.
#   BATCH_SIZE         markets to scan per cycle (overrides watchlist.batch_size).
#   BLOCKS_PER_MARKET  recent blocks sampled per market (overrides the watchlist).
#   NET_THRESHOLD_USD  net gap (USD) that triggers a fork-confirm plan (overrides).
#   SKIP_FORGE         reserved: the loop never runs forge itself (confirm is user-side).
#   MAX_CYCLES         optional cap on cycles (default 0 = run forever). Useful for tests.
#   HARNESS_DIR        harness dir, default: the directory this script lives in.
#
set -uo pipefail

# The sandbox (and possibly the user's WSL) points NODE_OPTIONS at a bootstrap that may
# not exist; clear it so node runs. Harmless when NODE_OPTIONS was unset.
unset NODE_OPTIONS || true

HARNESS_DIR="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LOOP_INTERVAL_MIN="${LOOP_INTERVAL_MIN:-10}"
MAX_CYCLES="${MAX_CYCLES:-0}"
SKIP_FORGE="${SKIP_FORGE:-1}"

export HARNESS_DIR SKIP_FORGE
export BATCH_SIZE="${BATCH_SIZE:-}"
export BLOCKS_PER_MARKET="${BLOCKS_PER_MARKET:-}"
export NET_THRESHOLD_USD="${NET_THRESHOLD_USD:-}"

log() { echo "search_loop: $*"; }

# Convenience: a single RPC_URL fills in any unset per-chain var so one endpoint works.
if [ -n "${RPC_URL:-}" ]; then
  [ -n "${ARBITRUM_RPC_URL:-}" ] || export ARBITRUM_RPC_URL="$RPC_URL"
  [ -n "${BASE_RPC_URL:-}" ] || export BASE_RPC_URL="$RPC_URL"
fi

# Require at least one chain RPC env to be set.
if [ -z "${ARBITRUM_RPC_URL:-}" ] && [ -z "${BASE_RPC_URL:-}" ]; then
  log "ERROR: no chain RPC env set. export ARBITRUM_RPC_URL=<...> and/or BASE_RPC_URL=<...> (or RPC_URL) first."
  exit 1
fi

final_summary() {
  echo ""
  echo "============================================================"
  echo "search_loop: stopping - final top-gaps from the scoreboard:"
  node "$HARNESS_DIR/search_once.mjs" top-gaps "$HARNESS_DIR/scoreboard.json" 2>/dev/null || true
  echo "============================================================"
}

STOP=0
on_signal() { log "signal received; will stop after the current cycle settles."; STOP=1; }
trap 'on_signal' INT TERM
trap 'final_summary' EXIT

log "starting continuous search loop. interval ${LOOP_INTERVAL_MIN} min."
log "stop with Ctrl+C (foreground) or: kill \$(pgrep -f search_loop.sh)"

cycle=0
while :; do
  cycle=$((cycle + 1))
  log "=== cycle $cycle starting ==="
  # A single failed cycle must not kill the loop (set -e is off). The scanner backs off
  # on 429 internally; if a cycle still errors we log and continue to the next interval.
  CYCLE_OUT="$(node "$HARNESS_DIR/search_once.mjs" 2>&1)"; rc=$?
  echo "$CYCLE_OUT"
  if [ "$rc" -ne 0 ]; then
    log "cycle $cycle returned non-zero (exit $rc). Likely rate-limited; continuing after the interval."
  else
    log "cycle $cycle complete."
  fi

  # Loud ALERT banner when a cycle surfaced a shape-CONFIRMABLE (REAL + scalable) candidate.
  if echo "$CYCLE_OUT" | grep -q "STRONG CANDIDATE"; then
    echo ""
    echo "################################################################"
    echo "##  ALERT: a REAL + scalable fork-confirmable candidate was    ##"
    echo "##  surfaced this cycle. Review the STRONG CANDIDATE line above ##"
    echo "##  and run the WethUsdcCycle fork test with the printed env.   ##"
    echo "################################################################"
    echo ""
  fi

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

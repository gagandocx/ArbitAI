#!/usr/bin/env bash
#
# run_once.sh - ONE full ArbitAI measurement cycle (preflight -> watch -> pick -> fork-confirm -> report).
#
# Steps:
#   (a) require RPC_URL to be set (the watcher + the fork test both need it).
#   (b) validate the pools config (refuse to run while a placeholder address remains)
#       and run the watcher --check preflight; abort on any failing pool.
#   (c) run the live two-DEX watcher for RUN_MINUTES, writing a per-run CSV.
#   (d) parse the CSV for would_fire==true rows and pick the TOP_N blocks by net_usd.
#   (e) for each chosen block, run the WethUsdcCycle forge fork test at that block,
#       capturing stdout to a per-block log. Skipped entirely if there were 0 signals.
#   (f) build a per-run report.md (watcher quote net vs real fork USDC-in/out, REAL vs MIRAGE).
#   (g) append one row to harness/history.csv.
#
# SAFETY: measurement only. Read-only watcher + fork simulation. NEVER broadcasts a
# transaction, holds keys, or funds anything. Fails loudly rather than silently.
#
# Environment (all optional except RPC_URL):
#   RPC_URL           (required) Arbitrum RPC URL (your Alchemy endpoint).
#   RUN_MINUTES       watcher duration, default 30.
#   TOP_N             how many firing blocks to fork-confirm, default 3.
#   HARNESS_DIR       harness dir, default: the directory this script lives in.
#   RESULTS_DIR       where per-run artifacts land, default $HARNESS_DIR/results.
#   POOLS_CONFIG      pools JSON, default $HARNESS_DIR/pools.arbitrum.json.
#   ARB_V2_DIR        Foundry project dir, default <repo>/arb-v2.
#   RUN_ID            optional explicit run id (default: UTC timestamp). Resumable.
#   SKIP_FORGE        if "1", skip the forge step (e.g. a watch-only measurement pass).
#
set -euo pipefail

# The sandbox (and possibly the user's WSL) sets NODE_OPTIONS to a bootstrap that may
# not exist; clear it so node/npm run. Harmless when NODE_OPTIONS was unset.
unset NODE_OPTIONS || true

HARNESS_DIR="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_DIR="$(cd "$HARNESS_DIR/.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$HARNESS_DIR/results}"
POOLS_CONFIG="${POOLS_CONFIG:-$HARNESS_DIR/pools.arbitrum.json}"
ARB_V2_DIR="${ARB_V2_DIR:-$REPO_DIR/arb-v2}"
HISTORY_CSV="${HISTORY_CSV:-$HARNESS_DIR/history.csv}"
RUN_MINUTES="${RUN_MINUTES:-30}"
TOP_N="${TOP_N:-3}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
SKIP_FORGE="${SKIP_FORGE:-0}"

WATCHER="$REPO_DIR/sim/live_two_dex_watcher.mjs"

die() { echo "run_once: ERROR: $*" >&2; exit 1; }
log() { echo "run_once: $*"; }

# --- (a) require RPC_URL -----------------------------------------------------
[ -n "${RPC_URL:-}" ] || die "RPC_URL is not set. export RPC_URL=<your Arbitrum RPC URL> first."
[ -f "$POOLS_CONFIG" ] || die "pools config not found: $POOLS_CONFIG"
[ -f "$WATCHER" ] || die "watcher not found: $WATCHER"

mkdir -p "$RESULTS_DIR"
RUN_DIR="$RESULTS_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"
CSV_PATH="$RUN_DIR/watch.csv"

CHAIN="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" chain)"
log "run id $RUN_ID  chain $CHAIN  minutes $RUN_MINUTES  top_n $TOP_N"
log "results dir: $RUN_DIR"

# --- (b) validate config + preflight ----------------------------------------
if ! node "$HARNESS_DIR/config.mjs" validate "$POOLS_CONFIG"; then
  die "pools config has placeholder addresses. Edit $POOLS_CONFIG (fill in the PancakeSwap pool/quoter, verify Uniswap) and re-run."
fi

# Build the watcher --check args from the config, then preflight each pool once.
mapfile -t CHECK_ARGS < <(node "$HARNESS_DIR/config.mjs" pools-check-args "$POOLS_CONFIG")
log "preflight --check on configured pools..."
if ! node "$WATCHER" "${CHECK_ARGS[@]}" | tee "$RUN_DIR/preflight.txt"; then
  die "preflight FAILED. Fix the pools that printed ❌ in $RUN_DIR/preflight.txt before running."
fi

# --- (c) run the watcher for RUN_MINUTES ------------------------------------
mapfile -t WATCH_ARGS < <(node "$HARNESS_DIR/config.mjs" watcher-args "$POOLS_CONFIG")
log "watching for $RUN_MINUTES min -> $CSV_PATH"
# The watcher writes the CSV header itself if the file is absent. Resumable: a re-run
# with the same RUN_ID appends to the existing CSV.
node "$WATCHER" "${WATCH_ARGS[@]}" --minutes "$RUN_MINUTES" --log "$CSV_PATH" \
  2>&1 | tee "$RUN_DIR/watch.log" || die "watcher exited non-zero (see $RUN_DIR/watch.log)"

# --- (d) pick top-N firing blocks -------------------------------------------
BLOCKS_WATCHED=0
if [ -f "$CSV_PATH" ]; then
  # count data rows (exclude header)
  BLOCKS_WATCHED="$(grep -c -v '^block,pair,' "$CSV_PATH" || true)"
fi
mapfile -t PICKS < <(node "$HARNESS_DIR/parse_fires.mjs" "$CSV_PATH" "$TOP_N")
SIGNALS="${#PICKS[@]}"
log "blocks watched: $BLOCKS_WATCHED  firing picks: $SIGNALS"

# Begin the run manifest the report helper consumes.
MANIFEST="$RUN_DIR/manifest.json"
REPORT_MD="$RUN_DIR/report.md"
CONFIRMED_JSON="[]"

if [ "$SIGNALS" -eq 0 ]; then
  log "no WOULD-FIRE signals this run - recording a clean zero-signal run, no fork step."
else
  # --- (e) fork-confirm each chosen block -----------------------------------
  WETH="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" weth)"
  USDC="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" usdc)"
  POOL_A="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" pools.A.pool)"
  POOL_B="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" pools.B.pool)"
  POOL_C="$(node "$HARNESS_DIR/config.mjs" get "$POOLS_CONFIG" pools.C.pool)"

  CONFIRMED_ENTRIES=()
  for line in "${PICKS[@]}"; do
    # each line: "block net_usd pair dir size_usd"
    BLOCK="$(echo "$line" | awk '{print $1}')"
    QNET="$(echo "$line" | awk '{print $2}')"
    GAS_FROM_CSV="$(awk -F, -v b="$BLOCK" '$1==b {print $6; exit}' "$CSV_PATH" 2>/dev/null || echo 0)"
    [ -n "$GAS_FROM_CSV" ] || GAS_FROM_CSV=0
    FORK_LOG="$RUN_DIR/fork_${BLOCK}.log"

    if [ "$SKIP_FORGE" = "1" ]; then
      log "SKIP_FORGE=1 set; not running forge for block $BLOCK (recording quote only)."
      : > "$FORK_LOG"
    else
      command -v forge >/dev/null 2>&1 || die "forge not found. Install Foundry (foundryup) to fork-confirm, or set SKIP_FORGE=1."
      log "fork-confirming block $BLOCK with WethUsdcCycle..."
      # forge-std must be present; install once (idempotent). Run in WSL home, not /mnt/c.
      ( cd "$ARB_V2_DIR" \
        && [ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-commit \
        ; WETH="$WETH" USDC="$USDC" POOL_A="$POOL_A" POOL_B="$POOL_B" POOL_C="$POOL_C" \
          forge test --match-contract WethUsdcCycle --fork-url "$RPC_URL" \
            --fork-block-number "$BLOCK" -vv ) 2>&1 | tee "$FORK_LOG" || \
        log "WARNING: forge returned non-zero for block $BLOCK (log kept at $FORK_LOG); verdict will degrade to MIRAGE."
    fi

    CONFIRMED_ENTRIES+=("{\"block\":$BLOCK,\"quoteNetUsd\":$QNET,\"gasUsd\":$GAS_FROM_CSV,\"logPath\":\"$FORK_LOG\"}")
  done
  # join entries with commas
  CONFIRMED_JSON="[$(IFS=,; echo "${CONFIRMED_ENTRIES[*]}")]"
fi

# --- (f) write manifest + build report.md + (g) append history --------------
cat > "$MANIFEST" <<EOF
{
  "timestamp": "$RUN_ID",
  "chain": "$CHAIN",
  "minutes": $RUN_MINUTES,
  "csvPath": "$CSV_PATH",
  "blocksWatched": $BLOCKS_WATCHED,
  "signals": $SIGNALS,
  "confirmed": $CONFIRMED_JSON
}
EOF

node "$HARNESS_DIR/write_run.mjs" "$MANIFEST" "$REPORT_MD" "$HISTORY_CSV"
log "report: $REPORT_MD"
log "history: $HISTORY_CSV"
log "done ($RUN_ID)."

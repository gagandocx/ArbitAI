# ArbitAI continuous measurement harness

This harness automates the full ArbitAI test loop so you kick it off once and it runs
itself. Every cycle it:

1. runs a **preflight pool check** (reads each configured pool once, verdicts it),
2. runs the **live two-DEX watcher** for a while (read-only quotes, per block),
3. automatically **picks the blocks where it fired** (top N by net USD),
4. **confirms each of those blocks with the `WethUsdcCycle` fork test** (REAL swaps at
   several sizes, on a fork at that exact block),
5. writes a clear **REAL vs MIRAGE verdict** per block into a per-run `report.md`,
6. appends one row to a running **`history.csv`** so the trend accumulates over days,
7. repeats on a schedule, printing a rolling summary after each cycle.

Target: **Arbitrum WETH/USDC** across **Uniswap V3, PancakeSwap V3, SushiSwap V3**.

> **This harness MEASURES whether a capturable edge exists and flags one if it ever
> appears. It cannot create an edge.** Consistent with the project's standing finding,
> apparent gaps are almost always mirages (shallow depth collapses under real size) or
> a sub-second latency race. A quote is not a trade; only a fork-confirmed REAL verdict
> that clears gas AND holds as size grows is worth a second look.

## Safety (read this once)

The harness is **measurement only**: a read-only watcher plus a fork simulation. It
**never broadcasts a transaction, holds keys, or funds anything.** There is no signing
or private-key handling anywhere in it. Scripts fail loudly rather than silently.

---

# Smarter autonomous search (the new primary workflow)

The single-market harness below (sections 1-8) still works and is kept for reference.
The **recommended** way to research price gaps now is the **smarter autonomous search**:
one `harness/search_loop.sh` that scans a whole **watchlist** of chains, pairs, and DEXes
by itself, auto-discovers the pool addresses, learns which markets show the biggest gaps,
and keeps a ranked **top-gaps research report** that accumulates over days. You configure
it once and leave it running.

> **Same honest caveat, scaled up.** This search **MEASURES and MAPS real cross-DEX price
> gaps across many markets and flags any capturable edge if one ever appears. It cannot
> create an edge.** Every chain touch is a read-only quote (`eth_call`); the only "real
> swap" check is the `WethUsdcCycle` fork simulation, run by you. It never trades, never
> holds keys, never funds anything. Consistent with the standing finding, apparent gaps
> are almost always mirages (shallow depth collapses under real size) or a sub-second
> latency race; a quote is not a trade.

## S1. The watchlist (`harness/watchlist.json`)

The search space is a single dependency-free config, `harness/watchlist.json`. **No key
material and no RPC URL ever live in this file** - each chain names an *env var* and the
URL is read from the environment at run time.

Seeded contents:

- **Chains:** `arbitrum` and `base`, both enabled. Each names its RPC env var
  (`rpc_env`): Arbitrum -> `ARBITRUM_RPC_URL`, Base -> `BASE_RPC_URL`.
  (Polygon is Alchemy-free-tier-enabled and a natural next chain to add, but is **not**
  seeded. Optimism is **not** on the free tier and is **not** included.)
- **Pairs:** `WETH/USDC`, `WETH/USDT`, `WBTC/WETH`, `WETH/DAI`, plus `ARB/WETH`
  (arbitrum-only via an `"chains": ["arbitrum"]` allow-list) and `cbETH/WETH`
  (base-only). A pair whose token does not exist on a chain is **skipped gracefully**,
  never an error.
- **DEXes:** `uniswap`, `pancake`, `sushi`. For each `(chain, pair)` the search
  discovers each DEX's V3 pool and compares the three cross-DEX cycles
  (uniswap<->pancake, uniswap<->sushi, pancake<->sushi) exactly like the watcher's
  SAME-PAIR mode.
- **Tunables:** `batch_size` (4), `blocks_per_market` (2), `base_delay_ms` (250),
  `max_delay_ms` (5000), `net_threshold_usd` (0.5), and `sizes`
  (`[1000, 5000, 20000, 100000]` USD notional). See the knobs table in **S6**.

Pair tokens resolve from the canonical `TOKENS` map in `sim/dex_registry.mjs` (per
chain). A **wide search runs SLOWLY on a free RPC tier by design**: small `batch_size`,
few `blocks_per_market`, inter-call throttle, and 429 backoff keep it under the rate
limit instead of crashing.

## S2. Auto-discovery of pool addresses (you do NOT hand-enter pools)

You never paste pool addresses for the autonomous search. For each `(chain, pair, DEX)`
the scanner calls that DEX's **V3 factory `getPool(tokenA, tokenB, fee)`** (read-only
`eth_call`, selector `0x1698ee82`) once per fee tier and keeps the non-zero pool(s). A
non-existent pool simply returns `address(0)` and is skipped - harmless and visible.

The factory and quoter addresses come from `sim/dex_registry.mjs`, which labels each one
**VERIFIED** or **UNVERIFIED**:

- **VERIFIED (reuse as-is):**
  - **All Base factories and quoters** (confirmed in-repo via `sim/base_live_check.mjs`):
    Uniswap, PancakeSwap, SushiSwap.
  - **Every per-DEX QuoterV2 on both chains** (Uniswap, Pancake, Sushi).
- **UNVERIFIED (overridable defaults you MUST confirm):**
  - **The three Arbitrum V3 *factories*** (Uniswap `0x1F98431c...`, Pancake
    `0x41ff9AA7...`, Sushi `0x1af415a1...`). These are well-known multi-chain
    deployments but are **not independently confirmed for Arbitrum in this repo**.
    **Confirm each on [Arbiscan](https://arbiscan.io/) / [Basescan](https://basescan.org/)
    or the DEX's official docs before trusting a live run.** A wrong factory just returns
    `address(0)` for every tier (no pool found), so a mistake is loud, not silent.

## S3. Persistent scoreboard + adaptive focus

Each cycle writes/updates `harness/scoreboard.json` (via `sim/scoreboard.mjs`). The
scoreboard remembers, per market, the **best gap**, a running **median gap**, how many
**times** it has been checked, and when it was **last checked**. From that, each cycle
picks a small **adaptive batch**: it biases toward the **highest-gap markets** (exploit)
while **round-robining the least-recently-seen / never-seen markets** (explore) so the
long tail is never starved. The scoreboard persists across restarts, so stopping and
relaunching just continues the same series.

## S4. Rate-limit safety on a free tier

Alchemy's free tier returns HTTP 429 under load. The search is built to **degrade
gracefully, never crash**:

- small `batch_size` markets per cycle,
- only `blocks_per_market` recent blocks sampled per market,
- an inter-call **throttle** (`base_delay_ms`, growing toward `max_delay_ms` when 429s
  appear, via `sim/backoff.mjs`),
- **429 backoff**: on a rate-limit error the scanner backs off and **continues** rather
  than throwing out of the loop.

A WIDE search is therefore SLOW on purpose. That is the correct trade on a free tier.

## S5. The exact commands

**(a) Configure / extend / validate the watchlist.** Edit `harness/watchlist.json`, then:

```bash
unset NODE_OPTIONS
# validate the shape (chains/pairs/dexes/knobs) before a run:
node harness/watchlist.mjs validate harness/watchlist.json
# see the concrete markets it expands to (enabled chains x available-token pairs):
node harness/watchlist.mjs expand harness/watchlist.json
# read any value by dotted key, e.g. a tunable:
node harness/watchlist.mjs get harness/watchlist.json batch_size
```

**(b) Launch the continuous search** (set at least one chain RPC env first):

```bash
unset NODE_OPTIONS
export ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
export BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
# (convenience: a single RPC_URL fills in any unset per-chain var)
nohup bash harness/search_loop.sh >> harness/search_loop.out 2>&1 &
tail -f harness/search_loop.out
```

Run a **single cycle** by hand (useful to test) without the loop:

```bash
unset NODE_OPTIONS
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY node harness/search_once.mjs
```

**(c) Read the ranked top-gaps research report** at any time, WITHOUT scanning:

```bash
unset NODE_OPTIONS
node harness/search_once.mjs top-gaps harness/scoreboard.json
# optional row limit (default 20):
node harness/search_once.mjs top-gaps harness/scoreboard.json 30
```

This prints a Markdown table ranked by best gap:
`chain | pair | DEX pair | best gap (bps) | median gap (bps) | times seen | last seen`.
Each cycle also appends one row per observation to the append-only
`harness/gaps_history.csv`
(columns: `timestamp,chain,pair,dex_pair,block,gross_gap_usd,net_usd,would_confirm`),
so the raw series accumulates for later analysis.

When an observation's `net_usd` crosses `net_threshold_usd`, the cycle assembles the
`WethUsdcCycle` fork-test env for it. For a **WETH/USDC-shaped** pair (18-dec base + a
stablecoin quote) it prints a **CONFIRMABLE** plan (base->`WETH`, quote->`USDC`, the
discovered pools->`POOL_A/POOL_B/POOL_C`) and, in the loop, a loud `STRONG CANDIDATE` /
`ALERT` banner. For a **mismatched shape** (e.g. `WBTC` 8-dec base, or a non-stable
quote) it degrades to **UNCONFIRMED/SKIPPED** with a note that a tailored test is needed
and **never claims REAL** without a shape-correct fork run.

## S6. Env knobs (new autonomous search)

All optional except at least one chain RPC URL. Defaults shown are what the code uses.

| var | default | meaning |
| --- | --- | --- |
| `ARBITRUM_RPC_URL` | (none) | Arbitrum RPC URL (named by `watchlist.chains.arbitrum.rpc_env`). |
| `BASE_RPC_URL` | (none) | Base RPC URL (named by `watchlist.chains.base.rpc_env`). |
| `RPC_URL` | (none) | Convenience: if set, fills any unset per-chain var so one endpoint runs both. **At least one** chain RPC must be set. |
| `LOOP_INTERVAL_MIN` | 10 | Minutes the loop sleeps between cycles. |
| `BATCH_SIZE` | 4 | Markets scanned per cycle (overrides `watchlist.batch_size`). |
| `BLOCKS_PER_MARKET` | 2 | Recent blocks sampled per market (overrides `watchlist.blocks_per_market`). |
| `NET_THRESHOLD_USD` | 0.5 | Net gap (USD) that triggers a fork-confirm plan (overrides `watchlist.net_threshold_usd`). |
| `MAX_CYCLES` | 0 | 0 = run forever; set a number to cap cycles (useful for tests). |
| `SKIP_FORGE` | 1 | Reserved. The loop never runs `forge` itself; fork-confirmation is user-side. |

Throttle/backoff knobs live in `harness/watchlist.json` (not env):

| key | default | meaning |
| --- | --- | --- |
| `base_delay_ms` | 250 | Baseline inter-call spacing. |
| `max_delay_ms` | 5000 | Cap on the throttle/backoff delay when 429s appear. |
| `net_threshold_usd` | 0.5 | Default net-gap threshold (env `NET_THRESHOLD_USD` overrides). |
| `batch_size` | 4 | Default batch size (env `BATCH_SIZE` overrides). |
| `blocks_per_market` | 2 | Default blocks per market (env `BLOCKS_PER_MARKET` overrides). |
| `sizes` | `[1000, 5000, 20000, 100000]` | USD notionals at which each cross-DEX cycle is evaluated. |

## S7. How to add a new chain or pair

1. **Add a pair:** append `{ "base": "SYM1", "quote": "SYM2" }` to `pairs` in
   `harness/watchlist.json`. If it should only run on some chains, add
   `"chains": ["arbitrum"]`. Make sure **both symbols exist in `TOKENS` for that chain**
   in `sim/dex_registry.mjs` (add the token address if missing). A pair whose token is
   not on a chain is dropped gracefully.
2. **Add a chain:** add it under `chains` with `{ "enabled": true, "rpc_env": "FOO_RPC_URL" }`,
   add that chain's `TOKENS` and per-DEX `factory`/`quoter`/`tiers` to
   `sim/dex_registry.mjs`, and **verify any new factory/quoter** on the chain's explorer
   or the DEX's official docs (mark unconfirmed ones `factoryVerified: false`). Then
   `export FOO_RPC_URL=...` before launching. Re-run
   `node harness/watchlist.mjs validate harness/watchlist.json` and `... expand ...` to
   confirm the new markets appear.

## S8. The pieces (autonomous search, for reference)

- `harness/watchlist.json` - the search space (RPC via env, never a key).
- `harness/watchlist.mjs` - pure `loadWatchlist`/`expandWatchlist`/`validateWatchlist`
  + `validate`/`expand`/`get` CLI.
- `sim/dex_registry.mjs` - per-chain×DEX factory/quoter/tiers + VERIFIED/UNVERIFIED flags
  + canonical `TOKENS`.
- `sim/discovery.mjs` - read-only factory `getPool` pool auto-discovery.
- `sim/scoreboard.mjs` - persistent scoreboard + adaptive `selectBatch`.
- `sim/gaps.mjs` - ranked top-gaps aggregation + Markdown table.
- `sim/backoff.mjs` - 429 detection, exponential backoff, adaptive scan-delay throttle.
- `sim/search_scan.mjs` - the read-only scanner (throttle + 429 backoff; ALLOWED set
  exactly `eth_blockNumber`/`eth_call`/`eth_gasPrice`/`eth_chainId`).
- `harness/search_once.mjs` - one adaptive cycle (I/O glue) + the `top-gaps` sub-command.
- `harness/search_loop.sh` - the continuous wrapper (nohup-safe, SIGINT-clean, loud ALERT
  on a REAL+scalable candidate).
- `harness/scoreboard.json` - persistent scoreboard (runtime; gitignored).
- `harness/gaps_history.csv` - append-only per-observation research log (runtime;
  gitignored).

---

# Single-market harness (original, kept for reference)

## Requirements

- WSL (Ubuntu), bash, Node 18+.
- [Foundry](https://book.getfoundry.sh/) (`forge`) installed for the fork-confirm step.
- Run inside **WSL home** (e.g. `~/ArbitAI`), **not** on `/mnt/c` - Foundry's git
  submodule step fails on a Windows drive (chmod).
- An Arbitrum RPC URL (your Alchemy endpoint) exported as `RPC_URL`.

## 1. Configure the pools

Edit `harness/pools.arbitrum.json`. It ships with:

- **Uniswap V3 (pool A)** - pre-filled with the candidate
  `0xC6962004f452bE9203591991D15f6b388e09E8D0`. This is **UNVERIFIED**: run the preflight
  (`--check`) against the live chain and confirm the ✅ before trusting results.
- **PancakeSwap V3 (pool B)** - a **placeholder** (`0xPANCAKE_...`). **You must supply the
  real pool AND the real Pancake quoter.** The harness refuses to run until you do.
- **SushiSwap V3 (pool C)** - pre-filled with the known pool
  `0xf3eb87c1f6020982173c908e7eb31aa66c1f0296`. Its **quoter** is still a placeholder;
  SushiSwap V3 uses its own quoter, so fill `pools.C.quoter` in (otherwise it is
  mis-quoted through the Uniswap quoter and the watcher prints a WARNING).

Find the addresses on [DEX Screener](https://dexscreener.com/arbitrum) (search
"WETH USDC"). RPC comes from the `RPC_URL` env var - **never put a key in the JSON.**

A value is treated as a placeholder when it is empty, not a `0x`+40-hex address, or an
obvious stand-in like `0xPANCAKE_...`. Check your config any time:

```bash
unset NODE_OPTIONS
node harness/config.mjs validate harness/pools.arbitrum.json
```

Then preflight the real addresses before a long run:

```bash
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
mapfile -t A < <(node harness/config.mjs pools-check-args harness/pools.arbitrum.json)
node sim/live_two_dex_watcher.mjs "${A[@]}"
```

Fix any ❌ pool (a common mistake is pasting a TOKEN address instead of a POOL address).

## 2. Set RPC_URL

```bash
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## 3. Run one cycle (to try it)

```bash
RUN_MINUTES=30 TOP_N=3 bash harness/run_once.sh
```

Artifacts land under `harness/results/<RUN_ID>/`:

- `watch.csv` - the watcher's per-block CSV for this run,
- `preflight.txt`, `watch.log` - captured output,
- `fork_<block>.log` - captured `forge` stdout per fork-confirmed block,
- `report.md` - the human-readable REAL/MIRAGE report for the run,
- `manifest.json` - the machine inputs the report was built from.

And one row is appended to `harness/history.csv`.

## 4. Start continuous mode (kick off once, it runs itself)

```bash
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
nohup bash harness/watch_loop.sh >> harness/loop.out 2>&1 &
```

It loops forever: one full cycle, then sleeps `LOOP_INTERVAL_MIN` minutes (default 60),
then repeats, printing a rolling summary after each cycle. It is nohup-safe and
resumable - stopping and restarting just continues the same `history.csv` series.

Tunables (all env vars):

| var | default | meaning |
| --- | --- | --- |
| `RPC_URL` | (required) | Arbitrum RPC URL |
| `LOOP_INTERVAL_MIN` | 60 | minutes between cycles |
| `RUN_MINUTES` | 30 | watcher minutes per cycle |
| `TOP_N` | 3 | firing blocks fork-confirmed per cycle |
| `MAX_CYCLES` | 0 | 0 = forever; set a number to cap cycles |
| `SKIP_FORGE` | 0 | 1 = measure quotes only, skip the fork step |

## 5. Watch progress and stop it

Tail the live output:

```bash
tail -f harness/loop.out
```

Read the rolling summary at any time (total runs, total signals, REAL vs MIRAGE counts,
best REAL net seen, time span):

```bash
unset NODE_OPTIONS
node harness/make_report.mjs summarize harness/history.csv
```

Stop the loop cleanly (it prints a final summary on exit):

```bash
kill "$(pgrep -f watch_loop.sh)"
```

If you ran it in the foreground, just press `Ctrl+C`.

## 6. Where results live and how to read a verdict

- Per-run reports: `harness/results/<RUN_ID>/report.md`
- Running history (one row per cycle): `harness/history.csv`
  columns: `timestamp,blocks_watched,signals,top_block,quote_net,fork_real_net_1k,verdict`
- Loop stdout: `harness/loop.out`

A block's verdict:

- **REAL** - on the fork, with real swaps, `USDC out > USDC in` at the smallest size by
  **more than the gas estimate**, AND the gross gap still holds as the trade size grows.
  This is the only outcome worth investigating further.
- **MIRAGE** - the gap vanishes, fails to clear gas, or **collapses as size grows**
  (shallow depth: `USDC out` flatlines or drops at larger sizes). This is the common
  outcome and matches the project's standing conclusion.

`history.csv` verdicts also include `NO_SIGNAL` (a clean cycle with zero WOULD-FIRE
signals, no fork step) and `UNCONFIRMED` (signals seen but no fork log, e.g. with
`SKIP_FORGE=1`).

## 7. Scheduler recipes (alternative to the bare loop)

Prefer the OS scheduler over the long-running loop? Run `run_once.sh` on a timer.

**cron (WSL):** edit with `crontab -e`, run every hour on the hour:

```cron
0 * * * * cd $HOME/ArbitAI && RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY RUN_MINUTES=30 TOP_N=3 /bin/bash harness/run_once.sh >> harness/cron.out 2>&1
```

(Each cron invocation uses a fresh timestamped `RUN_ID` and appends to the same
`history.csv`, so the series accumulates exactly like the loop.)

**Windows Task Scheduler:** create a Basic Task on your schedule whose action runs the
WSL bash entry point:

- Program/script: `wsl.exe`
- Arguments:
  `bash -lc "cd ~/ArbitAI && RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY RUN_MINUTES=30 TOP_N=3 bash harness/run_once.sh >> harness/cron.out 2>&1"`

## 8. The pieces (for reference)

- `harness/pools.arbitrum.json` - pool/quoter config (RPC via env).
- `harness/config.mjs` - config read + placeholder validation + CLI for the shell.
- `harness/parse_fires.mjs` - parse the watcher CSV, pick top-N firing blocks.
- `harness/make_report.mjs` - parse forge output, REAL/MIRAGE verdict, build report +
  history row + rolling summary. (All pure logic; unit-tested in
  `test/harness_report.test.js`.)
- `harness/write_run.mjs` - thin I/O glue that writes `report.md` + the history row.
- `harness/run_once.sh` - one full cycle (preflight -> watch -> pick -> fork -> report).
- `harness/watch_loop.sh` - the continuous wrapper.

The verdict/parsing logic is deliberately dependency-free and unit-tested with sample
watcher CSV and sample forge output (no network), so you can trust the REAL/MIRAGE call
without a live run.

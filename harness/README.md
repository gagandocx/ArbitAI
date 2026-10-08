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

# ArbitAI — Project Handoff / Memory

Paste this file (or point the assistant at it) at the start of a new chat to continue
without re-explaining. It summarizes the full history, findings, tools, and the next step.

Repo: `gagandocx/ArbitAI`, branch `feature/arbitai-scanner`. All work is pushed there.

---

## 1. The original ask & what we found

- User was given `Code.txt` claiming a flash-loan arbitrage bot making ~$266k/month.
- **`Code.txt` is a scam/non-functional.** Its "proofs" are fabricated (duplicate tx hashes,
  impossible math, leftover Russian text), it only finds pools created in the last ~17h so it
  finds nothing real, and its Uniswap V3 calls/routers are broken (verified against live contracts).
- **Never fund it or send ETH to anyone connected to it.**

## 2. What we built instead (all read-only unless noted)

Under `sim/` (Node, zero-dep, read-only — no wallet/keys/txs):
- `arb_recon.mjs` — multi-chain cyclic-arbitrage recon. `--chain base|arbitrum|optimism|polygon|bsc|ethereum`.
  Detects real on-chain arbs, ranks pools/cycles, measures TRUSTWORTHY profit. Has artifact filters:
  flags relays (profit >25% of cycled volume) and >$100k values. **Use this to measure any chain.**
- `chain_sweep.mjs` — runs recon across several chains, prints one comparison table.
- `live_two_dex_watcher.mjs` — live watch-only detector for ONE pair across TWO or THREE pools. Runs on
  Base (default) or Arbitrum via `--chain {base|arbitrum}`. Auto-detects pool tokens, computes flash-loan
  cycle profit at several sizes, charges a 3rd-leg (stable↔stable) cost (`--stable-leg-bps`), logs
  WOULD-FIRE signals. Has a `--check` preflight that verdicts each pool (real V3 WETH/USDC on the chosen
  chain?) and exits. Fires nothing.
- `live_mainnet_check.mjs`, `base_live_check.mjs`, `realistic_market_sim.js`, `keeper_replica.mjs` —
  earlier Ethereum/Base scanners and the offline market sim + a faithful replica of Code.txt's keeper.

Under `arb-v2/` (Foundry project — a REAL executor, only ever run on a fork):
- `src/ArbExecutorV2.sol` — from-scratch executor: Morpho FREE flash loan → direct V3-style pool
  swaps (no routers, uses swap callbacks → zero approvals on swap path) → profit-or-revert.
  Has `preApprove(asset)` (one-time max allowance to Morpho → zero approvals on hot path).
- `src/interfaces.sol`, `script/MakeCases.mjs` (builds replay cases from recon CSV, handles 2..N-pool
  cycles), `test/Backtest.t.sol` (fork replay with optimal-size search via `vm.rollFork(txHash)`),
  `test/B3Cycle.t.sol` (executes a real B3 cycle on a fork).

## 3. Hard findings (measured, not guessed)

- Across Base/Arbitrum/Polygon/Ethereum: real capturable arbitrage profit is ~zero. On Base,
  ~2 arbs/block but median $0.02; after removing artifacts, trusted total was a few dollars per hour
  across ALL bots. Winners land mid-block by priority fee (0% first-in-block), gas ~$0.03.
- The "most-arbitraged token on Base" is **B3** (`0x07b3D902783c3C12b077508c3B5c00113d1291D0`),
  traded vs USDC (pool `0x2df380544B88AdB3ad0A94100dcC45fd705aAE2d`) and
  USDT (pool `0xf411Dbf5978ce4089CF40ef7b83F813Efd312fB0`), both fee tier 100 (0.01%).
- The live watcher showed B3 "firing" on 93% of blocks (+$0.35..$2.77). **The fork test proved this
  is a MIRAGE:** at $1k the real cycle nets only ~$0.38 (eaten by the 3rd leg + gas); at $5k/$20k/$50k
  it LOSES hundreds-to-thousands because the B3/USDT pool has only ~$6,500 of real depth. QuoterV2
  quotes looked profitable but real swaps collapse. This is why the gap "persists" — it's uncapturable.
- **Lesson that matters:** always confirm a signal by EXECUTING real swaps on a fork
  (`test/B3Cycle.t.sol` pattern), never trust quotes/simulation alone. This is the one check the
  YouTube/sales bots skip, which is why they can show "opportunities" that never execute profitably.

## 4. Flash-loan constraint (important, settled)

Cross-chain arbitrage with a flash loan is IMPOSSIBLE — a flash loan is one atomic tx on one chain;
you can't buy on chain A and sell on chain B in one tx. Only SAME-CHAIN, two-DEX arbitrage works
with a flash loan. Cross-chain needs real capital on both sides (real risk, no flash loan).

## 5. Environment / workflow

- Assistant runs in an isolated sandbox: NO internet, CANNOT touch the user's PC/WSL/Alchemy.
  Workflow: assistant writes+tests code against mocks, pushes to the repo; user pulls and runs.
- User runs on Windows + WSL (Ubuntu) with Foundry installed. Project copy for Foundry lives at
  `~/ArbitAI` in WSL; original at `C:\Users\gagan\ArbitAI`.
- Alchemy free tier (Base enabled; Arbitrum/Polygon enabled; NOT Optimism). Rate-limits (HTTP 429)
  on heavy scans; the live watcher is light enough. Set `RPC_URL` (Windows `set`, WSL `export`).
  **Rotate the Alchemy key** — it has appeared in screenshots.
- `git reset --hard` in the WSL copy wipes generated `test/replay/cases.json`; prefer `cat >` to
  overwrite single files, or regenerate cases with MakeCases on the Windows side.
- Foundry on a Windows drive (`/mnt/c`) fails on git submodule chmod — work in WSL home (`~/ArbitAI`).

## 6. Where we are & the NEXT STEP

Last actions: made `live_two_dex_watcher.mjs` **multi-chain** and added a **preflight check**. It now
supports `--chain {base|arbitrum}` (default `base`, so existing Base behavior is unchanged); the chosen
chain selects the expected chainId (Base `0x2105`, Arbitrum `0xa4b1`), the Uniswap QuoterV2 address, the
canonical WETH + USDC addresses, and the stablecoin set, and the old hard-coded Base chainId guard now
validates against the selected chain. A new `--check` preflight reads each supplied pool ONCE, prints its
`token0`/`token1`, fee tier, and a clear ✅/❌ verdict (✅ only for a real V3-style pool on the selected
chain whose two tokens are that chain's canonical WETH + USDC), then exits WITHOUT watching; it catches a
pasted TOKEN address (e.g. the Arbitrum USDC token mistaken for a pool), a wrong-chain pool, and a
wrong-pair pool. Per-pool quoters `--quoterA/--quoterB/--quoterC` were added because Pancake V3 and Sushi
V3 use their OWN quoter contracts (not the Uniswap QuoterV2); a pool left on the Uniswap default prints a
visible WARNING. The read-only invariant is intact (ALLOWED still exactly
`eth_blockNumber`/`eth_call`/`eth_gasPrice`/`eth_chainId`). This all sits on top of the earlier SAME-PAIR
vs ONE-SHARED-TOKEN modes and the `--poolC` three-DEX coverage. The `arb-v2/test/WethUsdcCycle.t.sol` fork
test is unchanged in logic but now documents an Arbitrum run (override `WETH`/`USDC` env to the canonical
Arbitrum tokens).

**Immediate next step requested:** the deep WETH/USDC pools (Uniswap V3, PancakeSwap V3, SushiSwap V3) are
on **Arbitrum**. Fetch the three WETH/USDC pool addresses from DEX Screener (dexscreener.com/arbitrum,
search "WETH USDC"); the Sushi V3 WETH/USDC pool `0xf3eb87c1f6020982173c908e7eb31aa66c1f0296` is a known
example for `--poolC`, the Uniswap and Pancake addresses are yours to supply. Then:

1. PREFLIGHT the addresses:
   `node sim/live_two_dex_watcher.mjs --chain arbitrum --check --poolA <uni> --poolB <pancake> --poolC 0xf3eb87c1f6020982173c908e7eb31aa66c1f0296`
   (fix any ❌ before running; this is where a pasted token address gets caught).
2. RUN the watcher across all three pairings (per-pool quoters recommended for Pancake/Sushi):
   `node sim/live_two_dex_watcher.mjs --chain arbitrum --poolA <uni> --quoterA <uni-quoter> --poolB <pancake> --quoterB <pancake-quoter> --poolC 0xf3eb87c1f6020982173c908e7eb31aa66c1f0296 --quoterC <sushi-quoter> --minutes 60`
3. CONFIRM any WOULD-FIRE signal with the `WethUsdcCycle` fork test (real swaps, all sizes) at the firing
   block, using the canonical Arbitrum WETH/USDC tokens:
   `cd arb-v2 && forge install foundry-rs/forge-std --no-commit && export ARB_RPC=... WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 POOL_A=0x... POOL_B=0x... POOL_C=0xf3eb87c1f6020982173c908e7eb31aa66c1f0296 && forge test --match-contract WethUsdcCycle --fork-url $ARB_RPC --fork-block-number <block> -vv`.

Note on the QuoterV2 addresses: the Base QuoterV2 is the proven `0x3d4e...B76a`; the Arbitrum QuoterV2 is
set to the well-known Uniswap v3 periphery deployment `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` but is
overridable with `--quoter` if you want to verify it against the live chain first.

**Other honest options:** (1) backrun-opportunity analyzer (does a large swap trigger each arb, and how
big is the post-swap gap — probes intra-block timing, the real edge); (2) scan a newer/less-saturated
chain (e.g. Unichain) with the same fork-proof method.

**NEW WAY OF WORKING - the continuous measurement harness (`harness/`).** Instead of running
each step by hand, there is now a self-running harness that automates the whole loop and
accumulates results over days. See `harness/README.md` for full usage. In short, each cycle it:
(1) preflights the configured pools (`--check`), (2) runs `live_two_dex_watcher.mjs` for a while
writing a per-run CSV, (3) picks the top-N `would_fire==true` blocks by `net_usd`, (4) confirms
each with the `WethUsdcCycle` fork test at that `--fork-block-number`, (5) writes a per-run
`report.md` with a REAL vs MIRAGE verdict, (6) appends a row to `harness/history.csv`, and (7)
repeats on a schedule, printing a rolling summary. The REAL/MIRAGE verdict is honest: a block is
REAL only if the real fork swaps net positive beyond gas at the smallest size AND the gross gap
still holds as size grows; it is MIRAGE if the gap vanishes, fails to clear gas, or collapses with
size (the B3 shallow-depth pattern). Pieces: `harness/pools.arbitrum.json` (config; RPC via
`RPC_URL` env, never a key in the file), `harness/run_once.sh` (one cycle), `harness/watch_loop.sh`
(continuous, nohup-safe, SIGINT-clean), and dependency-free Node helpers
`config.mjs`/`parse_fires.mjs`/`make_report.mjs`/`write_run.mjs` whose CSV/forge-log/verdict logic
is unit-tested in `test/harness_report.test.js` (no network). The harness is MEASUREMENT ONLY:
read-only watcher plus fork simulation, no key custody, no transactions, no funding.

Kick it off once:
```
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
nohup bash harness/watch_loop.sh >> harness/loop.out 2>&1 &
```
Config note: the Uniswap pool is PRE-FILLED but UNVERIFIED (run `--check` to confirm), the Sushi
pool is PRE-FILLED (its quoter still needs filling), and the PancakeSwap pool/quoter are
PLACEHOLDERS the harness refuses to run against until you supply the real Arbitrum addresses from
DEX Screener.

**Honest standing conclusion:** no capturable edge found for a buildable same-chain flash-loan bot;
apparent gaps are artifacts or shallow-pool mirages; real profit is a sub-second latency race against
colocated bots. Keep testing, but confirm EVERY signal with real-swap fork execution, and never fund
anything on a quote/simulation alone. The harness operationalizes exactly this discipline: it flags a
candidate only when real fork swaps clear gas and hold as size grows, and it cannot manufacture an edge
that is not there.

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
- `live_two_dex_watcher.mjs` — live watch-only detector for ONE pair across TWO pools. Auto-detects
  pool tokens, computes flash-loan cycle profit at several sizes, charges a 3rd-leg (stable↔stable)
  cost (`--stable-leg-bps`), logs WOULD-FIRE signals. Fires nothing.
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

Last actions: added the pre-approval gas optimization to `ArbExecutorV2`. User wants to (a) test the
three big DEXes explicitly, (b) find a better edge with more advanced data.

**Immediate next step requested:** point `live_two_dex_watcher.mjs` at a DEEP major pair across the
three DEXes the video pushes — e.g. WETH/USDC on Uniswap V3 vs PancakeSwap V3, and vs SushiSwap V3 —
instead of the shallow B3 pools. Need the three pool addresses from DEX Screener (dexscreener.com/base,
search "WETH USDC"): the Uniswap V3, PancakeSwap V3, and SushiSwap V3 pool addresses. Then run:
`node sim/live_two_dex_watcher.mjs --poolA <uni> --poolB <pancake> --minutes 60`
and confirm any signal with a B3Cycle-style fork test (real swaps, all sizes) before trusting it.

**Other honest options:** (1) backrun-opportunity analyzer (does a large swap trigger each arb, and how
big is the post-swap gap — probes intra-block timing, the real edge); (2) scan a newer/less-saturated
chain (e.g. Unichain) with the same fork-proof method.

**Honest standing conclusion:** no capturable edge found for a buildable same-chain flash-loan bot;
apparent gaps are artifacts or shallow-pool mirages; real profit is a sub-second latency race against
colocated bots. Keep testing, but confirm EVERY signal with real-swap fork execution, and never fund
anything on a quote/simulation alone.

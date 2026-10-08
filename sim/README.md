# Testing ArbitrageExecutor (Code.txt) against reality

All scripts are **read-only**: no wallet, no private key, no transactions, no money at risk.
Requirements: **Node.js 18+**. No `npm install` needed.

## 0. Live two-DEX watcher (watch-only, deep WETH/USDC across three DEXes)

`live_two_dex_watcher.mjs` watches one pair across its pools every new block. It auto-detects each
pool's tokens and works in two modes:

- **SAME-PAIR mode** (the deep use case): both pools share BOTH tokens, e.g. **WETH/USDC** on
  Uniswap V3 vs PancakeSwap V3 vs SushiSwap V3. The cycle is a clean 2-leg same-pair cross-DEX loop
  (start USDC, buy WETH on the cheaper pool, sell on the dearer pool for USDC) with NO cross-stable
  3rd leg. The quote token (USDC) is the ~$1 stable; the base token (WETH, 18-dec) is read from chain.
- **ONE-SHARED-TOKEN mode** (the legacy B3 case): the two pools share exactly one token and the other
  two are treated as ~$1 stable quotes, with an optional 3rd stable-leg haircut.

From real on-chain QuoterV2 quotes it computes the flash-loan cycle at several sizes, subtracts the
live gas, and logs a **WOULD-FIRE** signal whenever a cycle would net more than a threshold.

**Three-DEX coverage:** pass `--poolC` in addition to `--poolA`/`--poolB`. When all three pools share
the same pair, the watcher evaluates all three DEX pairings per block (A<->B, A<->C, B<->C) and reports
the best. Omit `--poolC` and it behaves as before (A<->B only).

You must fetch the three pool addresses yourself from **DEX Screener** (dexscreener.com/base, search
"WETH USDC"): the Uniswap V3, PancakeSwap V3 and SushiSwap V3 WETH/USDC pool addresses. These are not
hardcoded; supply them via `--poolA/--poolB/--poolC`.

It fires nothing: no wallet, no keys, no transactions. It answers the make-or-break question before any money
is risked: *how often does a real, above-cost cross-DEX gap actually open on this pair?*

```sh
# WETH/USDC across the three DEXes (addresses from DEX Screener, dexscreener.com/base):
set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
node sim/live_two_dex_watcher.mjs \
  --poolA 0xUNISWAP_V3_WETH_USDC \
  --poolB 0xPANCAKE_V3_WETH_USDC \
  --poolC 0xSUSHI_V3_WETH_USDC \
  --minutes 60
```

Options: `--min-profit-usd 0.10` (signal threshold, after gas), `--sizes 1000,5000,20000,100000`,
`--poolA 0x..` / `--poolB 0x..` / `--poolC 0x..` / `--quoter 0x..` to watch a different pair or add a
third DEX. Watch for a few hours (ideally across a volatile moment). The summary's **WOULD-FIRE signals**
count is the opportunity rate; only if it is regularly non-zero is live execution worth considering. Then
confirm any signal with the `arb-v2/test/WethUsdcCycle.t.sol` fork test (real swaps, all sizes) at the
block where the watcher fired, before trusting it.

## 0a. Multi-chain arbitrage recon + sweep (where is the edge?)

`arb_recon.mjs` is chain-agnostic — pass `--chain base|arbitrum|optimism|polygon|bsc|ethereum`.
It detects cyclic arbitrage, removes measurement artifacts (relays / >$100k / profit>25%-of-volume),
and reports TRUSTWORTHY profit per chain. `chain_sweep.mjs` runs several chains and prints one
comparison table so you can see which chain actually has capturable arbitrage profit.

```sh
# compare chains (public RPCs are rate-limited; give each a private RPC for a real run)
set BASE_RPC=...  ARBITRUM_RPC=...  POLYGON_RPC=...   (etc.)
node sim/chain_sweep.mjs --chains base,arbitrum,optimism,polygon,bsc --blocks 300

# go deep on the winner
set RPC_URL=<winner chain rpc>
node sim/arb_recon.mjs --chain <winner> --blocks 2000
```

Judge each chain by: arbs/block, trusted$ total, and the >$5 / >$20 counts. A chain only
"has an edge" if there is real, repeatable profit in 2-3 pool routes after artifacts are removed.

## 0. Arbitrage recon on Base (learn from the bots that win)

`arb_recon.mjs` is read-only. It scans recent Base blocks, groups every DEX swap by transaction, and detects
**cyclic arbitrage**: one transaction that swaps through two or more pools and ends holding more of the token it
started with. For each winner it records the pools, token cycle, hop count, gas used, priority-fee bid, and the
transaction's position in its block. Then it ranks the most-arbitraged pools and token cycles and summarises real
profits. This tells us which setups to target, instead of guessing.

```sh
set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
node sim/arb_recon.mjs --blocks 300            # ~10 minutes of Base
node sim/arb_recon.mjs --blocks 1000 --min-hops 2
```

Options: `--from <block>` (default: latest), `--min-hops 2`, `--top 40`, `--log arb_recon_log.csv`.
A real RPC is strongly recommended — this reads full blocks and receipts, which public endpoints rate-limit.

## 1. Keeper replica on live Ethereum data (closest to the original)

`keeper_replica.mjs` re-implements the original keeper's decision logic (Code.txt, Appendix A) function by function
and runs it on every new block:

- pool discovery from factory logs
- USD liquidity scoring and the top-15 graph
- route search up to 4 swaps (first 200 cycles)
- the 1% price-impact pre-screen
- best-router quoting per swap
- the 30 bps slippage haircut
- the live Aave fee and gas costs
- the `profitBps >= 50` check

It stops before anything that needs a wallet.

```sh
node sim/keeper_replica.mjs                      # exactly the "HOW TO RUN" setup from Code.txt
node sim/keeper_replica.mjs --v3                 # same + Uniswap V3 factory (as an operator could add)
node sim/keeper_replica.mjs --mode fixed         # same logic with its discovery and V3 bugs repaired
```

Options: `--minutes 360` · `--flash 20000` (USDC) · `--max-hops 4` · `--gas-base/--gas-v2/--gas-v3` (gas model).
At startup it checks the real Uniswap contracts to confirm whether the original code's Uniswap V3 function calls
actually exist on them.
Differences from the original, all in the bot's favour: all routes are quoted in one pass per block, there are
no competing bots, and gas is estimated from a model rather than the deployed contract.

## 2. Base: 25 tokens, 7 DEXes, 2-step and 3-step (triangle) routes

```sh
node sim/base_live_check.mjs --minutes 60
```

This checks real quotes on Uniswap V3, PancakeSwap V3, SushiSwap V3, Aerodrome (volatile, stable, and Slipstream
concentrated-liquidity pools), Uniswap V2 and BaseSwap. It covers every pool between 25 tokens: stablecoins, ETH and
staked-ETH tokens, BTC tokens, and AERO, MORPHO, VIRTUAL, DEGEN, BRETT and more.

- **2-step routes:** borrow any token Aave lends on Base, buy on the best exchange, sell on the best *other* exchange.
- **3-step triangles:** borrow Q → X → Y → Q, using the best exchange for each step. A rotating 150 are checked per poll.

The live Aave fee and gas are subtracted. Exchanges and tokens are checked on-chain at startup, and any that don't
check out are skipped.

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--every` | 20 | seconds between checks |
| `--sizes` | 1000 | trade sizes in USD, e.g. `1000,10000` |
| `--triangles` | 150 | triangles checked per poll |
| `--no-triangles` | off | only check 2-step routes |
| `--tokens 0xAddr,...` | none | extra tokens (their name is read from the chain) |
| `--focus cbETH/WETH` | off | only routes that use this pair (2-step on its pools, plus every triangle through it), checked every 4 s at $250, $1k, $5k and $20k |

This makes many requests, so if public servers start refusing them, use your own `RPC_URL`.

## 3. Simple live check on Ethereum (two-step routes, several loan sizes)

```sh
node sim/live_mainnet_check.mjs --minutes 360
```

## 4. Offline market simulation (no internet)

```sh
node sim/realistic_market_sim.js --days 30 --seeds 5
```

If public RPCs rate-limit you, add a free Alchemy or Infura key, e.g. on Windows:
`set RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY` and then run the command.

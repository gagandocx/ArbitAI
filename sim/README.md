# Testing ArbitrageExecutor (Code.txt) against reality

All scripts are **read-only**: no wallet, no private key, no transactions, no money at risk.
Requirements: **Node.js 18+**. No `npm install` needed.

## 0. Live two-DEX watcher (watch-only, the proven hotspot pair)

`live_two_dex_watcher.mjs` watches the single most-arbitraged pair the recon found on Base — USDC/WETH on
the two hotspot pools (`0xf411…`, `0x2df3…`) — every new block. From real on-chain QuoterV2 quotes it computes
a flash-loan cycle (borrow USDC → buy WETH on the cheaper pool → sell on the dearer → USDC) at several sizes,
subtracts the live gas, and logs a **WOULD-FIRE** signal whenever a cycle would net more than a threshold.

It fires nothing — no wallet, no keys, no transactions. It answers the make-or-break question before any money
is risked: *how often does a real, above-cost two-DEX gap actually open on this pair?*

```sh
set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
node sim/live_two_dex_watcher.mjs --minutes 60
```

Options: `--min-profit-usd 0.10` (signal threshold, after gas), `--sizes 1000,5000,20000,100000`,
`--poolA 0x..` / `--poolB 0x..` / `--quoter 0x..` to watch a different pair. Watch for a few hours
(ideally across a volatile moment). The summary's **WOULD-FIRE signals** count is the opportunity rate;
only if it is regularly non-zero is live execution worth considering.

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

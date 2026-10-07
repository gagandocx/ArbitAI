# Testing ArbitrageExecutor (Code.txt) against reality

All scripts are **read-only**: no wallet, no private key, no transactions, no money at risk.
Requirements: **Node.js 18+**. No `npm install` needed.

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

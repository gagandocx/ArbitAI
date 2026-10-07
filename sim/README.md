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

## 2. Simple live check (two-step routes, several loan sizes)

```sh
node sim/live_mainnet_check.mjs --minutes 360
```

## 3. Offline market simulation (no internet)

```sh
node sim/realistic_market_sim.js --days 30 --seeds 5
```

If public RPCs rate-limit you, add a free Alchemy or Infura key, e.g. on Windows:
`set RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY` and then run the command.

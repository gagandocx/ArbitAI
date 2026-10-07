# Testing ArbitrageExecutor (Code.txt) against reality

Both scripts are **read-only**: no wallet, no private key, no transactions, no money at risk.
Requirements: **Node.js 18+**. No `npm install` needed.

## 1. Live check on real Ethereum data (needs internet)

```sh
git clone -b feature/arbitai-scanner https://github.com/gagandocx/ArbitAI.git
cd ArbitAI
node sim/live_mainnet_check.mjs --minutes 60
```

Each new block (~12 s), it asks Uniswap V2, SushiSwap and Uniswap V3 (0.05% / 0.3%) for real quotes on
"flash-borrow X USDC → buy WETH on one DEX → sell on another". It then applies the bot's rules: the live Aave
fee, the contract's 0.5% minimum profit, and gas at the live gas price. Every hit is re-checked one block later,
because that's the earliest this bot could actually trade. Press **Ctrl+C** at any time to see the summary.
Every quote is saved to `live_log.csv` (opens in Excel / Google Sheets).

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--minutes` | 60 | how long to run (try 360+ for a fair test) |
| `--sizes` | 2000,20000,100000,500000 | loan sizes in USDC (20000 = the bot's default) |
| `--min-profit-bps` | 50 | contract rule; 1 is the lowest the contract allows |
| `--gas-units` | 400000 | gas per arbitrage transaction |

If public RPCs rate-limit you, use a free key from Alchemy or Infura:
`RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY node sim/live_mainnet_check.mjs`

## 2. Offline market simulation (no internet)

```sh
node sim/realistic_market_sim.js --days 30 --seeds 5
```

Monte-Carlo model of the same pools with retail flow and competing bots. Pool sizes and volumes are approximate.

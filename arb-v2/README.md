# ArbExecutorV2 — Phase 2 (contract + fork backtester)

**Goal:** measure, risk-free, how much of the *real* Base arbitrage flow a from-scratch
executor could have captured — before spending anything on live infrastructure.

Nothing here touches real funds. The backtester runs entirely on a local **fork** of Base
(Foundry/anvil), replaying arbitrages that already happened. The contract is only ever
deployed to that fork.

## What's inside

```
arb-v2/
  src/ArbExecutorV2.sol        the executor: Morpho free flash loan -> direct V3 pool swaps -> profit-or-revert
  src/interfaces.sol           minimal interfaces (Morpho, UniV3-style pool, ERC20)
  test/Backtest.t.sol          fork test: deploy on a Base fork, replay a 2-pool cycle, assert profit
  test/replay/cases.json       arbitrage cases to replay (generated from arb_recon_clean.csv)
  script/MakeCases.mjs         turns arb_recon_clean.csv -> cases.json (pulls each tx's pools+block)
  foundry.toml
```

## Why this design

The recon (`sim/arb_recon.mjs`, 2000 Base blocks) showed:
- ~95% of arbitrage pool-hits are Uniswap-V3-style concentrated-liquidity pools (`v3/cl`).
- 70%+ of arbs are 2-pool cycles.
- Winners land mid-block via tiny priority fees (0% were first-in-block), gas ~$0.03.
- Real profit is concentrated: of 1601 arbs in ~67 min, only ~8 netted > $20; three netted $1k–$23k.

So V2 targets exactly that: **2-pool V3 cycles, free flash loan, direct pool `swap()` with a
callback, revert unless net profit > 0.** No routers (saves gas), no 0.5% floor (the old
contract's fatal flaw), no native ETH.

## Requirements (run locally — this sandbox has no Foundry/network)

1. Install Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. A Base archive RPC (your Alchemy URL works): `export BASE_RPC=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`

## Run

```sh
cd arb-v2
forge install foundry-rs/forge-std --no-commit     # test utils only
# 1) build the replay cases from your recon CSV (produced by sim/arb_recon.mjs)
node script/MakeCases.mjs ../arb_recon_clean.csv > test/replay/cases.json
# 2) fork-replay them through ArbExecutorV2
forge test --fork-url $BASE_RPC -vv
```

The test prints, per case: the real arb's profit vs **what our contract reproduced on the fork**,
and a final capture summary. Send me that output.

## What the result decides

- If V2 reproduces a meaningful share of the > $20 arbs on the fork → the strategy is sound;
  the remaining question is live race/latency (Phase 3).
- If it reproduces almost nothing even with perfect hindsight on a fork → the edge isn't in the
  contract, it's in detection/speed we can't match → stop before spending on infrastructure.

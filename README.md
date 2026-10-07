# ArbitAI

A **read-only DEX-to-DEX arbitrage scanner** for cheap EVM chains. It connects
to a chain over JSON-RPC, reads real on-chain pool reserves and quotes from two
or more DEXes, scans a curated set of token pairs, and computes the realistic
**net result after costs** for every cross-DEX price gap — not just the raw gap.
It also runs a honeypot/trap filter on each token and ranks the results.

Default target: **Base** (chainId 8453), comparing **Uniswap V3** and
**Aerodrome**, over a small curated token list of majors plus a couple of liquid
mid-caps. **BNB Smart Chain** (`--chain bsc`) and **Arbitrum One**
(`--chain arbitrum`) are now first-class live targets too, each with its own
curated token list and DEX pair. Base remains the default when `--chain` is
omitted.

---

## ⚠️ Disclaimer — please read

- **This is an educational / analysis tool.** It helps you understand and
  evaluate cross-DEX price differences. It does nothing else.
- **Strictly read-only.** ArbitAI only performs `eth_call` / view reads. It
  **never submits transactions, never signs anything, holds no private keys and
  no wallet, and cannot move or risk any funds.** There is no key material
  anywhere in the codebase. This boundary is enforced **two ways**: (1) the
  JSON-RPC provider's `send()` checks every method against a positive
  **read-method allowlist** (`eth_call`, `eth_blockNumber`, `eth_gasPrice`,
  `eth_chainId`, and a few other read methods) and throws on anything else, so a
  state-changing method such as `eth_sendTransaction`, `eth_sendRawTransaction`,
  or `eth_sign` is refused in code before any request is built; and (2) an
  automated test (`test/readonly_guard.test.js`) fails the build if any
  transaction-send or key-handling primitive appears in `src/` or `bin/`.
- **This is NOT financial advice.** A "profitable" verdict is a model estimate
  based on fixture or on-chain snapshot data and simplifying assumptions. Real
  execution involves latency, MEV, revert risk, and changing liquidity. Do your
  own research. You are solely responsible for anything you do with this
  information.

---

## Requirements

- **Node.js >= 18** (developed and tested on Node 22).
- **Zero dependencies.** Node standard library only. There is no install step.

## Quick start

### No-network demo (offline)

Runs the full scan + ranking pipeline against bundled fixture pool data with no
network access at all:

```sh
node bin/arbitai.js --offline
# or point at a specific fixture:
node bin/arbitai.js --offline --fixture test/fixtures/base_sample.json
```

You will get a ranked ASCII table like:

```
+------------+------------------------+-----------+--------+-------------+-------------------------------------------+--------------+
| PAIR       | BUY@ / SELL@           | RAW GAP % |  NET % | NET (quote) | TRAP FLAGS                                | VERDICT      |
+============+========================+===========+========+=============+===========================================+==============+
| WETH/USDC  | UniswapV3 -> Aerodrome |     1.00% |  0.15% |       14.98 | -                                         | profitable   |
| USDC/WETH  | UniswapV3 -> Aerodrome |     3.03% |  2.18% |      218.01 | THIN_LIQUIDITY,ONE_SIDED,LOW_POOL_COUNT   | suspicious   |
| USDT/USDC  | UniswapV3 -> Aerodrome |     3.00% |  2.15% |      214.98 | SELL_BLOCKED,NON_SELLABLE,FEE_ON_TRANSFER | trap/avoid   |
+------------+------------------------+-----------+--------+-------------+-------------------------------------------+--------------+
```

Add `--verbose` for a per-row cost breakdown, or `--json` for machine-readable
output.

### Live usage

Point it at a live RPC endpoint for the chain you want to scan. By default it
uses that chain's free public endpoint; you can override with an environment
variable or supply an Alchemy key:

```sh
# Free public endpoint (default, Base)
node bin/arbitai.js

# Explicit RPC URL
RPC_URL=https://mainnet.base.org node bin/arbitai.js

# Compose an Alchemy Base URL from your key (nothing is hardcoded)
ALCHEMY_KEY=your_key_here node bin/arbitai.js

# Or pass the URL on the command line
node bin/arbitai.js --rpc https://mainnet.base.org
```

If the network is unreachable, ArbitAI prints a clear, actionable error (never a
raw stack trace) and exits non-zero, suggesting `--offline`.

#### Live scan per chain

Each chain selects its own quote currency, curated token list, DEX pair, and a
free public RPC endpoint used when no key is supplied:

```sh
# Base (default): quoted in USDC, public RPC https://mainnet.base.org
node bin/arbitai.js --chain base

# BNB Smart Chain: quoted in USDT, public RPC https://bsc-dataseed.binance.org
node bin/arbitai.js --chain bsc

# Arbitrum One: quoted in USDC, public RPC https://arb1.arbitrum.io/rpc
node bin/arbitai.js --chain arbitrum
```

| Chain          | `--chain` key | Quote | Default public RPC                     |
| -------------- | ------------- | ----- | -------------------------------------- |
| Base           | `base`        | USDC  | `https://mainnet.base.org`             |
| BNB Smart Chain| `bsc`         | USDT  | `https://bsc-dataseed.binance.org`     |
| Arbitrum One   | `arbitrum`    | USDC  | `https://arb1.arbitrum.io/rpc`         |

Public endpoints are rate-limited and best-effort. For reliable live scans,
supply your own free key (see below).

#### Supplying a free RPC / Alchemy key

Nothing is hardcoded and no key is ever stored: the RPC URL is resolved from the
environment (or the CLI flag) at the start of each run and used only for
read calls. The resolution priority per chain is:

1. `RPC_URL=<url>` or `--rpc <url>`: an explicit override, highest priority,
   used verbatim for any chain or provider.
2. `ALCHEMY_KEY=<your_key>`: composes the chain-correct Alchemy endpoint.
3. The chain's public default endpoint (no key required).

```sh
# Explicit override (highest priority): works for any provider, incl. Infura
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/your_key node bin/arbitai.js --chain arbitrum
RPC_URL=https://arbitrum-mainnet.infura.io/v3/your_key node bin/arbitai.js --chain arbitrum

# Per-invocation CLI override (same priority as RPC_URL)
node bin/arbitai.js --chain bsc --rpc https://bsc-mainnet.infura.io/v3/your_key

# ALCHEMY_KEY composes the chain-correct Alchemy host automatically
ALCHEMY_KEY=your_key_here node bin/arbitai.js --chain base      # base-mainnet.g.alchemy.com
ALCHEMY_KEY=your_key_here node bin/arbitai.js --chain bsc       # bnb-mainnet.g.alchemy.com
ALCHEMY_KEY=your_key_here node bin/arbitai.js --chain arbitrum  # arb-mainnet.g.alchemy.com
```

The per-chain Alchemy hostnames composed from `ALCHEMY_KEY` are:

| Chain          | Alchemy host                 |
| -------------- | ---------------------------- |
| Base           | `base-mainnet.g.alchemy.com` |
| BNB Smart Chain| `bnb-mainnet.g.alchemy.com`  |
| Arbitrum One   | `arb-mainnet.g.alchemy.com`  |

**Getting a free Alchemy key:** sign up at
[alchemy.com](https://www.alchemy.com/), create an app for the network you want
(Base, BNB Smart Chain, or Arbitrum), and copy the API key from the app
dashboard. Pass it as `ALCHEMY_KEY` and ArbitAI composes the correct endpoint
for you.

**Using Infura (or any other provider):** Infura endpoints are not composed from
`ALCHEMY_KEY`; supply the full Infura URL via `RPC_URL` or `--rpc` instead. Sign
up at [infura.io](https://www.infura.io/), create a project, enable the network
you want, and copy the full HTTPS endpoint (it already includes your project
key), then pass it as the explicit override shown above.

## Per-chain DEX pairs

Each chain pairs one `v3` quoter-style DEX against one `v2` reserves-style DEX
over its curated token pairs. The scanning pipeline is identical across chains;
only the config differs.

| Chain          | DEXes compared                  | Default curated pairs (base/quote)              |
| -------------- | ------------------------------- | ----------------------------------------------- |
| Base           | Uniswap V3 vs Aerodrome         | WETH/USDC, cbETH/WETH, DAI/USDC, USDT/USDC, USDC/WETH |
| BNB Smart Chain| PancakeSwap V3 vs PancakeSwap V2| WBNB/USDT, ETH/USDT, CAKE/USDT                  |
| Arbitrum One   | Uniswap V3 vs Camelot           | WETH/USDC, ARB/USDC, GMX/USDC                   |

Base pairs are quoted in USDC, BSC pairs in USDT, and Arbitrum pairs in USDC.
The curated lists are majors plus a couple of liquid mid-caps per chain (for
example AERO/DEGEN on Base, CAKE on BSC, GMX on Arbitrum). Override the scanned
pairs for any chain with `--pairs "WBNB/USDT,CAKE/USDT"`.

### What a live scan reads today

The `v3` leg (Uniswap V3, PancakeSwap V3) reads a live quote directly from the
on-chain quoter, so it needs no extra setup. The `v2` leg (Aerodrome,
PancakeSwap V2, Camelot) reads reserves from a specific pair contract, so it
needs that pair's address in the per-DEX `pairs` map in `src/config/dexes.js`.
The shipped config leaves those `pairs` maps empty, so a live scan reads the
`v3` quote and gracefully skips the `v2` leg, printing a one-line
`Warning: skipping <DEX> leg ...` to stderr and still reporting the pair. A full
two-DEX comparison for a pair becomes live once you add that pair's `v2` pair
address to the DEX's `pairs` map. Offline runs (`--offline`) are unaffected: the
bundled fixture carries both legs, so the demo shows a complete comparison.

## CLI options

| Flag             | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `--chain <key>`  | Chain to scan (default `base`).                                    |
| `--rpc <url>`    | RPC endpoint override (else `RPC_URL` / `ALCHEMY_KEY` env).        |
| `--trade-size <num>` | Notional trade size in quote currency (default `10000`).       |
| `--slippage <num>`   | Slippage tolerance as a fraction, e.g. `0.005`.                |
| `--pairs <list>` | Comma-separated pairs, e.g. `"WETH/USDC,DAI/USDC"`.                |
| `--offline`      | Use bundled/offline fixtures (no network).                         |
| `--fixture <path>` | Path to a fixture JSON (implies `--offline`).                    |
| `--verbose`      | Show the per-row cost breakdown (fees, slippage, gas).             |
| `--json`         | Emit ranked candidates as JSON instead of a table.                 |
| `--help`         | Show usage.                                                        |

## The cost model

A positive raw cross-DEX gap is meaningless on its own. ArbitAI subtracts every
real cost of the round-trip so the **NET** figure reflects what you would
actually keep:

1. **Both DEX swap fees.** The buy-side and sell-side DEX each charge their fee
   (e.g. Uniswap V3 0.05% tier + Aerodrome 0.30%), applied to the trade size.
2. **Slippage at the trade size.** Price impact from constant-product pool depth
   is modelled on both legs, so bigger trades against thinner pools cost more.
   `--trade-size` drives this directly. When a leg exposes no reserves to model
   (e.g. a Uniswap V3 quoter leg), the configured **slippage tolerance**
   (`--slippage`, default 0.5%) is applied as a **floor** so price impact is
   never silently counted as zero. The floor is also a minimum when a depth
   model *is* available, so a shallow leg can never understate impact.
3. **Estimated gas.** A round-trip gas estimate (in the quote currency) is always
   subtracted, even on cheap L2s like Base. Gas is computed as
   `gasUnits * gasPrice`: `gasUnits` comes from config (`gasUnitsEstimate`), and
   the gas price comes from the live `eth_gasPrice` read on a live run, or from
   the configured `gasPriceGwei` on an offline/fixture run, converted to the
   quote currency via `nativeQuotePrice`. A flat `gasUsdEstimate` is the
   documented fallback only when neither a live nor a configured gas price is
   available.

```
net = (rawGap * tradeSize) - buyFee - sellFee - slippage - gas
```

The result is ranked **best-net-first within tiers**, with each row given a
verdict:

- `profitable` — clean pair, net above the floor.
- `marginal` — clean pair, thin positive net.
- `unprofitable` — clean pair, net <= 0.
- `suspicious` — a soft trap (thin / one-sided / low pool count). Still shown,
  but ranked **below every clean pair** and marked non-actionable: its net is
  typically overstated against shallow or skewed depth, so a `suspicious` pair
  is never presented as a clean top opportunity even when its net is the
  highest number in the table.
- `trap/avoid` — a hard trap (honeypot / rigged); demoted to the bottom.

Ordering is strictly tiered: all clean rows first (net descending), then
suspicious rows (net descending), then avoid rows. This is why in the demo above
the `suspicious` USDC/WETH row (net 218) sits **below** the clean `profitable`
WETH/USDC row (net 15).

## Trap / honeypot heuristics

Each token is screened before it can be considered actionable. The heuristics
interpret already-fetched read data (reserves plus a read-only sell simulation):

- **SELL_BLOCKED** — the simulated sell call reverts: the token cannot be sold
  (classic honeypot).
- **NON_SELLABLE** — the simulated sell returns zero output for a non-zero input.
- **FEE_ON_TRANSFER** — simulated output falls short of the expected output by
  more than the tolerance, implying the token skims a cut on transfer.
- **THIN_LIQUIDITY** — pool depth below the configured floor (prone to huge
  slippage / manipulation).
- **ONE_SIDED_LIQUIDITY** — reserve skew beyond the bound; the price is
  unreliable. The skew is measured on **quote value** (reserves normalized by
  token decimals, then the base side valued at the pool price), not on raw
  reserve integers. This matters for majors with mismatched decimals: a balanced
  WETH/USDC pool holds ~4,000 WETH against ~12,000,000 USDC — a ~3,000x ratio in
  raw/human token counts even though each side holds roughly equal value — and a
  naive raw-integer comparison would false-flag it. Only a genuine value
  imbalance is flagged.
- **LOW_POOL_COUNT** — too few discoverable pools to be confident.

Any hard trap (`SELL_BLOCKED`, `NON_SELLABLE`, `FEE_ON_TRANSFER`) yields a verdict
of `avoid`; those rows are demoted to the bottom of the table and flagged, never
treated as actionable. Soft signals (thin / one-sided / low pool count) mark a
pair `suspicious`: it stays visible in the ranking but is demoted below every
clean pair and is never actionable, so a thin/skewed pair cannot be presented as
a clean top opportunity.

## Swapping chains, DEXes, and tokens

Everything is config-driven under `src/config/`:

- `src/config/chains.js` — chain id, name, quote currency, default RPC.
- `src/config/dexes.js` — per-chain DEX set (quoter/factory/router + fee tiers).
- `src/config/tokens.js` — per-chain curated token list and default pairs.
- `src/config/index.js` — `buildConfig()` composes a run-ready config and applies
  env/CLI overrides.

Base, **BSC / PancakeSwap**, and **Arbitrum / Camelot** are all registered and
live out of the box; run them with `--chain base`, `--chain bsc`, or
`--chain arbitrum`. To add a brand-new chain, add a descriptor to `CHAINS` in
`chains.js`, a DEX set in `dexes.js`, and a curated token list plus default
pairs in `tokens.js` (the existing three chains show the exact shape). Nothing
in the scanning pipeline needs to change: the DEX read style (`v3` quoter vs
`v2` reserves) is selected from config.

Across every chain the tool stays **strictly read-only**: it performs view
reads only, holds no keys and no wallet, and never submits or signs a
transaction. If a chain's public RPC endpoint is unreachable, ArbitAI degrades
to a clear, actionable error (never a raw stack trace), exits non-zero, and
hints at `--offline` so you can still exercise the full pipeline against bundled
fixtures.

To scan different pairs without editing config, use `--pairs "WETH/USDC,DAI/USDC"`.

## Running the tests

The project uses Node's built-in test runner (no test framework to install):

```sh
node --test test/
# or
npm test
```

> Note: on some sandboxed Node setups you may need to run the tests as
> `node --test "test/**/*.test.js"`.

The suite covers the pure pricing / cost / trap / ranking layers, the EVM ABI
codec and keccak selector helper, the offline scanner pipeline, the CLI (`--help`
and the offline fixture run), and the read-only boundary guard.

## Project layout

```
bin/arbitai.js          CLI entrypoint
src/config/             chains, dexes, tokens, buildConfig
src/core/               pure pricing, costs, traps, ranking
src/evm/                keccak, ABI codec, read-only RPC client, pool readers
src/render/table.js     ranked ASCII table renderer
src/scanner.js          orchestration (injectable data source)
src/datasource.js       live (RPC) and offline (fixture) data sources
test/                   unit tests + fixtures
```

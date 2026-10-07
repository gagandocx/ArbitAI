# ArbitAI

A **read-only DEX-to-DEX arbitrage scanner** for cheap EVM chains. It connects
to a chain over JSON-RPC, reads real on-chain pool reserves and quotes from two
or more DEXes, scans a curated set of token pairs, and computes the realistic
**net result after costs** for every cross-DEX price gap — not just the raw gap.
It also runs a honeypot/trap filter on each token and ranks the results.

Default target: **Base** (chainId 8453), comparing **Uniswap V3** and
**Aerodrome**, over a small curated token list of majors plus a couple of liquid
mid-caps.

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

Point it at a live Base RPC endpoint. By default it uses a free public endpoint;
you can override with an environment variable or supply an Alchemy key:

```sh
# Free public endpoint (default)
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

To scan a different chain, uncomment the provided **BSC / PancakeSwap** and
**Arbitrum / Camelot** stub blocks in those three files (they show the exact
shape), register the chain in `CHAINS`, and run with `--chain bsc` or
`--chain arbitrum`. Nothing in the scanning pipeline needs to change — the DEX
read style (`v3` quoter vs `v2` reserves) is selected from config.

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

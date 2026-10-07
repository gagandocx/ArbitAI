import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan, crossDexGap } from '../src/scanner.js';
import { FixtureDataSource } from '../src/datasource.js';
import { DEFAULT_CONFIG } from '../src/config/default.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'base_sample.json'), 'utf8'),
);

function rowFor(rows, pair) {
  return rows.find((r) => r.pair === pair);
}

test('crossDexGap finds the buy-low / sell-high edge', () => {
  const gap = crossDexGap([
    { name: 'A', price: 100 },
    { name: 'B', price: 110 },
  ]);
  assert.equal(gap.buyDex.name, 'A');
  assert.equal(gap.sellDex.name, 'B');
  assert.ok(Math.abs(gap.rawGapFraction - 0.1) < 1e-9);
});

test('scan runs fully offline via FixtureDataSource and ranks candidates', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, DEFAULT_CONFIG.pairs.length);
});

test('the profitable pair ranks above the unprofitable one', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const profitable = rowFor(rows, 'WETH/USDC');
  const unprofitable = rowFor(rows, 'cbETH/WETH');

  assert.ok(profitable, 'WETH/USDC present');
  assert.ok(unprofitable, 'cbETH/WETH present');
  assert.ok(profitable.net > 0, 'profitable pair has positive net');
  assert.equal(profitable.rowVerdict, 'profitable');
  assert.ok(unprofitable.net < 0, 'thin-gap pair goes negative after costs');
  assert.equal(unprofitable.rowVerdict, 'unprofitable');

  const idxProfit = rows.indexOf(profitable);
  const idxUnprofit = rows.indexOf(unprofitable);
  assert.ok(idxProfit < idxUnprofit, 'profitable ranks above unprofitable');
});

test('fee-on-transfer and sell-blocked tokens are flagged avoid and demoted', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const fot = rowFor(rows, 'DAI/USDC');
  const blocked = rowFor(rows, 'USDT/USDC');

  assert.ok(fot.flags.includes('FEE_ON_TRANSFER'), 'FoT flagged');
  assert.equal(fot.trapVerdict, 'avoid');
  assert.equal(fot.rowVerdict, 'trap/avoid');
  assert.equal(fot.actionable, false);

  assert.ok(blocked.flags.includes('SELL_BLOCKED'), 'sell-block flagged');
  assert.equal(blocked.trapVerdict, 'avoid');
  assert.equal(blocked.rowVerdict, 'trap/avoid');
  assert.equal(blocked.actionable, false);

  // Avoid rows are demoted to the bottom (after every survivor).
  const lastSurvivorIdx = rows.findIndex((r) => r.trapVerdict === 'avoid') - 1;
  const profitable = rowFor(rows, 'WETH/USDC');
  assert.ok(rows.indexOf(profitable) <= lastSurvivorIdx);
  assert.ok(rows.indexOf(fot) > lastSurvivorIdx);
  assert.ok(rows.indexOf(blocked) > lastSurvivorIdx);
});

test('the thin / one-sided pair is suspicious (not avoid)', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const thin = rowFor(rows, 'USDC/WETH');
  assert.ok(thin, 'thin pair present');
  assert.equal(thin.trapVerdict, 'suspicious');
  assert.ok(
    thin.flags.includes('THIN_LIQUIDITY') ||
      thin.flags.includes('ONE_SIDED_LIQUIDITY') ||
      thin.flags.includes('LOW_POOL_COUNT'),
    'thin pair carries a soft-trap flag',
  );
  // suspicious is still a survivor, ranked among the non-avoid rows.
  assert.notEqual(thin.rowVerdict, 'trap/avoid');
});

// --- regression: the headline mislead the review caught ------------------
// The USDC/WETH fixture pair is the thinnest, most skewed, single-pool pair
// with the highest raw gap. Before the fix it was labelled 'profitable' and
// ranked #1 above the genuinely clean WETH/USDC pair. These assertions pin the
// intended behavior so that bug cannot ship green again.
test('a suspicious pair gets the suspicious verdict and never ranks #1', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const suspicious = rowFor(rows, 'USDC/WETH');
  const clean = rowFor(rows, 'WETH/USDC');

  // Verdict is 'suspicious', NOT 'profitable', despite a high positive net.
  assert.ok(suspicious.net > 0, 'suspicious pair still has a high positive net');
  assert.equal(suspicious.rowVerdict, 'suspicious');
  assert.notEqual(suspicious.rowVerdict, 'profitable');
  assert.equal(suspicious.actionable, false, 'suspicious is not actionable');

  // The clean profitable pair is the top row; the suspicious pair is below it
  // even though its net is larger.
  assert.equal(clean.rowVerdict, 'profitable');
  assert.equal(rows[0].pair, 'WETH/USDC', 'clean pair ranks #1');
  assert.ok(
    rows.indexOf(clean) < rows.indexOf(suspicious),
    'clean profitable pair outranks the higher-net suspicious pair',
  );
});

// --- regression: the designated clean pair must NOT be false-flagged -------
test('the clean WETH/USDC pair is not false-flagged one-sided (decimals)', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const clean = rowFor(rows, 'WETH/USDC');
  assert.ok(
    !clean.flags.includes('ONE_SIDED_LIQUIDITY'),
    'balanced WETH/USDC (18 vs 6 decimals) must not be flagged one-sided',
  );
  assert.equal(clean.trapVerdict, 'ok');
  assert.equal(clean.rowVerdict, 'profitable');
});

// --- regression: slippage is charged even for V3-legged pairs --------------
test('slippage is applied (non-zero) for V3-legged pairs via the floor', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const clean = rowFor(rows, 'WETH/USDC');
  // Every default pair has a reserve-less V3 leg, so the depth model is
  // unavailable; the configured slippageTolerance floor must still apply.
  const expectedFloor = DEFAULT_CONFIG.slippageTolerance * DEFAULT_CONFIG.tradeSize;
  assert.ok(clean.slippageCost > 0, 'slippage cost is not silently zero');
  assert.ok(
    Math.abs(clean.slippageCost - expectedFloor) < 1e-6,
    `slippage floor (${expectedFloor}) applied, got ${clean.slippageCost}`,
  );
});

// --- gas reflects the units*price path, not just a flat constant -----------
test('gas uses the configured units*price path, not the flat fallback', async () => {
  const rows = await scan(DEFAULT_CONFIG, new FixtureDataSource(fixture));
  const clean = rowFor(rows, 'WETH/USDC');
  // units*price: 400000 * (0.02 gwei -> native/gas) * nativeQuotePrice.
  const nativePerGas = DEFAULT_CONFIG.gasPriceGwei * 1e-9;
  const expectedGas =
    DEFAULT_CONFIG.gasUnitsEstimate * nativePerGas * DEFAULT_CONFIG.nativeQuotePrice;
  assert.ok(
    Math.abs(clean.gasCost - expectedGas) < 1e-6,
    `gas from units*price (${expectedGas}), got ${clean.gasCost}`,
  );
  assert.notEqual(clean.gasCost, DEFAULT_CONFIG.gasUsdEstimate, 'not the flat fallback');
});

// --- live gas path: provider.getGasPrice() wired into the scan -------------
test('live gas price from the provider is wired into the gas cost', async () => {
  // A dataSource exposing a provider.getGasPrice() should drive the gas line.
  const base = new FixtureDataSource(fixture);
  const liveLike = {
    provider: { async getGasPrice() { return 50_000_000n; } }, // 0.05 gwei in wei
    getPairData: (pair) => base.getPairData(pair),
  };
  const rows = await scan(DEFAULT_CONFIG, liveLike);
  const clean = rowFor(rows, 'WETH/USDC');
  const nativePerGas = Number(50_000_000n) / 1e18;
  const expectedGas =
    DEFAULT_CONFIG.gasUnitsEstimate * nativePerGas * DEFAULT_CONFIG.nativeQuotePrice;
  assert.ok(
    Math.abs(clean.gasCost - expectedGas) < 1e-6,
    `live gas (${expectedGas}) from provider.getGasPrice(), got ${clean.gasCost}`,
  );
});

test('excludeAvoid config drops avoid rows entirely', async () => {
  const cfg = { ...DEFAULT_CONFIG, rank: { ...DEFAULT_CONFIG.rank, excludeAvoid: true } };
  const rows = await scan(cfg, new FixtureDataSource(fixture));
  assert.ok(!rows.some((r) => r.trapVerdict === 'avoid'));
  assert.ok(!rowFor(rows, 'DAI/USDC'));
  assert.ok(!rowFor(rows, 'USDT/USDC'));
});

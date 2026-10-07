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

test('excludeAvoid config drops avoid rows entirely', async () => {
  const cfg = { ...DEFAULT_CONFIG, rank: { ...DEFAULT_CONFIG.rank, excludeAvoid: true } };
  const rows = await scan(cfg, new FixtureDataSource(fixture));
  assert.ok(!rows.some((r) => r.trapVerdict === 'avoid'));
  assert.ok(!rowFor(rows, 'DAI/USDC'));
  assert.ok(!rowFor(rows, 'USDT/USDC'));
});

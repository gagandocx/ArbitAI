import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTraps, FLAGS } from '../src/core/traps.js';

test('clean token => no flags, verdict ok', () => {
  const r = evaluateTraps({
    expectedOut: 1000n,
    simulatedOut: 1000n,
    sellReverted: false,
    simulatedSellOut: 1000n,
    liquidity: 500000,
    reserve0: 1000000n,
    reserve1: 1000000n,
    poolCount: 4,
  });
  assert.deepEqual(r.flags, []);
  assert.equal(r.verdict, 'ok');
});

test('fee-on-transfer: simulated output far below expected => avoid', () => {
  // expected 1000, simulated 900 => 10% shortfall > 2% tolerance.
  const r = evaluateTraps({ expectedOut: 1000n, simulatedOut: 900n });
  assert.ok(r.flags.includes(FLAGS.FEE_ON_TRANSFER));
  assert.equal(r.verdict, 'avoid');
});

test('sell-blocked: simulated sell reverted => avoid', () => {
  const r = evaluateTraps({ sellReverted: true });
  assert.ok(r.flags.includes(FLAGS.SELL_BLOCKED));
  assert.equal(r.verdict, 'avoid');
});

test('non-sellable: simulated sell returns zero out => avoid', () => {
  const r = evaluateTraps({ simulatedSellOut: 0n });
  assert.ok(r.flags.includes(FLAGS.NON_SELLABLE));
  assert.equal(r.verdict, 'avoid');
});

test('thin liquidity below floor => suspicious', () => {
  const r = evaluateTraps({ liquidity: 500 }, { minLiquidityFloor: 10000 });
  assert.ok(r.flags.includes(FLAGS.THIN_LIQUIDITY));
  assert.equal(r.verdict, 'suspicious');
});

test('one-sided liquidity beyond skew bound => suspicious', () => {
  // 100x skew exceeds the default 50x bound.
  const r = evaluateTraps({ reserve0: 100n, reserve1: 10000n });
  assert.ok(r.flags.includes(FLAGS.ONE_SIDED_LIQUIDITY));
  assert.equal(r.verdict, 'suspicious');
});

test('low pool count flagged as suspicious (optional heuristic)', () => {
  const r = evaluateTraps({ poolCount: 1 }, { minPoolCount: 2 });
  assert.ok(r.flags.includes(FLAGS.LOW_POOL_COUNT));
  assert.equal(r.verdict, 'suspicious');
});

test('a hard trap overrides soft traps in the verdict', () => {
  const r = evaluateTraps({
    sellReverted: true,
    liquidity: 1, // also thin
  });
  assert.ok(r.flags.includes(FLAGS.SELL_BLOCKED));
  assert.ok(r.flags.includes(FLAGS.THIN_LIQUIDITY));
  assert.equal(r.verdict, 'avoid');
});

test('thresholds are configurable (tighter fee tolerance trips earlier)', () => {
  // 1% shortfall: ok under default 2% tolerance, flagged under a 0.5% config.
  const lenient = evaluateTraps({ expectedOut: 1000n, simulatedOut: 990n });
  assert.ok(!lenient.flags.includes(FLAGS.FEE_ON_TRANSFER));
  const strict = evaluateTraps(
    { expectedOut: 1000n, simulatedOut: 990n },
    { feeOnTransferTolerance: 0.005 },
  );
  assert.ok(strict.flags.includes(FLAGS.FEE_ON_TRANSFER));
});

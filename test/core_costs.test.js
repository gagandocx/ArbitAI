import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNetResult, legSlippageFraction } from '../src/core/costs.js';

test('positive raw gap flips to NEGATIVE net after fees + slippage + gas', () => {
  // Trade size $10,000. Raw gap 0.5% => $50 gross edge.
  // Buy fee 30 bps + sell fee 30 bps = 60 bps => 0.6% => $60 fees.
  // Flat slippage 0.3% => $30. Gas $5.
  // net = 50 - 60 - 30 - 5 = -45  (false positive correctly rejected).
  const r = computeNetResult({
    tradeSize: 10000,
    rawGapFraction: 0.005,
    buyFeeBps: 30,
    sellFeeBps: 30,
    slippageFraction: 0.003,
    gasUsdEstimate: 5,
  });
  assert.equal(r.rawGap, 50);
  assert.equal(r.grossGap, 50);
  assert.equal(r.feeCost, 60);
  assert.equal(r.slippageCost, 30);
  assert.equal(r.gasCost, 5);
  assert.equal(r.net, -45);
  assert.ok(r.net < 0, 'net must be negative');
  assert.equal(r.netFraction, -45 / 10000);
});

test('a large enough gap survives all costs as positive net', () => {
  // Trade size $10,000. Raw gap 3% => $300 gross edge.
  // Fees 60 bps => $60. Slippage 0.4% => $40. Gas $5.
  // net = 300 - 60 - 40 - 5 = 195 (clearly profitable).
  const r = computeNetResult({
    tradeSize: 10000,
    rawGapFraction: 0.03,
    buyFeeBps: 30,
    sellFeeBps: 30,
    slippageFraction: 0.004,
    gasUsdEstimate: 5,
  });
  assert.equal(r.grossGap, 300);
  assert.equal(r.feeCost, 60);
  assert.equal(r.slippageCost, 40);
  assert.equal(r.gasCost, 5);
  assert.equal(r.net, 195);
  assert.ok(r.net > 0, 'net must be positive');
});

test('each cost component is actually subtracted from the gross gap', () => {
  const r = computeNetResult({
    tradeSize: 1000,
    rawGapFraction: 0.1, // $100 gross
    buyFeeBps: 25,
    sellFeeBps: 25, // $5 fees
    slippageFraction: 0.01, // $10
    gasUsdEstimate: 2,
  });
  assert.equal(r.net, r.grossGap - r.feeCost - r.slippageCost - r.gasCost);
  assert.equal(r.net, 100 - 5 - 10 - 2);
});

test('gas is computed from gasUnits * gasPrice when both provided (Base-cheap but non-zero)', () => {
  // 400,000 gas units * 0.0000125 quote/unit = $5.
  const r = computeNetResult({
    tradeSize: 10000,
    rawGapFraction: 0.01,
    buyFeeBps: 0,
    sellFeeBps: 0,
    slippageFraction: 0,
    gasUnits: 400000,
    gasPrice: 0.0000125,
  });
  assert.equal(r.gasCost, 5);
  // Gas is always included even on a cheap chain, so it reduces net.
  assert.equal(r.net, 100 - 5);
});

test('legSlippageFraction grows with trade size relative to pool depth', () => {
  // Pool depth 1,000,000 each side. A larger trade has larger price impact.
  const small = legSlippageFraction(1000n, 1000000n, 1000000n);
  const big = legSlippageFraction(100000n, 1000000n, 1000000n);
  assert.ok(small > 0 && small < 1);
  assert.ok(big > small, 'bigger trade => more slippage');
});

test('slippageModel derives slippage from constant-product impact on BOTH legs', () => {
  // Both legs identical shallow pools; combined slippage = 2x one leg.
  const oneLeg = legSlippageFraction(100n, 100000n, 100000n);
  const r = computeNetResult({
    tradeSize: 10000,
    rawGapFraction: 0.02,
    buyFeeBps: 0,
    sellFeeBps: 0,
    gasUsdEstimate: 0,
    slippageModel: {
      amountIn: 100n,
      buyReserveIn: 100000n,
      buyReserveOut: 100000n,
      sellReserveIn: 100000n,
      sellReserveOut: 100000n,
    },
  });
  // slippageCost = (2 * oneLeg) * tradeSize
  assert.ok(Math.abs(r.slippageCost - 2 * oneLeg * 10000) < 1e-6);
});

test('computeNetResult rejects a non-positive trade size', () => {
  assert.throws(() => computeNetResult({ tradeSize: 0, rawGapFraction: 0.01 }));
});

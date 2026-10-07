import test from 'node:test';
import assert from 'node:assert/strict';
import {
  priceFromReservesV2,
  amountOutV2,
  priceFromQuote,
  toHuman,
} from '../src/core/pricing.js';

test('amountOutV2 matches a hand-computed constant-product vector (30 bps)', () => {
  // reserves 1000/2000, feeBps 30, amountIn 10.
  // amountInWithFee = 10 * (10000 - 30) = 99700
  // numerator       = 99700 * 2000 = 199400000
  // denominator     = 1000 * 10000 + 99700 = 10099700
  // amountOut       = 199400000 / 10099700 = 19 (BigInt truncation)
  const out = amountOutV2(10n, 1000n, 2000n, 30);
  assert.equal(out, 19n);
});

test('amountOutV2 with zero fee matches the pure x*y=k curve', () => {
  // feeBps 0: amountInWithFee = amountIn.
  // out = (10 * 2000) / (1000 + 10) = 20000 / 1010 = 19
  const out = amountOutV2(10n, 1000n, 2000n, 0);
  assert.equal(out, 19n);
});

test('amountOutV2 returns 0 for a zero input', () => {
  assert.equal(amountOutV2(0n, 1000n, 2000n, 30), 0n);
});

test('amountOutV2 rejects an out-of-range fee', () => {
  assert.throws(() => amountOutV2(1n, 1n, 1n, 10000));
  assert.throws(() => amountOutV2(1n, 1n, 1n, -1));
});

test('priceFromReservesV2 handles WETH(18)/USDC(6) decimals', () => {
  // Pool: 100 WETH (1e20 base units) and 300,000 USDC (3e11 base units).
  // Price of USDC-per-WETH = (3e11 / 1e6) / (1e20 / 1e18)
  //                        = 300000 / 100 = 3000.
  const reserveWeth = 100n * 10n ** 18n;
  const reserveUsdc = 300000n * 10n ** 6n;
  const { price, reserveIn, reserveOut } = priceFromReservesV2(
    reserveWeth,
    reserveUsdc,
    18,
    6,
  );
  assert.equal(price, 3000);
  // Raw BigInt reserves are retained for exact downstream math.
  assert.equal(reserveIn, reserveWeth);
  assert.equal(reserveOut, reserveUsdc);
});

test('priceFromReservesV2 rejects non-positive reserves', () => {
  assert.throws(() => priceFromReservesV2(0n, 1n, 18, 6));
});

test('toHuman scales raw base units by decimals', () => {
  assert.equal(toHuman(1500000n, 6), 1.5);
  assert.equal(toHuman(2n * 10n ** 18n, 18), 2);
});

test('priceFromQuote adapts a V3 quoter result to the common price shape', () => {
  // Swap 1 WETH (1e18) and the quoter returns 2995 USDC (2995e6).
  // Realized price = (2995e6 / 1e6) / (1e18 / 1e18) = 2995.
  const amountIn = 1n * 10n ** 18n;
  const amountOut = 2995n * 10n ** 6n;
  const { price, amountIn: aIn, amountOut: aOut } = priceFromQuote(
    amountIn,
    amountOut,
    18,
    6,
  );
  assert.equal(price, 2995);
  assert.equal(aIn, amountIn);
  assert.equal(aOut, amountOut);
});

test('priceFromQuote and priceFromReservesV2 expose the same `price` key', () => {
  const v2 = priceFromReservesV2(1n * 10n ** 18n, 3000n * 10n ** 6n, 18, 6);
  const v3 = priceFromQuote(1n * 10n ** 18n, 3000n * 10n ** 6n, 18, 6);
  assert.equal(typeof v2.price, 'number');
  assert.equal(typeof v3.price, 'number');
  assert.equal(v2.price, v3.price);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeGetPool, decodeGetPool, discoverPools, makeCallFn } from '../sim/discovery.mjs';
import { getDexConfig, getTokens } from '../sim/dex_registry.mjs';

// ---------------------------------------------------------------------------
// All addresses here are FAKE TEST FIXTURES or well-known registry constants.
// The sandbox has no internet; everything runs against an injected callFn stub or
// an in-process mock RPC (global.fetch). Nothing contacts a live chain.
// ---------------------------------------------------------------------------
const WETH = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';
const strip = (h) => h.replace(/^0x/, '');
const asWord = (hex) => '0x' + strip(hex).toLowerCase().padStart(64, '0');
const ZERO = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// encodeGetPool builds factory.getPool(address,address,uint24) calldata.
// ---------------------------------------------------------------------------
test('encodeGetPool produces selector 0x1698ee82 + padded token words + uint24 fee', () => {
  const data = encodeGetPool(WETH, USDC, 500);
  assert.ok(data.startsWith('0x1698ee82'), 'selector is the V3 getPool selector');
  const body = strip(data).slice(8); // drop 0x + 4-byte selector
  assert.equal(body.length, 192, 'three 32-byte words follow the selector');
  const w0 = body.slice(0, 64), w1 = body.slice(64, 128), w2 = body.slice(128, 192);
  assert.equal('0x' + w0, asWord(WETH), 'tokenA left-padded to 32 bytes');
  assert.equal('0x' + w1, asWord(USDC), 'tokenB left-padded to 32 bytes');
  assert.equal(BigInt('0x' + w2), 500n, 'fee encoded in the third word');
});

// ---------------------------------------------------------------------------
// decodeGetPool: null for address(0)/empty, lowercased address otherwise.
// ---------------------------------------------------------------------------
test('decodeGetPool returns null for address(0) / empty and the address otherwise', () => {
  assert.equal(decodeGetPool(ZERO), null, 'address(0) -> null (no pool)');
  assert.equal(decodeGetPool('0x'), null, 'empty result -> null');
  assert.equal(decodeGetPool(null), null, 'null result -> null');

  const POOL = '0xABCdef0000000000000000000000000000001234';
  const result = asWord(POOL); // factory returns the address right-aligned in a 32-byte word
  assert.equal(decodeGetPool(result), POOL.toLowerCase(), 'non-zero -> lowercased 0x+40 address');
});

// ---------------------------------------------------------------------------
// discoverPools issues one eth_call per tier through the injected callFn and
// returns only the non-zero pools.
// ---------------------------------------------------------------------------
test('discoverPools issues one call per tier and returns only non-zero pools', async () => {
  const FACTORY = '0x3333333333333333333333333333333333333333';
  const POOL_500 = '0xaaa0000000000000000000000000000000000500';
  const POOL_3000 = '0xaaa0000000000000000000000000000000003000';
  const tiers = [100, 500, 3000, 10000];

  const calls = [];
  // mock: a real pool for tiers 500 and 3000, address(0) for 100 and 10000.
  const callFn = async (to, data) => {
    calls.push({ to, data });
    assert.equal(to, FACTORY, 'calls go to the factory address');
    assert.ok(data.startsWith('0x1698ee82'), 'calldata is a getPool call');
    const feeWord = strip(data).slice(8).slice(128, 192);
    const fee = Number(BigInt('0x' + feeWord));
    if (fee === 500) return asWord(POOL_500);
    if (fee === 3000) return asWord(POOL_3000);
    return ZERO; // 100 and 10000 have no pool
  };

  const found = await discoverPools({
    chain: 'arbitrum', dex: 'uniswap', tokenA: WETH, tokenB: USDC, tiers, callFn, factory: FACTORY,
  });

  assert.equal(calls.length, tiers.length, 'exactly one eth_call per requested tier');
  assert.deepEqual(found, [
    { chain: 'arbitrum', dex: 'uniswap', tier: 500, pool: POOL_500.toLowerCase() },
    { chain: 'arbitrum', dex: 'uniswap', tier: 3000, pool: POOL_3000.toLowerCase() },
  ], 'only the non-zero pools are returned, in tier order');
});

// ---------------------------------------------------------------------------
// discoverPools wired to the registry factory via a mock, exercising getDexConfig.
// ---------------------------------------------------------------------------
test('discoverPools uses the registry factory for the chain+dex', async () => {
  const cfg = getDexConfig('base', 'uniswap');
  const tokens = getTokens('base');
  assert.ok(cfg.factory.startsWith('0x'), 'registry provides a factory address');

  const seenTo = new Set();
  const callFn = async (to) => { seenTo.add(to); return ZERO; }; // no pools -> empty result
  const found = await discoverPools({
    chain: 'base', dex: 'uniswap', tokenA: tokens.WETH, tokenB: tokens.USDC,
    tiers: cfg.tiers, callFn, factory: cfg.factory,
  });
  assert.deepEqual(found, [], 'all address(0) -> no pools found');
  assert.deepEqual([...seenTo], [cfg.factory], 'every call targeted the registry factory');
});

// ---------------------------------------------------------------------------
// makeCallFn binds to a read-only eth_call batch (in-process mock, no network).
// ---------------------------------------------------------------------------
test('makeCallFn issues a single read-only eth_call via the batch function', async () => {
  const FACTORY = '0x4444444444444444444444444444444444444444';
  const POOL = '0xbbb0000000000000000000000000000000000001';

  const batchFn = async (calls) => {
    assert.equal(calls.length, 1, 'one call per invocation');
    const [method, params] = calls[0];
    assert.equal(method, 'eth_call', 'read-only eth_call only');
    assert.equal(params[0].to, FACTORY);
    assert.equal(params[1], 'latest');
    return [asWord(POOL)];
  };

  const callFn = makeCallFn(batchFn, 'latest');
  const res = await callFn(FACTORY, encodeGetPool(WETH, USDC, 500));
  assert.equal(decodeGetPool(res), POOL.toLowerCase());
});

// ---------------------------------------------------------------------------
// discoverPools validates its inputs (defensive, pure).
// ---------------------------------------------------------------------------
test('discoverPools throws without a callFn / factory / tiers', async () => {
  await assert.rejects(() => discoverPools({ tiers: [500], factory: '0x1', tokenA: WETH, tokenB: USDC }), /callFn/);
  await assert.rejects(() => discoverPools({ tiers: [500], callFn: async () => ZERO, tokenA: WETH, tokenB: USDC }), /factory/);
  await assert.rejects(() => discoverPools({ tiers: [], callFn: async () => ZERO, factory: '0x1', tokenA: WETH, tokenB: USDC }), /tiers/);
});

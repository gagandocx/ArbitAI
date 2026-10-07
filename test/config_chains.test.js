import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConfig, resolveRpcUrl, CHAINS } from '../src/config/index.js';
import { DEXES_BY_CHAIN } from '../src/config/dexes.js';
import { TOKENS_BY_CHAIN, PAIRS_BY_CHAIN } from '../src/config/tokens.js';

// Env with no RPC overrides, so public defaults are exercised deterministically.
const EMPTY_ENV = Object.freeze({});

test('bsc chain is registered and builds end to end without throwing', () => {
  let config;
  assert.doesNotThrow(() => {
    config = buildConfig({ chainKey: 'bsc', env: EMPTY_ENV });
  });

  assert.equal(config.chain.chainId, 56);
  assert.equal(config.quoteSymbol, 'USDT');

  // Activated DEX set matches DEXES_BY_CHAIN (names / kinds / feeBps).
  const dexNames = config.dexes.map((d) => d.name);
  assert.deepEqual(dexNames, ['PancakeSwapV3', 'PancakeSwapV2']);
  assert.equal(config.dexes[0].kind, 'v3');
  assert.equal(config.dexes[0].feeBps, 5);
  assert.equal(config.dexes[1].kind, 'v2');
  assert.equal(config.dexes[1].feeBps, 25);
  assert.equal(config.dexes, DEXES_BY_CHAIN.bsc);

  // Token map and default pairs are the activated ones and non-empty.
  assert.equal(config.tokens, TOKENS_BY_CHAIN.bsc);
  assert.ok(Object.keys(config.tokens).length > 0);
  assert.equal(config.pairs, PAIRS_BY_CHAIN.bsc);
  assert.ok(config.pairs.length > 0);
  assert.ok(config.pairs.every((p) => p.quote === 'USDT'));
});

test('arbitrum chain is registered and builds end to end without throwing', () => {
  let config;
  assert.doesNotThrow(() => {
    config = buildConfig({ chainKey: 'arbitrum', env: EMPTY_ENV });
  });

  assert.equal(config.chain.chainId, 42161);
  assert.equal(config.quoteSymbol, 'USDC');

  const dexNames = config.dexes.map((d) => d.name);
  assert.deepEqual(dexNames, ['UniswapV3', 'Camelot']);
  assert.equal(config.dexes[0].kind, 'v3');
  assert.equal(config.dexes[0].feeBps, 5);
  assert.equal(config.dexes[1].kind, 'v2');
  assert.equal(config.dexes[1].feeBps, 30);
  assert.equal(config.dexes, DEXES_BY_CHAIN.arbitrum);

  assert.equal(config.tokens, TOKENS_BY_CHAIN.arbitrum);
  assert.ok(Object.keys(config.tokens).length > 0);
  assert.equal(config.pairs, PAIRS_BY_CHAIN.arbitrum);
  assert.ok(config.pairs.length > 0);
  assert.ok(config.pairs.every((p) => p.quote === 'USDC'));
});

test('curated token maps carry correct decimals for non-18 stables', () => {
  // Arbitrum native stables are 6-decimal; BSC BEP-20 stables are 18-decimal.
  assert.equal(TOKENS_BY_CHAIN.arbitrum.USDC.decimals, 6);
  assert.equal(TOKENS_BY_CHAIN.arbitrum.USDT.decimals, 6);
  assert.equal(TOKENS_BY_CHAIN.arbitrum.WETH.decimals, 18);
  assert.equal(TOKENS_BY_CHAIN.bsc.USDT.decimals, 18);
  assert.equal(TOKENS_BY_CHAIN.bsc.WBNB.decimals, 18);
});

test('resolveRpcUrl: explicit RPC_URL / overrides.rpcUrl wins for every chain', () => {
  const url = 'https://my-private-node.example/rpc';
  for (const key of ['base', 'bsc', 'arbitrum']) {
    assert.equal(resolveRpcUrl(CHAINS[key], { RPC_URL: url }), url);
    // overrides.rpcUrl flows through buildConfig untouched.
    const cfg = buildConfig({ chainKey: key, env: EMPTY_ENV, overrides: { rpcUrl: url } });
    assert.equal(cfg.rpcUrl, url);
  }
});

test('resolveRpcUrl: ALCHEMY_KEY composes the chain-correct hostname', () => {
  const key = 'test_key_123';
  const env = { ALCHEMY_KEY: key };

  const baseUrl = resolveRpcUrl(CHAINS.base, env);
  assert.match(baseUrl, /base-mainnet\.g\.alchemy\.com/);
  assert.match(baseUrl, new RegExp(`/v2/${key}$`));

  const bscUrl = resolveRpcUrl(CHAINS.bsc, env);
  assert.match(bscUrl, /bnb-mainnet\.g\.alchemy\.com/);
  assert.match(bscUrl, new RegExp(`/v2/${key}$`));

  const arbUrl = resolveRpcUrl(CHAINS.arbitrum, env);
  assert.match(arbUrl, /arb-mainnet\.g\.alchemy\.com/);
  assert.match(arbUrl, new RegExp(`/v2/${key}$`));
});

test('resolveRpcUrl: no ALCHEMY_KEY / RPC_URL falls back to the public endpoint, no key leaks', () => {
  for (const [key, expected] of [
    ['base', 'https://mainnet.base.org'],
    ['bsc', 'https://bsc-dataseed.binance.org'],
    ['arbitrum', 'https://arb1.arbitrum.io/rpc'],
  ]) {
    const url = resolveRpcUrl(CHAINS[key], EMPTY_ENV);
    assert.equal(url, expected);
    assert.ok(!url.includes('alchemy'), 'public endpoint must not reference alchemy');
    assert.ok(!url.includes('/v2/'), 'public endpoint must not embed a key');
  }
});

test('empty-string ALCHEMY_KEY does not compose an Alchemy URL (treated as unset)', () => {
  const url = resolveRpcUrl(CHAINS.bsc, { ALCHEMY_KEY: '   ' });
  assert.equal(url, 'https://bsc-dataseed.binance.org');
});

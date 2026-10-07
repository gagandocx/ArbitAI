// Pins the REACHABLE-RPC-but-empty-V2-pairs behavior.
//
// On the two activated chains (BSC, Arbitrum) and on Base, every V2 DEX ships
// an empty `pairs` map, so no on-chain V2 pair address is configured. Against a
// reachable endpoint the V3 leg returns a quote, but the V2 leg has no pair to
// read. The contract pinned here is that this degrades GRACEFULLY: the V2 leg
// is skipped (with a warning via onWarn) and the pair still returns its V3
// quote, instead of aborting the whole scan with a plain, non-typed Error.
//
// This complements test/offline_degradation.test.js, which only covers the
// UNREACHABLE-endpoint case (where the V3 leg, iterated first, fails fast with
// an OfflineError). Here the fetch SUCCEEDS, so the V2-skip path is exercised
// directly and the plain-Error path is proven gone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RpcDataSource } from '../src/datasource.js';
import { buildConfig } from '../src/config/index.js';
import { scan } from '../src/scanner.js';

// A fetch stub that answers every eth_call with a valid 32-byte uint256 so the
// V3 quoter read (and the V3 sell-sim) succeed. The exact value only needs to
// decode to a finite, positive price; 600 * 1e18 stands in for ~600 quote per
// base at 18/18 decimals.
function reachableFetch() {
  const resultHex = '0x' + (600n * 10n ** 18n).toString(16).padStart(64, '0');
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: resultHex }),
  });
}

test('reachable RPC with an empty V2 pairs map skips the V2 leg instead of throwing (bsc)', async () => {
  const config = buildConfig({ chainKey: 'bsc', env: {} });
  const provider = { call: async () => {
    const r = await reachableFetch();
    const payload = await r.json();
    return payload.result;
  } };

  const warnings = [];
  const dataSource = new RpcDataSource(provider, config, {
    onWarn: (msg) => warnings.push(msg),
  });

  const pair = config.pairs[0]; // WBNB/USDT
  const data = await dataSource.getPairData(pair);

  // The V3 leg is priced; the V2 leg (PancakeSwapV2) is NOT present.
  const names = data.dexes.map((d) => d.name);
  assert.ok(names.includes('PancakeSwapV3'), 'V3 leg should be priced');
  assert.ok(!names.includes('PancakeSwapV2'), 'empty-pairs V2 leg should be skipped');
  assert.equal(data.dexes.length, 1, 'only the V3 leg should remain');
  assert.ok(Number.isFinite(data.dexes[0].price) && data.dexes[0].price > 0);

  // The skip is an explicit signal, not a silent gap, and it names the DEX.
  assert.equal(warnings.length, 1, 'exactly one skip warning expected');
  assert.match(warnings[0], /PancakeSwapV2/);
  assert.match(warnings[0], /no V2 pair address/);
});

test('reachable RPC with empty V2 pairs degrades the full scan to one-sided rows, not an abort (arbitrum)', async () => {
  const config = buildConfig({ chainKey: 'arbitrum', env: {} });
  const provider = { call: async () => {
    const r = await reachableFetch();
    const payload = await r.json();
    return payload.result;
  } };

  const warnings = [];
  const dataSource = new RpcDataSource(provider, config, {
    onWarn: (msg) => warnings.push(msg),
  });

  // scan() must complete for every configured pair without throwing.
  const ranked = await scan(config, dataSource);
  assert.equal(ranked.length, config.pairs.length, 'every pair should still be reported');

  // With only one priced leg per pair there is no cross-DEX opportunity, so
  // each row is trap-only: no buy/sell DEX and a zero net. This is the sensible
  // handling of a sub-two-leg pair (see crossDexGap in src/scanner.js).
  for (const row of ranked) {
    assert.equal(row.buyDex, null, 'no cross-DEX opportunity with a single priced leg');
    assert.equal(row.sellDex, null);
    assert.equal(row.net, 0);
  }

  // One skip warning per pair, each naming Camelot (the empty-pairs V2 DEX).
  assert.equal(warnings.length, config.pairs.length);
  for (const w of warnings) assert.match(w, /Camelot/);
});

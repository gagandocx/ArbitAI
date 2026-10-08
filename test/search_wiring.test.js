import test from 'node:test';
import assert from 'node:assert/strict';

import { expandWatchlist, validateWatchlist } from '../harness/watchlist.mjs';
import {
  forkShapeFitness,
  assembleForkEnv,
  buildGapsHistoryRow,
  GAPS_HISTORY_HEADER,
} from '../harness/make_report.mjs';
import {
  makeRpc,
  scanMarket,
  grossToBps,
  dexPairLabel,
  buildObservation,
} from '../sim/search_scan.mjs';
import { allMarketKeys, selectMarkets, loadScoreboard } from '../harness/search_once.mjs';
import { emptyScoreboard, updateScoreboard } from '../sim/scoreboard.mjs';

// ---------------------------------------------------------------------------
// A FAKE registry so expandWatchlist is tested without depending on the real
// token addresses. ARB only exists on arbitrum; cbETH only on base.
// ---------------------------------------------------------------------------
const FAKE_REGISTRY = {
  getTokens(chain) {
    const t = {
      arbitrum: { WETH: '0xweth_arb', USDC: '0xusdc_arb', ARB: '0xarb_arb', WBTC: '0xwbtc_arb' },
      base: { WETH: '0xweth_base', USDC: '0xusdc_base', cbETH: '0xcbeth_base', WBTC: '0xwbtc_base' },
    }[chain];
    if (!t) throw new Error('unknown chain ' + chain);
    return t;
  },
  listDexes(chain) {
    if (chain !== 'arbitrum' && chain !== 'base') throw new Error('unknown chain ' + chain);
    return ['uniswap', 'pancake', 'sushi'];
  },
};

const WATCHLIST = {
  chains: {
    arbitrum: { enabled: true, rpc_env: 'ARBITRUM_RPC_URL' },
    base: { enabled: false, rpc_env: 'BASE_RPC_URL' },
    polygon: { enabled: true, rpc_env: 'POLYGON_RPC_URL' }, // not in registry -> skipped
  },
  pairs: [
    { base: 'WETH', quote: 'USDC' },
    { base: 'ARB', quote: 'WETH', chains: ['arbitrum'] },
    { base: 'cbETH', quote: 'WETH', chains: ['base'] },
    { base: 'WBTC', quote: 'WETH' },
  ],
  dexes: ['uniswap', 'pancake', 'sushi'],
  batch_size: 4,
  blocks_per_market: 2,
  base_delay_ms: 250,
  max_delay_ms: 5000,
  net_threshold_usd: 0.5,
  sizes: [1000, 5000],
};

// ---------------------------------------------------------------------------
// expandWatchlist: enabled-chain filter + drop pairs whose token is unavailable.
// ---------------------------------------------------------------------------
test('expandWatchlist filters disabled chains and drops unavailable-token pairs', () => {
  const markets = expandWatchlist(WATCHLIST, FAKE_REGISTRY);
  // base is disabled; polygon is not in the registry -> only arbitrum markets.
  assert.ok(markets.every((m) => m.chain === 'arbitrum'), 'only enabled+known chains survive');

  const pairs = markets.map((m) => `${m.pair.base}/${m.pair.quote}`).sort();
  // On arbitrum: WETH/USDC (ok), ARB/WETH (ok, arbitrum-only), WBTC/WETH (ok).
  // cbETH/WETH is base-only -> excluded. All resolved to addresses.
  assert.deepEqual(pairs, ['ARB/WETH', 'WBTC/WETH', 'WETH/USDC']);
  const weth = markets.find((m) => m.pair.base === 'WETH');
  assert.equal(weth.pair.baseAddr, '0xweth_arb');
  assert.equal(weth.pair.quoteAddr, '0xusdc_arb');
  assert.deepEqual(weth.dexes, ['uniswap', 'pancake', 'sushi']);
});

test('expandWatchlist drops a pair when a token is missing on the chain, never throws', () => {
  // enable base; cbETH/WETH should now appear ONLY on base, ARB/WETH only on arbitrum.
  const wl = { ...WATCHLIST, chains: { arbitrum: { enabled: true, rpc_env: 'A' }, base: { enabled: true, rpc_env: 'B' } } };
  const markets = expandWatchlist(wl, FAKE_REGISTRY);
  const arb = markets.filter((m) => m.chain === 'arbitrum').map((m) => `${m.pair.base}/${m.pair.quote}`);
  const base = markets.filter((m) => m.chain === 'base').map((m) => `${m.pair.base}/${m.pair.quote}`);
  assert.ok(arb.includes('ARB/WETH'), 'ARB pair on arbitrum');
  assert.ok(!arb.includes('cbETH/WETH'), 'cbETH not on arbitrum');
  assert.ok(base.includes('cbETH/WETH'), 'cbETH pair on base');
  assert.ok(!base.includes('ARB/WETH'), 'ARB not on base');
});

// ---------------------------------------------------------------------------
// validateWatchlist
// ---------------------------------------------------------------------------
test('validateWatchlist accepts a good watchlist and flags problems', () => {
  assert.equal(validateWatchlist(WATCHLIST).ok, true);

  const bad = validateWatchlist({ chains: {}, pairs: [], dexes: ['uniswap'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /no chains configured/.test(p)));
  assert.ok(bad.problems.some((p) => /no pairs configured/.test(p)));
  assert.ok(bad.problems.some((p) => /at least 2 dexes/.test(p)));

  const enabledNoRpc = validateWatchlist({
    chains: { arbitrum: { enabled: true } },
    pairs: [{ base: 'WETH', quote: 'USDC' }],
    dexes: ['uniswap', 'sushi'],
    batch_size: 1, blocks_per_market: 1, base_delay_ms: 1, max_delay_ms: 1, net_threshold_usd: 0, sizes: [1000],
  });
  assert.equal(enabledNoRpc.ok, false);
  assert.ok(enabledNoRpc.problems.some((p) => /no rpc_env/.test(p)));
});

// ---------------------------------------------------------------------------
// forkShapeFitness + assembleForkEnv: WETH/USDC-shaped -> CONFIRMABLE; WBTC/
// non-stable -> UNCONFIRMED. env maps base->WETH, quote->USDC, pools->A/B/C.
// ---------------------------------------------------------------------------
test('forkShapeFitness: WETH/USDC-shaped pair is confirmable', () => {
  const obs = { decBase: 18, quoteIsStable: true };
  const f = forkShapeFitness(obs);
  assert.equal(f.fits, true);
  assert.equal(f.status, 'CONFIRMABLE');
});

test('forkShapeFitness: WBTC(8-dec)/non-stable pair needs a tailored test', () => {
  const wbtc = forkShapeFitness({ decBase: 8, quoteIsStable: true });
  assert.equal(wbtc.fits, false, '8-dec base does not fit the WETH-shape');
  assert.equal(wbtc.status, 'UNCONFIRMED');
  assert.match(wbtc.note, /tailored test/);

  const nonStable = forkShapeFitness({ decBase: 18, quoteIsStable: false });
  assert.equal(nonStable.fits, false, 'non-stable quote does not fit');
  assert.equal(nonStable.status, 'UNCONFIRMED');
  assert.match(nonStable.note, /stablecoin/);
});

test('assembleForkEnv maps base->WETH, quote->USDC, pools->POOL_A/B/C', () => {
  const obs = {
    decBase: 18, quoteIsStable: true,
    baseAddr: '0xbase', quoteAddr: '0xquote',
    pools: { uniswap: '0xpoolU', sushi: '0xpoolS', pancake: '0xpoolP' },
  };
  const a = assembleForkEnv(obs);
  assert.equal(a.fits, true);
  assert.equal(a.status, 'CONFIRMABLE');
  assert.equal(a.env.WETH, '0xbase');
  assert.equal(a.env.USDC, '0xquote');
  assert.equal(a.env.POOL_A, '0xpoolU');
  assert.equal(a.env.POOL_B, '0xpoolS');
  assert.equal(a.env.POOL_C, '0xpoolP');

  // a mismatched shape still assembles env but is NOT confirmable (never claims REAL)
  const bad = assembleForkEnv({ decBase: 8, quoteIsStable: false, baseAddr: '0xb', quoteAddr: '0xq', pools: { a: '0x1', b: '0x2' } });
  assert.equal(bad.fits, false);
  assert.equal(bad.status, 'UNCONFIRMED');
  assert.equal(bad.env.POOL_A, '0x1');
  assert.equal(bad.env.POOL_B, '0x2');
  assert.equal(bad.env.POOL_C, undefined);
});

// ---------------------------------------------------------------------------
// gaps_history.csv row builder: documented columns + values.
// ---------------------------------------------------------------------------
test('buildGapsHistoryRow emits the documented columns', () => {
  assert.equal(GAPS_HISTORY_HEADER, 'timestamp,chain,pair,dex_pair,block,gross_gap_usd,net_usd,would_confirm');
  const obs = { chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'sushi<->uniswap', block: 123, grossUsd: 1.2345 };
  const row = buildGapsHistoryRow({ timestamp: '2026-01-01T00:00:00.000Z', obs, netUsd: 0.9876, wouldConfirm: true });
  const cols = row.split(',');
  assert.equal(cols.length, 8);
  assert.equal(cols[0], '2026-01-01T00:00:00.000Z');
  assert.equal(cols[1], 'arbitrum');
  assert.equal(cols[2], 'WETH/USDC');
  assert.equal(cols[3], 'sushi<->uniswap');
  assert.equal(cols[4], '123');
  assert.equal(cols[5], '1.2345');
  assert.equal(cols[6], '0.9876');
  assert.equal(cols[7], 'true');
});

// ---------------------------------------------------------------------------
// pure helpers in search_scan
// ---------------------------------------------------------------------------
test('grossToBps and dexPairLabel are pure and stable', () => {
  assert.equal(grossToBps(10, 1000), 100); // $10 gap on $1000 = 100 bps
  assert.equal(grossToBps(5, 0), 0);
  assert.equal(dexPairLabel('uniswap', 'sushi'), 'sushi<->uniswap'); // sorted
  assert.equal(dexPairLabel('sushi', 'uniswap'), 'sushi<->uniswap'); // order-independent
});

test('buildObservation shapes a cycleOut result into an observation', () => {
  const market = { chain: 'arbitrum', pair: { base: 'WETH', quote: 'USDC', baseAddr: '0xb', quoteAddr: '0xq' } };
  const dexA = { dex: 'uniswap', pool: '0xA' };
  const dexB = { dex: 'sushi', pool: '0xB' };
  const plan = { quoteIsStable: true, decBase: 18 };
  const best = { dir: 'A->B', net: 12.5, baseUsd: 2500 };
  const obs = buildObservation({ market, dexA, dexB, plan, best, block: 999, sizeUsd: 1000 });
  assert.equal(obs.chain, 'arbitrum');
  assert.equal(obs.pair, 'WETH/USDC');
  assert.equal(obs.dexPair, 'sushi<->uniswap');
  assert.equal(obs.grossUsd, 12.5);
  assert.equal(obs.gapBps, 125); // 12.5/1000 * 10000
  assert.equal(obs.block, 999);
  assert.equal(obs.baseAddr, '0xb');
  assert.equal(obs.quoteAddr, '0xq');
  assert.deepEqual(obs.pools, { uniswap: '0xA', sushi: '0xB' });
});

// ---------------------------------------------------------------------------
// selectMarkets rolls per-pairing scoreboard keys up to (chain,pair) and never
// starves a never-seen market.
// ---------------------------------------------------------------------------
test('selectMarkets biases to top gaps but includes never-seen markets', () => {
  const markets = expandWatchlist(WATCHLIST, FAKE_REGISTRY); // 3 arbitrum markets
  // Seed the board so WETH/USDC uniswap<->sushi has a big gap (top-ranked).
  let board = emptyScoreboard();
  board = updateScoreboard(board, { chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'sushi<->uniswap', gapBps: 500, ts: 1 });
  const picked = selectMarkets(board, markets, { batchSize: 3, now: 1000 });
  const names = picked.map((m) => `${m.pair.base}/${m.pair.quote}`);
  assert.ok(names.includes('WETH/USDC'), 'top-ranked market selected');
  // batchSize 3 with 3 markets -> all are covered, proving the never-seen ones (ARB,
  // WBTC) are not starved.
  assert.equal(new Set(names).size, picked.length, 'no duplicate markets');
  assert.ok(names.includes('ARB/WETH') && names.includes('WBTC/WETH'), 'never-seen markets covered');
});

// ---------------------------------------------------------------------------
// allMarketKeys enumerates every (chain,pair,dexPair) key.
// ---------------------------------------------------------------------------
test('allMarketKeys enumerates all cross-DEX pairing keys', () => {
  const markets = [{ chain: 'arbitrum', pair: { base: 'WETH', quote: 'USDC' }, dexes: ['uniswap', 'pancake', 'sushi'] }];
  const keys = allMarketKeys(markets);
  // 3 dexes -> 3 pairings (uni<->pan, uni<->sushi, pan<->sushi)
  assert.equal(keys.length, 3);
  assert.ok(keys.every((k) => k.startsWith('arbitrum|weth/usdc|')));
});

// ---------------------------------------------------------------------------
// scanMarket against an IN-PROCESS MOCK RPC (injected fetchImpl). Exercises the
// full read-only glue: discovery -> loadPool -> detectShape -> cycleOut, with the
// ALLOWED-method guard, and asserts an observation with a positive gap comes back.
// NO network: every call is answered by the stub.
// ---------------------------------------------------------------------------
test('scanMarket produces an observation via a mock read-only RPC', async () => {
  const WETH = '0x1111111111111111111111111111111111111111';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const FACTORY_UNI = '0x33128a8fc17869897dce68ed026d694621f6fdfd';
  const FACTORY_SUSHI = '0xc35dadb65012ec5796536bd9864ed8773abc74c4';
  const POOL_UNI = '0xaaa0000000000000000000000000000000000001';
  const POOL_SUSHI = '0xaaa0000000000000000000000000000000000002';
  const QUOTER_UNI = '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a';
  const QUOTER_SUSHI = '0xb1e835dc2785b52265711e17fccb0fd018226a6e';

  const strip = (h) => h.replace(/^0x/, '');
  const asWord = (hex) => '0x' + strip(hex).toLowerCase().padStart(64, '0');
  const uintWord = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', fee: '0xddca3f43', decimals: '0x313ce567', quote: '0xc6a5026a', getPool: '0x1698ee82' };

  // decimals + a 2-DEX same-pair market. Pool UNI quotes WETH cheaper (good buy),
  // Pool SUSHI dearer (good sell) -> a positive cross-DEX gap.
  const DEC = { [WETH]: 18, [USDC]: 6 };
  const amt = (tok, human) => BigInt(Math.round(human * 10 ** DEC[tok.toLowerCase()]));

  function handle(method, params) {
    if (method === 'eth_blockNumber') return uintWord(1000);
    if (method !== 'eth_call') throw new Error('unexpected method ' + method);
    const to = params[0].to.toLowerCase();
    const data = params[0].data;
    const sel = data.slice(0, 10);

    // factory getPool(a,b,fee) -> pool
    if (sel === SEL.getPool) {
      if (to === FACTORY_UNI) return asWord(POOL_UNI);
      if (to === FACTORY_SUSHI) return asWord(POOL_SUSHI);
      return asWord('0x0000000000000000000000000000000000000000');
    }
    // pool reads
    if (to === POOL_UNI || to === POOL_SUSHI) {
      if (sel === SEL.token0) return asWord(WETH);
      if (sel === SEL.token1) return asWord(USDC);
      if (sel === SEL.fee) return uintWord(3000);
    }
    // token decimals
    if (sel === SEL.decimals) {
      if (to === WETH) return uintWord(18);
      if (to === USDC) return uintWord(6);
    }
    // quoter.quoteExactInputSingle(tokenIn,tokenOut,amountIn,fee,limit) -> amountOut
    if (sel === SEL.quote) {
      const tokenIn = '0x' + data.slice(10 + 24, 10 + 64);
      const tokenOut = '0x' + data.slice(10 + 64 + 24, 10 + 128);
      const amountIn = BigInt('0x' + data.slice(10 + 128, 10 + 192));
      const inHuman = Number(amountIn) / 10 ** DEC[tokenIn.toLowerCase()];
      const cheap = to === QUOTER_UNI; // uni cheaper WETH
      if (tokenIn.toLowerCase() === USDC && tokenOut.toLowerCase() === WETH) {
        const rate = cheap ? 1 / 2381 : 1 / 2632;
        return asWordAmt(amt(WETH, inHuman * rate));
      }
      if (tokenIn.toLowerCase() === WETH && tokenOut.toLowerCase() === USDC) {
        const rate = cheap ? 2381 : 2632;
        return asWordAmt(amt(USDC, inHuman * rate));
      }
      return asWordAmt(0n);
    }
    return '0x';
  }
  function asWordAmt(big) { return '0x' + big.toString(16).padStart(64, '0'); }

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, result: handle(r.method, r.params) }));
    return { ok: true, json: async () => (Array.isArray(body) ? out : out[0]) };
  };

  const rpc = makeRpc({ url: 'http://mock', fetchImpl });
  // only read-only methods are allowed
  assert.ok(rpc.ALLOWED.has('eth_call') && rpc.ALLOWED.has('eth_blockNumber'));
  assert.ok(!rpc.ALLOWED.has('eth_sendRawTransaction'));

  const market = {
    chain: 'base',
    pair: { base: 'WETH', quote: 'USDC', baseAddr: WETH, quoteAddr: USDC },
    dexes: ['uniswap', 'sushi'],
  };
  const observations = await scanMarket({ market, rpc, sizes: [1000], blocksPerMarket: 1, baseDelayMs: 0, maxDelayMs: 0 });
  assert.equal(observations.length, 1, 'one cross-DEX pairing observed');
  const obs = observations[0];
  assert.equal(obs.pair, 'WETH/USDC');
  assert.equal(obs.dexPair, 'sushi<->uniswap');
  assert.ok(obs.grossUsd > 0, `positive cross-DEX gap, got ${obs.grossUsd}`);
  assert.ok(obs.gapBps > 0);
  assert.equal(obs.quoteIsStable, true);
  assert.equal(obs.decBase, 18);
  assert.deepEqual(obs.pools, { uniswap: POOL_UNI, sushi: POOL_SUSHI });
});

// ---------------------------------------------------------------------------
// loadScoreboard returns a fresh board for a missing file (no throw).
// ---------------------------------------------------------------------------
test('loadScoreboard returns an empty board for a missing file', () => {
  const board = loadScoreboard('/no/such/scoreboard-xyz.json');
  assert.equal(board.version, 1);
  assert.deepEqual(board.markets, {});
});

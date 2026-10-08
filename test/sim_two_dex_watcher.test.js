import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectShape,
  cycleOut,
  loadPool,
  tokenDecimals,
} from '../sim/live_two_dex_watcher.mjs';

// ---------------------------------------------------------------------------
// All addresses here are FAKE TEST FIXTURES. They are NOT real live pools or
// tokens and must never be presented as such. The sandbox has no internet, so
// everything runs against an in-process mock RPC / mock quote functions.
// ---------------------------------------------------------------------------
const FAKE = {
  WETH: '0x1111111111111111111111111111111111111111', // 18-dec base (NOT ~$1)
  USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // known stable (lowercased)
  USDT: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // known stable (lowercased)
  B3:   '0x07b3000000000000000000000000000000000000', // fake non-stable base token
  WBTC: '0x2222222222222222222222222222222222222222', // fake 8-dec base token
};

// A deterministic decimals map for the mock chain reads.
const DECIMALS = {
  [FAKE.WETH]: 18,
  [FAKE.USDC]: 6,
  [FAKE.USDT]: 6,
  [FAKE.B3]: 18,
  [FAKE.WBTC]: 8,
};
const decimalsFn = async (t) => DECIMALS[t.toLowerCase()];

// Helper: a loaded-pool fixture as produced by loadPool().
function pool(addr, t0, t1, fee) {
  return { addr: addr.toLowerCase(), t0: t0.toLowerCase(), t1: t1.toLowerCase(), fee, quoter: FAKE.WETH };
}

// ---------------------------------------------------------------------------
// (a) SAME-PAIR shape detection: two WETH/USDC-like pools (both tokens shared)
//     selects WETH as base and USDC as the stable quote, with NO 3rd-leg haircut.
// ---------------------------------------------------------------------------
test('SAME-PAIR: both tokens shared -> WETH base, USDC quote, no haircut', async () => {
  const poolA = pool(FAKE.WETH, FAKE.WETH, FAKE.USDC, 500);  // token order WETH/USDC
  const poolB = pool(FAKE.USDC, FAKE.USDC, FAKE.WETH, 3000); // token order flipped USDC/WETH

  const plan = await detectShape(poolA, poolB, { decimalsFn });

  assert.equal(plan.mode, 'SAME_PAIR');
  assert.equal(plan.base, FAKE.WETH, 'base is the non-stable WETH');
  assert.equal(plan.quote, FAKE.USDC, 'quote is the stablecoin USDC');
  assert.equal(plan.decBase, 18, 'WETH base decimals read as 18');
  assert.equal(plan.decQA, 6);
  assert.equal(plan.decQB, 6);
  assert.equal(plan.QA, plan.QB, 'both legs priced in the same stable quote');
  assert.equal(plan.crossStable, false, 'same stable both sides -> no cross-stable leg');
  assert.equal(plan.quoteIsStable, true);
});

// ---------------------------------------------------------------------------
// (b) A profitable SAME-PAIR cycle: WETH is cheaper on pool A than on pool B,
//     so buying BASE on A and selling on B (dir A->B) yields a positive net and
//     the correct direction. No haircut is charged.
// ---------------------------------------------------------------------------
test('SAME-PAIR: profitable cross-DEX cycle yields positive net + correct direction', async () => {
  const poolA = pool(FAKE.WETH, FAKE.WETH, FAKE.USDC, 500);
  const poolB = pool(FAKE.USDC, FAKE.USDC, FAKE.WETH, 3000);
  const plan = await detectShape(poolA, poolB, { decimalsFn });

  const startUsd = 1000;
  // Mock quoteFn: amountOut as BigInt. We encode per-pool rates via `fee`.
  //   feeA=500 (pool A): cheap WETH  -> 1 USDC buys 0.00042 WETH; 1 WETH sells for ~2381 USDC
  //   feeB=3000 (pool B): dear WETH  -> 1 USDC buys 0.00038 WETH; 1 WETH sells for ~2632 USDC
  const DEC = { [FAKE.WETH]: 18, [FAKE.USDC]: 6 };
  function amt(token, human) { return BigInt(Math.round(human * 10 ** DEC[token.toLowerCase()])); }

  const quoteFn = async (tokenIn, tokenOut, amountIn, fee /*, quoter */) => {
    const inHuman = Number(amountIn) / 10 ** DEC[tokenIn.toLowerCase()];
    if (tokenIn === FAKE.USDC && tokenOut === FAKE.WETH) {
      // buy WETH with USDC
      const rate = fee === 500 ? 1 / 2381 : 1 / 2632; // WETH per USDC (A cheaper -> more WETH)
      return amt(FAKE.WETH, inHuman * rate);
    }
    if (tokenIn === FAKE.WETH && tokenOut === FAKE.USDC) {
      // sell WETH for USDC
      const rate = fee === 500 ? 2381 : 2632; // USDC per WETH (B dearer -> more USDC on sell)
      return amt(FAKE.USDC, inHuman * rate);
    }
    throw new Error('unexpected quote ' + tokenIn + '->' + tokenOut);
  };

  const best = await cycleOut(startUsd, plan, poolA, poolB, { quoteFn });
  assert.ok(best, 'a cycle result is returned');
  // Buy cheap on A (0.42 WETH), sell dear on B (2632/WETH) -> ~1105 USDC out => +105 net.
  assert.equal(best.dir, 'A->B', 'profitable direction is buy-on-A / sell-on-B');
  assert.ok(best.net > 0, `net should be positive, got ${best.net}`);
  assert.ok(best.net > 50, `net should reflect the ~5% gap, got ${best.net}`);
  // baseUsd is priced from the base token's real decimals (18 here), ~ $2381.
  assert.ok(best.baseUsd > 2000 && best.baseUsd < 3000, `baseUsd priced sensibly, got ${best.baseUsd}`);
});

// ---------------------------------------------------------------------------
// (c) Legacy ONE-SHARED-TOKEN (B3-style) shape: pools share exactly one base
//     token traded against TWO different stables. Still detected, and the
//     cross-stable 3rd-leg haircut is still charged.
// ---------------------------------------------------------------------------
test('ONE-SHARED-TOKEN: legacy B3 shape detected and still charges cross-stable haircut', async () => {
  const FEE_A = 10000; // pool A: B3/USDT
  const FEE_B = 3000;  // pool B: B3/USDC (DIFFERENT fee tier)
  const poolA = pool(FAKE.B3, FAKE.B3, FAKE.USDT, FEE_A); // B3/USDT
  const poolB = pool(FAKE.USDC, FAKE.USDC, FAKE.B3, FEE_B); // B3/USDC (flipped order)

  const plan = await detectShape(poolA, poolB, { decimalsFn });
  assert.equal(plan.mode, 'ONE_SHARED');
  assert.equal(plan.base, FAKE.B3, 'base is the single shared token');
  assert.equal(plan.QA, FAKE.USDT, 'pool-A quote is USDT');
  assert.equal(plan.QB, FAKE.USDC, 'pool-B quote is USDC');
  assert.equal(plan.crossStable, true, 'different stables -> cross-stable leg');
  assert.equal(plan.quoteIsStable, true);

  // A FLAT market (buy then sell returns exactly startUsd gross) so the ONLY thing
  // reducing net is the cross-stable haircut. With bps=50 the net must be < 0.
  //
  // CRITICAL: this mock routes by (tokenIn, fee) and gives USDC and USDT DIFFERENT
  // identities. Pool A ONLY trades B3<->USDT at FEE_A; pool B ONLY trades B3<->USDC
  // at FEE_B. A (stable, fee) combination that does not correspond to a real pool
  // returns null, exactly as QuoterV2 would revert on a non-existent pool. This is
  // what makes a leg MISPAIRING observable: if cycleOut spends QB (USDC) through
  // pool X's FEE_A, or QA (USDT) through pool Y's FEE_B, the quote resolves to null
  // and the cycle produces no result, failing the assertions below.
  const DEC = { [FAKE.B3]: 18, [FAKE.USDC]: 6, [FAKE.USDT]: 6 };
  function amt(token, human) { return BigInt(Math.round(human * 10 ** DEC[token.toLowerCase()])); }
  // valid (stable, fee) routes: USDT only on pool A (FEE_A), USDC only on pool B (FEE_B)
  const routeOk = (stable, fee) =>
    (stable === FAKE.USDT && fee === FEE_A) || (stable === FAKE.USDC && fee === FEE_B);
  const quoteFn = async (tokenIn, tokenOut, amountIn, fee) => {
    const inHuman = Number(amountIn) / 10 ** DEC[tokenIn.toLowerCase()];
    if (tokenOut === FAKE.B3) {
      // buy B3 with a stable: only valid on that stable's own pool/fee
      if (!routeOk(tokenIn, fee)) return null; // non-existent pool -> QuoterV2 reverts
      return amt(FAKE.B3, inHuman / 10); // 1 stable -> 0.1 B3 (B3 ~ $10), flat
    }
    if (tokenIn === FAKE.B3) {
      // sell B3 into a stable: only valid on that stable's own pool/fee
      if (!routeOk(tokenOut, fee)) return null;
      return amt(tokenOut, inHuman * 10); // 0.1 B3 -> 1 stable back (flat)
    }
    throw new Error('unexpected quote ' + tokenIn + '->' + tokenOut);
  };

  const startUsd = 1000;
  const withHaircut = await cycleOut(startUsd, plan, poolA, poolB, { quoteFn, stableLegBps: 50 });
  assert.ok(withHaircut, 'cycle returns a result (legs are correctly paired with their pools)');
  // Gross is flat (~0), so the 50 bps haircut on ~$1000 (~ -$5) makes net clearly negative.
  assert.ok(withHaircut.net < 0, `cross-stable haircut should push net negative, got ${withHaircut.net}`);
  assert.ok(withHaircut.net < -4 && withHaircut.net > -6, `~50bps of $1000 ~ -$5, got ${withHaircut.net}`);

  // Sanity: the SAME flat market in a SAME-PAIR plan (no haircut) nets ~0, proving the
  // haircut is the only difference between the two modes. SAME-PAIR shares one stable
  // (USDC) and one fee tier, so route both legs through pool B's (USDC, FEE_B).
  const samePairPlan = { ...plan, mode: 'SAME_PAIR', crossStable: false, QA: FAKE.USDC, QB: FAKE.USDC, decQA: 6, decQB: 6 };
  const samePoolA = pool(FAKE.USDC, FAKE.USDC, FAKE.B3, FEE_B);
  const flat = await cycleOut(startUsd, samePairPlan, samePoolA, poolB,
    { quoteFn, stableLegBps: 50 });
  assert.ok(flat, 'same-pair cycle returns a result');
  assert.ok(Math.abs(flat.net) < 0.01, `SAME-PAIR mode charges no haircut (net ~0), got ${flat.net}`);
});

// ---------------------------------------------------------------------------
// (d) Non-18 base decimals read from chain are used in pricing (an 8-dec base,
//     e.g. WBTC-like, must be priced with 10**8, NOT forced to 10**18).
// ---------------------------------------------------------------------------
test('base decimals read from chain are used in pricing (8-dec base, not forced to 18)', async () => {
  const poolA = pool(FAKE.WBTC, FAKE.WBTC, FAKE.USDC, 500);
  const poolB = pool(FAKE.USDC, FAKE.USDC, FAKE.WBTC, 3000);
  const plan = await detectShape(poolA, poolB, { decimalsFn });

  assert.equal(plan.mode, 'SAME_PAIR');
  assert.equal(plan.base, FAKE.WBTC);
  assert.equal(plan.decBase, 8, 'base decimals read from chain as 8');

  const DEC = { [FAKE.WBTC]: 8, [FAKE.USDC]: 6 };
  function amt(token, human) { return BigInt(Math.round(human * 10 ** DEC[token.toLowerCase()])); }
  // WBTC ~ $50000. $1000 buys 0.02 WBTC. Flat market so net ~0; the point is baseUsd.
  const quoteFn = async (tokenIn, tokenOut, amountIn) => {
    const inHuman = Number(amountIn) / 10 ** DEC[tokenIn.toLowerCase()];
    if (tokenOut === FAKE.WBTC) return amt(FAKE.WBTC, inHuman / 50000); // USDC -> WBTC
    return amt(FAKE.USDC, inHuman * 50000);                             // WBTC -> USDC
  };

  const best = await cycleOut(1000, plan, poolA, poolB, { quoteFn });
  assert.ok(best, 'cycle returns a result');
  // baseUsd = startUsd / (baseFromY / 10**decBase). With decBase=8 this is ~$50000.
  // If the code wrongly used 10**18, baseUsd would be astronomically wrong (~5e14).
  assert.ok(best.baseUsd > 40000 && best.baseUsd < 60000,
    `8-dec base priced ~ $50000 using real decimals, got ${best.baseUsd}`);
});

// ---------------------------------------------------------------------------
// detectShape throws a clear error when pools share NO token.
// ---------------------------------------------------------------------------
test('detectShape throws when pools share no token', async () => {
  const poolA = pool(FAKE.WETH, FAKE.WETH, FAKE.USDC, 500);
  const poolB = pool(FAKE.B3, FAKE.B3, FAKE.USDT, 500); // disjoint tokens
  await assert.rejects(() => detectShape(poolA, poolB, { decimalsFn }), /do not share/);
});

// ---------------------------------------------------------------------------
// loadPool + tokenDecimals against an IN-PROCESS MOCK RPC (global.fetch stub).
// This exercises the real read-only RPC path (eth_call batching + ABI decode).
// ---------------------------------------------------------------------------
test('loadPool and tokenDecimals decode an in-process mock RPC (global.fetch)', async () => {
  const POOL = '0x3333333333333333333333333333333333333333';
  const strip = (h) => h.replace(/^0x/, '');
  const asWord = (hex) => '0x' + strip(hex).toLowerCase().padStart(64, '0');
  const uintWord = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

  const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', fee: '0xddca3f43', decimals: '0x313ce567' };

  // Deterministic responses keyed by (to, selector).
  const RESP = {
    [`${POOL}|${SEL.token0}`]: asWord(FAKE.WETH),
    [`${POOL}|${SEL.token1}`]: asWord(FAKE.USDC),
    [`${POOL}|${SEL.fee}`]: uintWord(500),
    [`${FAKE.WETH}|${SEL.decimals}`]: uintWord(18),
    [`${FAKE.USDC}|${SEL.decimals}`]: uintWord(6),
  };

  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((r) => {
      assert.equal(r.method, 'eth_call', 'mock RPC only serves read-only eth_call here');
      const call = r.params[0];
      const to = call.to.toLowerCase();
      const sel = call.data.slice(0, 10);
      const key = `${to}|${sel}`;
      const result = RESP[key];
      assert.ok(result !== undefined, `no mock for ${key}`);
      return { jsonrpc: '2.0', id: r.id, result };
    });
    return { ok: true, json: async () => (Array.isArray(body) ? out : out[0]) };
  };

  try {
    const p = await loadPool(POOL);
    assert.equal(p.addr, POOL.toLowerCase());
    assert.equal(p.t0, FAKE.WETH);
    assert.equal(p.t1, FAKE.USDC);
    assert.equal(p.fee, 500);

    assert.equal(await tokenDecimals(FAKE.WETH), 18);
    assert.equal(await tokenDecimals(FAKE.USDC), 6);
  } finally {
    global.fetch = originalFetch;
  }
});

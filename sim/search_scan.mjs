#!/usr/bin/env node
/*
 * SEARCH SCANNER (read-only, measurement-only) — the I/O layer that GLUES the pure
 * FEAT-002 core (dex_registry / discovery / scoreboard / backoff) to a live RPC and
 * reuses the two-DEX watcher's cross-DEX cycle math.
 *
 * For one market { chain, pair:{base,quote}, dexes } it:
 *   1) discovers each DEX's V3 pool for (base, quote) via sim/discovery.mjs
 *      discoverPools (ONE read-only eth_call per fee tier, through the factory's
 *      getPool), picking the standard tier per DEX,
 *   2) forms the cross-DEX pairings (A<->B, A<->C, B<->C) exactly like the watcher's
 *      SAME-PAIR mode (detectShape + cycleOut),
 *   3) samples a few recent blocks and computes the best net cross-DEX gap at the
 *      configured sizes,
 *   4) returns one observation per pairing { chain, pair, dexPair, gapUsd, gapBps,
 *      netUsd, grossUsd, block, pools, ... }.
 *
 * PACING: it THROTTLES between calls using a delay from sim/backoff.mjs
 * decideScanDelayMs, and on a fetch error that sim/backoff.mjs isRateLimited flags it
 * backs off nextBackoffMs and CONTINUES (it never throws out of the scan loop). The
 * pure DECISIONS (how long to wait, is-this-a-429) live in sim/backoff.mjs; only the
 * actual setTimeout sleep + fetch live here.
 *
 * SAFETY / READ-ONLY INVARIANT: this file touches the chain ONLY through the ALLOWED
 * read-only methods (eth_blockNumber / eth_call / eth_gasPrice / eth_chainId),
 * enforced by the same batch() guard the watcher uses. No key material, no key custody,
 * no transactions. (This file lives under sim/ and is scanned by the read-only guard.)
 */
import { pathToFileURL } from "node:url";
import { getDexConfig } from "./dex_registry.mjs";
import { discoverPools } from "./discovery.mjs";
import { detectShape, cycleOut, firstUint } from "./live_two_dex_watcher.mjs";
import { decideScanDelayMs, isRateLimited, nextBackoffMs } from "./backoff.mjs";

// ----------------------------------------------------- read-only RPC ----
// The SAME allow-list the watcher enforces: only these four read-only methods may ever
// be issued. Any other method throws before a request is built.
const ALLOWED = new Set(["eth_blockNumber", "eth_call", "eth_gasPrice", "eth_chainId"]);

// ----------------------------------------------------- ABI helpers ----
// Identical to the watcher's helpers (kept local, no dependency).
const strip = (h) => (h || "").replace(/^0x/, "");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const aw = (a) => strip(a).toLowerCase().padStart(64, "0");
const addrW = (hex) => "0x" + strip(hex).slice(24).toLowerCase();

const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43", decimals: "0x313ce567", quote: "0xc6a5026a" };

// QuoterV2.quoteExactInputSingle calldata (same shape as the watcher's quoteCall).
function quoteData(tokenIn, tokenOut, amountIn, fee) {
    return SEL.quote + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(fee) + word(0);
}

// sleep(ms) — the ONLY timer in this module; the delay VALUE is decided by backoff.mjs.
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

// makeRpc({ url, fetchImpl }) -> a read-only RPC client with a guarded batch().
// fetchImpl defaults to the global fetch; tests inject a stub. The batch() signature
// matches the watcher's (batch([[method, params], ...]) -> [result, ...]) so it feeds
// sim/discovery.mjs makeCallFn and the watcher's cycle math unchanged.
export function makeRpc({ url, fetchImpl } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new Error("makeRpc needs a fetch implementation (global fetch or injected fetchImpl)");
    let reqId = 1;

    async function batch(calls) {
        for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error("blocked method " + m);
        const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
        const body = reqs.length === 1 ? reqs[0] : reqs;
        const r = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
        });
        if (!r.ok) {
            const err = new Error("HTTP " + r.status);
            err.status = r.status;
            throw err;
        }
        let resp = await r.json();
        if (!Array.isArray(resp)) resp = [resp];
        const byId = new Map(resp.map((x) => [x.id, x]));
        return reqs.map((x) => byId.get(x.id)?.result ?? null);
    }
    return { batch, ALLOWED };
}

// A callFn(to, data) -> hex bound to a read-only eth_call at a block tag, for discovery.
export function makeCallFn(batchFn, blockTag = "latest") {
    return async (to, data) => {
        const [r] = await batchFn([["eth_call", [{ to, data }, blockTag]]]);
        return r;
    };
}

// A quoteFn(tokenIn, tokenOut, amountIn, fee, quoter) -> amountOut BigInt|null bound to
// a read-only eth_call at a block tag, matching the watcher's cycleOut expectation.
export function makeQuoteFn(batchFn, blockTag = "latest") {
    return async (tokenIn, tokenOut, amountIn, fee, quoter) => {
        const [r] = await batchFn([["eth_call", [{ to: quoter, data: quoteData(tokenIn, tokenOut, amountIn, fee) }, blockTag]]]);
        return firstUint(r);
    };
}

// ----------------------------------------------------- pool loading (read-only) ----
// Load a discovered pool's token0/token1/fee at a block tag. Returns the loaded-pool
// shape cycleOut/detectShape expect, with quoter attached. PURE w.r.t. the injected
// batchFn (one read-only eth_call batch).
async function loadPoolAt(batchFn, addr, quoter, blockTag) {
    const [t0, t1, f] = await batchFn([
        ["eth_call", [{ to: addr, data: SEL.token0 }, blockTag]],
        ["eth_call", [{ to: addr, data: SEL.token1 }, blockTag]],
        ["eth_call", [{ to: addr, data: SEL.fee }, blockTag]],
    ]);
    const fee = Number(firstUint(f) ?? 0n);
    return { addr: String(addr).toLowerCase(), t0: addrW(t0), t1: addrW(t1), fee, quoter };
}

// Read an ERC-20 token's decimals at a block tag (read-only). Returns a Number.
async function decimalsAt(batchFn, token, blockTag, dflt = 18) {
    const [d] = await batchFn([["eth_call", [{ to: token, data: SEL.decimals }, blockTag]]]);
    return Number(firstUint(d) ?? BigInt(dflt));
}

// ----------------------------------------------------- gap in bps ----
// grossToBps(grossUsd, startUsd) -> the gross gap expressed in basis points of the
// trade size, so the scoreboard ranks size-independently. PURE.
export function grossToBps(grossUsd, startUsd) {
    if (!startUsd) return 0;
    return (grossUsd / startUsd) * 10000;
}

// dexPairLabel(dexA, dexB) -> a stable "a<->b" label (sorted) for the scoreboard key.
export function dexPairLabel(dexA, dexB) {
    const [a, b] = [String(dexA).toLowerCase(), String(dexB).toLowerCase()].sort();
    return `${a}<->${b}`;
}

// standardTier(dexCfg) -> the per-DEX "medium" tier to prefer when a market has pools
// at several tiers: Pancake uses 2500, the others 3000, falling back to the first tier.
function standardTier(dexCfg) {
    const want = dexCfg.tiers.includes(2500) && !dexCfg.tiers.includes(3000) ? 2500 : 3000;
    return dexCfg.tiers.includes(want) ? want : dexCfg.tiers[0];
}

// ----------------------------------------------------- discovery of a market's pools --
// discoverMarketPools({ market, rpc, blockTag, delayState }) -> for each DEX in the
// market, the chosen { dex, pool, tier, quoter } (or omitted when no pool exists).
// Throttles between the per-DEX discovery calls using decideScanDelayMs. On a 429 it
// backs off and SKIPS that DEX (never throws). PURE core (registry/discovery/backoff)
// is reused; only the sleep + fetch are here.
async function discoverMarketPools({ market, rpc, blockTag, delayState }) {
    const callFn = makeCallFn(rpc.batch, blockTag);
    const chosen = [];
    for (const dex of market.dexes) {
        let dexCfg;
        try {
            dexCfg = getDexConfig(market.chain, dex);
        } catch {
            continue; // unknown dex for this chain -> skip gracefully
        }
        const tier = standardTier(dexCfg);
        try {
            const found = await discoverPools({
                chain: market.chain,
                dex,
                tokenA: market.pair.baseAddr,
                tokenB: market.pair.quoteAddr,
                tiers: [tier],
                callFn,
                factory: dexCfg.factory,
            });
            if (found.length) {
                chosen.push({ dex, pool: found[0].pool, tier: found[0].tier, quoter: dexCfg.quoter });
            }
        } catch (e) {
            if (isRateLimited(e)) {
                delayState.recent429++;
                await sleep(nextBackoffMs({ attempt: delayState.attempt++, baseMs: delayState.baseDelayMs, maxMs: delayState.maxDelayMs }));
                continue; // skip this DEX, keep going
            }
            // a non-429 read error on one DEX should not abort the whole market
            continue;
        }
        await sleep(decideScanDelayMs({ recent429: delayState.recent429, baseDelayMs: delayState.baseDelayMs, maxDelayMs: delayState.maxDelayMs, current: delayState.current }));
    }
    return chosen;
}

// ----------------------------------------------------- observation builder (pure) ----
// buildObservation({ market, dexA, dexB, plan, best, block }) -> the observation object
// the scoreboard + history consume. PURE: it only shapes already-computed numbers, so
// the test suite exercises it directly against a mock cycleOut result.
export function buildObservation({ market, dexA, dexB, plan, best, block, sizeUsd }) {
    const dexPair = dexPairLabel(dexA.dex, dexB.dex);
    const grossUsd = best ? best.net : 0; // cycleOut returns net USD PRE-gas = the gross cross-DEX gap
    const gapBps = grossToBps(grossUsd, sizeUsd);
    return {
        chain: market.chain,
        pair: `${market.pair.base}/${market.pair.quote}`,
        dexPair,
        gapUsd: grossUsd,
        gapBps,
        grossUsd,
        netUsd: grossUsd, // net-of-gas is applied by the driver using eth_gasPrice; pre-gas here
        block,
        sizeUsd,
        dir: best ? best.dir : null,
        baseUsd: best ? best.baseUsd ?? null : null,
        quoteIsStable: plan.quoteIsStable,
        decBase: plan.decBase,
        pools: {
            [dexA.dex]: dexA.pool,
            [dexB.dex]: dexB.pool,
        },
        quoteSymbol: market.pair.quote,
        baseSymbol: market.pair.base,
        baseAddr: market.pair.baseAddr,
        quoteAddr: market.pair.quoteAddr,
    };
}

// ----------------------------------------------------- scan one market (I/O) ----
// scanMarket({ market, rpc, sizes, blocksPerMarket, baseDelayMs, maxDelayMs,
//              gasUsdPerBlock, delayState }) -> array of observations (best per pairing
// across the sampled blocks). Throttles between calls; backs off and continues on 429.
export async function scanMarket({ market, rpc, sizes = [1000], blocksPerMarket = 2,
    baseDelayMs = 250, maxDelayMs = 5000, delayState } = {}) {
    const state = delayState || { recent429: 0, attempt: 0, current: baseDelayMs, baseDelayMs, maxDelayMs };

    // latest block number (read-only)
    let latest;
    try {
        latest = Number(BigInt((await rpc.batch([["eth_blockNumber", []]]))[0] || "0x0"));
    } catch (e) {
        if (isRateLimited(e)) { state.recent429++; await sleep(nextBackoffMs({ attempt: state.attempt++, baseMs: baseDelayMs, maxMs: maxDelayMs })); }
        return [];
    }
    if (!latest) return [];

    // discover each DEX's pool once (at latest); cross-DEX pairings reuse them per block
    const chosen = await discoverMarketPools({ market, rpc, blockTag: "latest", delayState: state });
    if (chosen.length < 2) return []; // need >= 2 DEX pools to compare cross-DEX

    // all cross-DEX pairings (A<->B, A<->C, B<->C)
    const combos = [];
    for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) combos.push([chosen[i], chosen[j]]);

    const bestByPair = new Map();
    const blocks = [];
    for (let k = 0; k < Math.max(1, blocksPerMarket); k++) blocks.push(latest - k);

    for (const blockNum of blocks) {
        const blockTag = "0x" + Math.max(0, blockNum).toString(16);
        const batchFn = rpc.batch;
        const quoteFn = makeQuoteFn(batchFn, blockTag);
        const decimalsFn = (t) => decimalsAt(batchFn, t, blockTag);

        for (const [dexA, dexB] of combos) {
            let poolX, poolY, plan;
            try {
                poolX = await loadPoolAt(batchFn, dexA.pool, dexA.quoter, blockTag);
                poolY = await loadPoolAt(batchFn, dexB.pool, dexB.quoter, blockTag);
                if (!poolX.fee || !poolY.fee) continue; // not a readable V3 pool at this block
                plan = await detectShape(poolX, poolY, { decimalsFn });
            } catch (e) {
                if (isRateLimited(e)) {
                    state.recent429++;
                    await sleep(nextBackoffMs({ attempt: state.attempt++, baseMs: baseDelayMs, maxMs: maxDelayMs }));
                }
                continue; // skip this pairing/block, keep scanning
            }

            // best net cross-DEX gap over the configured sizes
            let best = null, bestSize = sizes[0];
            for (const usd of sizes) {
                let c = null;
                try {
                    c = await cycleOut(usd, plan, poolX, poolY, { quoteFn });
                } catch (e) {
                    if (isRateLimited(e)) {
                        state.recent429++;
                        await sleep(nextBackoffMs({ attempt: state.attempt++, baseMs: baseDelayMs, maxMs: maxDelayMs }));
                    }
                    continue;
                }
                if (c && (!best || c.net > best.net)) { best = c; bestSize = usd; }
                // throttle between quote windows; delay value decided by backoff.mjs
                state.current = decideScanDelayMs({ recent429: state.recent429, baseDelayMs, maxDelayMs, current: state.current });
                await sleep(state.current);
            }
            if (!best) continue;

            const obs = buildObservation({ market, dexA, dexB, plan, best, block: blockNum, sizeUsd: bestSize });
            const prev = bestByPair.get(obs.dexPair);
            if (!prev || obs.gapUsd > prev.gapUsd) bestByPair.set(obs.dexPair, obs);
        }
        // one 429-free block decays the delay back toward base
        state.recent429 = 0;
    }
    return [...bestByPair.values()];
}

// Run main() only when executed directly; stay importable (pure helpers) for tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    console.error("sim/search_scan.mjs is a library used by harness/search_once.mjs; it is not run directly.");
    process.exit(2);
}

#!/usr/bin/env node
/*
 * LIVE TWO-/THREE-DEX WATCHER (watch-only) — one pair across several DEX pools, on Base.
 *
 * Primary use case: a DEEP major pair — WETH/USDC — traded on the SAME two tokens
 * across multiple DEXes (Uniswap V3, PancakeSwap V3, SushiSwap V3 on Base). Every
 * new block it computes, from REAL on-chain quotes, a clean 2-leg cross-DEX loop:
 *   USDC -> buy WETH on DEX A -> sell WETH on DEX B -> USDC   (and the reverse B->A)
 * at several trade sizes, keeps the best, subtracts the live gas cost, and logs a
 * "WOULD-FIRE" signal whenever a flash-loan cycle would net > threshold.
 *
 * TWO shapes are supported, auto-detected from each pool's token0/token1:
 *   • SAME-PAIR mode  — both pools share BOTH tokens (e.g. WETH & USDC). This is the
 *     clean cross-DEX arb: the quote is the stablecoin (USDC, ~$1), the base is the
 *     other token (WETH, 18 dec, NOT ~$1). There is NO 3rd stable leg, so no haircut.
 *     Base-token decimals are read from chain (not assumed 18).
 *   • ONE-SHARED-TOKEN mode (legacy B3 style) — the two pools share exactly one base
 *     token traded against two different stable quotes (e.g. B3/USDC vs B3/USDT). The
 *     cycle ends in the "wrong" stable, so a conservative cross-stable 3rd-leg haircut
 *     is charged. This behavior is unchanged.
 *
 * THREE-DEX coverage: pass --poolC in addition to --poolA/--poolB and, when all three
 * share the same pair, the watcher evaluates all three DEX pairings per block
 * (A<->B, A<->C, B<->C) and reports the best net, labeling which DEX pair fired. When
 * --poolC is omitted it behaves exactly as before (A<->B only).
 *
 * It fires NOTHING. No key custody, no key material, no transactions. It only answers:
 * "how often does a real, above-cost cross-DEX gap actually open on this pair?"
 * That is the make-or-break number to measure BEFORE risking a cent.
 *
 * SAFETY: read-only (eth_blockNumber / eth_call / eth_gasPrice / eth_chainId only).
 * Requirements: Node 18+. Use your Alchemy Base URL (RPC_URL) — public RPCs
 * rate-limit the per-block quoting.
 *
 * POOL ADDRESSES ARE NOT HARDCODED FOR WETH/USDC. The three real Base WETH/USDC pool
 * addresses (Uniswap V3, PancakeSwap V3, SushiSwap V3) must be supplied by YOU from
 * DEX Screener (https://dexscreener.com/base , search "WETH USDC"). The defaults below
 * are the legacy one-shared-token (B3) example and keep that path working; override
 * them for the WETH/USDC cross-DEX run.
 *
 * Usage:
 *   set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   # WETH/USDC across three DEXes (addresses from DEX Screener):
 *   node sim/live_two_dex_watcher.mjs --minutes 60 \
 *        --poolA 0xUNISWAP_V3_WETH_USDC --poolB 0xPANCAKE_V3_WETH_USDC --poolC 0xSUSHI_V3_WETH_USDC
 *   Options: --min-profit-usd 0.10  --sizes 1000,5000,20000,100000
 *            --poolA 0x..  --poolB 0x..  --poolC 0x..  --quoter 0x..  (override the defaults)
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(opt("minutes", 60));
const MIN_PROFIT_USD = Number(opt("min-profit-usd", 0.10)); // after gas; threshold to call it a signal
const SIZES = opt("sizes", "1000,5000,20000,100000").split(",").map(Number);
const GAS_UNITS = BigInt(opt("gas-units", "450000")); // 2-hop flash-loan arb incl. Morpho
const L1_FEE_USD = Number(opt("l1-fee-usd", "0.02"));  // Base L1 data fee approx
const LOG_FILE = opt("log", "two_dex_watch.csv");
const RPCS = process.env.RPC_URL ? [process.env.RPC_URL]
    : ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://1rpc.io/base"];

// ---- proven hotspot pools on Base (legacy B3 one-shared-token example) ----
// For the WETH/USDC cross-DEX use case these MUST be overridden with the three real
// Base pool addresses (Uniswap V3, PancakeSwap V3, SushiSwap V3) from DEX Screener —
// they are deliberately NOT hardcoded here. The watcher AUTO-DETECTS each pool's
// tokens, so it works both for two pools sharing BOTH tokens (SAME-PAIR mode) and for
// two pools sharing one base token against two quotes (legacy ONE-SHARED-TOKEN mode).
const lower = (a) => a.toLowerCase();
const QUOTER = lower(opt("quoter", "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")); // Uniswap QuoterV2 on Base
const POOL_A = lower(opt("poolA", "0xf411dbf5978ce4089cf40ef7b83f813efd312fb0")); // legacy #1 pool (B3/USDT)
const POOL_B = lower(opt("poolB", "0x2df380544b88adb3ad0a94100dcc45fd705aae2d")); // legacy #2 pool (B3/USDC)
const POOL_C = opt("poolC", null) ? lower(opt("poolC", null)) : null;            // optional 3rd DEX pool (WETH/USDC)
// stablecoins we treat as ~$1 and freely convertible (used to pick the quote leg)
const STABLES = new Set([
    lower("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), // USDC
    lower("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"), // USDT
    lower("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"), // USDbC
    lower("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"), // DAI
]);

const SEL = { slot0: "0x3850c7bd", token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43",
    decimals: "0x313ce567", quote: "0xc6a5026a" };

// ----------------------------------------------------- read-only RPC ----
const ALLOWED = new Set(["eth_blockNumber", "eth_call", "eth_gasPrice", "eth_chainId"]);
let rpcIdx = 0, reqId = 1, rpcErr = 0;
async function post(body) {
    for (let i = 0; i < RPCS.length * 3; i++) {
        try {
            const r = await fetch(RPCS[rpcIdx % RPCS.length], { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
            if (!r.ok) throw new Error("HTTP " + r.status);
            return await r.json();
        } catch (e) { rpcErr++; rpcIdx++; await new Promise((x) => setTimeout(x, 800)); }
    }
    throw new Error("All RPC endpoints failed. Set RPC_URL to your Alchemy Base URL.");
}
async function batch(calls) {
    for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error("blocked method " + m);
    const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
    let resp = await post(reqs);
    if (!Array.isArray(resp)) resp = await Promise.all(reqs.map((r) => post(r)));
    const byId = new Map(resp.map((r) => [r.id, r]));
    return reqs.map((r) => byId.get(r.id)?.result ?? null);
}
const rpc = async (m, p) => (await batch([[m, p]]))[0];

// ----------------------------------------------------- ABI helpers ----
const strip = (h) => (h || "").replace(/^0x/, "");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const aw = (a) => strip(a).toLowerCase().padStart(64, "0");
const firstUint = (hex) => (hex && hex !== "0x" ? BigInt("0x" + strip(hex).slice(0, 64)) : null);
const addrW = (hex) => "0x" + strip(hex).slice(24).toLowerCase();

// QuoterV2.quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96)) -> amountOut
function quoteCall(tokenIn, tokenOut, amountIn, fee, blockTag, quoter = QUOTER) {
    const data = SEL.quote + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(fee) + word(0);
    return ["eth_call", [{ to: quoter, data }, blockTag]];
}

// ----------------------------------------------------- pool loading ----
// Read a single pool's token0/token1/fee. Returns { addr, t0, t1, fee }.
async function loadPool(addr, batchFn = batch) {
    const [t0, t1, f] = await batchFn([
        ["eth_call", [{ to: addr, data: SEL.token0 }, "latest"]],
        ["eth_call", [{ to: addr, data: SEL.token1 }, "latest"]],
        ["eth_call", [{ to: addr, data: SEL.fee }, "latest"]],
    ]);
    const fee = Number(firstUint(f) ?? 0n);
    if (!fee) throw new Error(`Could not read fee for pool ${addr} (is the address right?).`);
    return { addr: lower(addr), t0: addrW(t0), t1: addrW(t1), fee };
}

// Read an ERC-20 token's decimals from chain (NOT assumed). Returns a Number.
async function tokenDecimals(token, batchFn = batch, dflt = 18) {
    const [d] = await batchFn([["eth_call", [{ to: token, data: SEL.decimals }, "latest"]]]);
    return Number(firstUint(d) ?? BigInt(dflt));
}

// ----------------------------------------------------- shape detection ----
// Classify a PAIR of loaded pools into a cycle plan.
//   intersection of {t0,t1} == 2  -> SAME-PAIR mode (both tokens shared).
//     quote = the stablecoin (STABLES); base = the other (e.g. WETH, read decimals).
//     NO cross-stable 3rd leg -> haircut 0.
//   intersection == 1             -> ONE-SHARED-TOKEN mode (legacy B3 style).
//     base = the shared token; QA/QB = each pool's own quote; charge cross-stable
//     haircut when QA !== QB.
//   otherwise                     -> throw a clear error.
// Returns a plain plan object; decimals are filled in via decimalsFn (chain reads).
async function detectShape(poolX, poolY, { decimalsFn, stables = STABLES } = {}) {
    const setY = new Set([poolY.t0, poolY.t1]);
    const shared = [poolX.t0, poolX.t1].filter((t) => setY.has(t));

    if (shared.length === 2) {
        // SAME-PAIR: both tokens shared. Pick the stablecoin as the quote.
        const tokens = [poolX.t0, poolX.t1];
        const stableTok = tokens.find((t) => stables.has(t));
        // If neither token is a known stable, fall back to tokens[1] as the quote and
        // the caller is warned the USD figures are approximate. base is then derived as
        // "the token that is NOT the quote", so base and quote are ALWAYS distinct (a V3
        // pool's token0 !== token1); the fallback can never pick the base as the quote.
        const quote = stableTok ?? tokens[1];
        const base = tokens.find((t) => t !== quote);
        const decBase = decimalsFn ? await decimalsFn(base) : 18;
        const decQuote = decimalsFn ? await decimalsFn(quote) : 18;
        return {
            mode: "SAME_PAIR",
            base, quote,
            QA: quote, QB: quote,              // both legs priced in the same stable
            decQA: decQuote, decQB: decQuote,
            decBase,
            crossStable: false,                // same stable both sides -> NO haircut
            quoteIsStable: stables.has(quote),
        };
    }

    if (shared.length === 1) {
        // ONE-SHARED-TOKEN (legacy B3): base is the shared token; each pool keeps its quote.
        const base = shared[0];
        const QA = poolX.t0 === base ? poolX.t1 : poolX.t0;
        const QB = poolY.t0 === base ? poolY.t1 : poolY.t0;
        const decQA = decimalsFn ? await decimalsFn(QA) : 18;
        const decQB = decimalsFn ? await decimalsFn(QB) : 18;
        const decBase = decimalsFn ? await decimalsFn(base) : 18;
        return {
            mode: "ONE_SHARED",
            base, quote: QA,
            QA, QB,
            decQA, decQB,
            decBase,
            crossStable: QA !== QB,            // different quotes -> cross-stable 3rd leg
            quoteIsStable: stables.has(QA) && stables.has(QB),
        };
    }

    throw new Error(
        `Pools do not share one or both tokens (X=${poolX.t0},${poolX.t1} Y=${poolY.t0},${poolY.t1}). ` +
        `Pass pools of the SAME pair (both tokens) or the SAME base token vs two quotes.`);
}

// ----------------------------------------------------- cycle math ----
// Compute the best net USD for a cross-DEX cycle between poolX (fee+quoter) and poolY,
// given a `plan` from detectShape(). Direction X->Y = buy BASE on X, sell BASE on Y for
// the quote; Y->X is the reverse. Net USD = quote_out (quote ~ $1) - startUsd, minus the
// cross-stable 3rd-leg haircut (0 in SAME-PAIR mode). Uses QuoterV2 for exact amounts.
//
// `quoteFn(tokenIn, tokenOut, amountIn, fee, quoter)` returns amountOut as BigInt|null.
// This indirection makes the math testable against an in-process mock RPC.
async function cycleOut(startUsd, plan, poolX, poolY, { quoteFn, stableLegBps = 5 } = {}) {
    const { base, QA, QB, decQA, decQB } = plan;
    const feeX = poolX.fee, feeY = poolY.fee;
    const quoterX = poolX.quoter ?? QUOTER, quoterY = poolY.quoter ?? QUOTER;

    // Each leg's quote token MUST match the pool whose fee/quoter it is swapped
    // through: QA lives in pool X (feeX/quoterX), QB lives in pool Y (feeY/quoterY).
    // In SAME-PAIR mode QA==QB so this is identical both ways; in ONE-SHARED mode
    // QA!==QB and mispairing a quote with the wrong pool would target a non-existent
    // (quote, base, fee) pool and the quote would revert to null.
    //
    // amounts in each quote's own decimals (quote assumed ~$1 stable)
    const inX = BigInt(Math.round(startUsd * 10 ** decQA)); // dir X->Y starts with QA (pool-X quote spent on X)
    const inY = BigInt(Math.round(startUsd * 10 ** decQB)); // dir Y->X starts with QB (pool-Y quote spent on Y)

    // leg 1 of each direction: buy BASE on the pool whose quote we spend
    const baseFromX = await quoteFn(QA, base, inX, feeX, quoterX); // dir X->Y: buy BASE on X with QA
    const baseFromY = await quoteFn(QB, base, inY, feeY, quoterY); // dir Y->X: buy BASE on Y with QB

    // leg 2 of each direction: sell BASE back into the OTHER pool's quote on that pool
    const outX = baseFromX != null ? await quoteFn(base, QB, baseFromX, feeY, quoterY) : null; // sell on Y -> QB
    const outY = baseFromY != null ? await quoteFn(base, QA, baseFromY, feeX, quoterX) : null; // sell on X -> QA

    // cross-stable 3rd-leg haircut: only in ONE-SHARED-TOKEN mode where QA !== QB.
    // In SAME-PAIR mode plan.crossStable is false -> haircut is 0.
    const haircut = (usd) => (plan.crossStable ? (usd * stableLegBps) / 10000 : 0);

    let best = null;
    // dir X->Y: started with startUsd of QA (on X), ended with QB out (on Y)
    if (baseFromX != null && outX != null) {
        const outUsd = Number(outX) / 10 ** decQB; // QB ~ $1
        best = { dir: "A->B", net: outUsd - startUsd - haircut(outUsd) };
    }
    // dir Y->X: started with startUsd of QB (on Y), ended with QA out (on X)
    if (baseFromY != null && outY != null) {
        const outUsd = Number(outY) / 10 ** decQA; // QA ~ $1
        const net2 = outUsd - startUsd - haircut(outUsd);
        if (!best || net2 > best.net) best = { dir: "B->A", net: net2 };
    }
    // price BASE in USD (from pool-Y buy quote) for gas conversion / display — use the
    // base token's REAL decimals from the plan (NOT a hardcoded 10**18).
    if (baseFromY != null && baseFromY > 0n) {
        best = best || null;
        if (best) best.baseUsd = startUsd / (Number(baseFromY) / 10 ** plan.decBase);
    }
    return best; // { dir, net(USD, pre-gas) } or null
}

// A production quoteFn bound to the real RPC batch(). Returns amountOut (BigInt) or null.
function makeLiveQuoteFn(blockTag) {
    return async (tokenIn, tokenOut, amountIn, fee, quoter) => {
        const [r] = await batch([quoteCall(tokenIn, tokenOut, amountIn, fee, blockTag, quoter)]);
        return firstUint(r);
    };
}

// ----------------------------------------------------- runtime state ----
// Loaded pools + the per-pairing plans, built once in discover().
const RUNTIME = { pools: [], pairings: [] };

async function discover() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x2105") throw new Error(`Expected Base (0x2105), got ${chainId}. Point RPC_URL at Base.`);

    const addrs = [POOL_A, POOL_B];
    const labels = ["A", "B"];
    if (POOL_C) { addrs.push(POOL_C); labels.push("C"); }

    const pools = [];
    for (let i = 0; i < addrs.length; i++) {
        const p = await loadPool(addrs[i]);
        p.quoter = QUOTER; p.label = labels[i];
        pools.push(p);
    }
    RUNTIME.pools = pools;

    const decimalsFn = (t) => tokenDecimals(t);
    // Pairings: A<->B always; add A<->C and B<->C when poolC is present.
    const combos = POOL_C ? [[0, 1], [0, 2], [1, 2]] : [[0, 1]];
    RUNTIME.pairings = [];
    for (const [i, j] of combos) {
        const plan = await detectShape(pools[i], pools[j], { decimalsFn });
        RUNTIME.pairings.push({ x: pools[i], y: pools[j], plan, label: `${pools[i].label}<->${pools[j].label}` });
    }

    // ---- report ----
    for (const p of pools) {
        console.log(`Pool ${p.label} ${p.addr} fee ${p.fee}  tokens=${p.t0},${p.t1}`);
    }
    for (const pr of RUNTIME.pairings) {
        const { plan } = pr;
        if (plan.mode === "SAME_PAIR") {
            console.log(`${pr.label}: SAME-PAIR mode — base=${plan.base} (dec ${plan.decBase}), ` +
                `quote=${plan.quote}${plan.quoteIsStable ? " (stable)" : ""}, no 3rd-leg haircut.`);
        } else {
            console.log(`${pr.label}: ONE-SHARED-TOKEN mode — base=${plan.base}, ` +
                `QA=${plan.QA}, QB=${plan.QB}${plan.crossStable ? " (cross-stable: 3rd-leg haircut applied)" : ""}.`);
        }
        if (!plan.quoteIsStable) {
            console.log("  WARNING: a quote token is NOT a known stablecoin. USD figures assume ~1:1 stables;");
            console.log("  results for a non-stable quote are approximate. Pass stablecoin pools for an exact read.");
        }
    }
}

const STATS = { blocks: 0, signals: 0, bestNet: -Infinity, bestDesc: "", survived: 0 };
let lastSignal = null;

async function onBlock(bn) {
    const tag = "0x" + bn.toString(16);
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) || "0x0");
    // gas cost in USD: gas is paid in ETH; approximate ETH price (default $2500).
    const ethUsd = Number(opt("eth-usd", "2500"));
    const gasUsd = (Number(gasPrice * GAS_UNITS) / 1e18) * ethUsd + L1_FEE_USD;
    const stableLegBps = Number(opt("stable-leg-bps", "5"));
    const quoteFn = makeLiveQuoteFn(tag);

    // search sizes across ALL pairings for the best net (cycleOut returns net USD pre-gas)
    let best = null;
    for (const pr of RUNTIME.pairings) {
        for (const usd of SIZES) {
            const c = await cycleOut(usd, pr.plan, pr.x, pr.y, { quoteFn, stableLegBps });
            if (!c) continue;
            const net = c.net - gasUsd;          // free flash loan (Morpho) -> no premium
            if (!best || net > best.net) best = { usd, dir: c.dir, pair: pr.label, grossUsd: c.net, net };
        }
    }
    STATS.blocks++;
    const t = new Date().toISOString().slice(11, 19);
    if (!best) { console.log(`${t} block ${bn} | no quote`); return; }
    if (best.net > STATS.bestNet) { STATS.bestNet = best.net; STATS.bestDesc = `block ${bn} ${best.pair} ${best.dir} $${best.usd}`; }

    const fire = best.net >= MIN_PROFIT_USD;
    const line = `${t} block ${bn} | gas $${gasUsd.toFixed(3)} | best ${best.pair} ${best.dir} $${best.usd}: ` +
        `gross $${best.grossUsd.toFixed(3)}, NET ${best.net >= 0 ? "+" : ""}$${best.net.toFixed(3)}` + (fire ? "  <<<< WOULD FIRE" : "");
    console.log(line);
    fs.appendFileSync(LOG_FILE, [bn, best.pair, best.dir, best.usd, best.grossUsd.toFixed(4), gasUsd.toFixed(4), best.net.toFixed(4), fire].join(",") + "\n");

    if (fire) {
        STATS.signals++;
        if (lastSignal === bn - 1) STATS.survived++;
        lastSignal = bn;
    }
}

function summary() {
    const hrs = (STATS.blocks * 2) / 3600; // Base ~2s blocks
    const poolList = RUNTIME.pools.map((p) => `${p.label}=${p.addr.slice(0, 10)}`).join(" ");
    console.log("\n" + "=".repeat(80));
    console.log(`WATCH-ONLY SUMMARY — pools ${poolList}`);
    console.log(`  blocks watched: ${STATS.blocks} (~${hrs.toFixed(2)} h) | pairings: ${RUNTIME.pairings.map((p) => p.label).join(", ")}`);
    console.log(`  WOULD-FIRE signals (net >= $${MIN_PROFIT_USD}): ${STATS.signals}`);
    console.log(`  ...that persisted into the next block: ${STATS.survived}`);
    console.log(`  best net seen: $${STATS.bestNet.toFixed(3)} (${STATS.bestDesc})`);
    console.log(`  RPC errors: ${rpcErr}. Log: ${LOG_FILE}`);
    console.log("  NOTE: watch-only. A 'WOULD FIRE' is an on-chain quote at block end — a real bot");
    console.log("        would still have to win the race to land it. This measures opportunity, not capture.");
    console.log("=".repeat(80));
}

async function main() {
    await discover();
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,pair,dir,size_usd,gross_usd,gas_usd,net_usd,would_fire\n");
    const pairDesc = RUNTIME.pairings.map((p) => p.label).join(", ");
    console.log(`\nWatching one pair across pools [${pairDesc}], sizes $${SIZES.join(", $")}, signal threshold net >= $${MIN_PROFIT_USD}.`);
    console.log(`Running ${MINUTES} min. Ctrl+C for summary.\n`);
    process.on("SIGINT", () => { summary(); process.exit(0); });
    const end = Date.now() + MINUTES * 60000;
    let last = 0;
    while (Date.now() < end) {
        try {
            const bn = Number(BigInt(await rpc("eth_blockNumber", [])));
            if (bn > last) { last = bn; await onBlock(bn); }
        } catch (e) { console.error("  error:", e.message); }
        await new Promise((r) => setTimeout(r, 1500));
    }
    summary();
}

// Run main() only when executed directly; stay importable (pure functions) for tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch((e) => { console.error(e.message); process.exit(1); });
}

// Exported for the in-process mock-RPC test suite (test/sim_two_dex_watcher.test.js).
export { detectShape, cycleOut, loadPool, tokenDecimals, firstUint, addrW, quoteCall, STABLES };

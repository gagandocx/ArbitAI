#!/usr/bin/env node
/*
 * LIVE TWO-DEX WATCHER (watch-only) — one pair, two pools, on Base.
 *
 * Watches the single most-arbitraged pair the recon found on Base — USDC/WETH on
 * the two hotspot pools — and every new block computes, from REAL on-chain quotes:
 *   borrow USDC -> buy WETH on pool A -> sell WETH on pool B -> USDC   (and B->A)
 * at several trade sizes, keeps the best, subtracts the live gas cost, and logs a
 * "WOULD-FIRE" signal whenever a flash-loan cycle would net > threshold.
 *
 * It fires NOTHING. No wallet, no key material, no transactions. It only answers:
 * "how often does a real, above-cost two-DEX gap actually open on this pair?"
 * That is the make-or-break number to measure BEFORE risking a cent.
 *
 * SAFETY: read-only (eth_blockNumber / eth_call / eth_gasPrice / eth_chainId).
 * Requirements: Node 18+. Use your Alchemy Base URL (RPC_URL) — public RPCs
 * rate-limit the per-block quoting.
 *
 * Usage:
 *   set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   node sim/live_two_dex_watcher.mjs --minutes 60
 *   Options: --min-profit-usd 0.10  --sizes 1000,5000,20000,100000
 *            --poolA 0x..  --poolB 0x..  --quoter 0x..  (override the defaults)
 */
import fs from "node:fs";

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

// ---- the proven hotspot pools on Base (the token 0x07b3… = B3, vs USDC & USDT) ----
// The watcher AUTO-DETECTS each pool's tokens, so it works for any two pools that
// share a common "base" token traded against two (possibly different) quote tokens.
const lower = (a) => a.toLowerCase();
const QUOTER = lower(opt("quoter", "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")); // Uniswap QuoterV2 on Base
const POOL_A = lower(opt("poolA", "0xf411dbf5978ce4089cf40ef7b83f813efd312fb0")); // #1 arbitraged pool (B3/USDT)
const POOL_B = lower(opt("poolB", "0x2df380544b88adb3ad0a94100dcc45fd705aae2d")); // #2 arbitraged pool (B3/USDC)
// stablecoins we treat as ~$1 and freely convertible (for the quote-token leg)
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

// QuoterV2.quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96)) -> amountOut
function quoteCall(tokenIn, tokenOut, amountIn, fee, blockTag) {
    const data = SEL.quote + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(fee) + word(0);
    return ["eth_call", [{ to: QUOTER, data }, blockTag]];
}

// ----------------------------------------------------- setup ----
// Auto-detected: the shared "base" token (e.g. B3) and each pool's quote token.
let BASE_TOK = null, QA = null, QB = null;        // base token, pool-A quote, pool-B quote
let feeA = 0, feeB = 0, decQA = 6, decQB = 6, baseUsd = 0;
const addrW = (hex) => "0x" + strip(hex).slice(24).toLowerCase();

async function discover() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x2105") throw new Error(`Expected Base (0x2105), got ${chainId}. Point RPC_URL at Base.`);
    const [t0a, t1a, fa, t0b, t1b, fb] = await batch([
        ["eth_call", [{ to: POOL_A, data: SEL.token0 }, "latest"]],
        ["eth_call", [{ to: POOL_A, data: SEL.token1 }, "latest"]],
        ["eth_call", [{ to: POOL_A, data: SEL.fee }, "latest"]],
        ["eth_call", [{ to: POOL_B, data: SEL.token0 }, "latest"]],
        ["eth_call", [{ to: POOL_B, data: SEL.token1 }, "latest"]],
        ["eth_call", [{ to: POOL_B, data: SEL.fee }, "latest"]],
    ]);
    const a0 = addrW(t0a), a1 = addrW(t1a), b0 = addrW(t0b), b1 = addrW(t1b);
    feeA = Number(firstUint(fa) ?? 0n); feeB = Number(firstUint(fb) ?? 0n);
    if (!feeA || !feeB) throw new Error("Could not read pool fees (is the --quoter / pool address right?).");

    // the base token is the one both pools share
    const setB = new Set([b0, b1]);
    const shared = [a0, a1].filter((t) => setB.has(t));
    if (shared.length !== 1) throw new Error(`Pools do not share exactly one token (A=${a0},${a1} B=${b0},${b1}). Pass two pools of the SAME base token vs two quotes.`);
    BASE_TOK = shared[0];
    QA = a0 === BASE_TOK ? a1 : a0;   // pool-A quote token
    QB = b0 === BASE_TOK ? b1 : b0;   // pool-B quote token

    const [dqa, dqb] = await batch([
        ["eth_call", [{ to: QA, data: SEL.decimals }, "latest"]],
        ["eth_call", [{ to: QB, data: SEL.decimals }, "latest"]],
    ]);
    decQA = Number(firstUint(dqa) ?? 18n); decQB = Number(firstUint(dqb) ?? 18n);

    const qaStable = STABLES.has(QA), qbStable = STABLES.has(QB);
    console.log(`Base token : ${BASE_TOK}`);
    console.log(`Pool A ${POOL_A} fee ${feeA}  quote=${QA}${qaStable ? " (stable)" : ""}`);
    console.log(`Pool B ${POOL_B} fee ${feeB}  quote=${QB}${qbStable ? " (stable)" : ""}`);
    if (!qaStable || !qbStable) {
        console.log("  WARNING: a quote token is NOT a known stablecoin. The USD/cross-quote leg assumes ~1:1 stables;");
        console.log("  results for a non-stable quote are approximate. Pass stablecoin pools for an exact read.");
    }
}

// Cycle (watch-only): start with `startUsd` worth of pool-B's quote token, buy BASE on
// pool B, sell BASE on pool A for pool-A's quote, and (if quotes differ, both stables)
// treat the result ~1:1 back to the start quote. Also tries the reverse (A first).
// Returns the best net in USD. Uses QuoterV2 for exact executable amounts incl. fees.
async function cycleOut(startUsd, tag) {
    // amounts in each quote's own decimals (stables assumed ~$1)
    const inB = BigInt(Math.round(startUsd * 10 ** decQB)); // start in QB
    const inA = BigInt(Math.round(startUsd * 10 ** decQA)); // start in QA

    // Direction 1: QB -> BASE (pool B) -> QA (pool A)
    // Direction 2: QA -> BASE (pool A) -> QB (pool B)
    const [b1q, a1q] = await batch([
        quoteCall(QB, BASE_TOK, inB, feeB, tag),   // buy BASE on pool B with QB
        quoteCall(QA, BASE_TOK, inA, feeA, tag),   // buy BASE on pool A with QA
    ]);
    const baseFromB = firstUint(b1q), baseFromA = firstUint(a1q);
    const calls = [];
    calls.push(baseFromB != null ? quoteCall(BASE_TOK, QA, baseFromB, feeA, tag) : ["eth_chainId", []]); // sell on A -> QA
    calls.push(baseFromA != null ? quoteCall(BASE_TOK, QB, baseFromA, feeB, tag) : ["eth_chainId", []]); // sell on B -> QB
    const [o1, o2] = await batch(calls);

    // If the two pools quote in DIFFERENT stablecoins (e.g. B3/USDC vs B3/USDT),
    // the cycle ends in the wrong stable and needs a 3rd swap (USDT<->USDC) to truly
    // return to the start token. Charge a conservative cost for that leg so we don't
    // over-count. Default 5 bps (~a stable-pool fee); override with --stable-leg-bps.
    const crossStable = QA !== QB;
    const stableLegBps = Number(opt("stable-leg-bps", "5"));
    const haircut = (usd) => (crossStable ? (usd * stableLegBps) / 10000 : 0);

    let best = null;
    // dir1: started with startUsd of QB, ended with QA out -> net USD = QA_out_usd - startUsd - 3rd-leg
    if (baseFromB != null) {
        const outUsd = o1 && o1 !== "0x" ? Number(firstUint(o1)) / 10 ** decQA : null; // QA ~ $1
        if (outUsd != null) best = { dir: "B->A", net: outUsd - startUsd - haircut(outUsd) };
    }
    // dir2: started with startUsd of QA, ended with QB out
    if (baseFromA != null) {
        const outUsd = o2 && o2 !== "0x" ? Number(firstUint(o2)) / 10 ** decQB : null;
        const net2 = outUsd != null ? outUsd - startUsd - haircut(outUsd) : null;
        if (net2 != null && (!best || net2 > best.net)) best = { dir: "A->B", net: net2 };
    }
    // price BASE in USD (from pool A quote) for gas conversion / display
    if (baseFromA != null && baseFromA > 0n) baseUsd = startUsd / (Number(baseFromA) / 10 ** 18); // assumes BASE 18 dec
    return best; // { dir, net(USD, pre-gas) }
}

const STATS = { blocks: 0, signals: 0, bestNet: -Infinity, bestDesc: "", survived: 0 };
let lastSignal = null;

async function onBlock(bn) {
    const tag = "0x" + bn.toString(16);
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) || "0x0");
    // gas cost in USD: gas is paid in ETH; approximate ETH at $2500 if we can't price it
    // (the cycle tokens here are a token + stables, so we don't have a direct ETH quote).
    const ethUsd = Number(opt("eth-usd", "2500"));
    const gasUsd = (Number(gasPrice * GAS_UNITS) / 1e18) * ethUsd + L1_FEE_USD;

    // search sizes for the best net (cycleOut already returns net USD pre-gas)
    let best = null;
    for (const usd of SIZES) {
        const c = await cycleOut(usd, tag);
        if (!c) continue;
        const net = c.net - gasUsd;              // free flash loan (Morpho) -> no premium
        if (!best || net > best.net) best = { usd, dir: c.dir, grossUsd: c.net, net };
    }
    STATS.blocks++;
    const t = new Date().toISOString().slice(11, 19);
    if (!best) { console.log(`${t} block ${bn} | no quote`); return; }
    if (best.net > STATS.bestNet) { STATS.bestNet = best.net; STATS.bestDesc = `block ${bn} ${best.dir} $${best.usd}`; }

    const fire = best.net >= MIN_PROFIT_USD;
    const line = `${t} block ${bn} | gas $${gasUsd.toFixed(3)} | best ${best.dir} $${best.usd}: ` +
        `gross $${best.grossUsd.toFixed(3)}, NET ${best.net >= 0 ? "+" : ""}$${best.net.toFixed(3)}` + (fire ? "  <<<< WOULD FIRE" : "");
    console.log(line);
    fs.appendFileSync(LOG_FILE, [bn, best.dir, best.usd, best.grossUsd.toFixed(4), gasUsd.toFixed(4), best.net.toFixed(4), fire].join(",") + "\n");

    if (fire) {
        STATS.signals++;
        if (lastSignal === bn - 1) STATS.survived++;
        lastSignal = bn;
    }
}

function summary() {
    const hrs = (STATS.blocks * 2) / 3600; // Base ~2s blocks
    console.log("\n" + "=".repeat(80));
    console.log(`WATCH-ONLY SUMMARY — base token ${BASE_TOK ? BASE_TOK.slice(0,10) : "?"}, pools ${POOL_A.slice(0,10)} & ${POOL_B.slice(0,10)}`);
    console.log(`  blocks watched: ${STATS.blocks} (~${hrs.toFixed(2)} h) | fee tiers: A=${feeA} B=${feeB}`);
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
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,dir,size_usd,gross_usd,gas_usd,net_usd,would_fire\n");
    console.log(`\nWatching USDC/WETH on 2 pools, sizes $${SIZES.join(", $")}, signal threshold net >= $${MIN_PROFIT_USD}.`);
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
main().catch((e) => { console.error(e.message); process.exit(1); });

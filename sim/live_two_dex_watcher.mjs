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

// ---- the proven hotspot pair/pools on Base (USDC/WETH), from the recon ----
const lower = (a) => a.toLowerCase();
const USDC = lower("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const WETH = lower("0x4200000000000000000000000000000000000006");
const QUOTER = lower(opt("quoter", "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")); // Uniswap QuoterV2 on Base
const POOL_A = lower(opt("poolA", "0xf411dbf5978ce4089cf40ef7b83f813efd312fb0")); // #1 arbitraged pool
const POOL_B = lower(opt("poolB", "0x2df380544b88adb3ad0a94100dcc45fd705aae2d")); // #2 arbitraged pool

const SEL = { slot0: "0x3850c7bd", token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43",
    quote: "0xc6a5026a" };

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
let feeA = 0, feeB = 0, wethUsd = 0;
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
    const a0 = "0x" + strip(t0a).slice(24), a1 = "0x" + strip(t1a).slice(24);
    const b0 = "0x" + strip(t0b).slice(24), b1 = "0x" + strip(t1b).slice(24);
    feeA = Number(firstUint(fa) ?? 0n); feeB = Number(firstUint(fb) ?? 0n);
    const okA = [a0, a1].sort().join() === [USDC, WETH].sort().join();
    const okB = [b0, b1].sort().join() === [USDC, WETH].sort().join();
    console.log("Pool A", POOL_A, "fee", feeA, okA ? "(USDC/WETH ok)" : "!! NOT USDC/WETH: " + a0 + "," + a1);
    console.log("Pool B", POOL_B, "fee", feeB, okB ? "(USDC/WETH ok)" : "!! NOT USDC/WETH: " + b0 + "," + b1);
    if (!okA || !okB) throw new Error("A pool is not the USDC/WETH pair — pass --poolA/--poolB with correct addresses.");
    if (!feeA || !feeB) throw new Error("Could not read pool fees (is QuoterV2 address right? pass --quoter).");
}

// Quote both directions of a flash cycle for a given USDC input, pick the best.
// Direction 1: USDC --A--> WETH --B--> USDC ; Direction 2: USDC --B--> WETH --A--> USDC
async function cycleOut(usdcIn, tag) {
    const amt = BigInt(Math.round(usdcIn * 1e6));
    // leg1 both pools: USDC->WETH
    const [wA, wB] = await batch([
        quoteCall(USDC, WETH, amt, feeA, tag),
        quoteCall(USDC, WETH, amt, feeB, tag),
    ]);
    const wethA = firstUint(wA), wethB = firstUint(wB);
    if (wethA == null && wethB == null) return null;
    // leg2: sell the WETH on the OTHER pool back to USDC
    const calls = [];
    if (wethA != null) calls.push(quoteCall(WETH, USDC, wethA, feeB, tag)); else calls.push(["eth_chainId", []]);
    if (wethB != null) calls.push(quoteCall(WETH, USDC, wethB, feeA, tag)); else calls.push(["eth_chainId", []]);
    const [o1, o2] = await batch(calls);
    const out1 = wethA != null ? firstUint(o1) : null; // A then B
    const out2 = wethB != null ? firstUint(o2) : null; // B then A
    let best = null;
    if (out1 != null) best = { dir: "A->B", out: out1 };
    if (out2 != null && (!best || out2 > best.out)) best = { dir: "B->A", out: out2 };
    return best ? { ...best, amt } : null;
}

const STATS = { blocks: 0, signals: 0, bestNet: -Infinity, bestDesc: "", survived: 0 };
let lastSignal = null;

async function onBlock(bn) {
    const tag = "0x" + bn.toString(16);
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) || "0x0");
    // price WETH in USDC from pool A (1 WETH quote) for the gas conversion
    const [wq] = await batch([quoteCall(WETH, USDC, 10n ** 18n, feeA, tag)]);
    const wUsd = firstUint(wq); if (wUsd != null) wethUsd = Number(wUsd) / 1e6;
    const gasUsd = (Number(gasPrice * GAS_UNITS) / 1e18) * (wethUsd || 2500) + L1_FEE_USD;

    // search sizes for the best net
    let best = null;
    for (const usd of SIZES) {
        const c = await cycleOut(usd, tag);
        if (!c) continue;
        const grossUsd = (Number(c.out - c.amt) / 1e6);
        const net = grossUsd - gasUsd;           // free flash loan (Morpho) -> no premium
        if (!best || net > best.net) best = { usd, dir: c.dir, grossUsd, net };
    }
    STATS.blocks++;
    const t = new Date().toISOString().slice(11, 19);
    if (!best) { console.log(`${t} block ${bn} | no quote`); return; }
    if (best.net > STATS.bestNet) { STATS.bestNet = best.net; STATS.bestDesc = `block ${bn} ${best.dir} $${best.usd}`; }

    const fire = best.net >= MIN_PROFIT_USD;
    const line = `${t} block ${bn} | ETH $${(wethUsd || 0).toFixed(0)} | gas $${gasUsd.toFixed(3)} | best ${best.dir} $${best.usd}: ` +
        `gross $${best.grossUsd.toFixed(3)}, NET ${best.net >= 0 ? "+" : ""}$${best.net.toFixed(3)}` + (fire ? "  <<<< WOULD FIRE" : "");
    console.log(line);
    fs.appendFileSync(LOG_FILE, [bn, best.dir, best.usd, best.grossUsd.toFixed(4), gasUsd.toFixed(4), best.net.toFixed(4), fire].join(",") + "\n");

    if (fire) {
        STATS.signals++;
        // did the previous block's signal still stand this block? (persistence check)
        if (lastSignal === bn - 1) STATS.survived++;
        lastSignal = bn;
    }
}

function summary() {
    const hrs = (STATS.blocks * 2) / 3600; // Base ~2s blocks
    console.log("\n" + "=".repeat(80));
    console.log(`WATCH-ONLY SUMMARY — USDC/WETH, pools ${POOL_A.slice(0,10)} & ${POOL_B.slice(0,10)}`);
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

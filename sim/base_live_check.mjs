#!/usr/bin/env node
/*
 * READ-ONLY live gap check on BASE (chain 8453) across many tokens.
 *
 * Question it answers: "Are cross-DEX gaps bigger / more frequent on other
 * tokens or a cheap chain than on Ethereum ETH/USDC?"
 *
 * Every poll it takes REAL round-trip quotes:  flash-borrow X (USDC or WETH)
 * -> buy TOKEN on DEX A -> sell TOKEN on DEX B -> back to X, for several trade
 * sizes, using the DEXes' own on-chain quote functions (fees and price impact
 * included):
 *   - Uniswap V3 (QuoterV2, every fee tier that has a pool)
 *   - Aerodrome  (pool.getAmountOut on both "volatile" and "stable" pools)
 * Then it subtracts the Aave flash fee (read live) and gas (live gas price),
 * and reports:
 *   - profitable at all (net > 0)
 *   - passes the original contract's rule (final >= loan + Aave fee + 0.5%)
 *   - still there at the next poll (could anyone slower than the top bots get it?)
 *
 * NOTE: the original ArbitrageExecutor contract could NOT execute most of these
 * routes on Base anyway (Aerodrome's router uses a different swap interface,
 * and the contract's V3 swap call needs the old SwapRouter). This measures
 * whether the opportunities EXIST.
 *
 * SAFETY: read-only (eth_call / eth_blockNumber / eth_gasPrice / eth_chainId /
 * eth_getCode only). No wallet, no key, no transactions.
 *
 * Usage: node sim/base_live_check.mjs [--minutes 60] [--every 12] [--sizes 1000,10000]
 *        RPC_URL=<your Base RPC> to use your own node.
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(opt("minutes", 60));
const EVERY_SEC = Number(opt("every", 12));                 // Base makes a block every 2 s; public RPCs limit us
const SIZES_USD = opt("sizes", "1000,10000").split(",").map(Number);
const MIN_PROFIT_BPS = Number(opt("min-profit-bps", 50));   // original contract default
const GAS_UNITS = BigInt(opt("gas-units", "400000"));
const L1_FEE_USD = Number(opt("l1-fee-usd", "0.02"));       // Base's extra L1 data fee per tx (approx.)
const LOG_FILE = opt("log", "base_live_log.csv");
const RPCS = process.env.RPC_URL ? [process.env.RPC_URL]
    : ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"];

// ----------------------------------------------------------- addresses ----
const lower = (a) => a.toLowerCase();
const TOKENS = [ // symbol must match on-chain symbol() or the token is skipped
    { sym: "WETH",    addr: "0x4200000000000000000000000000000000000006" },
    { sym: "USDC",    addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { sym: "USDbC",   addr: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
    { sym: "DAI",     addr: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
    { sym: "USDT",    addr: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", altSyms: ["USD₮0", "USDT0"] },
    { sym: "cbETH",   addr: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
    { sym: "wstETH",  addr: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" },
    { sym: "cbBTC",   addr: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
    { sym: "AERO",    addr: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
    { sym: "DEGEN",   addr: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
    { sym: "BRETT",   addr: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
    { sym: "VIRTUAL", addr: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
].map((t) => ({ ...t, addr: lower(t.addr) }));
const A = {
    UNI_V3_FACTORY: lower("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
    QUOTER_V2: lower("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
    AERO_FACTORY: lower("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
    AAVE_POOL: lower("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
    MULTICALL3: lower("0xcA11bde05977b3631167028862bE2a173976CA11"),
};
const QUOTE_ASSETS = ["USDC", "WETH"];  // what the bot would flash-borrow (both on Aave Base)
const V3_TIERS = [100, 500, 3000, 10000];

const SEL = {
    aggregate3: "0x82ad56cb", v3GetPool: "0x1698ee82", aeroGetPool: "0x79bc57d5",
    quoteV2: "0xc6a5026a", aeroAmountOut: "0xf140a35a", symbol: "0x95d89b41",
    decimals: "0x313ce567", premium: "0x074b2e43",
};

// ------------------------------------------------------ read-only RPC ----
const ALLOWED = new Set(["eth_call", "eth_blockNumber", "eth_gasPrice", "eth_chainId", "eth_getCode"]);
let rpcIdx = 0, reqId = 1, rpcErrors = 0;
async function post(body) {
    for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.error(`  [rpc] ${url} failed (${e.message}), trying next...`);
            rpcIdx++;
            await new Promise((r) => setTimeout(r, 1500));
        }
    }
    throw new Error("All Base RPC endpoints failed. Set RPC_URL to your own provider (Alchemy/Infura free tier).");
}
async function rpcBatch(calls) {
    for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error(`Blocked non-read method ${m}`);
    const out = [];
    for (let i = 0; i < calls.length; i += 10) {
        const chunk = calls.slice(i, i + 10).map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
        let resp = await post(chunk);
        if (!Array.isArray(resp)) resp = await Promise.all(chunk.map((r) => post(r)));
        const byId = new Map(resp.map((r) => [r.id, r]));
        for (const r of chunk) out.push(byId.get(r.id)?.result ?? null);
    }
    return out;
}
const rpc = async (m, p) => (await rpcBatch([[m, p]]))[0];

// --------------------------------------------------------- ABI helpers ----
const strip = (h) => (h || "").replace(/^0x/, "");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const aw = (a) => strip(a).toLowerCase().padStart(64, "0");
const wordsOf = (hex) => (strip(hex).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const addrOf = (hex) => "0x" + strip(hex).slice(24, 64).toLowerCase();
const isZero = (a) => /^0x0{40}$/.test(a);
function encAggregate3(calls) {
    const tuples = calls.map((c) => {
        const d = strip(c.data), len = d.length / 2;
        return aw(c.target) + word(1) + word(96) + word(len) + d.padEnd(Math.ceil(len / 32) * 64, "0");
    });
    let head = "", off = calls.length * 32;
    for (const t of tuples) { head += word(off); off += t.length / 2; }
    return SEL.aggregate3 + word(32) + word(calls.length) + head + tuples.join("");
}
function decAggregate3(hex) {
    const d = strip(hex), at = (b) => Number(BigInt("0x" + d.slice(b * 2, b * 2 + 64)));
    const arr = at(0), n = at(arr), base = arr + 32, out = [];
    for (let i = 0; i < n; i++) {
        const t = base + at(base + 32 * i), b = t + at(t + 32), len = at(b);
        out.push({ success: at(t) === 1, ret: "0x" + d.slice((b + 32) * 2, (b + 32 + len) * 2) });
    }
    return out;
}
async function multicall(calls, tag = "latest") {
    const chunks = [];
    for (let i = 0; i < calls.length; i += 100) chunks.push(calls.slice(i, i + 100));
    const res = await rpcBatch(chunks.map((c) => ["eth_call", [{ to: A.MULTICALL3, data: encAggregate3(c) }, tag]]));
    const out = [];
    res.forEach((r, i) => {
        if (!r || r === "0x") { rpcErrors++; chunks[i].forEach(() => out.push({ success: false, ret: "0x" })); }
        else out.push(...decAggregate3(r));
    });
    return out;
}
function decodeString(ret) {
    const d = strip(ret);
    if (d.length >= 192) {
        const len = Number(BigInt("0x" + d.slice(64, 128)));
        if (len > 0 && len < 64) return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString("utf8");
    }
    return Buffer.from(d.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "");
}

// ------------------------------------------------------------- venues ----
// venue: { name, kind: "v3"|"aero", pool, fee? }
function quoteCall(v, tokenIn, tokenOut, amountIn) {
    if (v.kind === "v3") return { target: A.QUOTER_V2, data: SEL.quoteV2 + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(v.fee) + word(0) };
    return { target: v.pool, data: SEL.aeroAmountOut + word(amountIn) + aw(tokenIn) };
}
const firstWord = (r) => (r && r.success ? wordsOf(r.ret)[0] ?? null : null);

// ------------------------------------------------------------- setup ----
const tok = new Map();      // sym -> {addr, dec}
let pairs = [];             // {base: sym, quote: sym, venues: []}
let premiumBps = 5n;

async function setup() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x2105") throw new Error(`Expected Base (0x2105), got ${chainId}`);

    const codes = await rpcBatch([A.QUOTER_V2, A.UNI_V3_FACTORY, A.AERO_FACTORY, A.MULTICALL3].map((a) => ["eth_getCode", [a, "latest"]]));
    ["Uniswap QuoterV2", "Uniswap V3 factory", "Aerodrome factory", "Multicall3"].forEach((n, i) => {
        if (!codes[i] || codes[i] === "0x") throw new Error(`${n} not found on Base — address wrong?`);
    });

    const meta = await multicall(TOKENS.flatMap((t) => [{ target: t.addr, data: SEL.symbol }, { target: t.addr, data: SEL.decimals }]));
    console.log("Tokens (checked on-chain):");
    TOKENS.forEach((t, i) => {
        const s = meta[2 * i].success ? decodeString(meta[2 * i].ret) : null;
        const d = firstWord(meta[2 * i + 1]);
        const ok = s && (s === t.sym || (t.altSyms || []).includes(s)) && d != null;
        console.log(`  ${t.sym.padEnd(8)} ${ok ? "ok" : "SKIPPED (on-chain symbol: " + s + ")"}${ok ? ", " + d + " decimals" : ""}`);
        if (ok) tok.set(t.sym, { addr: t.addr, dec: Number(d) });
    });

    const prem = await rpc("eth_call", [{ to: A.AAVE_POOL, data: SEL.premium }, "latest"]);
    if (prem && prem.length >= 66) premiumBps = BigInt(prem);

    // candidate pairs: every token vs each quote asset
    const cand = [];
    for (const q of QUOTE_ASSETS) for (const [b] of tok) if (b !== q && tok.has(q)) {
        if (cand.some((p) => p.base === q && p.quote === b)) continue;
        cand.push({ base: b, quote: q, venues: [] });
    }
    const calls = [], who = [];
    for (const p of cand) {
        const a = tok.get(p.base).addr, b = tok.get(p.quote).addr;
        for (const fee of V3_TIERS) { calls.push({ target: A.UNI_V3_FACTORY, data: SEL.v3GetPool + aw(a) + aw(b) + word(fee) }); who.push({ p, kind: "v3", fee }); }
        for (const st of [false, true]) { calls.push({ target: A.AERO_FACTORY, data: SEL.aeroGetPool + aw(a) + aw(b) + word(st ? 1 : 0) }); who.push({ p, kind: "aero", stable: st }); }
    }
    const res = await multicall(calls);
    res.forEach((r, i) => {
        if (!r.success) return;
        const pool = addrOf(r.ret);
        if (isZero(pool)) return;
        const w = who[i];
        w.p.venues.push(w.kind === "v3"
            ? { name: `UniV3-${(w.fee / 10000).toString()}%`, kind: "v3", pool, fee: w.fee }
            : { name: `Aero-${w.stable ? "stable" : "volatile"}`, kind: "aero", pool });
    });
    pairs = cand.filter((p) => p.venues.length >= 2);
    console.log(`\nAave flash fee on Base: ${premiumBps} bps (live). Pairs with 2+ DEX pools: ${pairs.length}`);
    for (const p of pairs) console.log(`  ${(p.base + "/" + p.quote).padEnd(14)} ${p.venues.map((v) => v.name).join(", ")}`);
}

// ------------------------------------------------------------ polling ----
const STATS = { polls: 0, routes: 0, profitable: 0, passRule: 0, survived: 0, perPair: new Map() };
let lastPassing = new Set();
const fmt = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(2);

async function poll() {
    const bnHex = await rpc("eth_blockNumber", []);
    const tag = bnHex;
    const [gasHex] = await rpcBatch([["eth_gasPrice", []]]);
    const gasPrice = gasHex ? BigInt(gasHex) : 0n;

    // ETH price from the deepest WETH/USDC venue (1 WETH quote)
    const wu = pairs.find((p) => p.base === "WETH" && p.quote === "USDC") || pairs.find((p) => p.base === "USDC" && p.quote === "WETH");
    let ethUsd = 0;
    if (wu) {
        const r = await multicall(wu.venues.map((v) => quoteCall(v, tok.get("WETH").addr, tok.get("USDC").addr, 10n ** 18n)), tag);
        ethUsd = Math.max(0, ...r.map((x) => Number(firstWord(x) ?? 0n) / 1e6));
    }
    if (!ethUsd) { console.log("  could not price ETH this poll, skipping"); return; }
    const gasUsd = (Number(gasPrice * GAS_UNITS) / 1e18) * ethUsd + L1_FEE_USD;
    const quoteUsd = (sym) => (sym === "WETH" ? ethUsd : 1);

    // leg 1: quote -> base on every venue, every size
    const legs = [], c1 = [];
    for (const p of pairs) for (const usd of SIZES_USD) {
        const q = tok.get(p.quote), b = tok.get(p.base);
        const amtIn = BigInt(Math.round((usd / quoteUsd(p.quote)) * 10 ** q.dec));
        for (const A_ of p.venues) { legs.push({ p, usd, amtIn, A: A_ }); c1.push(quoteCall(A_, q.addr, b.addr, amtIn)); }
    }
    const r1 = await multicall(c1, tag);
    // leg 2: base -> quote on every OTHER venue
    const routes = [], c2 = [];
    legs.forEach((l, i) => {
        const mid = firstWord(r1[i]);
        if (!mid) return;
        for (const B of l.p.venues) if (B !== l.A) {
            routes.push({ ...l, B, mid });
            c2.push(quoteCall(B, tok.get(l.p.base).addr, tok.get(l.p.quote).addr, mid));
        }
    });
    const r2 = await multicall(c2, tag);

    STATS.polls++;
    let best = null;
    const passingNow = new Set();
    routes.forEach((rt, i) => {
        const out = firstWord(r2[i]);
        if (out == null) return;
        const q = tok.get(rt.p.quote);
        const premium = (rt.amtIn * premiumBps) / 10000n;
        const required = rt.amtIn + premium + (rt.amtIn * BigInt(MIN_PROFIT_BPS)) / 10000n;
        const toUsd = (raw) => (Number(raw) / 10 ** q.dec) * quoteUsd(rt.p.quote);
        const net = toUsd(out - rt.amtIn - premium) - gasUsd;
        const gapBps = (Number(out - rt.amtIn) / Number(rt.amtIn)) * 1e4;
        const key = `${rt.p.base}/${rt.p.quote}`;
        const s = STATS.perPair.get(key) || { bestGap: -Infinity, bestNet: -Infinity, profitable: 0, pass: 0 };
        s.bestGap = Math.max(s.bestGap, gapBps); s.bestNet = Math.max(s.bestNet, net);
        STATS.routes++;
        if (net > 0) { STATS.profitable++; s.profitable++; }
        if (out >= required && net > 0) {
            STATS.passRule++; s.pass++;
            passingNow.add(`${key}|${rt.A.name}|${rt.B.name}|${rt.usd}`);
        }
        STATS.perPair.set(key, s);
        if (!best || net > best.net) best = { ...rt, net, gapBps, pass: out >= required };
        fs.appendFileSync(LOG_FILE, [parseInt(bnHex, 16), key, rt.A.name, rt.B.name, rt.usd, gapBps.toFixed(2), net.toFixed(2), net > 0, out >= required && net > 0].join(",") + "\n");
    });
    let surv = 0;
    for (const k of lastPassing) if (passingNow.has(k)) surv++;
    if (lastPassing.size) { if (surv) STATS.survived++; console.log(`    re-check: ${surv}/${lastPassing.size} of last poll's passing routes still pass`); }
    lastPassing = passingNow;

    const t = new Date().toISOString().slice(11, 19);
    console.log(`${t} block ${parseInt(bnHex, 16)} | ETH $${ethUsd.toFixed(0)} | gas ≈ $${gasUsd.toFixed(3)}/trade | ${routes.length} routes | ` +
        (best ? `best: ${best.p.base}/${best.p.quote} $${best.usd} ${best.A.name}->${best.B.name} gap ${best.gapBps.toFixed(1)} bps, net ${fmt(best.net)}` +
            (best.pass ? " << PASSES CONTRACT RULE" : best.net > 0 ? " (profitable but below the 0.5% rule)" : " (rejected)") : "n/a"));
}

function summary() {
    console.log("\n" + "=".repeat(92));
    console.log(`SUMMARY — Base, ${STATS.polls} polls (every ~${EVERY_SEC}s), ${STATS.routes} round-trip quotes, sizes $${SIZES_USD.join(", $")}`);
    console.log(`  Routes profitable after Aave fee + gas: ${STATS.profitable} | also passing the original 0.5% rule: ${STATS.passRule}`);
    console.log(`  Polls where a passing route was STILL there at the next poll: ${STATS.survived}`);
    console.log("  Per pair (best gap = round trip before Aave fee & gas; needs > " + (Number(premiumBps) + MIN_PROFIT_BPS) + " bps for the rule):");
    const rows = [...STATS.perPair.entries()].sort((a, b) => b[1].bestGap - a[1].bestGap);
    for (const [k, s] of rows) console.log(`    ${k.padEnd(14)} best gap ${s.bestGap.toFixed(1).padStart(8)} bps | best net ${fmt(s.bestNet).padStart(10)} | profitable ${s.profitable} | pass rule ${s.pass}`);
    console.log(`  Failed multicalls: ${rpcErrors}. Full log: ${LOG_FILE}`);
    console.log("  Not modelled: other bots (they run every 2 s block), builder/sequencer priority fees.");
    console.log("=".repeat(92));
}

async function main() {
    await setup();
    if (!pairs.length) throw new Error("No pairs with pools on 2+ DEXes found.");
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,pair,buy_on,sell_on,size_usd,gap_bps,net_usd,profitable,passes_rule\n");
    console.log(`\nRunning ${MINUTES} min, checking every ${EVERY_SEC}s. Ctrl+C for the summary.\n`);
    process.on("SIGINT", () => { summary(); process.exit(0); });
    const end = Date.now() + MINUTES * 60000;
    while (Date.now() < end) {
        const t0 = Date.now();
        try { await poll(); } catch (e) { console.error("  error:", e.message); }
        await new Promise((r) => setTimeout(r, Math.max(1000, EVERY_SEC * 1000 - (Date.now() - t0))));
    }
    summary();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
/*
 * READ-ONLY live gap check on BASE (chain 8453): many tokens, many DEXes,
 * 2-step and 3-step (triangle) routes.
 *
 * Every poll it takes REAL quotes from the DEXes' own on-chain quote functions
 * (fees and price impact included) for:
 *   2-step:  borrow Q -> buy X on the best DEX -> sell X on the best OTHER DEX -> Q
 *   3-step:  borrow Q -> X -> Y -> Q, best DEX on every step
 * where Q is any token Aave lends on Base (USDC, WETH, cbBTC, cbETH, wstETH,
 * weETH, EURC, USDbC). It subtracts the live Aave flash fee and gas, and reports
 * whether the route is profitable at all and whether it passes the original
 * contract's rule (final >= loan + Aave fee + 0.5%). Passing routes are re-checked
 * at the next poll.
 *
 * DEXes: Uniswap V3, PancakeSwap V3, SushiSwap V3 (all fee tiers), Aerodrome
 * (volatile + stable), Aerodrome Slipstream (all tick spacings), Uniswap V2,
 * BaseSwap. Every DEX and token is verified on-chain at startup; anything that
 * does not check out is skipped (so a wrong address can't produce fake results).
 *
 * Picking "best DEX per step" is exact here: more output from one step always
 * means more output from the next. The only special case (2-step, best buy and
 * best sell on the same pool) is handled with a second quote round.
 *
 * NOTE: the original ArbitrageExecutor contract could NOT execute most of these
 * routes. This measures whether such opportunities EXIST.
 *
 * SAFETY: read-only (eth_call / eth_blockNumber / eth_gasPrice / eth_chainId /
 * eth_getCode). No wallet, no key, no transactions.
 *
 * Usage: node sim/base_live_check.mjs [--minutes 60] [--every 20] [--sizes 1000]
 *        [--triangles 150] [--no-triangles] [--tokens 0xAddr,0xAddr]
 *        RPC_URL=<your Base RPC> to use your own node (recommended for this size).
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(opt("minutes", 60));
const EVERY_SEC = Number(opt("every", 20));
const SIZES_USD = opt("sizes", "1000").split(",").map(Number);
const TRI_PER_POLL = args.includes("--no-triangles") ? 0 : Number(opt("triangles", 150));
const MIN_PROFIT_BPS = Number(opt("min-profit-bps", 50));
const GAS_UNITS_2 = 400000n, GAS_UNITS_3 = 550000n;
const L1_FEE_USD = Number(opt("l1-fee-usd", "0.02"));
const LOG_FILE = opt("log", "base_routes_log.csv");
const RPCS = process.env.RPC_URL ? [process.env.RPC_URL]
    : ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"];
const MC_CHUNK = 50;

// ------------------------------------------------------------ tokens ----
const lower = (a) => a.toLowerCase();
const TOKEN_LIST = [ // symbol must match on-chain symbol() (or altSyms) or the token is skipped
    // borrowable on Aave Base (also used as start/end assets)
    { sym: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", flash: true },
    { sym: "WETH", addr: "0x4200000000000000000000000000000000000006", flash: true },
    { sym: "cbBTC", addr: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", flash: true },
    { sym: "cbETH", addr: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", flash: true },
    { sym: "wstETH", addr: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", flash: true },
    { sym: "weETH", addr: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", flash: true },
    { sym: "EURC", addr: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", flash: true },
    { sym: "USDbC", addr: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", flash: true },
    // other liquid tokens
    { sym: "DAI", addr: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
    { sym: "USDT", addr: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", altSyms: ["USD₮0", "USDT0"] },
    { sym: "ezETH", addr: "0x2416092f143378750bb29b79eD961ab195CcEea5" },
    { sym: "rETH", addr: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c" },
    { sym: "tBTC", addr: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b" },
    { sym: "LBTC", addr: "0xecAc9C5F704e954931349Da37F60E39f515c11c1" },
    { sym: "AERO", addr: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
    { sym: "MORPHO", addr: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842" },
    { sym: "WELL", addr: "0xA88594D404727625A9437C3f886C7643872296AE" },
    { sym: "ZORA", addr: "0x1111111111166b7FE7bd91427724B487980aFc69" },
    { sym: "VIRTUAL", addr: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
    { sym: "AIXBT", addr: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825" },
    { sym: "CLANKER", addr: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb" },
    { sym: "DEGEN", addr: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
    { sym: "BRETT", addr: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
    { sym: "TOSHI", addr: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" },
    { sym: "HIGHER", addr: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe" },
];
const EXTRA = (opt("tokens", "") || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((addr) => ({ sym: null, addr })); // symbol taken from chain
const TOKENS = [...TOKEN_LIST, ...EXTRA].map((t) => ({ ...t, addr: lower(t.addr) }));

// -------------------------------------------------------------- DEXes ----
// kind: "v3" (Uniswap-style QuoterV2, fee tiers) | "cl" (Slipstream, tick spacings)
//       "v2" (router getAmountsOut, factory getPair) | "aero" (pool.getAmountOut)
const DEX_LIST = [
    { name: "UniV3", kind: "v3", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", tiers: [100, 500, 3000, 10000] },
    { name: "PancakeV3", kind: "v3", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", tiers: [100, 500, 2500, 10000] },
    { name: "SushiV3", kind: "v3", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", quoter: "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e", tiers: [100, 500, 3000, 10000] },
    { name: "AeroCL", kind: "cl", factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0", tiers: [1, 50, 100, 200, 2000] },
    { name: "Aero", kind: "aero", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
    { name: "UniV2", kind: "v2", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" },
    { name: "BaseSwap", kind: "v2", factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB", router: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" },
].map((d) => ({ ...d, factory: lower(d.factory), quoter: d.quoter && lower(d.quoter), router: d.router && lower(d.router) }));
const AAVE_POOL = lower("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const MULTICALL3 = lower("0xcA11bde05977b3631167028862bE2a173976CA11");

const SEL = {
    aggregate3: "0x82ad56cb", v3GetPool: "0x1698ee82", clGetPool: "0x28af8d0b", aeroGetPool: "0x79bc57d5",
    v2GetPair: "0xe6a43905", quoteV3: "0xc6a5026a", quoteCL: "0x9e7defe6", aeroAmountOut: "0xf140a35a",
    v2AmountsOut: "0xd06ca61f", symbol: "0x95d89b41", decimals: "0x313ce567", premium: "0x074b2e43",
};

// ------------------------------------------------------ read-only RPC ----
const ALLOWED = new Set(["eth_call", "eth_blockNumber", "eth_gasPrice", "eth_chainId", "eth_getCode"]);
let rpcIdx = 0, reqId = 1, rpcErrors = 0;
async function post(body) {
    for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.error(`  [rpc] ${url} failed (${e.message}), trying next...`);
            rpcIdx++;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw new Error("All Base RPC endpoints failed. Set RPC_URL to your own provider (Alchemy/Infura free tier).");
}
async function rpcBatch(calls) {
    for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error(`Blocked non-read method ${m}`);
    const out = [];
    for (let i = 0; i < calls.length; i += 5) {
        const chunk = calls.slice(i, i + 5).map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
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
const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
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
    if (!calls.length) return [];
    const chunks = [];
    for (let i = 0; i < calls.length; i += MC_CHUNK) chunks.push(calls.slice(i, i + MC_CHUNK));
    const res = await rpcBatch(chunks.map((c) => ["eth_call", [{ to: MULTICALL3, data: encAggregate3(c) }, tag]]));
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
const firstWord = (r) => (r && r.success ? wordsOf(r.ret)[0] ?? null : null);

// ------------------------------------------------------------- venues ----
function quoteCall(v, tokenIn, tokenOut, amountIn) {
    switch (v.kind) {
        case "v3": return { target: v.dex.quoter, data: SEL.quoteV3 + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(v.tier) + word(0) };
        case "cl": return { target: v.dex.quoter, data: SEL.quoteCL + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(v.tier) + word(0) };
        case "aero": return { target: v.pool, data: SEL.aeroAmountOut + word(amountIn) + aw(tokenIn) };
        case "v2": return { target: v.dex.router, data: SEL.v2AmountsOut + word(amountIn) + word(64) + word(2) + aw(tokenIn) + aw(tokenOut) };
    }
}
function decodeQuote(v, r) {
    if (!r || !r.success) return null;
    const w = wordsOf(r.ret);
    if (v.kind === "v2") return w.length >= 4 ? w[2 + Number(w[1]) - 1] : null;
    return w[0] ?? null;
}

// -------------------------------------------------------------- setup ----
const tok = new Map();        // sym -> {sym, addr, dec, flash}
const venues = new Map();     // "A|B" (sorted syms) -> [venue]
let dexes = [];
let premiumBps = 5n;
const pairKey = (a, b) => [a, b].sort().join("|");

async function setup() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x2105") throw new Error(`Expected Base (0x2105), got ${chainId}`);

    // DEX contracts must exist
    const addrs = DEX_LIST.flatMap((d) => [d.factory, d.quoter || d.router || d.factory]); // Aerodrome quotes on the pool itself
    const codes = await rpcBatch(addrs.map((a) => ["eth_getCode", [a, "latest"]]));
    console.log("DEXes (checked on-chain):");
    DEX_LIST.forEach((d, i) => {
        const ok = codes[2 * i] && codes[2 * i] !== "0x" && codes[2 * i + 1] && codes[2 * i + 1] !== "0x";
        console.log(`  ${d.name.padEnd(10)} ${ok ? "ok" : "SKIPPED (contract not found)"}`);
        if (ok) dexes.push(d);
    });
    const mc = await rpc("eth_getCode", [MULTICALL3, "latest"]);
    if (!mc || mc === "0x") throw new Error("Multicall3 not found on this RPC.");

    // tokens: symbol + decimals
    const meta = await multicall(TOKENS.flatMap((t) => [{ target: t.addr, data: SEL.symbol }, { target: t.addr, data: SEL.decimals }]));
    console.log("\nTokens (checked on-chain):");
    const line = [];
    TOKENS.forEach((t, i) => {
        const s = meta[2 * i].success ? decodeString(meta[2 * i].ret) : null;
        const d = firstWord(meta[2 * i + 1]);
        const sym = t.sym ?? s;
        const ok = s && d != null && (t.sym == null || s === t.sym || (t.altSyms || []).includes(s)) && !tok.has(sym);
        if (ok) tok.set(sym, { sym, addr: t.addr, dec: Number(d), flash: !!t.flash });
        line.push(ok ? `${sym}${t.flash ? "*" : ""}` : `${t.sym || t.addr}=SKIPPED(${s})`);
    });
    console.log("  " + line.join(", ") + "\n  (* = can be flash-borrowed from Aave and used as start/end)");

    const prem = await rpc("eth_call", [{ to: AAVE_POOL, data: SEL.premium }, "latest"]);
    if (prem && prem.length >= 66) premiumBps = BigInt(prem);

    // discover pools for every token pair on every DEX
    const syms = [...tok.keys()];
    const calls = [], who = [];
    for (let i = 0; i < syms.length; i++) for (let k = i + 1; k < syms.length; k++) {
        const a = tok.get(syms[i]).addr, b = tok.get(syms[k]).addr, key = pairKey(syms[i], syms[k]);
        for (const d of dexes) {
            if (d.kind === "v3" || d.kind === "cl") for (const t of d.tiers) {
                calls.push({ target: d.factory, data: (d.kind === "v3" ? SEL.v3GetPool : SEL.clGetPool) + aw(a) + aw(b) + word(t) });
                who.push({ key, d, tier: t });
            } else if (d.kind === "aero") for (const st of [0, 1]) {
                calls.push({ target: d.factory, data: SEL.aeroGetPool + aw(a) + aw(b) + word(st) });
                who.push({ key, d, stable: st });
            } else {
                calls.push({ target: d.factory, data: SEL.v2GetPair + aw(a) + aw(b) });
                who.push({ key, d });
            }
        }
    }
    process.stdout.write(`\nLooking up pools for ${syms.length * (syms.length - 1) / 2} token pairs on ${dexes.length} DEXes (${calls.length} lookups)... `);
    const res = await multicall(calls);
    let found = 0;
    res.forEach((r, i) => {
        if (!r.success) return;
        const pool = addrOf(r.ret);
        if (isZero(pool)) return;
        const w = who[i], d = w.d;
        const name = d.kind === "v3" ? `${d.name}-${w.tier / 10000}%` : d.kind === "cl" ? `${d.name}-ts${w.tier}`
            : d.kind === "aero" ? `${d.name}-${w.stable ? "stable" : "volatile"}` : d.name;
        if (!venues.has(w.key)) venues.set(w.key, []);
        venues.get(w.key).push({ name, kind: d.kind, dex: d, pool, tier: w.tier });
        found++;
    });
    console.log(`${found} pools found.`);
}

// ------------------------------------------------------------ routes ----
let twoStep = [];     // {q, x, venues}
let triangles = [];   // {q, x, y}
function buildRoutes() {
    const flash = [...tok.values()].filter((t) => t.flash).map((t) => t.sym);
    for (const q of flash) for (const [x] of tok) {
        if (x === q) continue;
        const v = venues.get(pairKey(q, x)) || [];
        if (v.length >= 2) twoStep.push({ q, x, venues: v });
    }
    for (const q of flash) for (const [x] of tok) for (const [y] of tok) {
        if (x === q || y === q || x === y) continue;
        if (venues.has(pairKey(q, x)) && venues.has(pairKey(x, y)) && venues.has(pairKey(y, q))) triangles.push({ q, x, y });
    }
}

// ------------------------------------------------------------- pricing ----
const usdPrice = new Map(); // flash sym -> USD per 1 token
async function refreshPrices(tag) {
    const calls = [], who = [];
    for (const t of tok.values()) {
        if (!t.flash) continue;
        if (t.sym === "USDC") { usdPrice.set("USDC", 1); continue; }
        const via = venues.get(pairKey(t.sym, "USDC")) ? "USDC" : venues.get(pairKey(t.sym, "WETH")) ? "WETH" : null;
        if (!via) continue;
        for (const v of venues.get(pairKey(t.sym, via))) {
            calls.push(quoteCall(v, t.addr, tok.get(via).addr, 10n ** BigInt(t.dec) / 10n)); // 0.1 token
            who.push({ t, via, v });
        }
    }
    const res = await multicall(calls, tag);
    const best = new Map();
    res.forEach((r, i) => {
        const out = decodeQuote(who[i].v, r);
        if (out == null) return;
        const w = who[i], val = (Number(out) / 10 ** tok.get(w.via).dec) * 10;
        const k = w.t.sym + "|" + w.via;
        if (!best.has(k) || val > best.get(k)) best.set(k, val);
    });
    if (best.has("WETH|USDC")) usdPrice.set("WETH", best.get("WETH|USDC"));
    for (const [k, val] of best) {
        const [s, via] = k.split("|");
        if (s === "WETH") continue;
        if (via === "USDC") usdPrice.set(s, val);
        else if (!usdPrice.has(s) && usdPrice.has("WETH")) usdPrice.set(s, val * usdPrice.get("WETH"));
    }
}
const amountFor = (sym, usd) => {
    const p = usdPrice.get(sym), t = tok.get(sym);
    return p ? BigInt(Math.round((usd / p) * 10 ** Math.min(t.dec, 15))) * 10n ** BigInt(Math.max(0, t.dec - 15)) : null;
};

/** best quote over all venues of pair (a,b) for each request; returns [{out, venue, all:[{v,out}]}] */
async function bestHop(reqs, tag) {
    const calls = [], who = [];
    reqs.forEach((r, i) => {
        if (r.amt == null || r.amt <= 0n) return;
        for (const v of venues.get(pairKey(r.from, r.to)) || []) {
            calls.push(quoteCall(v, tok.get(r.from).addr, tok.get(r.to).addr, r.amt));
            who.push({ i, v });
        }
    });
    const res = await multicall(calls, tag);
    const out = reqs.map(() => ({ out: null, venue: null, all: [] }));
    res.forEach((r, j) => {
        const { i, v } = who[j], q = decodeQuote(v, r);
        if (q == null || q <= 0n) return;
        out[i].all.push({ v, out: q });
        if (out[i].out == null || q > out[i].out) { out[i].out = q; out[i].venue = v; }
    });
    return out;
}

// ------------------------------------------------------------- polling ----
const STATS = { polls: 0, quotes: 0, profitable: 0, passRule: 0, survived: 0, per: new Map() };
let lastPassing = new Set(), triCursor = 0;
const fmt = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(2);

const evaluatedNow = new Set();
function record(label, kind, q, amtIn, out, gasUsd, desc, bn, passingNow) {
    evaluatedNow.add(label);
    const t = tok.get(q), p = usdPrice.get(q);
    const premium = (amtIn * premiumBps) / 10000n;
    const required = amtIn + premium + (amtIn * BigInt(MIN_PROFIT_BPS)) / 10000n;
    const usdOf = (raw) => (Number(raw) / 10 ** t.dec) * p;
    const net = usdOf(out - amtIn - premium) - gasUsd;
    const gapBps = (Number(out - amtIn) / Number(amtIn)) * 1e4;
    const pass = out >= required && net > 0;
    STATS.quotes++;
    if (net > 0) STATS.profitable++;
    if (pass) { STATS.passRule++; passingNow.add(label); }
    const s = STATS.per.get(label) || { kind, bestGap: -Infinity, bestNet: -Infinity, profitable: 0, pass: 0, desc: "" };
    if (gapBps > s.bestGap) { s.bestGap = gapBps; s.desc = desc; }
    s.bestNet = Math.max(s.bestNet, net);
    if (net > 0) s.profitable++;
    if (pass) s.pass++;
    STATS.per.set(label, s);
    fs.appendFileSync(LOG_FILE, [bn, kind, `"${desc}"`, gapBps.toFixed(2), net.toFixed(2), net > 0, pass].join(",") + "\n");
    return { label, desc, gapBps, net, pass };
}

async function poll() {
    const bnHex = await rpc("eth_blockNumber", []);
    const bn = parseInt(bnHex, 16), tag = bnHex;
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) || "0x0");
    await refreshPrices(tag);
    const eth = usdPrice.get("WETH");
    if (!eth) { console.log("  could not price ETH this poll, skipping"); return; }
    const gasUsd2 = (Number(gasPrice * GAS_UNITS_2) / 1e18) * eth + L1_FEE_USD;
    const gasUsd3 = (Number(gasPrice * GAS_UNITS_3) / 1e18) * eth + L1_FEE_USD;
    const passingNow = new Set();
    const results = [];

    // ---- 2-step: best buy venue, then every sell venue (exact) ----
    const reqs1 = [];
    for (const r of twoStep) for (const usd of SIZES_USD) reqs1.push({ r, usd, from: r.q, to: r.x, amt: amountFor(r.q, usd) });
    const h1 = await bestHop(reqs1, tag);
    const reqs2 = reqs1.map((rq, i) => ({ from: rq.r.x, to: rq.r.q, amt: h1[i].out }));
    const h2 = await bestHop(reqs2, tag);
    const retry = [];
    reqs1.forEach((rq, i) => {
        const buy = h1[i];
        if (!buy.out) return;
        const sells = h2[i].all.filter((s) => s.v !== buy.venue).sort((a, b) => (a.out > b.out ? -1 : 1));
        const bestSellOther = sells[0];
        if (bestSellOther) {
            const desc = `${rq.r.q}->${rq.r.x}->${rq.r.q} $${rq.usd} ${buy.venue.name}->${bestSellOther.v.name}`;
            results.push(record(`${rq.r.q}/${rq.r.x} 2-step`, "2-step", rq.r.q, rq.amt, bestSellOther.out, gasUsd2, desc, bn, passingNow));
        }
        // if the best sell is on the same pool as the best buy, also try the 2nd-best buy venue
        if (h2[i].venue === buy.venue && buy.all.length >= 2) {
            const second = [...buy.all].filter((b) => b.v !== buy.venue).sort((a, b) => (a.out > b.out ? -1 : 1))[0];
            retry.push({ rq, buyV: second.v, mid: second.out });
        }
    });
    if (retry.length) {
        const h3 = await bestHop(retry.map((t) => ({ from: t.rq.r.x, to: t.rq.r.q, amt: t.mid })), tag);
        retry.forEach((t, i) => {
            const s = h3[i].all.filter((x) => x.v !== t.buyV).sort((a, b) => (a.out > b.out ? -1 : 1))[0];
            if (!s) return;
            const desc = `${t.rq.r.q}->${t.rq.r.x}->${t.rq.r.q} $${t.rq.usd} ${t.buyV.name}->${s.v.name}`;
            results.push(record(`${t.rq.r.q}/${t.rq.r.x} 2-step`, "2-step", t.rq.r.q, t.rq.amt, s.out, gasUsd2, desc, bn, passingNow));
        });
    }

    // ---- 3-step triangles (rotating subset each poll), best venue per step ----
    let triCount = 0;
    if (TRI_PER_POLL > 0 && triangles.length) {
        const batch = [];
        for (let k = 0; k < Math.min(TRI_PER_POLL, triangles.length); k++) batch.push(triangles[(triCursor + k) % triangles.length]);
        triCursor = (triCursor + batch.length) % triangles.length;
        const usd = SIZES_USD[0];
        const t1 = await bestHop(batch.map((c) => ({ from: c.q, to: c.x, amt: amountFor(c.q, usd) })), tag);
        const t2 = await bestHop(batch.map((c, i) => ({ from: c.x, to: c.y, amt: t1[i].out })), tag);
        const t3 = await bestHop(batch.map((c, i) => ({ from: c.y, to: c.q, amt: t2[i].out })), tag);
        batch.forEach((c, i) => {
            if (!t3[i].out) return;
            triCount++;
            const desc = `${c.q}->${c.x}->${c.y}->${c.q} $${usd} ${t1[i].venue.name}/${t2[i].venue.name}/${t3[i].venue.name}`;
            results.push(record(`${c.q}>${c.x}>${c.y} 3-step`, "3-step", c.q, amountFor(c.q, usd), t3[i].out, gasUsd3, desc, bn, passingNow));
        });
    }

    STATS.polls++;
    // re-check only routes evaluated in BOTH polls (triangles rotate)
    let surv = 0, comparable = 0;
    for (const k of lastPassing) if (evaluatedNow.has(k)) { comparable++; if (passingNow.has(k)) surv++; }
    if (comparable) { if (surv) STATS.survived++; console.log(`    re-check: ${surv}/${comparable} of last poll's passing routes still pass`); }
    lastPassing = passingNow;
    evaluatedNow.clear();

    const best = results.reduce((a, b) => (!a || b.gapBps > a.gapBps ? b : a), null);
    const t = new Date().toISOString().slice(11, 19);
    console.log(`${t} block ${bn} | ETH $${eth.toFixed(0)} | gas ≈ $${gasUsd2.toFixed(3)} | ${results.length - triCount} two-step + ${triCount} triangle routes | ` +
        (best ? `best: ${best.desc} gap ${best.gapBps.toFixed(1)} bps, net ${fmt(best.net)}` +
            (best.pass ? " << PASSES CONTRACT RULE" : best.net > 0 ? " (profitable, below 0.5% rule)" : " (rejected)") : "n/a"));
}

function summary() {
    console.log("\n" + "=".repeat(100));
    console.log(`SUMMARY — Base, ${STATS.polls} polls (~every ${EVERY_SEC}s), ${STATS.quotes} routes evaluated (sizes $${SIZES_USD.join(", $")})`);
    console.log(`  ${tok.size} tokens, ${dexes.length} DEXes, ${[...venues.values()].reduce((s, v) => s + v.length, 0)} pools | ${twoStep.length} two-step pairs, ${triangles.length} triangles`);
    console.log(`  Routes profitable after Aave fee + gas: ${STATS.profitable} | also passing the original 0.5% rule: ${STATS.passRule}`);
    console.log(`  Polls where a passing route was STILL there at the next poll: ${STATS.survived}`);
    console.log(`  TOP 20 routes by best gap (round trip before Aave fee & gas; the rule needs > ${Number(premiumBps) + MIN_PROFIT_BPS} bps):`);
    const rows = [...STATS.per.entries()].sort((a, b) => b[1].bestGap - a[1].bestGap).slice(0, 20);
    for (const [k, s] of rows) console.log(`    ${k.padEnd(28)} ${s.bestGap.toFixed(1).padStart(8)} bps | net ${fmt(s.bestNet).padStart(9)} | profitable ${String(s.profitable).padStart(3)} | pass ${String(s.pass).padStart(3)} | ${s.desc}`);
    console.log(`  Failed multicalls: ${rpcErrors}. Full log: ${LOG_FILE}`);
    console.log("  Not modelled: other bots (they act every 2 s block), priority fees, tokens with hidden transfer taxes.");
    console.log("=".repeat(100));
}

async function main() {
    await setup();
    buildRoutes();
    console.log(`Routes: ${twoStep.length} two-step pairs, ${triangles.length} triangles` +
        (TRI_PER_POLL ? ` (checking ${Math.min(TRI_PER_POLL, triangles.length)} per poll, rotating)` : " (off)") + `. Aave flash fee: ${premiumBps} bps (live).`);
    if (!twoStep.length && !triangles.length) throw new Error("No routes found.");
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,type,route,gap_bps,net_usd,profitable,passes_rule\n");
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

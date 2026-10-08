#!/usr/bin/env node
/*
 * LIVE, READ-ONLY reality check for ArbitrageExecutor v3.3 (Code.txt).
 *
 * Every new Ethereum block it asks the REAL exchanges (Uniswap V2, SushiSwap,
 * Uniswap V3 0.05% and 0.3%) "if I flash-borrowed X USDC, bought WETH on one
 * DEX and sold it on another, what would I get back?" — using the DEXes' own
 * on-chain quote functions — and applies the bot's exact rules:
 *   - Aave flash-loan fee (read live from Aave)
 *   - contract rule: final >= loan + Aave fee + loan * minProfitBps (default 50 = 0.5%)
 *   - keeper rule: profit after gas > 0 (gas price read live)
 * Anything found at block N is re-checked at block N+1, because that is the
 * earliest the bot (which reacts to new blocks) could actually land a trade.
 *
 * SAFETY: read-only. Only eth_call / eth_blockNumber / eth_gasPrice /
 * eth_chainId are allowed (enforced below). No key custody, no private key, no
 * transactions, no money at risk.
 *
 * Requirements: Node.js 18+ (no npm install needed).
 * Usage:
 *   node sim/live_mainnet_check.mjs                      # 60 minutes, public RPC
 *   node sim/live_mainnet_check.mjs --minutes 360
 *   RPC_URL=https://your-provider node sim/live_mainnet_check.mjs
 *   Options: --minutes N  --sizes 2000,20000,100000  --gas-units 400000  --min-profit-bps 50
 */
import fs from "node:fs";

// ---------------------------------------------------------------- options ----
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const MINUTES = Number(opt("minutes", 60));
const SIZES = opt("sizes", "2000,20000,100000,500000").split(",").map(Number); // USDC; 20000 = keeper FLASH_AMOUNT
const GAS_UNITS = BigInt(opt("gas-units", "400000"));
const MIN_PROFIT_BPS = Number(opt("min-profit-bps", "50"));
const LOG_FILE = opt("log", "live_log.csv");
const RPCS = process.env.RPC_URL
    ? [process.env.RPC_URL]
    : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"];

// ------------------------------------------------------ mainnet addresses ----
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const VENUES = [
    { name: "UniV2",     kind: "v2", addr: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" }, // Uniswap V2 router
    { name: "Sushi",     kind: "v2", addr: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" }, // SushiSwap router
    { name: "UniV3-.05", kind: "v3", addr: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", fee: 500 },  // QuoterV2
    { name: "UniV3-.30", kind: "v3", addr: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", fee: 3000 },
];

// --------------------------------------------------- read-only JSON-RPC ----
const ALLOWED = new Set(["eth_call", "eth_blockNumber", "eth_gasPrice", "eth_chainId"]);
let rpcIdx = 0, reqId = 1;

async function post(body) {
    for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.error(`  [rpc] ${url} failed (${e.message}), trying next...`);
            rpcIdx++;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw new Error("All RPC endpoints failed. Set RPC_URL to your own provider (Alchemy/Infura free tier).");
}

/** Batch of [method, params]; returns results (null for errored/reverted calls). */
async function batch(calls) {
    for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error(`Blocked non-read method ${m}`);
    const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
    const out = [];
    for (let i = 0; i < reqs.length; i += 40) {                 // stay under provider batch limits
        const chunk = reqs.slice(i, i + 40);
        let resp = await post(chunk);
        if (!Array.isArray(resp)) resp = await Promise.all(chunk.map((r) => post(r))); // no batch support
        const byId = new Map(resp.map((r) => [r.id, r]));
        for (const r of chunk) out.push(byId.get(r.id)?.result ?? null);
    }
    return out;
}

// ------------------------------------------------------------ ABI helpers ----
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
const SEL_V2 = "0xd06ca61f";     // getAmountsOut(uint256,address[])
const SEL_V3 = "0xc6a5026a";     // QuoterV2.quoteExactInputSingle((address,address,uint256,uint24,uint160))
const SEL_PREMIUM = "0x074b2e43"; // Aave FLASHLOAN_PREMIUM_TOTAL()

function quoteCall(v, tokenIn, tokenOut, amountIn, blockTag) {
    const data = v.kind === "v2"
        ? SEL_V2 + word(amountIn) + word(64) + word(2) + addrWord(tokenIn) + addrWord(tokenOut)
        : SEL_V3 + addrWord(tokenIn) + addrWord(tokenOut) + word(amountIn) + word(v.fee) + word(0);
    return ["eth_call", [{ to: v.addr, data }, blockTag]];
}
function decodeQuote(v, hex) {
    if (!hex || hex === "0x" || hex.length < 66) return null;
    const words = hex.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
    return v.kind === "v2" ? words[2 + Number(words[1]) - 1] : words[0];
}

// ----------------------------------------------------------------- logic ----
const usd = (raw6) => Number(raw6) / 1e6;
const fmt = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(2);
const stats = {
    blocks: 0, routes: 0, passContract: 0, passKeeper: 0, survived: 0,
    bestGapBps: -Infinity, bestNet: -Infinity, bestDesc: "", paperNet: 0, survivedNet: 0, errors: 0,
};
let premiumBps = 5n, pending = [];

async function scanBlock(bn) {
    const tag = "0x" + bn.toString(16);
    // round 1: gas + leg 1 (USDC -> WETH on every venue, every size) + re-checks of last block's hits
    const leg1Keys = [];
    const calls = [["eth_gasPrice", []]];
    for (const v of VENUES) for (const L of SIZES) {
        leg1Keys.push({ v, L });
        calls.push(quoteCall(v, USDC, WETH, BigInt(L) * 1000000n, tag));
    }
    const r1 = await batch(calls);
    const gasPrice = r1[0] ? BigInt(r1[0]) : 0n;
    const leg1 = leg1Keys.map((k, i) => ({ ...k, weth: decodeQuote(k.v, r1[i + 1]) }));

    const ref = leg1.find((x) => x.v.name === "UniV3-.05" && x.L === SIZES[0] && x.weth);
    const ethUsd = ref ? SIZES[0] / (Number(ref.weth) / 1e18) : 0;
    const gasUsd = (Number(gasPrice * GAS_UNITS) / 1e18) * ethUsd;

    // round 2: leg 2 (WETH -> USDC on every OTHER venue)
    const leg2Keys = [], calls2 = [];
    for (const a of leg1) {
        if (!a.weth) { stats.errors++; continue; }
        for (const b of VENUES) if (b !== a.v) {
            leg2Keys.push({ a, b });
            calls2.push(quoteCall(b, WETH, USDC, a.weth, tag));
        }
    }
    // re-check last block's opportunities at THIS block (full 2-leg re-quote)
    const recheck = pending; pending = [];
    for (const p of recheck) calls2.push(quoteCall(p.a, USDC, WETH, BigInt(p.L) * 1000000n, tag));
    const r2 = await batch(calls2);

    let best = null;
    leg2Keys.forEach(({ a, b }, i) => {
        const out = decodeQuote(b, r2[i]);
        if (out == null) { stats.errors++; return; }
        const L = BigInt(a.L) * 1000000n;
        const premium = (L * premiumBps) / 10000n;
        const required = L + premium + (L * BigInt(MIN_PROFIT_BPS)) / 10000n;
        const profit = usd(out - L - premium);
        const net = profit - gasUsd;
        const gapBps = (Number(out - L) / Number(L)) * 1e4;
        const okContract = out >= required;
        const okKeeper = okContract && net > 0;
        stats.routes++;
        if (okContract) stats.passContract++;
        if (okKeeper) { stats.passKeeper++; stats.paperNet += net; pending.push({ a: a.v, b, L: a.L, net, bn }); }
        if (gapBps > stats.bestGapBps) stats.bestGapBps = gapBps;
        if (net > stats.bestNet) { stats.bestNet = net; stats.bestDesc = `block ${bn}: $${a.L} ${a.v.name}->${b.name}`; }
        if (!best || net > best.net) best = { desc: `$${a.L} ${a.v.name}->${b.name}`, gapBps, net, okContract };
        fs.appendFileSync(LOG_FILE, [bn, a.L, a.v.name, b.name, usd(out).toFixed(2), gapBps.toFixed(2),
            profit.toFixed(2), gasUsd.toFixed(2), net.toFixed(2), okContract, okKeeper].join(",") + "\n");
    });

    // finish re-checks: leg 2 of last block's hits, at this block
    if (recheck.length) {
        const leg1b = recheck.map((p, i) => decodeQuote(p.a, r2[leg2Keys.length + i]));
        const r3 = await batch(recheck.map((p, i) => leg1b[i] ? quoteCall(p.b, WETH, USDC, leg1b[i], tag) : ["eth_chainId", []]));
        recheck.forEach((p, i) => {
            const out = leg1b[i] ? decodeQuote(p.b, r3[i]) : null;
            if (out == null) return;
            const L = BigInt(p.L) * 1000000n, premium = (L * premiumBps) / 10000n;
            const required = L + premium + (L * BigInt(MIN_PROFIT_BPS)) / 10000n;
            const net = usd(out - L - premium) - gasUsd;
            if (out >= required && net > 0) { stats.survived++; stats.survivedNet += net; }
            console.log(`    re-check of block ${p.bn} hit at block ${bn}: ${out >= required && net > 0 ? "STILL THERE " + fmt(net) : "GONE (someone else took it)"}`);
        });
    }

    stats.blocks++;
    const t = new Date().toISOString().slice(11, 19);
    console.log(`${t} block ${bn} | ETH $${ethUsd.toFixed(0)} | gas ${(Number(gasPrice) / 1e9).toFixed(2)} gwei ≈ $${gasUsd.toFixed(2)}/trade | ` +
        `best: ${best ? `${best.desc} gap ${best.gapBps.toFixed(1)} bps, net ${fmt(best.net)} ${best.okContract ? "<< PASSES CONTRACT" : "(rejected)"}` : "n/a"}`);
}

function summary() {
    const hours = (stats.blocks * 12) / 3600;
    console.log("\n" + "=".repeat(78));
    console.log(`SUMMARY — ${stats.blocks} real blocks (~${hours.toFixed(1)} h), ${stats.routes} route quotes, rules: minProfit ${MIN_PROFIT_BPS} bps, Aave ${premiumBps} bps`);
    console.log(`  Best price gap seen (before Aave fee & gas): ${stats.bestGapBps.toFixed(1)} bps  (needs > ${Number(premiumBps) + MIN_PROFIT_BPS} bps to pass the contract)`);
    console.log(`  Best net result seen: ${fmt(stats.bestNet)}  (${stats.bestDesc})`);
    console.log(`  Routes passing contract rule: ${stats.passContract}; also profitable after gas: ${stats.passKeeper} (paper total ${fmt(stats.paperNet)})`);
    console.log(`  ...still available one block later (when the bot could actually land): ${stats.survived} (total ${fmt(stats.survivedNet)})`);
    console.log(`  Failed quotes: ${stats.errors}.  Per-route log: ${LOG_FILE}`);
    console.log("  NOTE: even 'still available' trades must still beat other bots and pay builder fees.");
    console.log("=".repeat(78));
}

// ------------------------------------------------------------------- main ----
async function main() {
    const [chainId] = await batch([["eth_chainId", []]]);
    if (chainId !== "0x1") throw new Error(`Expected Ethereum mainnet (0x1), got ${chainId}`);
    const [prem] = await batch([["eth_call", [{ to: AAVE_POOL, data: SEL_PREMIUM }, "latest"]]]);
    if (prem && prem.length >= 66) premiumBps = BigInt(prem);
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,loan_usdc,buy_on,sell_on,usdc_back,gap_bps,profit_after_aave,gas_usd,net_usd,passes_contract,passes_keeper\n");
    console.log(`Read-only live check on Ethereum mainnet. Aave flash fee: ${premiumBps} bps (live). Loan sizes: ${SIZES.join(", ")} USDC.`);
    console.log(`Running ${MINUTES} min. Press Ctrl+C any time for the summary.\n`);

    process.on("SIGINT", () => { summary(); process.exit(0); });
    const end = Date.now() + MINUTES * 60000;
    let last = 0;
    while (Date.now() < end) {
        try {
            const [bnHex] = await batch([["eth_blockNumber", []]]);
            const bn = Number(BigInt(bnHex));
            if (bn > last) {
                if (last && bn > last + 1) pending = []; // missed a block: re-check no longer meaningful
                last = bn;
                await scanBlock(bn);
            }
        } catch (e) { console.error("  error:", e.message); }
        await new Promise((r) => setTimeout(r, 3000));
    }
    summary();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

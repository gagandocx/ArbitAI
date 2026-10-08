#!/usr/bin/env node
/*
 * PHASE 1 — ARBITRAGE RECON (read-only) for Base.
 *
 * Goal: learn from the bots that already win. We scan recent Base blocks, group
 * every DEX Swap event by transaction, and detect CYCLIC ARBITRAGE: a single
 * transaction that swaps through >= 2 pools and ends holding more of the token
 * it started with. For each one we record:
 *   - the pools and tokens used (the "route")
 *   - how many hops
 *   - which DEXes
 *   - gas used, effective gas price, and priority fee paid
 *   - the position of the tx within its block (were they first?)
 *   - whether a large non-arb swap happened earlier in the same block (a backrun)
 *
 * Then it ranks the setups: which pools and token cycles are arbitraged most,
 * and how much the winners actually net after gas. That tells us exactly what to
 * target in Phase 2/3, instead of guessing.
 *
 * SAFETY: read-only (eth_getLogs / eth_getBlockByNumber / eth_getTransactionReceipt
 * / eth_blockNumber / eth_chainId only). No wallet, no key, no transactions.
 *
 * Requirements: Node 18+. A real RPC is strongly recommended (set RPC_URL) because
 * this reads full blocks and receipts; public endpoints will rate-limit.
 *
 * Usage:
 *   set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   node sim/arb_recon.mjs --blocks 300            # scan the last 300 blocks (~10 min of Base)
 *   node sim/arb_recon.mjs --blocks 1000 --min-hops 2
 *   Options: --from <block> (default: latest), --min-usd 1 (ignore dust arbs),
 *            --top 40 (rows per ranking), --log arb_recon_log.csv
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const lower = (a) => a.toLowerCase();

// ---- multi-chain config: public fallback RPCs + known tokens for USD pricing ----
// The detection logic is chain-agnostic (any EVM Swap/Transfer events). Only the
// RPC endpoints and the stablecoin set (for USD valuation) differ per chain.
const CHAINS = {
    base: {
        chainId: "0x2105",
        rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"],
        tokens: {
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { s: "USDC", d: 6, usd: 1 },
            "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { s: "USDbC", d: 6, usd: 1 },
            "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { s: "USDT", d: 6, usd: 1 },
            "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { s: "DAI", d: 18, usd: 1 },
            "0x4200000000000000000000000000000000000006": { s: "WETH", d: 18, usd: null },
            "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { s: "cbBTC", d: 8, usd: null },
            "0x940181a94a35a4569e4529a3cdfb74e38fd98631": { s: "AERO", d: 18, usd: null },
        },
    },
    arbitrum: {
        chainId: "0xa4b1",
        rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arb"],
        tokens: {
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { s: "USDC", d: 6, usd: 1 },
            "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { s: "USDC.e", d: 6, usd: 1 },
            "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { s: "USDT", d: 6, usd: 1 },
            "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { s: "DAI", d: 18, usd: 1 },
            "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { s: "WETH", d: 18, usd: null },
            "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { s: "WBTC", d: 8, usd: null },
            "0x912ce59144191c1204e64559fe8253a0e49e6548": { s: "ARB", d: 18, usd: null },
        },
    },
    optimism: {
        chainId: "0xa",
        rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://1rpc.io/op"],
        tokens: {
            "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { s: "USDC", d: 6, usd: 1 },
            "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { s: "USDC.e", d: 6, usd: 1 },
            "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { s: "USDT", d: 6, usd: 1 },
            "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { s: "DAI", d: 18, usd: 1 },
            "0x4200000000000000000000000000000000000006": { s: "WETH", d: 18, usd: null },
            "0x4200000000000000000000000000000000000042": { s: "OP", d: 18, usd: null },
        },
    },
    polygon: {
        chainId: "0x89",
        rpcs: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
        tokens: {
            "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { s: "USDC", d: 6, usd: 1 },
            "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { s: "USDC.e", d: 6, usd: 1 },
            "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { s: "USDT", d: 6, usd: 1 },
            "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { s: "DAI", d: 18, usd: 1 },
            "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { s: "WETH", d: 18, usd: null },
            "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { s: "WMATIC", d: 18, usd: null },
        },
    },
    bsc: {
        chainId: "0x38",
        rpcs: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"],
        tokens: {
            "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { s: "USDC", d: 18, usd: 1 },
            "0x55d398326f99059ff775485246999027b3197955": { s: "USDT", d: 18, usd: 1 },
            "0xe9e7cea3dedca5984780bafc599bd69add087d56": { s: "BUSD", d: 18, usd: 1 },
            "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { s: "WBNB", d: 18, usd: null },
            "0x2170ed0880ac9a755fd29b2688956bd959f933f8": { s: "ETH", d: 18, usd: null },
        },
    },
    ethereum: {
        chainId: "0x1",
        rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
        tokens: {
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { s: "USDC", d: 6, usd: 1 },
            "0xdac17f958d2ee523a2206206994597c13d831ec7": { s: "USDT", d: 6, usd: 1 },
            "0x6b175474e89094c44da98b954eedeac495271d0f": { s: "DAI", d: 18, usd: 1 },
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { s: "WETH", d: 18, usd: null },
            "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { s: "WBTC", d: 8, usd: null },
        },
    },
};

const CHAIN = opt("chain", "base");
if (!CHAINS[CHAIN]) { console.error(`Unknown --chain "${CHAIN}". Options: ${Object.keys(CHAINS).join(", ")}`); process.exit(1); }
const CFG = CHAINS[CHAIN];
const N_BLOCKS = Number(opt("blocks", 300));
const FROM = opt("from", null) ? Number(opt("from")) : null;
const MIN_HOPS = Number(opt("min-hops", 2));
const TOP = Number(opt("top", 40));
const LOG_FILE = opt("log", `arb_recon_${CHAIN}.csv`);
const RPCS = process.env.RPC_URL ? [process.env.RPC_URL] : CFG.rpcs;
const KNOWN = CFG.tokens;
const sym = (a) => KNOWN[lower(a)]?.s || (lower(a).slice(0, 6) + "…" + lower(a).slice(-4));

// ---- event topics ----
const T_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"; // UniV2-style Swap
const T_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"; // UniV3 / Pancake / Aero CL Swap
const T_AV2 = "0x236c64fd115dc00cafeeaf44b6ca2af23a66ba0e282852756756b073c5515075"; // Aerodrome v2 Swap
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ------------------------------------------------------ read-only RPC ----
const ALLOWED = new Set(["eth_blockNumber", "eth_chainId", "eth_getLogs", "eth_getBlockByNumber", "eth_getTransactionReceipt"]);
let rpcIdx = 0, reqId = 1, rpcErrors = 0;
async function post(body) {
    for (let attempt = 0; attempt < RPCS.length * 3; attempt++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
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
    for (let i = 0; i < calls.length; i += 5) {
        const chunk = calls.slice(i, i + 5).map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
        let resp = await post(chunk);
        if (!Array.isArray(resp)) resp = await Promise.all(chunk.map((r) => post(r)));
        const byId = new Map(resp.map((r) => [r.id, r]));
        for (const r of chunk) { const v = byId.get(r.id); if (v && v.error) rpcErrors++; out.push(v?.result ?? null); }
    }
    return out;
}
const rpc = async (m, p) => (await rpcBatch([[m, p]]))[0];

// --------------------------------------------------------- helpers ----
const strip = (h) => (h || "").replace(/^0x/, "");
const toBig = (h) => (!h || h === "0x" ? 0n : BigInt(h));
const hexInt = (h) => Number(BigInt(h));
const addrOfTopic = (t) => "0x" + strip(t).slice(24).toLowerCase();
// signed int256 from a 32-byte word
function sint(word) { const v = BigInt("0x" + word); return v >= (1n << 255n) ? v - (1n << 256n) : v; }

// A pool's "class" guessed from which event it emitted
function dexClass(topic) { return topic === T_V3 ? "v3/cl" : topic === T_AV2 ? "aero-v2" : "v2"; }

// ---- parse one swap log into {pool, class, tokenInGuess?, amounts} ----
// We don't know token0/token1 here, so we classify by sign and pair pools via
// transfers. For routing we rely on the Transfer events (who received what).

// ------------------------------------------------------------- main ----
const STATS = {
    blocksScanned: 0, txWithSwaps: 0, arbTxs: 0, totalSwaps: 0,
    byPool: new Map(),      // pool -> {count, class}
    byCycle: new Map(),     // "WETH>cbBTC>WETH" -> {count, hopsSum}
    byHops: new Map(),      // nHops -> count
    byDex: new Map(),       // class -> count
    arbSamples: [],         // detailed rows
    gasUsedSum: 0n, prioritySum: 0n, firstInBlock: 0, backruns: 0,
};

async function scanBlock(bn) {
    const tag = "0x" + bn.toString(16);
    // 1 full block (tx list + baseFee) + all logs in the block
    const [block, logs] = await rpcBatch([
        ["eth_getBlockByNumber", [tag, false]],
        ["eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [[T_V2, T_V3, T_AV2]] }]],
    ]);
    if (!block || !logs) { rpcErrors++; return; }
    STATS.blocksScanned++;
    const baseFee = block.baseFeePerGas ? toBig(block.baseFeePerGas) : 0n;
    const txIndex = new Map((block.transactions || []).map((h, i) => [lower(h), i]));
    const txCount = (block.transactions || []).length;

    // group swap logs by tx
    const byTx = new Map();
    for (const lg of logs) {
        const h = lower(lg.transactionHash);
        if (!byTx.has(h)) byTx.set(h, []);
        byTx.get(h).push(lg);
        STATS.totalSwaps++;
    }

    // also need Transfer logs to reconstruct token flow per tx
    const [transferLogs] = await rpcBatch([["eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [T_TRANSFER] }]]]);
    const transfersByTx = new Map();
    for (const lg of transferLogs || []) {
        const h = lower(lg.transactionHash);
        if (!byTx.has(h)) continue; // only care about txs that also did swaps
        if (!transfersByTx.has(h)) transfersByTx.set(h, []);
        transfersByTx.get(h).push(lg);
    }

    for (const [txh, swaps] of byTx) {
        STATS.txWithSwaps++;
        if (swaps.length < MIN_HOPS) continue;

        // reconstruct the token path from Transfer events: the sender/initiator
        // is whoever appears as both a receiver (first hop in) and final receiver.
        const transfers = (transfersByTx.get(txh) || []).map((t) => ({
            token: lower(t.address), from: addrOfTopic(t.topics[1]), to: addrOfTopic(t.topics[2]), amt: toBig(t.data || "0x0"),
        }));
        // find an address that both spends and receives the SAME token (net>=0) and is net-positive on it => arbitrageur
        const perAddrToken = new Map(); // addr -> token -> net
        for (const tr of transfers) {
            for (const [addr, sign] of [[tr.from, -1n], [tr.to, 1n]]) {
                if (!perAddrToken.has(addr)) perAddrToken.set(addr, new Map());
                const m = perAddrToken.get(addr);
                m.set(tr.token, (m.get(tr.token) || 0n) + sign * tr.amt);
            }
        }
        // cyclic arb heuristic: some address ends net-positive in exactly one token
        // and touched >= MIN_HOPS pools (swaps). Pools = unique swap log addresses.
        const pools = [...new Set(swaps.map((s) => lower(s.address)))];
        if (pools.length < MIN_HOPS) continue;

        // Track gross in/out per address per token so we can require a true CYCLE
        // (the profit token must have been BOTH received and sent by the arb address —
        // i.e. it round-tripped — not merely relayed/forwarded once).
        const grossIn = new Map(), grossOut = new Map(); // addr -> token -> amt
        for (const tr of transfers) {
            const gi = grossIn.get(tr.to) || new Map(); gi.set(tr.token, (gi.get(tr.token) || 0n) + tr.amt); grossIn.set(tr.to, gi);
            const go = grossOut.get(tr.from) || new Map(); go.set(tr.token, (go.get(tr.token) || 0n) + tr.amt); grossOut.set(tr.from, go);
        }

        let arb = null;
        for (const [addr, m] of perAddrToken) {
            const positives = [...m.entries()].filter(([, v]) => v > 0n);
            const negatives = [...m.entries()].filter(([, v]) => v < 0n);
            // classic atomic arb: net-positive in one token, roughly net-zero elsewhere
            if (positives.length === 1 && negatives.length === 0) {
                const [token, profit] = positives[0];
                // CYCLE REQUIREMENT: the profit token must have round-tripped through
                // this address (both received AND sent during the tx). A token that was
                // only received (relayed/forwarded) is NOT arbitrage profit — this is
                // what caused the phantom ~$437k rows.
                const outVol = grossOut.get(addr)?.get(token) || 0n;
                const inVol = grossIn.get(addr)?.get(token) || 0n;
                if (outVol > 0n && inVol > 0n) {
                    // round-trip volume = the smaller of in/out; a real arb nets a small
                    // SLICE of what it cycled, a relay "nets" ~all of what came in.
                    const roundTrip = outVol < inVol ? outVol : inVol;
                    arb = { addr, token, profit, roundTrip };
                    break;
                }
            }
        }
        if (!arb) continue;

        // build a readable cycle from the pools' token symbols (best-effort via transfers touching the arb addr)
        const touched = transfers.filter((t) => t.from === arb.addr || t.to === arb.addr).map((t) => sym(t.token));
        const cycle = [...new Set(touched)].join(">") || pools.map(() => "?").join(">");

        // economics: fetch receipt for gas + effective price
        const rcpt = await rpc("eth_getTransactionReceipt", [txh]);
        let gasUsed = 0n, effPrice = 0n, priority = 0n;
        if (rcpt) {
            gasUsed = toBig(rcpt.gasUsed || "0x0");
            effPrice = toBig(rcpt.effectiveGasPrice || "0x0");
            priority = effPrice > baseFee ? effPrice - baseFee : 0n;
            STATS.gasUsedSum += gasUsed; STATS.prioritySum += priority * gasUsed;
        }
        const idx = txIndex.get(txh) ?? -1;
        if (idx === 0) STATS.firstInBlock++;

        const kt = KNOWN[arb.token];
        let profUsd = kt && kt.usd != null ? Number(arb.profit) / 10 ** kt.d * kt.usd : null;
        // Sanity flag: a single on-chain arb netting > $100k is implausible on Base and
        // almost always a decimals/relay artifact. Record it but mark as untrusted so it
        // does not pollute totals/medians.
        let flagged = false, flagReason = "";
        if (profUsd != null && profUsd > 100000) { flagged = true; flagReason = ">$100k"; }
        // RELAY CHECK: profit as a fraction of the round-tripped volume of the profit
        // token. A genuine arb nets a small slice (typically < a few %); a relayed/
        // forwarded token shows profit ~= all of what round-tripped. Flag > 25%.
        if (!flagged && arb.roundTrip > 0n) {
            // profitShare = profit / roundTrip, in basis points (avoid float on bigint)
            const shareBps = Number((arb.profit * 10000n) / arb.roundTrip);
            if (shareBps > 2500) { flagged = true; flagReason = "profit>25% of volume (relay)"; }
        }
        const gasEth = Number(gasUsed * effPrice) / 1e18;

        STATS.arbTxs++;
        STATS.byHops.set(pools.length, (STATS.byHops.get(pools.length) || 0) + 1);
        for (const p of pools) {
            const cls = dexClass(swaps.find((s) => lower(s.address) === p).topics[0]);
            const e = STATS.byPool.get(p) || { count: 0, class: cls };
            e.count++; STATS.byPool.set(p, e);
            STATS.byDex.set(cls, (STATS.byDex.get(cls) || 0) + 1);
        }
        const cy = STATS.byCycle.get(cycle) || { count: 0, hopsSum: 0 };
        cy.count++; cy.hopsSum += pools.length; STATS.byCycle.set(cycle, cy);

        STATS.arbSamples.push({ bn, txh, idx, txCount, hops: pools.length, cycle, token: kt?.s || sym(arb.token),
            profit: arb.profit.toString(), profUsd, flagged, flagReason, gasEth, priorityGwei: Number(priority) / 1e9 });
        fs.appendFileSync(LOG_FILE, [bn, idx, txCount, pools.length, cycle, kt?.s || sym(arb.token),
            profUsd != null ? profUsd.toFixed(4) : "", flagged ? "FLAGGED" : "", gasEth.toFixed(8), (Number(priority) / 1e9).toFixed(4), txh].join(",") + "\n");
    }
}

function fmtEth(x) { return x.toFixed(6) + " ETH"; }
function report() {
    console.log("\n" + "=".repeat(96));
    console.log(`ARB RECON SUMMARY [${CHAIN}] — ${STATS.blocksScanned} blocks scanned, min hops ${MIN_HOPS}`);
    console.log(`  Transactions containing DEX swaps: ${STATS.txWithSwaps} | total swaps: ${STATS.totalSwaps}`);
    console.log(`  CYCLIC ARBITRAGE transactions detected: ${STATS.arbTxs}`);
    if (!STATS.arbTxs) { console.log("  (none detected — try more --blocks, or lower --min-hops to 2)"); console.log("=".repeat(96)); return; }
    const perBlock = (STATS.arbTxs / STATS.blocksScanned).toFixed(2);
    console.log(`  ≈ ${perBlock} arbitrage txs per block | first-in-block: ${STATS.firstInBlock} (${(100 * STATS.firstInBlock / STATS.arbTxs).toFixed(0)}%)`);
    const avgGas = Number(STATS.gasUsedSum / BigInt(STATS.arbTxs));
    console.log(`  Avg gas used per arb: ${Math.round(avgGas).toLocaleString()} | avg priority fee bid: ${(Number(STATS.prioritySum) / Number(STATS.gasUsedSum) / 1e9).toFixed(3)} gwei`);

    console.log(`\n  Hops distribution:`);
    [...STATS.byHops.entries()].sort((a, b) => a[0] - b[0]).forEach(([h, c]) => console.log(`    ${h} pools: ${c}`));
    console.log(`\n  DEX class usage (pool-hits across all arbs):`);
    [...STATS.byDex.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`    ${k.padEnd(10)} ${c}`));

    console.log(`\n  TOP ${TOP} token cycles by arb count:`);
    [...STATS.byCycle.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP)
        .forEach(([k, v]) => console.log(`    ${String(v.count).padStart(5)}×  ${k}`));

    console.log(`\n  TOP ${TOP} most-arbitraged pools (address — hits — class):`);
    [...STATS.byPool.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP)
        .forEach(([p, v]) => console.log(`    ${String(v.count).padStart(5)}×  ${p}  ${v.class}`));

    const trusted = STATS.arbSamples.filter((s) => s.profUsd != null && !s.flagged);
    const flaggedArr = STATS.arbSamples.filter((s) => s.flagged);
    if (trusted.length) {
        trusted.sort((a, b) => b.profUsd - a.profUsd);
        const sum = trusted.reduce((s, x) => s + x.profUsd, 0);
        console.log(`\n  TRUSTED profit (stablecoin-ending, known decimals, < $100k, ${trusted.length} of ${STATS.arbTxs}):`);
        console.log(`    total ~$${sum.toFixed(2)} | avg ~$${(sum / trusted.length).toFixed(2)} | median ~$${trusted[Math.floor(trusted.length / 2)].profUsd.toFixed(2)} | best ~$${trusted[0].profUsd.toFixed(2)}`);
        const over = (t) => trusted.filter((s) => s.profUsd > t).length;
        console.log(`    arbs over $1: ${over(1)} | over $5: ${over(5)} | over $20: ${over(20)} | over $100: ${over(100)}`);
        console.log(`    (profit is the on-chain token delta; gas is separate, avg ${fmtEth(STATS.arbSamples.reduce((s, x) => s + x.gasEth, 0) / STATS.arbSamples.length)})`);
        console.log(`    Biggest 10 trusted:`);
        trusted.slice(0, 10).forEach((s) => console.log(`      $${s.profUsd.toFixed(2).padStart(10)}  ${s.cycle.padEnd(28)} ${s.hops} pools, gas ${s.gasEth.toFixed(6)} ETH, pos ${s.idx}/${s.txCount}, blk ${s.bn}`));
    } else {
        console.log(`\n  (No trusted stablecoin-ending arbs; see ${LOG_FILE}.)`);
    }
    if (flaggedArr.length) {
        console.log(`\n  FLAGGED (excluded from totals — artifacts: >$100k or profit>25% of cycled volume): ${flaggedArr.length}`);
        const byReason = {};
        for (const f of flaggedArr) byReason[f.flagReason] = (byReason[f.flagReason] || 0) + 1;
        console.log(`    reasons: ${JSON.stringify(byReason)}`);
        flaggedArr.sort((a, b) => (b.profUsd || 0) - (a.profUsd || 0));
        console.log(`    biggest flagged: $${(flaggedArr[0].profUsd || 0).toFixed(0)} (${flaggedArr[0].flagReason}), cycle ${flaggedArr[0].cycle}`);
    }
    console.log(`\n  RPC errors: ${rpcErrors}. Full per-arb log: ${LOG_FILE}`);
    console.log("  NOTE: 'profit' is the arbitrageur's token gain measured on-chain; it already beat THEIR gas+bid.");
    console.log("=".repeat(96));
}

async function main() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== CFG.chainId) throw new Error(`Expected ${CHAIN} (${CFG.chainId}), got ${chainId}. Is RPC_URL pointed at ${CHAIN}?`);
    const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
    const from = FROM ?? (latest - N_BLOCKS + 1);
    const to = FROM ? FROM + N_BLOCKS - 1 : latest;
    if (!process.env.RPC_URL) console.log("WARNING: no RPC_URL set — public endpoints will likely rate-limit full-block reads. Set your Alchemy URL first.\n");
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,tx_index,tx_count,pools,cycle,profit_token,profit_usd,flagged,gas_eth,priority_gwei,tx_hash\n");
    console.log(`Scanning ${CHAIN} blocks ${from}..${to} (${to - from + 1} blocks) for cyclic arbitrage...\n`);

    let done = 0;
    for (let bn = from; bn <= to; bn++) {
        try { await scanBlock(bn); } catch (e) { console.error(`  block ${bn} error: ${e.message}`); }
        if (++done % 25 === 0) process.stdout.write(`  ...${done}/${to - from + 1} blocks, ${STATS.arbTxs} arbs so far\n`);
    }
    report();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

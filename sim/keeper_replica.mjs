#!/usr/bin/env node
/*
 * READ-ONLY REPLICA of the ArbitrageExecutor v3.3-live keeper (Code.txt, Appendix A),
 * run against LIVE Ethereum mainnet data.
 *
 * It re-implements the keeper's decision pipeline function-for-function and
 * applies it to every new block, but STOPS before anything that needs a wallet.
 *
 *   Original keeper                        This replica
 *   ------------------------------------   -----------------------------------------------
 *   discoverV2/V3 (PairCreated/PoolCreated  same (eth_getLogs, last 5000 blocks, LOG_CHUNK 2000)
 *     logs, last 5000 blocks)
 *   refreshV2Reserves / Sync listeners      getReserves every block (= keeper with WS_RPC_URL)
 *   refreshV3State, refreshTokenMeta        same
 *   computeUsdPrices / pairLiquidityScore   same (BigInt, E18)
 *   buildLiquidityGraph (top 15 / token)    same
 *   findCandidateCycles (DFS, maxHops 4,    same
 *     first 200 cycles)
 *   reserveCycleQuote (1% impact guard)     same
 *   batchQuoteCycles (round-based, best     same (Multicall3 aggregate3, like the keeper)
 *     router per hop)
 *   calculateWorstCaseFinal (30 bps)        same
 *   getPremiumBps (Aave)                    same (read from the Aave pool)
 *   previewRoute (contract, V2 only)        = the same router quotes (no deployed contract)
 *   estimateGas(startArbitrage)             SUBSTITUTE: the contract's revert rule is checked
 *                                           explicitly; gas units from a per-hop model
 *   gas safety x1.2, ceiling 1.2M           same
 *   getFeeData -> maxFeePerGas              same formula (2*baseFee + priority, ethers v6)
 *   getGasCostInAsset (UniV2 WETH->USDC)    same
 *   calcEconomics, gasBps<=80, profitBps>=50 same
 *   eth_call simulate / Flashbots / submit  NOT RUN (needs a deployed contract + key)
 *
 * Generous simplifications (they can only make the bot look BETTER):
 *   - all cycles are quoted in one batched pass per block; the real keeper quotes
 *     them one by one and drops quotes that become stale when a new block lands;
 *   - no competition: we assume nobody else takes the trade first.
 *
 * MODES
 *   --mode exact  (default) exactly the configuration from Code.txt "HOW TO RUN":
 *                 V2 factories Uni+Sushi, V2 routers Uni+Sushi, NO V3 factories,
 *                 STABLECOINS=USDC,DAI, BOOTSTRAP_TOKENS=WETH, FLASH_AMOUNT=20,000 USDC,
 *                 and the keeper's original V3 quoter call.
 *                 Add --v3 to also set V3_FACTORIES=Uniswap V3 (as an operator could).
 *   --mode fixed  same logic, with its discovery and V3 bugs repaired: the big
 *                 established pools (USDC/USDT/DAI/WETH/WBTC on Uni V2, Sushi, Uni V3)
 *                 are added, V3 quotes use the correct QuoterV2 call and V3 swaps
 *                 assume a router the contract is compatible with.
 *
 * SAFETY: only read methods are allowed (enforced). No wallet, no key, no transactions.
 *
 * Usage: node sim/keeper_replica.mjs [--mode exact|fixed] [--v3] [--minutes 360]
 *        [--flash 20000] [--max-hops 4]      RPC_URL=<your node> to use your own RPC.
 */
import fs from "node:fs";

// ================================================================ options ====
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes("--" + n);
const MODE = opt("mode", "exact");
if (!["exact", "fixed"].includes(MODE)) { console.error("--mode must be exact or fixed"); process.exit(1); }
const USE_V3 = MODE === "fixed" || flag("v3");
const MINUTES = Number(opt("minutes", 360));
const LOG_FILE = opt("log", `keeper_replica_${MODE}.csv`);
const RPCS = process.env.RPC_URL
    ? [process.env.RPC_URL]
    : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"];

// =========================================== keeper constants (Code.txt) ====
const BPS = 10000n;
const E18 = 10n ** 18n;
const TOP_PAIRS_PER_TOKEN = 15;
const MAX_CANDIDATE_CYCLES = 200;
const PRICE_IMPACT_BPS = 100n;
const V2_RESERVE_FEE_BPS = 30n;
const BOOT_LOOKBACK = 5000;              // discoverV2/V3: latest - 5000 when BOOTSTRAP_FROM_BLOCK unset
const LOG_CHUNK = 2000;
const CFG = {
    flashAmount: BigInt(Math.round(Number(opt("flash", "20000")) * 1e6)), // FLASH_AMOUNT=20000000000
    maxHops: Number(opt("max-hops", "4")),                                 // MAX_HOPS default 4
    minProfitBps: 50,                                                      // MIN_PROFIT_BPS_LOCAL
    slippageBps: 30,                                                       // ROUTE_SLIPPAGE_BPS
    gasSafetyBps: 12000n,                                                  // GAS_SAFETY_BPS
    gasLimitCeiling: 1200000n,                                             // GAS_LIMIT_CEILING
    maxGasBpsOfTrade: 80,                                                  // MAX_GAS_BPS_OF_TRADE
    contractMinProfitBps: 50n,                                             // contract minProfitBps
};
// Gas model replacing estimateGas (no deployed contract): flash-loan + bookkeeping
// overhead plus per-swap cost. Override with --gas-base / --gas-v2 / --gas-v3.
const GAS = { base: BigInt(opt("gas-base", "130000")), v2: BigInt(opt("gas-v2", "100000")), v3: BigInt(opt("gas-v3", "130000")) };

// ================================================== mainnet addresses ====
const A = {
    USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
    USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    UNI_V2_FACTORY: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    SUSHI_FACTORY: "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac",
    UNI_V3_FACTORY: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    UNI_V2_ROUTER: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    SUSHI_ROUTER: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
    QUOTER_V2: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
    SWAP_ROUTER02: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    SWAP_ROUTER_V1: "0xe592427a0aece92de3edee1f18e0157c05861564",
    AAVE_POOL: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    MULTICALL3: "0xca11bde05977b3631167028862be2a173976ca11",
};
const FLASH_ASSET = A.USDC;
const STABLECOINS = [A.USDC, A.DAI];                  // STABLECOINS from HOW TO RUN
const BOOTSTRAP_TOKENS = [A.WETH];                    // BOOTSTRAP_TOKENS from HOW TO RUN
const V2_FACTORIES = [A.UNI_V2_FACTORY, A.SUSHI_FACTORY];
const V2_ROUTERS = [A.UNI_V2_ROUTER, A.SUSHI_ROUTER];
const V3_FACTORIES = USE_V3 ? [A.UNI_V3_FACTORY] : [];
const V3_PAIRS = [{ quoter: A.QUOTER_V2, router: MODE === "fixed" ? A.SWAP_ROUTER_V1 : A.SWAP_ROUTER02 }];
const MAJORS = [A.USDC, A.USDT, A.DAI, A.WETH, A.WBTC];
const V3_FEE_TIERS = [100, 500, 3000, 10000];

// ========================================================= selectors ====
const SEL = {
    aggregate3: "0x82ad56cb",
    getAmountsOut: "0xd06ca61f",
    quoteV1Style: "0xf7729d43",   // quoteExactInputSingle(address,address,uint24,uint256,uint160) — what the keeper calls
    quoteV2Struct: "0xc6a5026a",  // quoteExactInputSingle((address,address,uint256,uint24,uint160)) — QuoterV2's real fn
    swapV1Struct: "0x414bf389",   // exactInputSingle((..,deadline,..)) — what the CONTRACT calls
    swap02Struct: "0x04e45aaf",   // exactInputSingle((.. no deadline ..)) — SwapRouter02's real fn
    getReserves: "0x0902f1ac",
    liquidity: "0x1a686502",
    decimals: "0x313ce567",
    symbol: "0x95d89b41",
    getPair: "0xe6a43905",
    getPool: "0x1698ee82",
    premium: "0x074b2e43",
};
const TOPIC_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const TOPIC_POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

// ================================================ read-only JSON-RPC ====
const ALLOWED = new Set(["eth_call", "eth_blockNumber", "eth_chainId", "eth_getBlockByNumber",
    "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getLogs", "eth_getCode"]);
let rpcIdx = 0, reqId = 1;
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
    throw new Error("All RPC endpoints failed. Set RPC_URL to your own provider (Alchemy/Infura free tier).");
}
/** [[method, params], ...] -> results (null where the node returned an error). */
async function rpcBatch(calls) {
    for (const [m] of calls) if (!ALLOWED.has(m)) throw new Error(`Blocked non-read method ${m}`);
    const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: reqId++, method, params }));
    const out = [];
    for (let i = 0; i < reqs.length; i += 20) {
        const chunk = reqs.slice(i, i + 20);
        let resp = await post(chunk);
        if (!Array.isArray(resp)) resp = await Promise.all(chunk.map((r) => post(r)));
        const byId = new Map(resp.map((r) => [r.id, r]));
        for (const r of chunk) out.push(byId.get(r.id)?.result ?? null);
    }
    return out;
}
const rpc = async (m, p) => (await rpcBatch([[m, p]]))[0];

// ======================================================== ABI helpers ====
const strip = (h) => h.replace(/^0x/, "");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const aw = (a) => strip(a).toLowerCase().padStart(64, "0");
const wordsOf = (hex) => (strip(hex || "").match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const addrOfWord = (w) => "0x" + strip(w).slice(-40).toLowerCase();
const lower = (a) => a.toLowerCase();

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
    const d = strip(hex);
    const at = (b) => Number(BigInt("0x" + d.slice(b * 2, b * 2 + 64)));
    const arr = at(0), n = at(arr), base = arr + 32, out = [];
    for (let i = 0; i < n; i++) {
        const t = base + at(base + 32 * i);
        const success = at(t) === 1;
        const b = t + at(t + 32), len = at(b);
        out.push({ success, ret: "0x" + d.slice((b + 32) * 2, (b + 32 + len) * 2) });
    }
    return out;
}
/** Multicall3.aggregate3 with allowFailure=true, like the keeper's multicall(). */
async function multicall(calls, tag) {
    const out = [];
    const chunks = [];
    for (let i = 0; i < calls.length; i += 80) chunks.push(calls.slice(i, i + 80));
    const res = await rpcBatch(chunks.map((c) => ["eth_call", [{ to: A.MULTICALL3, data: encAggregate3(c) }, tag]]));
    res.forEach((r, i) => {
        if (!r || r === "0x") { STATS.rpcErrors++; chunks[i].forEach(() => out.push({ success: false, ret: "0x" })); }
        else out.push(...decAggregate3(r));
    });
    return out;
}
function decodeString(ret) {
    const d = strip(ret);
    if (d.length >= 192) {
        const len = Number(BigInt("0x" + d.slice(64, 128)));
        if (len > 0 && len < 64) return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
    }
    if (d.length >= 64) return Buffer.from(d.slice(0, 64), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
    return "?";
}

// ============================================================== state ====
const STATE = {
    tokens: new Set(), v2Pairs: new Map(), v3Pools: new Map(),
    tokenDecimals: new Map(), tokenSymbols: new Map(), graph: new Map(),
};
const STATS = {
    blocks: 0, cyclesTotal: 0, drops: {}, wouldSubmit: 0, blocksWithOpp: 0, survived: 0, survivedNet: 0n,
    paperNet: 0n, bestBps: -Infinity, bestDesc: "", rpcErrors: 0, emptyGraphBlocks: 0,
};
const drop = (r) => { STATS.drops[r] = (STATS.drops[r] || 0) + 1; };
const addToken = (t) => { if (t && !/^0x0{40}$/.test(t)) STATE.tokens.add(lower(t)); };
const sym = (t) => STATE.tokenSymbols.get(lower(t)) || t.slice(0, 8);

function addV2Pair(pair, t0, t1, factory) {
    STATE.v2Pairs.set(lower(pair), { pair: lower(pair), token0: lower(t0), token1: lower(t1), factory, reserve0: 0n, reserve1: 0n });
    addToken(t0); addToken(t1);
}
function addV3Pool(pool, t0, t1, fee, factory) {
    STATE.v3Pools.set(lower(pool), { pool: lower(pool), token0: lower(t0), token1: lower(t1), fee: Number(fee), factory, liquidity: 0n });
    addToken(t0); addToken(t1);
}

// ========================================================= discovery ====
/** discoverV2 / discoverV3: factory creation logs over the last 5000 blocks. */
async function discoverFromLogs(latest) {
    const from = Math.max(0, latest - BOOT_LOOKBACK);
    const jobs = [...V2_FACTORIES.map((f) => ({ f, topic: TOPIC_PAIR_CREATED, v3: false })),
        ...V3_FACTORIES.map((f) => ({ f, topic: TOPIC_POOL_CREATED, v3: true }))];
    for (const j of jobs) {
        for (let s = from; s <= latest; s += LOG_CHUNK) {
            const e = Math.min(latest, s + LOG_CHUNK - 1);
            let logs = await rpc("eth_getLogs", [{ address: j.f, fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16), topics: [j.topic] }]);
            if (logs === null) { // the keeper just warns and moves on; we retry smaller ranges to be fair to public RPC limits
                logs = [];
                for (let s2 = s; s2 <= e; s2 += 250) {
                    const r = await rpc("eth_getLogs", [{ address: j.f, fromBlock: "0x" + s2.toString(16), toBlock: "0x" + Math.min(e, s2 + 249).toString(16), topics: [j.topic] }]);
                    if (r === null) console.error(`  [warn] eth_getLogs failed for ${j.f} blocks ${s2}..${s2 + 249} (keeper would skip these too)`);
                    else logs.push(...r);
                }
            }
            for (const l of logs) {
                const t0 = addrOfWord(l.topics[1]), t1 = addrOfWord(l.topics[2]);
                const w = strip(l.data).match(/.{64}/g) || [];
                if (j.v3) addV3Pool(addrOfWord(w[1]), t0, t1, Number(BigInt(l.topics[3])), j.f);
                else addV2Pair(addrOfWord(w[0]), t0, t1, j.f);
            }
        }
    }
}
/** fixed mode only: look up the long-established major pools directly. */
async function discoverMajors(tag) {
    const pairs = [];
    for (let i = 0; i < MAJORS.length; i++) for (let k = i + 1; k < MAJORS.length; k++) {
        const [t0, t1] = BigInt(MAJORS[i]) < BigInt(MAJORS[k]) ? [MAJORS[i], MAJORS[k]] : [MAJORS[k], MAJORS[i]];
        pairs.push([t0, t1]);
    }
    const calls = [], meta = [];
    for (const [t0, t1] of pairs) {
        for (const f of V2_FACTORIES) { calls.push({ target: f, data: SEL.getPair + aw(t0) + aw(t1) }); meta.push({ v3: false, f, t0, t1 }); }
        for (const f of V3_FACTORIES) for (const fee of V3_FEE_TIERS) {
            calls.push({ target: f, data: SEL.getPool + aw(t0) + aw(t1) + word(fee) }); meta.push({ v3: true, f, t0, t1, fee });
        }
    }
    const res = await multicall(calls, tag);
    res.forEach((r, i) => {
        if (!r.success) return;
        const a = addrOfWord(strip(r.ret).slice(0, 64));
        if (/^0x0{40}$/.test(a)) return;
        const m = meta[i];
        if (m.v3) addV3Pool(a, m.t0, m.t1, m.fee, m.f); else addV2Pair(a, m.t0, m.t1, m.f);
    });
}

// ================================================= refresh (per block) ====
async function refreshState(tag) {
    const v2 = [...STATE.v2Pairs.values()], v3 = [...STATE.v3Pools.values()];
    const newTokens = [...STATE.tokens].filter((t) => !STATE.tokenDecimals.has(t));
    const calls = [
        ...v2.map((p) => ({ target: p.pair, data: SEL.getReserves })),
        ...v3.map((p) => ({ target: p.pool, data: SEL.liquidity })),
        ...newTokens.flatMap((t) => [{ target: t, data: SEL.decimals }, { target: t, data: SEL.symbol }]),
    ];
    const res = await multicall(calls, tag);
    let i = 0;
    for (const p of v2) { const r = res[i++]; if (r.success) { const w = wordsOf(r.ret); p.reserve0 = w[0] ?? 0n; p.reserve1 = w[1] ?? 0n; } }
    for (const p of v3) { const r = res[i++]; if (r.success) p.liquidity = wordsOf(r.ret)[0] ?? 0n; }
    for (const t of newTokens) {
        const d = res[i++], s = res[i++];
        STATE.tokenDecimals.set(t, d.success && wordsOf(d.ret)[0] !== undefined ? Number(wordsOf(d.ret)[0]) : 18);
        if (s.success) STATE.tokenSymbols.set(t, decodeString(s.ret));
    }
}

// ============================================ [FIX-8] USD scoring (exact) ====
const getDecimals = (t) => { const d = STATE.tokenDecimals.get(lower(t)); return d === undefined || !Number.isFinite(d) || d < 0 ? 18 : d; };
function normalizeReserve(r, dec) {
    if (dec === 18) return r;
    if (dec < 18) return r * 10n ** BigInt(18 - dec);
    return r / 10n ** BigInt(dec - 18);
}
function integerSqrt(x) {
    if (x <= 0n) return 0n; if (x < 4n) return 1n;
    let z = x, y = (x + 1n) / 2n;
    while (y < z) { z = y; y = (x / y + y) / 2n; }
    return z;
}
function computeUsdPrices() {
    const prices = new Map();
    for (const s of STABLECOINS) prices.set(lower(s), E18);
    const best = new Map();
    for (const p of STATE.v2Pairs.values()) {
        if (p.reserve0 === 0n || p.reserve1 === 0n) continue;
        const p0 = prices.get(p.token0), p1 = prices.get(p.token1);
        if ((p0 === undefined) === (p1 === undefined)) continue;
        const n0 = normalizeReserve(p.reserve0, getDecimals(p.token0));
        const n1 = normalizeReserve(p.reserve1, getDecimals(p.token1));
        if (n0 === 0n || n1 === 0n) continue;
        let token, price, liq;
        if (p0 !== undefined) { price = (p0 * n0) / n1; liq = (2n * n0 * p0) / E18; token = p.token1; }
        else { price = (p1 * n1) / n0; liq = (2n * n1 * p1) / E18; token = p.token0; }
        if (price === 0n) continue;
        const cur = best.get(token);
        if (!cur || liq > cur.liq) best.set(token, { price, liq });
    }
    for (const [k, c] of best) prices.set(k, c.price);
    return prices;
}
function pairLiquidityScoreUsd(p, prices) {
    const p0 = prices.get(p.token0), p1 = prices.get(p.token1);
    if (p0 === undefined || p1 === undefined) return 0n;
    const v0 = (normalizeReserve(p.reserve0, getDecimals(p.token0)) * p0) / E18;
    const v1 = (normalizeReserve(p.reserve1, getDecimals(p.token1)) * p1) / E18;
    if (v0 === 0n || v1 === 0n) return 0n;
    return 2n * integerSqrt(v0 * v1);
}
function buildLiquidityGraph() {
    const graph = new Map(), edges = [];
    const prices = computeUsdPrices();
    for (const p of STATE.v2Pairs.values()) {
        if (p.reserve0 === 0n || p.reserve1 === 0n) continue;
        const score = pairLiquidityScoreUsd(p, prices);
        if (score === 0n) continue;
        edges.push({ token0: p.token0, token1: p.token1, score, type: "v2", fee: 0, key: p.pair });
    }
    for (const p of STATE.v3Pools.values()) {
        if (!p.liquidity) continue;
        const p0 = prices.get(p.token0), p1 = prices.get(p.token1);
        if (p0 === undefined || p1 === undefined) continue;
        const score = (p.liquidity * ((p0 + p1) / 2n)) / E18;
        if (score === 0n) continue;
        edges.push({ token0: p.token0, token1: p.token1, score, type: "v3", fee: p.fee, key: p.pool });
    }
    const tokenEdges = new Map();
    for (const e of edges) for (const t of [e.token0, e.token1]) {
        if (!tokenEdges.has(t)) tokenEdges.set(t, []);
        tokenEdges.get(t).push(e);
    }
    for (const [k, list] of tokenEdges) {
        list.sort((a, b) => (a.score > b.score ? -1 : 1));
        graph.set(k, list.slice(0, TOP_PAIRS_PER_TOKEN));
    }
    STATE.graph = graph;
    return { edges: edges.length, priced: prices.size, prices };
}

// ============================================ findCandidateCycles (exact) ====
function findCandidateCycles(startAsset, maxHops) {
    const start = lower(startAsset), cycles = [], graph = STATE.graph;
    function dfs(current, path, visited, depth) {
        if (depth >= 2 && lower(current) === start) { cycles.push([...path]); return; }
        if (depth >= maxHops) return;
        for (const edge of graph.get(lower(current)) || []) {
            const outToken = lower(edge.token0) === lower(current) ? edge.token1 : edge.token0;
            const next = lower(outToken);
            if (visited.has(next) && next !== start) continue;
            visited.add(next);
            path.push({ tokenIn: current, tokenOut: outToken, ...edge });
            dfs(outToken, path, visited, depth + 1);
            path.pop();
            visited.delete(next);
        }
    }
    dfs(startAsset, [], new Set([start]), 0);
    return cycles.slice(0, MAX_CANDIDATE_CYCLES);
}

// ============================================== reserveCycleQuote (exact) ====
function quoteV2Reserve(amountIn, rIn, rOut, feeBps) {
    if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
    const feeMul = BPS - feeBps;
    const den = rIn * BPS + amountIn * feeMul;
    return den === 0n ? 0n : (amountIn * feeMul * rOut) / den;
}
function reserveCycleQuote(amountIn, cycle) {
    let cur = amountIn;
    for (const edge of cycle) {
        if (edge.type !== "v2") return -1n;
        const p = STATE.v2Pairs.get(edge.key);
        if (!p) return 0n;
        const isT0 = lower(edge.tokenIn) === p.token0;
        const rIn = isT0 ? p.reserve0 : p.reserve1, rOut = isT0 ? p.reserve1 : p.reserve0;
        const out = quoteV2Reserve(cur, rIn, rOut, V2_RESERVE_FEE_BPS);
        if (out === 0n) return 0n;
        const spotNum = rOut * cur, execNum = out * rIn;
        if (spotNum > 0n && ((spotNum - execNum) * BPS) / spotNum > PRICE_IMPACT_BPS) return 0n;
        cur = out;
    }
    return cur;
}

// =============================================== batchQuoteCycles (exact) ====
function v3QuoteData(tokenIn, tokenOut, fee, amountIn) {
    return MODE === "fixed"
        ? SEL.quoteV2Struct + aw(tokenIn) + aw(tokenOut) + word(amountIn) + word(fee) + word(0)
        : SEL.quoteV1Style + aw(tokenIn) + aw(tokenOut) + word(fee) + word(amountIn) + word(0); // keeper's V3_QUOTER_ABI
}
async function batchQuoteCycles(cycles, amountIn, tag) {
    const states = cycles.map((cycle) => ({ cycle, current: amountIn, valid: true, hops: new Array(cycle.length).fill(null) }));
    const maxLen = Math.max(0, ...cycles.map((c) => c.length));
    for (let round = 0; round < maxLen; round++) {
        const calls = [], meta = [];
        states.forEach((st, c) => {
            if (!st.valid || round >= st.cycle.length) return;
            const e = st.cycle[round];
            if (e.type === "v2") for (const r of V2_ROUTERS) {
                calls.push({ target: r, data: SEL.getAmountsOut + word(st.current) + word(64) + word(2) + aw(e.tokenIn) + aw(e.tokenOut) });
                meta.push({ c, type: "v2", router: r });
            } else for (const p of V3_PAIRS) {
                calls.push({ target: p.quoter, data: v3QuoteData(e.tokenIn, e.tokenOut, e.fee, st.current) });
                meta.push({ c, type: "v3", router: p.router });
            }
        });
        if (!calls.length) break;
        const results = await multicall(calls, tag);
        const roundBest = new Map();
        results.forEach((res, i) => {
            if (!res.success) return;
            const m = meta[i], w = wordsOf(res.ret);
            let out = 0n;
            if (m.type === "v2") { if (w.length >= 4) out = w[2 + Number(w[1]) - 1]; }
            else out = w[0] ?? 0n;
            if (out <= 0n) return;
            const cur = roundBest.get(m.c);
            if (!cur || out > cur.bestOut) roundBest.set(m.c, { bestOut: out, bestRouter: m.router, type: m.type, fee: states[m.c].cycle[round].fee });
        });
        states.forEach((st, c) => {
            if (!st.valid || round >= st.cycle.length) return;
            const best = roundBest.get(c);
            if (!best) { st.valid = false; return; }
            st.hops[round] = best;
            st.current = best.bestOut;
        });
    }
    return states.map((st) => (st.valid && st.hops.every((h) => h && h.bestOut > 0n)
        ? { cycle: st.cycle, hops: st.hops.map((h, i) => ({ ...h, tokenIn: st.cycle[i].tokenIn, tokenOut: st.cycle[i].tokenOut, quoteOut: h.bestOut })), finalAmount: st.current }
        : null));
}

// ======================================= slippage + economics (exact) ====
function buildMinOutHops(quotedHops, totalSlippageBps) {
    const n = quotedHops.length;
    const hopRatio = Math.pow((10000 - totalSlippageBps) / 10000, 1 / n);
    const multiplier = 10000n - BigInt(Math.ceil((1 - hopRatio) * 10000));
    return quotedHops.map((h) => ({ ...h, minOut: (h.quoteOut * multiplier) / 10000n }));
}
function calcEconomics({ amountIn, worstCaseFinal, premiumBps, gasCostAsset }) {
    const premium = (amountIn * premiumBps) / BPS;
    const worstGross = worstCaseFinal > amountIn ? worstCaseFinal - amountIn : 0n;
    const afterAave = worstGross > premium ? worstGross - premium : 0n;
    const afterGas = afterAave > gasCostAsset ? afterAave - gasCostAsset : 0n;
    const profitBps = amountIn > 0n ? Number((afterGas * BPS) / amountIn) : 0;
    return { premium, worstGross, afterAave, afterGas, profitBps };
}

// ===================================================== per-block eval ====
let premiumBps = 5n;
let lastPassing = new Map(); // cycleKey -> afterGas at previous block
const cycleKey = (c) => c.map((e) => e.key + ":" + lower(e.tokenIn)).join(">");
const routeName = (c) => [sym(c[0].tokenIn), ...c.map((e) => `${e.type === "v3" ? "v3/" + e.fee : "v2"}->${sym(e.tokenOut)}`)].join(" ");
const usd = (raw) => Number(raw) / 1e6;
const signed = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(2);

async function getFeeData(tag) {
    const [block, prio] = await rpcBatch([["eth_getBlockByNumber", [tag, false]], ["eth_maxPriorityFeePerGas", []]]);
    let maxPriority = prio ? BigInt(prio) : 1000000000n;           // ethers v6 falls back to 1 gwei
    if (maxPriority === 0n) maxPriority = 2000000000n;             // keeper fallback
    const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
    return { maxFeePerGas: baseFee * 2n + maxPriority, baseFee };
}

async function evaluateBlock(bn) {
    const tag = "0x" + bn.toString(16);
    await refreshState(tag);
    const g = buildLiquidityGraph();
    const cycles = findCandidateCycles(FLASH_ASSET, CFG.maxHops);
    const fee = await getFeeData(tag);
    STATS.blocks++;
    const t = new Date().toISOString().slice(11, 19);
    if (!cycles.length) {
        STATS.emptyGraphBlocks++;
        console.log(`${t} block ${bn} | graph: ${g.edges} usable pools, ${g.priced} priced tokens | 0 candidate cycles -> keeper has nothing to evaluate (idle)`);
        lastPassing = new Map();
        return;
    }
    STATS.cyclesTotal += cycles.length;
    const amountIn = CFG.flashAmount;

    // 1. reserve pre-screen
    const live = [];
    for (const c of cycles) { if (reserveCycleQuote(amountIn, c) === 0n) drop("priceImpact"); else live.push(c); }
    // 3. router quotes
    const quotes = await batchQuoteCycles(live, amountIn, tag);
    // 8. gas in flash asset, per distinct gas limit (getGasCostInAsset via V2_ROUTERS[0])
    const gasOf = (c) => {
        const est = GAS.base + c.reduce((s, e) => s + (e.type === "v3" ? GAS.v3 : GAS.v2), 0n);
        return (est * CFG.gasSafetyBps) / 10000n;
    };
    const limits = [...new Set(quotes.filter(Boolean).map((q) => gasOf(q.cycle)))];
    const gasRes = await multicall(limits.map((l) => ({ target: V2_ROUTERS[0],
        data: SEL.getAmountsOut + word(l * fee.maxFeePerGas) + word(64) + word(2) + aw(A.WETH) + aw(FLASH_ASSET) })), tag);
    const gasAsset = new Map(limits.map((l, i) => {
        const w = gasRes[i]?.success ? wordsOf(gasRes[i].ret) : [];
        return [l, w.length >= 4 ? w[3] : null];
    }));

    let best = null, nearMiss = null;
    const passing = new Map();
    quotes.forEach((q, i) => {
        if (!q) { drop("quoteGone"); return; }
        const c = live[i];
        const minHops = buildMinOutHops(q.hops, CFG.slippageBps);
        const worstCaseFinal = minHops[minHops.length - 1].minOut;
        const safe = gasOf(c);
        const gasCost = gasAsset.get(safe);
        const premium = (amountIn * premiumBps) / BPS;
        // signed near-miss metric for reporting: worst-case result after Aave fee and gas, in bps of the loan
        const signedNet = gasCost == null ? null : Number(worstCaseFinal - amountIn - premium - gasCost);
        const signedBps = signedNet == null ? -Infinity : (signedNet / Number(amountIn)) * 1e4;
        if (!nearMiss || signedBps > nearMiss.bps) nearMiss = { bps: signedBps, net: signedNet, c, final: q.finalAmount };
        if (signedBps > STATS.bestBps) { STATS.bestBps = signedBps; STATS.bestDesc = `block ${bn}: ${routeName(c)}`; }

        // estimateGas stand-in: the contract reverts unless final >= loan + premium + loan*minProfitBps
        const required = amountIn + premium + (amountIn * CFG.contractMinProfitBps) / BPS;
        if (q.finalAmount < required) { drop("gasEstimateFail(contract would revert)"); return; }
        if (safe > CFG.gasLimitCeiling) { drop("gasEstimateFail(ceiling)"); return; }
        if (gasCost == null) { drop("gasConversionUnknown"); return; }
        const econ = calcEconomics({ amountIn, worstCaseFinal, premiumBps, gasCostAsset: gasCost });
        if (Number((gasCost * BPS) / amountIn) > CFG.maxGasBpsOfTrade) { drop("gasTooHigh"); return; }
        if (econ.profitBps < CFG.minProfitBps) { drop("profitTooLow"); return; }
        STATS.wouldSubmit++;
        passing.set(cycleKey(c), econ.afterGas);
        if (!best || econ.afterGas > best.econ.afterGas) best = { c, econ };
    });

    // re-check: which of last block's passing cycles still pass now (earliest the bot could land)
    let survivedNow = 0, bestSurvivor = 0n;
    for (const [k] of lastPassing) if (passing.has(k)) { survivedNow++; if (passing.get(k) > bestSurvivor) bestSurvivor = passing.get(k); }
    if (survivedNow) { STATS.survived++; STATS.survivedNet += bestSurvivor; } // counted per block, like WOULD SUBMIT
    if (lastPassing.size) console.log(`    re-check: ${survivedNow}/${lastPassing.size} of last block's opportunities still pass at block ${bn}`);
    lastPassing = passing;

    const ethQ = g.prices.get(A.WETH);
    const ethUsd = ethQ ? Number(ethQ / 10n ** 14n) / 1e4 : 0;
    const gasUsd2hop = Number(gasAsset.get(gasOf([{ type: "v2" }, { type: "v2" }])) ?? 0n) / 1e6;
    let line = `${t} block ${bn} | ETH $${ethUsd.toFixed(0)} | maxFee ${(Number(fee.maxFeePerGas) / 1e9).toFixed(2)} gwei` +
        (gasUsd2hop ? ` (≈$${gasUsd2hop.toFixed(2)}/2-hop)` : "") + ` | ${cycles.length} cycles, ${quotes.filter(Boolean).length} quoted | `;
    if (best) {
        STATS.blocksWithOpp++; STATS.paperNet += best.econ.afterGas;
        line += `WOULD SUBMIT: ${routeName(best.c)} profit ${best.econ.profitBps} bps = +$${usd(best.econ.afterGas).toFixed(2)}`;
    } else if (nearMiss) {
        line += `best: ${routeName(nearMiss.c)} ${nearMiss.bps.toFixed(1)} bps (${signed((nearMiss.net ?? 0) / 1e6)}), needs +${CFG.minProfitBps} -> rejected`;
    }
    console.log(line);
    if (nearMiss) fs.appendFileSync(LOG_FILE, [bn, `"${routeName((best || nearMiss).c)}"`, best ? "WOULD_SUBMIT" : "rejected",
        (best ? best.econ.profitBps : nearMiss.bps.toFixed(2)), usd(nearMiss.final).toFixed(2), cycles.length].join(",") + "\n");
}

// ===================================================== startup checks ====
async function compatibilityChecks() {
    const [quoterCode, router02Code, routerV1Code] = await rpcBatch([
        ["eth_getCode", [A.QUOTER_V2, "latest"]], ["eth_getCode", [A.SWAP_ROUTER02, "latest"]], ["eth_getCode", [A.SWAP_ROUTER_V1, "latest"]]]);
    const has = (code, sel) => (code || "").toLowerCase().includes("63" + strip(sel));
    console.log("Compatibility checks against the real Uniswap V3 contracts (function selectors in deployed bytecode):");
    console.log(`  QuoterV2 supports the keeper's V3 quote call (${SEL.quoteV1Style})?      ${has(quoterCode, SEL.quoteV1Style) ? "YES" : "NO  -> every V3 quote in the original keeper fails"}`);
    console.log(`  QuoterV2 supports the correct struct call (${SEL.quoteV2Struct})?         ${has(quoterCode, SEL.quoteV2Struct) ? "YES" : "NO"}`);
    console.log(`  SwapRouter02 (keeper default) supports the contract's V3 swap (${SEL.swapV1Struct})? ${has(router02Code, SEL.swapV1Struct) ? "YES" : "NO  -> the contract's V3 hops would revert"}`);
    console.log(`  SwapRouter V1 supports the contract's V3 swap (${SEL.swapV1Struct})?           ${has(routerV1Code, SEL.swapV1Struct) ? "YES (used in --mode fixed)" : "NO"}`);
}

function summary() {
    const h = (STATS.blocks * 12) / 3600;
    console.log("\n" + "=".repeat(86));
    console.log(`SUMMARY — keeper replica, mode=${MODE}${USE_V3 ? " (+V3)" : ""}, ${STATS.blocks} live blocks (~${h.toFixed(1)} h)`);
    console.log(`  Pools known: ${STATE.v2Pairs.size} V2, ${STATE.v3Pools.size} V3 | tokens: ${STATE.tokens.size}`);
    console.log(`  Blocks with ZERO candidate cycles (bot idle): ${STATS.emptyGraphBlocks}`);
    console.log(`  Cycles evaluated: ${STATS.cyclesTotal} | rejection reasons: ${JSON.stringify(STATS.drops)}`);
    console.log(`  Best worst-case result seen (after Aave + gas): ${Number.isFinite(STATS.bestBps) ? STATS.bestBps.toFixed(1) + " bps" : "n/a"}  — keeper needs >= +${CFG.minProfitBps} bps`);
    console.log(`     ${STATS.bestDesc}`);
    console.log(`  Blocks where the keeper WOULD SUBMIT: ${STATS.blocksWithOpp} (paper total +$${usd(STATS.paperNet).toFixed(2)})`);
    console.log(`  Blocks where last block's opportunity was STILL valid (earliest the bot could land): ${STATS.survived} (+$${usd(STATS.survivedNet).toFixed(2)})`);
    console.log(`  RPC/multicall errors: ${STATS.rpcErrors}. Per-block log: ${LOG_FILE}`);
    console.log("  Not modelled (would only reduce results further): other bots, builder fees, stale quotes.");
    console.log("=".repeat(86));
}

// =============================================================== main ====
async function main() {
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x1") throw new Error(`Expected Ethereum mainnet (0x1), got ${chainId}`);
    const prem = await rpc("eth_call", [{ to: A.AAVE_POOL, data: SEL.premium }, "latest"]);
    if (prem && prem.length >= 66) premiumBps = BigInt(prem);
    const latest = Number(BigInt(await rpc("eth_blockNumber", [])));

    console.log(`Keeper replica (read-only) — mode=${MODE}${USE_V3 ? " +V3" : ""} | flash ${usd(CFG.flashAmount)} USDC | maxHops ${CFG.maxHops} | ` +
        `slippage ${CFG.slippageBps} bps | minProfit ${CFG.minProfitBps} bps | Aave premium ${premiumBps} bps (live)\n`);
    await compatibilityChecks();

    for (const t of BOOTSTRAP_TOKENS) addToken(t);
    addToken(FLASH_ASSET);
    console.log(`\nDiscovering pools like the keeper: creation logs of ${V2_FACTORIES.length + V3_FACTORIES.length} factories, blocks ${latest - BOOT_LOOKBACK}..${latest} ...`);
    await discoverFromLogs(latest);
    console.log(`  found ${STATE.v2Pairs.size} V2 pairs and ${STATE.v3Pools.size} V3 pools created in the last ${BOOT_LOOKBACK} blocks`);
    if (MODE === "fixed") {
        await discoverMajors("latest");
        console.log(`  + major pools (USDC/USDT/DAI/WETH/WBTC): now ${STATE.v2Pairs.size} V2 pairs, ${STATE.v3Pools.size} V3 pools`);
    }
    await refreshState("latest");
    const g = buildLiquidityGraph();
    const c0 = findCandidateCycles(FLASH_ASSET, CFG.maxHops);
    console.log(`  graph: ${g.edges} usable pools, ${g.priced} USD-priced tokens, ${c0.length} candidate cycles from USDC`);
    c0.slice(0, 5).forEach((c) => console.log(`    e.g. ${routeName(c)}`));
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "block,route,result,profit_bps,quoted_final_usdc,cycles\n");
    console.log(`\nRunning ${MINUTES} min. Ctrl+C for the summary.\n`);

    process.on("SIGINT", () => { summary(); process.exit(0); });
    const end = Date.now() + MINUTES * 60000;
    let last = 0;
    while (Date.now() < end) {
        try {
            const bn = Number(BigInt(await rpc("eth_blockNumber", [])));
            if (bn > last) {
                if (last && bn > last + 1) lastPassing = new Map();
                last = bn;
                await evaluateBlock(bn);
            }
        } catch (e) { console.error("  error:", e.message); }
        await new Promise((r) => setTimeout(r, 1000));
    }
    summary();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
/*
 * Realistic-market Monte-Carlo test for ArbitrageExecutor v3.3 (Code.txt).
 *
 * Zero dependencies. Reproduces, in plain JS:
 *   - the CONTRACT rules: Aave flash premium (5 bps), Uniswap-V2 swap math
 *     (amountIn*997/1000), the final invariant
 *       endingBalance >= loan + premium + loan*minProfitBps/10000   (default 50 bps)
 *   - the KEEPER rules: fixed FLASH_AMOUNT (20,000 USDC per the HOW TO RUN
 *     section), newHeads-driven (it reacts to the state AFTER a block, it does
 *     not watch the mempool), 1% per-hop price-impact guard, net-after-gas > 0.
 *
 * Market model (per 12 s block, 30 days by default):
 *   - a "real" reference price (CEX) moving like ETH (60% annual volatility);
 *   - 3 WETH/USDC pools: Uniswap V2, SushiSwap, Uniswap V3 0.05% (modelled as an
 *     in-range V3 position = V2 curve with deep virtual reserves);
 *   - random retail swaps (heavy-tailed sizes, incl. occasional whales) sized to
 *     match approximate daily volumes;
 *   - professional searchers who back-run every swap in the same block and keep
 *     each pool within (pool fee + 2 bps) of the reference price — this is what
 *     happens on mainnet today.
 *
 * Pool sizes / volumes are approximations of mainnet magnitudes, NOT live data
 * (the sandbox has no network). All of them are CLI-overridable.
 *
 * Usage: node sim/realistic_market_sim.js [--days 30] [--seeds 5] [--price 2500]
 */

// ---------------------------------------------------------------- config ----
const argv = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => {
        if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
        return acc;
    }, [])
);
const num = (k, d) => (argv[k] !== undefined ? Number(argv[k]) : d);

const CFG = {
    days: num("days", 30),
    seeds: num("seeds", 5),
    price0: num("price", 2500),          // ETH/USD start price
    annualVol: num("vol", 0.60),
    blockSec: 12,
    // pools: WETH side, fee bps, daily USD volume
    pools: [
        { name: "UniV2",   weth: num("univ2Weth", 4000),   feeBps: 30, dailyVol: num("univ2Vol", 8e6) },
        { name: "Sushi",   weth: num("sushiWeth", 1000),   feeBps: 30, dailyVol: num("sushiVol", 1.5e6) },
        { name: "UniV3_5", weth: num("univ3Weth", 200000), feeBps: 5,  dailyVol: num("univ3Vol", 5e8) },
    ],
    retailMedianUsd: 1500,
    retailSigma: 1.5,                    // lognormal -> mean ~$4.6k, long whale tail
    retailCapUsd: 3e6,
    proCostBps: 2,                       // pros' own cost (CEX fee etc.)
    // contract / keeper
    aavePremiumBps: 5,
    minProfitBps: 50,                    // contract default `minProfitBps = 50`
    flashUsdc: 20000,                    // keeper FLASH_AMOUNT from HOW TO RUN
    maxImpactBps: 100,                   // keeper FIX-7 guard
    gasUnits: 400000,                    // file reports ~350k-472k
    gasMedianGwei: num("gwei", 1.5),
    gasSigma: 0.7,
};
const BLOCKS_PER_DAY = 86400 / CFG.blockSec;
const SIGMA_BLOCK = CFG.annualVol / Math.sqrt(365 * BLOCKS_PER_DAY);

// ------------------------------------------------------------------- rng ----
function rng(seed) {
    let a = seed >>> 0;
    const u = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
    const poisson = (l) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= u(); } while (p > L); return k - 1; };
    return { u, normal, poisson };
}

// ------------------------------------------------------------------ pool ----
class Pool {
    constructor({ name, weth, feeBps, dailyVol }, price) {
        Object.assign(this, { name, feeBps, dailyVol });
        this.x = weth;             // WETH reserve
        this.y = weth * price;     // USDC reserve
        this.f = 1 - feeBps / 1e4; // 997/1000 for V2
    }
    price() { return this.y / this.x; }
    qUsdcToWeth(a) { const ai = a * this.f; return (this.x * ai) / (this.y + ai); }
    qWethToUsdc(a) { const ai = a * this.f; return (this.y * ai) / (this.x + ai); }
    swapUsdcIn(a) { const o = this.qUsdcToWeth(a); this.y += a; this.x -= o; return o; }
    swapWethIn(a) { const o = this.qWethToUsdc(a); this.x += a; this.y -= o; return o; }
    setPrice(p) { const k = this.x * this.y; this.x = Math.sqrt(k / p); this.y = Math.sqrt(k * p); }
    clone() { const c = Object.create(Pool.prototype); return Object.assign(c, this); }
}

// Pros: back-run anything outside (fee + proCost) of the reference price.
function prosCleanup(pools, ref) {
    for (const p of pools) {
        const band = (p.feeBps + CFG.proCostBps) / 1e4;
        const pr = p.price();
        if (pr > ref * (1 + band)) p.setPrice(ref * (1 + band));
        else if (pr < ref * (1 - band)) p.setPrice(ref * (1 - band));
    }
}

// --------------------------------------------- contract + keeper economics ----
// Cycle: flash USDC -> buy WETH on A -> sell WETH on B -> repay Aave.
function evalCycle(A, B, L, gasUsd, minProfitBps, impactGuard = true) {
    const w = A.qUsdcToWeth(L);
    const out = B.qWethToUsdc(w);
    // keeper FIX-7: per-hop price impact (spot vs execution) <= 1%
    const imp1 = 1 - (w / L) / ((1 / A.price()) * A.f);
    const imp2 = 1 - (out / w) / (B.price() * B.f);
    if (impactGuard && (imp1 > CFG.maxImpactBps / 1e4 || imp2 > CFG.maxImpactBps / 1e4)) return null;
    const premium = (L * CFG.aavePremiumBps) / 1e4;
    // contract invariant (_approveRepaymentAndGetProfit)
    if (out < L + premium + (L * minProfitBps) / 1e4) return null;
    const profit = out - L - premium;          // what the contract keeps
    const net = profit - gasUsd;               // keeper gate: after gas
    if (net <= 0) return null;
    return { A, B, L, profit, net };
}

const SIZE_GRID = Array.from({ length: 48 }, (_, i) => 1000 * Math.pow(10, i / 12)); // $1k..~$9M

function bestOpportunity(pools, gasUsd, { minProfitBps, fixedSize }) {
    let best = null;
    for (const A of pools) for (const B of pools) {
        if (A === B) continue;
        // cheap exact pre-filter: marginal return at size->0
        const marginal = A.f * B.f * (B.price() / A.price());
        if (marginal <= 1 + (CFG.aavePremiumBps + minProfitBps) / 1e4) continue;
        const sizes = fixedSize ? [fixedSize] : SIZE_GRID;
        for (const L of sizes) {
            const r = evalCycle(A, B, L, gasUsd, minProfitBps);
            if (r && (!best || r.net > best.net)) best = r;
        }
    }
    return best;
}

function executeCycle(o) { const w = o.A.swapUsdcIn(o.L); o.B.swapWethIn(w); }

// ------------------------------------------------------------- scenarios ----
/*
 * mode "keeper": the bot as written. Sees state only after each block
 *                (newHeads), pros have already back-run in-block.
 * mode "backrun": generous upgrade — bot sees every swap instantly (mempool)
 *                and competes with pros for the back-run.
 */
function runMarket(seed, sc) {
    const R = rng(seed);
    let ref = CFG.price0;
    const pools = CFG.pools.map((p) => new Pool(p, ref));
    const lambda = pools.map((p) => p.dailyVol / BLOCKS_PER_DAY /
        (CFG.retailMedianUsd * Math.exp(CFG.retailSigma ** 2 / 2)));
    const s = { opps: 0, won: 0, gross: 0, bribes: 0, gas: 0, net: 0, best: 0, swaps: 0 };
    const blocks = CFG.days * BLOCKS_PER_DAY;

    const tryBot = (gasUsd) => {
        const o = bestOpportunity(pools, gasUsd, sc);
        if (!o) return;
        s.opps++;
        if (R.u() >= sc.pWin) return;                 // another searcher got it
        const bribe = o.profit * sc.bribe;           // builder auction payment
        const net = o.profit - bribe - gasUsd;
        executeCycle(o);
        s.won++; s.gross += o.profit; s.bribes += bribe; s.gas += gasUsd; s.net += net;
        s.best = Math.max(s.best, net);
    };

    for (let b = 0; b < blocks; b++) {
        ref *= Math.exp(SIGMA_BLOCK * R.normal() - SIGMA_BLOCK ** 2 / 2);
        const gasUsd = CFG.gasUnits * CFG.gasMedianGwei * Math.exp(CFG.gasSigma * R.normal()) * 1e-9 * ref;
        if (sc.pros) prosCleanup(pools, ref);         // top-of-block CEX-DEX arb

        pools.forEach((p, i) => {
            const n = R.poisson(lambda[i]);
            for (let k = 0; k < n; k++) {
                s.swaps++;
                const usd = Math.min(CFG.retailCapUsd, CFG.retailMedianUsd * Math.exp(CFG.retailSigma * R.normal()));
                if (R.u() < 0.5) p.swapUsdcIn(usd); else p.swapWethIn(usd / ref);
                if (sc.mode === "backrun") tryBot(gasUsd);
                if (sc.pros) prosCleanup(pools, ref);   // in-block back-run by pros
            }
        });
        if (sc.mode === "keeper") tryBot(gasUsd);      // newHeads: end-of-block state
        if (!sc.pros) {                                // keep a no-pros world anchored
            for (const p of pools) if (Math.abs(p.price() / ref - 1) > 0.05) p.setPrice(ref);
        }
    }
    return s;
}

// The file's own "proof": dump N WETH into Uni V2, then flash-arb Uni->Sushi.
function whaleProof(wethDump, flash, withPros) {
    const ref = CFG.price0;
    const [uni, sushi] = CFG.pools.slice(0, 2).map((p) => new Pool(p, ref));
    uni.swapWethIn(wethDump);
    if (withPros) prosCleanup([uni, sushi], ref);
    const gasUsd = CFG.gasUnits * CFG.gasMedianGwei * 1e-9 * ref;
    const r = evalCycle(uni, sushi, flash, gasUsd, CFG.minProfitBps, false); // fork test calls the contract directly (no keeper guard)
    const w = uni.qUsdcToWeth(flash), raw = sushi.qWethToUsdc(w) - flash;
    return { raw, accepted: !!r, net: r ? r.net : 0 };
}

// ----------------------------------------------------------------- report ----
const usd = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

console.log("=".repeat(78));
console.log("ArbitrageExecutor v3.3 — realistic-market simulation (offline, approximate data)");
console.log("=".repeat(78));
console.log(`ETH start $${CFG.price0}, vol ${CFG.annualVol * 100}%/yr, gas ~${CFG.gasMedianGwei} gwei x ${CFG.gasUnits / 1000}k`);
for (const p of CFG.pools) console.log(`  ${p.name.padEnd(8)} ${p.weth.toLocaleString()} WETH/side, fee ${p.feeBps} bps, ~${usd(p.dailyVol)}/day volume`);
console.log(`Contract: Aave ${CFG.aavePremiumBps} bps, minProfitBps ${CFG.minProfitBps}. Keeper: flash ${usd(CFG.flashUsdc)}, impact <= 1%`);

console.log("\n[1] The file's own 'proof' (whale dump into Uni V2, flash 20k USDC):");
for (const [dump, flash] of [[100, 2000], [1000, 20000], [5000, 50000]]) {
    const a = whaleProof(dump, flash, false), b = whaleProof(dump, flash, true);
    console.log(`  whale ${String(dump).padStart(5)} WETH, flash ${usd(flash).padStart(7)}: ` +
        `no other bots -> raw ${usd(a.raw).padStart(8)}, ${a.accepted ? "ACCEPTED net " + usd(a.net) : "REJECTED"}` +
        ` | real world (bots back-run first) -> ${b.accepted ? "ACCEPTED net " + usd(b.net) : "REJECTED (gap already closed)"}`);
}

const SCENARIOS = [
    { id: "A", label: "Bot as written (newHeads, fixed 20k), real competition", mode: "keeper", pros: true, pWin: 0.05, bribe: 0.9, minProfitBps: 50, fixedSize: CFG.flashUsdc },
    { id: "B", label: "Same, but bot ALWAYS wins & pays no bribe", mode: "keeper", pros: true, pWin: 1, bribe: 0, minProfitBps: 50, fixedSize: CFG.flashUsdc },
    { id: "C", label: "Upgraded: sees mempool, optimal size, minProfit 50bps, always wins, no bribe", mode: "backrun", pros: true, pWin: 1, bribe: 0, minProfitBps: 50 },
    { id: "D", label: "Upgraded + minProfit 0 (contract changed), always wins, no bribe", mode: "backrun", pros: true, pWin: 1, bribe: 0, minProfitBps: 0 },
    { id: "E1", label: "Upgraded + minProfit 0, wins 1 in 100, pays 90% bribe", mode: "backrun", pros: true, pWin: 0.01, bribe: 0.9, minProfitBps: 0 },
    { id: "E2", label: "Upgraded + minProfit 0, wins 1 in 10, pays 90% bribe", mode: "backrun", pros: true, pWin: 0.1, bribe: 0.9, minProfitBps: 0 },
    { id: "E3", label: "Upgraded + minProfit 0, wins 1 in 3, pays 95% bribe", mode: "backrun", pros: true, pWin: 0.33, bribe: 0.95, minProfitBps: 0 },
    { id: "F", label: "Fantasy: NO other bots exist at all, bot as written", mode: "keeper", pros: false, pWin: 1, bribe: 0, minProfitBps: 50, fixedSize: CFG.flashUsdc },
];

console.log(`\n[2] Market simulation: ${CFG.days} days x ${CFG.seeds} random seeds (results = average per ${CFG.days} days)`);
console.log("-".repeat(78));
for (const sc of SCENARIOS) {
    const agg = { opps: 0, won: 0, gross: 0, bribes: 0, gas: 0, net: 0, best: 0, swaps: 0 };
    for (let k = 0; k < CFG.seeds; k++) {
        const r = runMarket(1000 + k, sc);
        for (const key of Object.keys(agg)) agg[key] = key === "best" ? Math.max(agg.best, r.best) : agg[key] + r[key];
    }
    const n = CFG.seeds;
    console.log(`${sc.id}) ${sc.label}`);
    console.log(`   retail swaps ${Math.round(agg.swaps / n).toLocaleString()} | opportunities passing contract rules ${(agg.opps / n).toFixed(1)}` +
        ` | trades won ${(agg.won / n).toFixed(1)}`);
    console.log(`   profit ${usd(agg.gross / n)} - bribes ${usd(agg.bribes / n)} - gas ${usd(agg.gas / n)} = NET ${usd(agg.net / n)}` +
        ` (best single trade ${usd(agg.best)})`);
}
console.log("-".repeat(78));
console.log("File claims for comparison: 847 trades, +$266,187 net in 30 days.");

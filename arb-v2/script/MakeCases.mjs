#!/usr/bin/env node
/*
 * MakeCases.mjs — turn arb_recon_clean.csv into test/replay/cases.json for the
 * Foundry fork backtester.
 *
 * For each profitable 2-pool arbitrage above a USD threshold, we re-read that
 * transaction's swap logs to reconstruct the exact route: the two pool addresses,
 * the start token, the direction of each hop, and the amount into hop 0. We also
 * carry the real on-chain profit so the fork test can compare.
 *
 * Read-only. Uses RPC_URL (your Alchemy Base URL). No wallet, no transactions.
 *
 * Usage:
 *   set RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   node script/MakeCases.mjs ../arb_recon_clean.csv --min-usd 5 --max 40 > test/replay/cases.json
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--"));
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const MIN_USD = Number(opt("min-usd", 5));
const MAX = Number(opt("max", 40));
if (!csvPath) { console.error("usage: node MakeCases.mjs <recon.csv> [--min-usd 5] [--max 40]"); process.exit(1); }
const RPCS = process.env.RPC_URL ? [process.env.RPC_URL]
    : ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

const T_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7" };

let reqId = 1, rpcIdx = 0;
async function post(body) {
    for (let i = 0; i < RPCS.length * 3; i++) {
        try {
            const r = await fetch(RPCS[rpcIdx % RPCS.length], { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error("HTTP " + r.status);
            return await r.json();
        } catch (e) { rpcIdx++; await new Promise((x) => setTimeout(x, 1000)); }
    }
    throw new Error("RPC failed; set RPC_URL");
}
const rpc = async (m, p) => (await post({ jsonrpc: "2.0", id: reqId++, method: m, params: p })).result;
const strip = (h) => (h || "").replace(/^0x/, "");
const addrOf = (t) => "0x" + strip(t).slice(24).toLowerCase();
const sint = (word) => { const v = BigInt("0x" + word); return v >= (1n << 255n) ? v - (1n << 256n) : v; };

async function poolTokens(pool) {
    const [t0, t1] = await Promise.all([
        rpc("eth_call", [{ to: pool, data: SEL.token0 }, "latest"]),
        rpc("eth_call", [{ to: pool, data: SEL.token1 }, "latest"]),
    ]);
    return { token0: addrOf(t0), token1: addrOf(t1) };
}

async function buildCase(row) {
    const [block, , , pools, cycle, token, profitUsd, flagged, , , txh] = row;
    if (flagged === "FLAGGED") return null;
    if (Number(pools) !== 2) return null;              // start with the clean 2-pool case
    if (!profitUsd || Number(profitUsd) < MIN_USD) return null;

    const rcpt = await rpc("eth_getTransactionReceipt", [txh]);
    if (!rcpt || !rcpt.logs) return null;
    // the two V3 swap logs, in execution order
    const swaps = rcpt.logs.filter((l) => l.topics[0] === T_V3 || l.topics[0] === T_V2);
    if (swaps.length !== 2) return null;               // keep it exact for now

    // decode each V3 swap: data = amount0,amount1,sqrtP,liq,tick (first two are int256)
    const hops = [];
    let startToken = null, amountIn = null;
    for (const s of swaps) {
        const pool = s.address.toLowerCase();
        const { token0, token1 } = await poolTokens(pool);
        if (s.topics[0] !== T_V3) return null;         // skip v2-mixed for the first cut
        const d = strip(s.data);
        const amount0 = sint(d.slice(0, 64));
        const amount1 = sint(d.slice(64, 128));
        // positive delta = token coming INTO the pool (what we pay); negative = out
        const zeroForOne = amount0 > 0n;
        const tokenIn = zeroForOne ? token0 : token1;
        const inAmt = zeroForOne ? amount0 : amount1;
        if (startToken === null) { startToken = tokenIn; amountIn = inAmt.toString(); }
        hops.push({ pool, zeroForOne, tokenIn });
    }
    return {
        block: Number(block), txHash: txh, startToken, amountIn,
        realProfitUsd: Number(profitUsd), cycle, hopsLen: hops.length, hops,
    };
}

async function main() {
    const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
    const rows = lines.map((l) => l.split(",")).sort((a, b) => Number(b[6] || 0) - Number(a[6] || 0));
    const cases = [];
    for (const r of rows) {
        if (cases.length >= MAX) break;
        try { const c = await buildCase(r); if (c) cases.push(c); } catch { /* skip */ }
    }
    // `count` is emitted flat so the Solidity test can read it without array-length cheats
    process.stdout.write(JSON.stringify({ chain: "base", count: cases.length, cases }, null, 2) + "\n");
    console.error(`Built ${cases.length} replay cases (2-pool V3, >= $${MIN_USD}).`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

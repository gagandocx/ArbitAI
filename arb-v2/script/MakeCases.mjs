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
    const swaps = rcpt.logs.filter((l) => l.topics[0] === T_V3);  // 2-pool V3 only, first cut
    if (swaps.length !== 2) return null;

    // Decode each swap into {pool, inToken, outToken, inAmt, zeroForOne}.
    // Positive amount = token flowing INTO the pool (what the trader pays);
    // negative = token flowing OUT (what the trader receives).
    const legs = [];
    for (const s of swaps) {
        const pool = s.address.toLowerCase();
        const { token0, token1 } = await poolTokens(pool);
        const d = strip(s.data);
        const amount0 = sint(d.slice(0, 64));
        const amount1 = sint(d.slice(64, 128));
        if (amount0 === 0n && amount1 === 0n) return null;
        const zeroForOne = amount0 > 0n;                 // token0 in, token1 out
        const inToken = zeroForOne ? token0 : token1;
        const outToken = zeroForOne ? token1 : token0;
        const inAmt = zeroForOne ? amount0 : -amount1 < 0n ? amount0 : amount0; // input is the positive one
        const inPos = amount0 > 0n ? amount0 : amount1;  // the positive (paid) amount
        legs.push({ pool, zeroForOne, inToken, outToken, inAmt: inPos });
    }

    // Verify it's a clean 2-pool cycle: the two legs must share both tokens
    // (A->B on one pool, B->A on the other).
    const sameCycle = (legs[0].outToken === legs[1].inToken && legs[1].outToken === legs[0].inToken);
    if (!sameCycle) return null;

    // The START token is the one the arbitrageur flash-borrows and profits in.
    // The recon CSV gives it: `token` (col 5) is the known symbol or raw address of
    // the net-positive token. Map known symbols back to addresses; else it's a 0x addr.
    const SYM2ADDR = {
        USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        WETH: "0x4200000000000000000000000000000000000006",
        USDT: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
        USDbC: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
        DAI: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
        cbBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    };
    let startToken = SYM2ADDR[token] || (token && token.startsWith("0x") ? token.toLowerCase() : null);
    // Fallback: if the CSV token isn't one of our pools' tokens, pick whichever of
    // the two cycle tokens matches; otherwise default to leg0's inToken.
    const cycleTokens = [legs[0].inToken, legs[0].outToken];
    if (!startToken || !cycleTokens.includes(startToken)) startToken = legs[0].inToken;

    // Order the hops so hop0 PAYS the start token.
    const first = legs[0].inToken === startToken ? legs[0] : legs[1];
    const second = first === legs[0] ? legs[1] : legs[0];
    const ordered = [first, second];

    const amountIn = ordered[0].inAmt.toString();
    const hops = ordered.map((l) => ({ pool: l.pool, zeroForOne: l.zeroForOne, tokenIn: l.inToken }));

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

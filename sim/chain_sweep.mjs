#!/usr/bin/env node
/*
 * CHAIN SWEEP — run arb_recon across several chains and print one comparison table.
 *
 * The question: which chain has the most TRUSTWORTHY, capturable arbitrage profit
 * (artifacts removed, 2-3 pool routes), per block? We scan each chain for a short
 * window and rank them. Whichever wins, we then go deep there.
 *
 * Read-only (delegates to arb_recon.mjs, which is read-only). No key custody/txs.
 *
 * Public RPCs rate-limit hard on full-block reads, so defaults are modest. For a
 * real comparison, give each chain its own RPC via env:
 *   BASE_RPC, ARBITRUM_RPC, OPTIMISM_RPC, POLYGON_RPC, BSC_RPC, ETHEREUM_RPC
 *
 * Usage:
 *   node sim/chain_sweep.mjs --blocks 200
 *   node sim/chain_sweep.mjs --chains base,arbitrum,polygon --blocks 300
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const BLOCKS = opt("blocks", "200");
const CHAINS = (opt("chains", "base,arbitrum,optimism,polygon,bsc") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ENV_RPC = {
    base: "BASE_RPC", arbitrum: "ARBITRUM_RPC", optimism: "OPTIMISM_RPC",
    polygon: "POLYGON_RPC", bsc: "BSC_RPC", ethereum: "ETHEREUM_RPC",
};

// parse a few numbers out of arb_recon's summary text
function parseSummary(out) {
    const g = (re) => { const m = out.match(re); return m ? m[1] : null; };
    return {
        blocks: g(/—\s*(\d+)\s*blocks scanned/),
        arbs: g(/CYCLIC ARBITRAGE transactions detected:\s*(\d+)/),
        perBlock: g(/≈\s*([\d.]+)\s*arbitrage txs per block/),
        trustedN: g(/TRUSTED profit[^\n]*?,\s*(\d+)\s*of/),
        trustedTotal: g(/total ~\$([\-\d.]+)/),
        trustedBest: g(/best ~\$([\-\d.]+)/),
        over5: g(/over \$5:\s*(\d+)/),
        over20: g(/over \$20:\s*(\d+)/),
        over100: g(/over \$100:\s*(\d+)/),
        flagged: g(/FLAGGED[^\n]*?:\s*(\d+)/),
        rpcErrors: g(/RPC errors:\s*(\d+)/),
    };
}

const rows = [];
for (const chain of CHAINS) {
    const rpc = process.env[ENV_RPC[chain]] || "";
    const env = { ...process.env };
    if (rpc) env.RPC_URL = rpc; else delete env.RPC_URL; // fall back to public
    console.error(`\n=== scanning ${chain} (${BLOCKS} blocks)${rpc ? " [custom RPC]" : " [public RPC]"} ===`);
    const r = spawnSync(process.execPath, ["sim/arb_recon.mjs", "--chain", chain, "--blocks", BLOCKS, "--log", `arb_recon_${chain}.csv`],
        { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || "") + (r.stderr || "");
    if (!/ARB RECON SUMMARY/.test(out)) {
        console.error(`  ${chain}: scan failed (likely rate-limited). Set ${ENV_RPC[chain]} to a private RPC.`);
        rows.push({ chain, failed: true });
        continue;
    }
    const s = parseSummary(out);
    rows.push({ chain, ...s });
    console.error(`  ${chain}: ${s.arbs} arbs, trusted total ~$${s.trustedTotal}, over$5=${s.over5}, over$20=${s.over20}`);
}

// comparison table
const pad = (v, n) => String(v ?? "-").padEnd(n);
const padL = (v, n) => String(v ?? "-").padStart(n);
console.log("\n" + "=".repeat(96));
console.log("CHAIN SWEEP — trustworthy arbitrage profit (artifacts removed), per scan window");
console.log("=".repeat(96));
console.log(`${pad("chain", 10)} ${padL("blocks", 7)} ${padL("arbs", 6)} ${padL("arb/blk", 8)} ${padL("trusted$", 10)} ${padL("best$", 9)} ${padL(">$5", 5)} ${padL(">$20", 5)} ${padL(">$100", 6)} ${padL("flagged", 8)}`);
for (const r of rows) {
    if (r.failed) { console.log(`${pad(r.chain, 10)} (scan failed — set a private RPC)`); continue; }
    console.log(`${pad(r.chain, 10)} ${padL(r.blocks, 7)} ${padL(r.arbs, 6)} ${padL(r.perBlock, 8)} ${padL(r.trustedTotal, 10)} ${padL(r.trustedBest, 9)} ${padL(r.over5, 5)} ${padL(r.over20, 5)} ${padL(r.over100, 6)} ${padL(r.flagged, 8)}`);
}
console.log("=".repeat(96));
console.log("Pick the chain with the most arbs/block AND the highest trusted$ + >$5/$20 counts.");
console.log("Then: node sim/arb_recon.mjs --chain <winner> --blocks 2000  (with a private RPC) to go deep.");
console.log("Per-chain CSVs written: arb_recon_<chain>.csv");

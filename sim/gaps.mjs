#!/usr/bin/env node
/*
 * GAP AGGREGATION (pure, research view) — turn the scoreboard into a ranked
 * top-gaps table for the research write-up.
 *
 * SAFETY: pure functions only. No I/O, no network, no key material, no transactions.
 * It reads a scoreboard object (produced by sim/scoreboard.mjs) and emits plain data
 * and a Markdown string. Formatting mirrors harness/make_report.mjs's fmt() style.
 */

// aggregateTopGaps(board, { limit }) -> ranked rows sorted by bestGap DESC, limited.
// PURE. Each row: { chain, pair, dexPair, bestGap, medianGap, timesSeen, lastSeen }.
// Ties on bestGap are broken by medianGap DESC then key ASC for determinism.
export function aggregateTopGaps(board, { limit = 20 } = {}) {
    const markets = board && board.markets ? board.markets : {};
    const rows = Object.values(markets).map((m) => ({
        chain: m.chain ?? null,
        pair: m.pair ?? null,
        dexPair: m.dexPair ?? null,
        bestGap: m.bestGap ?? 0,
        medianGap: m.medianGap ?? 0,
        timesSeen: m.timesChecked ?? 0,
        lastSeen: m.lastChecked ?? 0,
        key: m.key ?? "",
    }));
    rows.sort((a, b) => {
        if (b.bestGap !== a.bestGap) return b.bestGap - a.bestGap;
        if (b.medianGap !== a.medianGap) return b.medianGap - a.medianGap;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    const n = Math.max(0, Number(limit) || 0);
    return rows.slice(0, n).map(({ key, ...row }) => row); // drop the internal key from output
}

// fmt(n, dp) -> fixed-decimal string, mirroring harness/make_report.mjs. PURE.
function fmt(n, dp = 2) {
    if (n == null || !Number.isFinite(Number(n))) return "";
    return Number(n).toFixed(dp);
}

// renderTopGapsTable(rows) -> a Markdown table string. PURE.
// Columns: chain | pair | DEX pair | best gap | median gap | times seen | last seen.
// Gaps are rendered in bps (2dp). Pass the rows from aggregateTopGaps().
export function renderTopGapsTable(rows) {
    const L = [];
    L.push("| chain | pair | DEX pair | best gap (bps) | median gap (bps) | times seen | last seen |");
    L.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
    for (const r of rows || []) {
        L.push(
            `| ${r.chain ?? ""} | ${r.pair ?? ""} | ${r.dexPair ?? ""} | ` +
            `${fmt(r.bestGap)} | ${fmt(r.medianGap)} | ${r.timesSeen ?? 0} | ${r.lastSeen ?? 0} |`
        );
    }
    return L.join("\n");
}

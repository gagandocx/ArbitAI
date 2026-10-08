#!/usr/bin/env node
/*
 * search_once.mjs - ONE adaptive search cycle for the smarter autonomous search.
 *
 * This is the thin I/O glue (like write_run.mjs) over the pure FEAT-002 core and the
 * read-only scanner (sim/search_scan.mjs). Per cycle it:
 *   (1) loads the watchlist + registry and expands the concrete market list,
 *   (2) loads-or-inits the persistent scoreboard (harness/scoreboard.json),
 *   (3) picks this cycle's ADAPTIVE batch of markets via sim/scoreboard.mjs selectBatch
 *       (exploit top-ranked + explore least-recently/never-seen),
 *   (4) scans each selected market read-only (throttle + 429 backoff in search_scan),
 *   (5) updateScoreboard with every observation and persists the board back to disk,
 *   (6) appends one row per observation to the append-only harness/gaps_history.csv,
 *   (7) prints the ranked top-gaps research table (sim/gaps.mjs),
 *   (8) for any observation whose net_usd >= net_threshold_usd, assembles the env for
 *       the EXISTING WethUsdcCycle fork test and prints a fork-confirm plan — claiming
 *       REAL only for a WETH/USDC-shaped pair that a fork run can confirm, and degrading
 *       a mismatched-shape pair to UNCONFIRMED/SKIPPED with a clear note.
 *
 * A chain's RPC URL is read from the env var named by watchlist.chains[chain].rpc_env
 * (never a key in a file). A chain with no RPC env set is skipped (not an error).
 *
 * Sub-command: `node harness/search_once.mjs top-gaps <scoreboard.json> [limit]` prints
 * the ranked table WITHOUT scanning.
 *
 * SAFETY: measurement only. Read-only chain access via the scanner's ALLOWED guard. No
 * key material, no key custody, no transactions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadWatchlist, expandWatchlist } from "./watchlist.mjs";
import { getTokens, listDexes } from "../sim/dex_registry.mjs";
import {
    emptyScoreboard, updateScoreboard, marketKey, selectBatch, rankMarkets,
} from "../sim/scoreboard.mjs";
import { aggregateTopGaps, renderTopGapsTable } from "../sim/gaps.mjs";
import { makeRpc, scanMarket, dexPairLabel } from "../sim/search_scan.mjs";
import { assembleForkEnv, GAPS_HISTORY_HEADER, buildGapsHistoryRow } from "./make_report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------- scoreboard persistence ----
export function loadScoreboard(file) {
    try {
        if (fs.existsSync(file)) {
            const board = JSON.parse(fs.readFileSync(file, "utf8"));
            if (board && board.markets) return board;
        }
    } catch { /* fall through to a fresh board on any parse/read error */ }
    return emptyScoreboard();
}

export function saveScoreboard(file, board) {
    fs.writeFileSync(file, JSON.stringify(board, null, 2) + "\n");
}

// ----------------------------------------------------- gaps history (append-only) ----
function appendGapsHistory(file, rows) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, GAPS_HISTORY_HEADER + "\n");
    if (rows.length) fs.appendFileSync(file, rows.join("\n") + "\n");
}

// ----------------------------------------------------- market key universe ----
// allMarketKeys(markets) -> every (chain, pair, dexPair) key the watchlist can produce,
// so selectBatch can treat never-seen markets as maximally stale. PURE.
export function allMarketKeys(markets) {
    const keys = [];
    for (const m of markets) {
        const pair = `${m.pair.base}/${m.pair.quote}`;
        for (let i = 0; i < m.dexes.length; i++) {
            for (let j = i + 1; j < m.dexes.length; j++) {
                keys.push(marketKey({ chain: m.chain, pair, dexPair: dexPairLabel(m.dexes[i], m.dexes[j]) }));
            }
        }
    }
    return [...new Set(keys)];
}

// marketByKey(markets) -> Map of every selectable market-key -> the market def it came
// from, so a picked key maps back to the market to scan. PURE.
function marketIndex(markets) {
    const idx = new Map();
    for (const m of markets) {
        const pair = `${m.pair.base}/${m.pair.quote}`;
        const k = marketKey({ chain: m.chain, pair, dexPair: "search" });
        idx.set(k, m);
    }
    return idx;
}

// selectMarkets(board, markets, batchSize, now) -> the market defs to scan this cycle.
// We select at the (chain, pair) grain so one scan covers all its DEX pairings; the
// scoreboard keys are per-pairing, so we roll pairing keys up to their (chain,pair).
export function selectMarkets(board, markets, { batchSize = 4, now = 0, staleMs = 0 } = {}) {
    // one representative key per (chain, pair) market for selection
    const repKeyToMarket = new Map();
    for (const m of markets) {
        const pair = `${m.pair.base}/${m.pair.quote}`;
        repKeyToMarket.set(marketKey({ chain: m.chain, pair, dexPair: "*" }), m);
    }
    // Build a per-(chain,pair) rolled-up board so selectBatch ranks whole markets.
    const rolled = emptyScoreboard();
    const ranked = rankMarkets(board);
    const bestByMarket = new Map();
    for (const r of ranked) {
        const repKey = marketKey({ chain: r.chain, pair: r.pair, dexPair: "*" });
        const prev = bestByMarket.get(repKey);
        if (!prev || r.bestGap > prev.bestGap) bestByMarket.set(repKey, r);
    }
    let b = rolled;
    for (const [repKey, r] of bestByMarket) {
        b = updateScoreboard(b, { key: repKey, chain: r.chain, pair: r.pair, dexPair: "*", gapBps: r.bestGap, ts: r.lastChecked });
    }
    const allKeys = [...repKeyToMarket.keys()];
    const picked = selectBatch(b, { batchSize, allKeys, now, staleMs });
    return picked.map((k) => repKeyToMarket.get(k)).filter(Boolean);
}

// ----------------------------------------------------- one cycle ----
export async function runCycle(opts = {}) {
    const {
        watchlistPath = path.join(HERE, "watchlist.json"),
        scoreboardPath = path.join(HERE, "scoreboard.json"),
        gapsHistoryPath = path.join(HERE, "gaps_history.csv"),
        env = process.env,
        now = Date.now(),
        fetchImpl,
        log = console.log,
        rpcFor, // optional override: (chain, rpcUrl) -> rpc client (for tests)
    } = opts;

    const watchlist = loadWatchlist(watchlistPath);
    const markets = expandWatchlist(watchlist, { getTokens, listDexes });
    const batchSize = Number(env.BATCH_SIZE || watchlist.batch_size || 4);
    const blocksPerMarket = Number(env.BLOCKS_PER_MARKET || watchlist.blocks_per_market || 2);
    const baseDelayMs = Number(watchlist.base_delay_ms || 250);
    const maxDelayMs = Number(watchlist.max_delay_ms || 5000);
    const netThresholdUsd = Number(env.NET_THRESHOLD_USD || watchlist.net_threshold_usd || 0.5);
    const sizes = Array.isArray(watchlist.sizes) && watchlist.sizes.length ? watchlist.sizes.map(Number) : [1000];

    let board = loadScoreboard(scoreboardPath);
    const selected = selectMarkets(board, markets, { batchSize, now });

    const ts = new Date(now).toISOString();
    const historyRows = [];
    const confirms = [];
    const alerts = [];

    for (const market of selected) {
        const chainCfg = watchlist.chains[market.chain] || {};
        const rpcUrl = chainCfg.rpc_env ? env[chainCfg.rpc_env] : null;
        if (!rpcUrl && !rpcFor) {
            log(`  [skip] ${market.chain} ${market.pair.base}/${market.pair.quote}: RPC env ${chainCfg.rpc_env || "(none)"} not set`);
            continue;
        }
        let rpc;
        try {
            rpc = rpcFor ? rpcFor(market.chain, rpcUrl) : makeRpc({ url: rpcUrl, fetchImpl });
        } catch (e) {
            log(`  [skip] ${market.chain} ${market.pair.base}/${market.pair.quote}: ${e.message}`);
            continue;
        }

        let observations = [];
        try {
            observations = await scanMarket({ market, rpc, sizes, blocksPerMarket, baseDelayMs, maxDelayMs });
        } catch (e) {
            // scanMarket already swallows 429s; a stray error here is logged, not fatal
            log(`  [warn] scan ${market.chain} ${market.pair.base}/${market.pair.quote} errored: ${e.message}`);
            continue;
        }

        for (const obs of observations) {
            board = updateScoreboard(board, { chain: obs.chain, pair: obs.pair, dexPair: obs.dexPair, gapBps: obs.gapBps, ts: now });
            const wouldConfirm = obs.netUsd >= netThresholdUsd;
            historyRows.push(buildGapsHistoryRow({ timestamp: ts, obs, netUsd: obs.netUsd, wouldConfirm }));
            if (wouldConfirm) {
                const plan = assembleForkEnv(obs);
                confirms.push({ obs, plan });
                if (plan.fits) alerts.push({ obs, plan });
            }
        }
    }

    // persist + append
    saveScoreboard(scoreboardPath, board);
    appendGapsHistory(gapsHistoryPath, historyRows);

    // research summary
    const rows = aggregateTopGaps(board, { limit: 15 });
    log("");
    log(`SEARCH CYCLE @ ${ts}  (markets scanned: ${selected.length}, observations: ${historyRows.length})`);
    log(renderTopGapsTable(rows));

    // fork-confirm plans for threshold crossings
    for (const c of confirms) {
        const { obs, plan } = c;
        log("");
        if (plan.fits) {
            log(`THRESHOLD CROSSED (CONFIRMABLE): ${obs.chain} ${obs.pair} ${obs.dexPair} net $${obs.netUsd.toFixed(4)} @ block ${obs.block}`);
            log(`  fork-confirm env: ${Object.entries(plan.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
            log(`  note: ${plan.note}`);
        } else {
            log(`THRESHOLD CROSSED (UNCONFIRMED/SKIPPED): ${obs.chain} ${obs.pair} ${obs.dexPair} net $${obs.netUsd.toFixed(4)} @ block ${obs.block}`);
            log(`  ${plan.note}`);
            log(`  env assembled for a tailored run only: ${Object.entries(plan.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
            log(`  NOT claiming REAL without a shape-correct fork test.`);
        }
    }

    return { board, historyRows, confirms, alerts, selected };
}

// ----------------------------------------------------- top-gaps sub-command ----
export function printTopGaps(scoreboardFile, limit = 20, log = console.log) {
    const board = loadScoreboard(scoreboardFile);
    const rows = aggregateTopGaps(board, { limit: Number(limit) || 20 });
    log(renderTopGapsTable(rows));
}

// ----------------------------------------------------- CLI ----
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === "top-gaps") {
        const file = rest[0] || path.join(HERE, "scoreboard.json");
        printTopGaps(file, rest[1]);
    } else {
        // default: run one scan cycle using env RPCs and the default watchlist.
        const alertsBanner = (alerts) => {
            for (const a of alerts) {
                // A loud banner is reserved for a shape-CONFIRMABLE threshold crossing;
                // "REAL + scalable" is only asserted by a live fork run (SKIP_FORGE off,
                // user side). Here we flag the strong candidate loudly.
                console.log("\n" + "!".repeat(70));
                console.log(`!! STRONG CANDIDATE: ${a.obs.chain} ${a.obs.pair} ${a.obs.dexPair} net $${a.obs.netUsd.toFixed(4)}`);
                console.log("!! Shape is fork-confirmable. Run the WethUsdcCycle fork test with the env above.");
                console.log("!".repeat(70));
            }
        };
        runCycle({})
            .then((r) => { alertsBanner(r.alerts); })
            .catch((e) => { console.error("search_once error:", e.message); process.exit(1); });
    }
}

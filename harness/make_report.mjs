#!/usr/bin/env node
/*
 * make_report.mjs - dependency-free fork-log parsing + REAL-vs-MIRAGE verdict.
 *
 * The WethUsdcCycle fork test (arb-v2/test/WethUsdcCycle.t.sol) prints, per size and
 * per pairing, the REAL on-fork swap result with `forge test -vv`:
 *
 *   ==== pairing: A->B (buy on A, sell on B)
 *   --- size USD: 1000
 *     USDC in  (6dec) : 1000000000
 *     WETH bought (18dec): 400000000000000000
 *     USDC out (6dec) : 1004000000
 *     2-leg GROSS +USDC (6dec): 4000000
 *   --- size USD: 5000
 *     ...
 *
 * This module turns that text into structured per-size results and decides whether a
 * confirmed block is a REAL edge or a MIRAGE:
 *
 *   REAL    - usdc_out > usdc_in at the smallest size (a genuine gross gap beyond the
 *             watcher's gas estimate) AND the gross edge does NOT collapse as size
 *             grows (i.e. the edge still holds, in absolute USDC, at a larger size).
 *   MIRAGE  - the gap vanishes or goes negative at any tested size, OR the gross out
 *             flatlines / shrinks as size grows (the classic shallow-pool collapse
 *             the B3 pools showed: out stops increasing with size because real depth
 *             is tiny). This is the uncapturable "gap" the project keeps measuring.
 *
 * The gas floor is the watcher's own gas estimate for that block (quote net vs gas),
 * passed in so the verdict is honest about costs. A gross gap smaller than gas is a
 * MIRAGE even if usdc_out > usdc_in.
 *
 * PURE + READ-ONLY: no network, no key material, no transactions. Unit-tested in
 * test/harness_report.test.js against sample forge output text.
 */

// Parse one forge `-vv` stdout blob into pairings -> ordered size rows.
// Returns: [{ label, sizes: [{ sizeUsd, usdcIn, wethOut, usdcOut, grossUsd }] }]
// All USDC values are returned in whole USDC (not 6-dec integer) for readability;
// grossUsd is usdcOut - usdcIn (can be negative).
export function parseForkLog(text) {
  const pairings = [];
  let current = null;
  let size = null;

  const lines = String(text ?? "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // console2.log prefixes vary (forge indents logs); match on the stable labels.
    const mPair = line.match(/====\s*pairing:\s*(.+)$/i);
    if (mPair) {
      current = { label: mPair[1].trim(), sizes: [] };
      pairings.push(current);
      size = null;
      continue;
    }

    const mSize = line.match(/---\s*size USD:\s*([0-9]+)/i);
    if (mSize && current) {
      size = { sizeUsd: Number(mSize[1]), usdcIn: null, wethOut: null, usdcOut: null, grossUsd: null };
      current.sizes.push(size);
      continue;
    }
    if (!size) continue;

    const mIn = line.match(/USDC in\b.*?:\s*([0-9]+)/i);
    if (mIn) { size.usdcIn = Number(mIn[1]) / 1e6; continue; }

    const mWeth = line.match(/WETH bought\b.*?:\s*([0-9]+)/i);
    if (mWeth) { size.wethOut = Number(mWeth[1]) / 1e18; continue; }

    const mOut = line.match(/USDC out\b.*?:\s*([0-9]+)/i);
    if (mOut) { size.usdcOut = Number(mOut[1]) / 1e6; continue; }

    // GROSS/LOSS line is optional (we derive grossUsd ourselves), but read it when
    // present as a cross-check is not required; derivation below is authoritative.
  }

  // derive grossUsd per size from in/out
  for (const p of pairings) {
    for (const s of p.sizes) {
      if (s.usdcIn != null && s.usdcOut != null) s.grossUsd = s.usdcOut - s.usdcIn;
    }
  }
  return pairings;
}

// Decide REAL vs MIRAGE for a single pairing's ordered size rows.
//   gasUsd    - the watcher's gas estimate (USD) for this block; the gross edge must
//               exceed it to count as REAL. Defaults to 0 if unknown (still requires
//               a positive, non-collapsing gross gap).
// Returns { verdict: "REAL"|"MIRAGE", reason, smallestNetUsd, scales }.
export function verdictForPairing(sizes, gasUsd = 0) {
  const ok = sizes.filter((s) => s.usdcIn != null && s.usdcOut != null);
  if (ok.length === 0) {
    return { verdict: "MIRAGE", reason: "no parseable size rows", smallestNetUsd: null, scales: false };
  }
  const ordered = ok.slice().sort((a, b) => a.sizeUsd - b.sizeUsd);
  const smallest = ordered[0];
  const smallestNetUsd = smallest.grossUsd - gasUsd;

  // 1) gross gap at the smallest size must clear the gas floor.
  if (smallest.grossUsd <= 0) {
    return { verdict: "MIRAGE", reason: `smallest size (${smallest.sizeUsd}) usdc_out <= usdc_in on fork`, smallestNetUsd, scales: false };
  }
  if (smallest.grossUsd <= gasUsd) {
    return {
      verdict: "MIRAGE",
      reason: `smallest-size gross gap $${smallest.grossUsd.toFixed(4)} does not clear gas $${gasUsd.toFixed(4)}`,
      smallestNetUsd, scales: false,
    };
  }

  // 2) the gap must NOT collapse as size grows. Shallow-pool collapse shows up as the
  //    gross USDC gap flatlining or shrinking at a larger size (the B3 mirage). We call
  //    it REAL only if a larger size still yields a gross gap >= the smallest size's.
  let scales = false;
  for (const s of ordered.slice(1)) {
    if (s.grossUsd >= smallest.grossUsd - 1e-9) { scales = true; break; }
  }
  // If there is only one size, we cannot observe scaling; treat as MIRAGE-leaning
  // (one point is not enough to trust depth), but still surface the positive gap.
  if (ordered.length === 1) {
    return {
      verdict: "MIRAGE",
      reason: `only one size tested; cannot confirm the gap holds as size grows`,
      smallestNetUsd, scales: false,
    };
  }
  if (!scales) {
    return {
      verdict: "MIRAGE",
      reason: `gross gap collapses as size grows (shallow depth): smallest $${smallest.grossUsd.toFixed(4)} not matched at larger sizes`,
      smallestNetUsd, scales: false,
    };
  }
  return {
    verdict: "REAL",
    reason: `gross gap $${smallest.grossUsd.toFixed(4)} clears gas $${gasUsd.toFixed(4)} and holds as size grows`,
    smallestNetUsd, scales: true,
  };
}

// Decide the verdict for a whole fork run (which may contain several pairings). The
// block is REAL if ANY pairing is REAL (a capturable edge needs only one route).
// Returns { verdict, reason, pairings: [{ label, ...verdictForPairing, sizes }] }.
export function verdictForForkLog(text, gasUsd = 0) {
  const pairings = parseForkLog(text);
  const perPairing = pairings.map((p) => ({ label: p.label, sizes: p.sizes, ...verdictForPairing(p.sizes, gasUsd) }));
  const anyReal = perPairing.find((p) => p.verdict === "REAL");
  if (perPairing.length === 0) {
    return { verdict: "MIRAGE", reason: "no pairings parsed from fork log", pairings: perPairing };
  }
  return {
    verdict: anyReal ? "REAL" : "MIRAGE",
    reason: anyReal ? `pairing "${anyReal.label}" is REAL: ${anyReal.reason}` : perPairing[0].reason,
    pairings: perPairing,
  };
}

// Build a per-run Markdown report body from the pieces the harness has gathered.
//   run - {
//     timestamp, chain, minutes, csvPath, blocksWatched, signals,
//     confirmed: [ { block, quoteNetUsd, gasUsd, forkText } ]   // one per fork-confirmed block
//   }
// Returns a Markdown string. When signals === 0 it records a clean zero-signal run.
export function buildReportMarkdown(run) {
  const L = [];
  L.push(`# ArbitAI harness run - ${run.timestamp}`);
  L.push("");
  L.push(`- chain: **${run.chain}**`);
  L.push(`- watcher minutes: ${run.minutes}`);
  L.push(`- watcher CSV: \`${run.csvPath}\``);
  L.push(`- blocks watched: ${run.blocksWatched}`);
  L.push(`- WOULD-FIRE signals: ${run.signals}`);
  L.push("");

  if (!run.confirmed || run.confirmed.length === 0) {
    L.push("## No fork-confirmed blocks");
    L.push("");
    if (run.signals === 0) {
      L.push("The watcher produced **0 WOULD-FIRE signals** this run. No fork confirmation was needed.");
      L.push("A clean zero-signal run is the expected outcome when no above-cost gap opens.");
    } else {
      L.push("Signals were seen but no block was fork-confirmed (see harness log).");
    }
    L.push("");
    L.push(verdictFootnote());
    return L.join("\n");
  }

  L.push("## Fork-confirmed blocks (real swaps)");
  L.push("");
  let anyReal = false;
  for (const c of run.confirmed) {
    const v = verdictForForkLog(c.forkText, c.gasUsd ?? 0);
    if (v.verdict === "REAL") anyReal = true;
    L.push(`### Block ${c.block} - **${v.verdict}**`);
    L.push("");
    L.push(`- watcher quote net (after gas): $${fmt(c.quoteNetUsd)}`);
    L.push(`- watcher gas estimate: $${fmt(c.gasUsd ?? 0)}`);
    L.push(`- verdict reason: ${v.reason}`);
    L.push("");
    for (const p of v.pairings) {
      L.push(`#### pairing \`${p.label}\` - ${p.verdict}`);
      L.push("");
      L.push("| size USD | USDC in | WETH bought | USDC out | gross USD |");
      L.push("| ---: | ---: | ---: | ---: | ---: |");
      for (const s of p.sizes) {
        L.push(`| ${s.sizeUsd} | ${fmt(s.usdcIn)} | ${fmt(s.wethOut, 8)} | ${fmt(s.usdcOut)} | ${s.grossUsd == null ? "" : (s.grossUsd >= 0 ? "+" : "") + fmt(s.grossUsd)} |`);
      }
      L.push("");
    }
  }
  L.push(`## Run verdict: **${anyReal ? "REAL" : "MIRAGE"}**`);
  L.push("");
  L.push(verdictFootnote());
  return L.join("\n");
}

function verdictFootnote() {
  return [
    "> How to read this: the watcher reports a WOULD-FIRE when a live QUOTE shows an",
    "> above-gas gap. A quote is not a trade. The fork test re-runs the full cycle with",
    "> REAL swaps at several sizes. **REAL** means the gross USDC gap clears the gas",
    "> floor at the smallest size AND still holds as size grows. **MIRAGE** means the",
    "> gap vanishes, fails to clear gas, or collapses as size grows (shallow depth).",
    "> This harness MEASURES whether a capturable edge exists; it cannot create one.",
  ].join("\n");
}

// Build the single history.csv row for a run. Returns a comma-joined string (no newline).
// Columns: timestamp,blocks_watched,signals,top_block,quote_net,fork_real_net_1k,verdict
export const HISTORY_HEADER = "timestamp,blocks_watched,signals,top_block,quote_net,fork_real_net_1k,verdict";
export function buildHistoryRow(run) {
  let topBlock = "";
  let quoteNet = "";
  let forkRealNet1k = "";
  let verdict = "NONE";

  if (run.confirmed && run.confirmed.length > 0) {
    const top = run.confirmed[0];
    topBlock = top.block;
    quoteNet = fmt(top.quoteNetUsd);
    const v = verdictForForkLog(top.forkText, top.gasUsd ?? 0);
    verdict = v.verdict;
    // fork_real_net_1k: the smallest-size (1k) net (gross - gas) of the best pairing.
    const real = v.pairings.find((p) => p.verdict === "REAL") || v.pairings[0];
    if (real && real.smallestNetUsd != null) forkRealNet1k = fmt(real.smallestNetUsd);
  } else if (run.signals === 0) {
    verdict = "NO_SIGNAL";
  } else {
    verdict = "UNCONFIRMED";
  }

  return [run.timestamp, run.blocksWatched, run.signals, topBlock, quoteNet, forkRealNet1k, verdict].join(",");
}

// Summarize history.csv text into a rolling status block (string). Pure.
export function summarizeHistory(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (line.startsWith("timestamp,")) continue;
    const [timestamp, blocks_watched, signals, top_block, quote_net, fork_real_net_1k, verdict] = line.split(",");
    rows.push({
      timestamp,
      blocks_watched: Number(blocks_watched),
      signals: Number(signals),
      top_block,
      quote_net,
      fork_real_net_1k: fork_real_net_1k === "" ? null : Number(fork_real_net_1k),
      verdict: (verdict || "").trim(),
    });
  }
  const totalRuns = rows.length;
  const totalSignals = rows.reduce((a, r) => a + (Number.isFinite(r.signals) ? r.signals : 0), 0);
  const real = rows.filter((r) => r.verdict === "REAL");
  const mirage = rows.filter((r) => r.verdict === "MIRAGE");
  let bestRealNet = null;
  for (const r of real) {
    if (r.fork_real_net_1k != null && (bestRealNet == null || r.fork_real_net_1k > bestRealNet)) bestRealNet = r.fork_real_net_1k;
  }
  const first = rows.length ? rows[0].timestamp : null;
  const last = rows.length ? rows[rows.length - 1].timestamp : null;

  const L = [];
  L.push("ROLLING SUMMARY (from history.csv)");
  L.push(`  total runs            : ${totalRuns}`);
  L.push(`  total WOULD-FIRE signals: ${totalSignals}`);
  L.push(`  fork-confirmed REAL   : ${real.length}`);
  L.push(`  fork-confirmed MIRAGE : ${mirage.length}`);
  L.push(`  best REAL net (1k)    : ${bestRealNet == null ? "none" : "$" + fmt(bestRealNet)}`);
  L.push(`  time span             : ${first ?? "n/a"}  ->  ${last ?? "n/a"}`);
  if (real.length === 0) {
    L.push("  conclusion            : no capturable edge confirmed yet (consistent with the project's standing finding).");
  } else {
    L.push("  conclusion            : a REAL edge was flagged - review the matching report.md before trusting it.");
  }
  return { text: L.join("\n"), totalRuns, totalSignals, real: real.length, mirage: mirage.length, bestRealNet, first, last };
}

function fmt(n, dp = 4) {
  if (n == null || !Number.isFinite(Number(n))) return "";
  return Number(n).toFixed(dp);
}

// CLI: small dispatcher so the shell scripts can call sub-commands without inlining
// JS. Not required for the unit tests (they import the functions directly).
//   node harness/make_report.mjs summarize <history.csv>
//   node harness/make_report.mjs history-header
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const fs = await import("node:fs");
  if (cmd === "summarize") {
    const text = arg && fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : "";
    console.log(summarizeHistory(text).text);
  } else if (cmd === "history-header") {
    console.log(HISTORY_HEADER);
  } else {
    console.error("usage: node harness/make_report.mjs {summarize <history.csv>|history-header}");
    process.exit(2);
  }
}

#!/usr/bin/env node
/*
 * parse_fires.mjs - dependency-free CSV parsing + top-N firing-block selection.
 *
 * The live watcher (sim/live_two_dex_watcher.mjs) appends one row per block to a
 * CSV with this header:
 *
 *   block,pair,dir,size_usd,gross_usd,gas_usd,net_usd,would_fire
 *
 * A "firing" block is a row whose last column `would_fire` == "true". This module
 * parses that CSV, keeps only firing rows, and ranks them by `net_usd` descending so
 * the harness can pick the top N blocks to confirm with the WethUsdcCycle fork test.
 *
 * It is PURE and READ-ONLY (no network, no fs side effects beyond an optional read),
 * so it is unit-testable against sample CSV text with no RPC. See
 * test/harness_report.test.js.
 *
 * SAFETY: measurement only. This file holds NO key material and sends NO transaction.
 */
import fs from "node:fs";

// Column order the watcher writes. Kept here as the single source of truth so the
// parser and the report stay in sync with the watcher.
export const CSV_HEADER = "block,pair,dir,size_usd,gross_usd,gas_usd,net_usd,would_fire";
export const CSV_COLUMNS = CSV_HEADER.split(",");

// Parse watcher CSV text into an array of row objects. Tolerates:
//   - an optional header line (detected by the literal "block,pair,...")
//   - blank lines and trailing whitespace
//   - CRLF or LF line endings
// Numeric columns are coerced to Number; `would_fire` to a real boolean.
// Rows that do not have the expected column count are skipped (defensive).
export function parseWatcherCsv(text) {
  const rows = [];
  if (text == null) return rows;
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("block,pair,")) continue; // header
    const parts = line.split(",");
    if (parts.length < CSV_COLUMNS.length) continue; // malformed -> skip
    const [block, pair, dir, size_usd, gross_usd, gas_usd, net_usd, would_fire] = parts;
    rows.push({
      block: Number(block),
      pair,
      dir,
      size_usd: Number(size_usd),
      gross_usd: Number(gross_usd),
      gas_usd: Number(gas_usd),
      net_usd: Number(net_usd),
      would_fire: String(would_fire).trim().toLowerCase() === "true",
    });
  }
  return rows;
}

// Keep only the firing rows (would_fire === true), ranked by net_usd descending.
export function firingRows(rows) {
  return rows
    .filter((r) => r.would_fire === true && Number.isFinite(r.net_usd))
    .slice()
    .sort((a, b) => b.net_usd - a.net_usd);
}

// Select the top-N firing blocks by net_usd. If the same block fires more than once
// (different size/pairing), keep only its single best (highest net_usd) row so each
// chosen entry maps to a distinct --fork-block-number. Returns at most n rows.
export function topFiringBlocks(rows, n = 3) {
  const best = new Map(); // block -> best row for that block
  for (const r of firingRows(rows)) {
    const prev = best.get(r.block);
    if (!prev || r.net_usd > prev.net_usd) best.set(r.block, r);
  }
  const unique = [...best.values()].sort((a, b) => b.net_usd - a.net_usd);
  return unique.slice(0, Math.max(0, n | 0));
}

// Convenience: read + parse + select straight from a CSV file path.
export function topFiringBlocksFromFile(path, n = 3) {
  if (!fs.existsSync(path)) return [];
  return topFiringBlocks(parseWatcherCsv(fs.readFileSync(path, "utf8")), n);
}

// CLI: `node harness/parse_fires.mjs <csvpath> [topN]` prints the chosen blocks as
// JSON (one object per line is avoided; a single JSON array keeps shell parsing easy).
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  const n = Number(process.argv[3] || "3");
  if (!path) {
    console.error("usage: node harness/parse_fires.mjs <watcher-csv> [topN]");
    process.exit(2);
  }
  const picks = topFiringBlocksFromFile(path, n);
  // Emit a compact, shell-friendly form: one "block net_usd pair dir size_usd" per line.
  for (const r of picks) {
    console.log([r.block, r.net_usd, r.pair, r.dir, r.size_usd].join(" "));
  }
}

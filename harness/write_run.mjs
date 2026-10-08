#!/usr/bin/env node
/*
 * write_run.mjs - glue the parsing/verdict helpers into a per-run report.md and a
 * one-line history.csv row, driven by a small JSON manifest the shell writes.
 *
 * The shell (run_once.sh) gathers the facts of a run (CSV path, blocks watched,
 * signals, and for each fork-confirmed block: the block number, the watcher quote net,
 * the gas estimate, and the path to the captured forge stdout). It writes those into a
 * manifest JSON and calls:
 *
 *   node harness/write_run.mjs <manifest.json> <report.md-out> <history.csv>
 *
 * This reads each fork log from disk, builds the report, writes it to <report.md-out>,
 * appends the history row to <history.csv> (writing the header first if absent), and
 * prints a short rolling summary to stdout.
 *
 * PURE logic lives in make_report.mjs (unit-tested); this file is thin I/O glue so the
 * shell never has to inline JS. Read-only w.r.t. the chain; no key material, no tx.
 */
import fs from "node:fs";
import { buildReportMarkdown, buildHistoryRow, HISTORY_HEADER, summarizeHistory } from "./make_report.mjs";

const [manifestPath, reportOut, historyCsv] = process.argv.slice(2);
if (!manifestPath || !reportOut || !historyCsv) {
  console.error("usage: node harness/write_run.mjs <manifest.json> <report.md-out> <history.csv>");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// Resolve each confirmed block's fork text from its logPath (if the file is missing,
// record an empty blob so the verdict degrades to MIRAGE rather than crashing).
const confirmed = (manifest.confirmed || []).map((c) => ({
  block: c.block,
  quoteNetUsd: c.quoteNetUsd,
  gasUsd: c.gasUsd,
  forkText: c.logPath && fs.existsSync(c.logPath) ? fs.readFileSync(c.logPath, "utf8") : "",
}));

const run = {
  timestamp: manifest.timestamp,
  chain: manifest.chain,
  minutes: manifest.minutes,
  csvPath: manifest.csvPath,
  blocksWatched: manifest.blocksWatched,
  signals: manifest.signals,
  confirmed,
};

// 1) write report.md
fs.writeFileSync(reportOut, buildReportMarkdown(run) + "\n");

// 2) append history row (header first if the file does not exist yet)
if (!fs.existsSync(historyCsv)) fs.writeFileSync(historyCsv, HISTORY_HEADER + "\n");
fs.appendFileSync(historyCsv, buildHistoryRow(run) + "\n");

// 3) print a short rolling summary from the (now updated) history
const summary = summarizeHistory(fs.readFileSync(historyCsv, "utf8"));
console.log(summary.text);

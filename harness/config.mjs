#!/usr/bin/env node
/*
 * config.mjs - read + validate the harness pools config (harness/pools.arbitrum.json).
 *
 * Pure helpers plus a small CLI the shell scripts use to pull values out of the JSON
 * without inlining a JSON parser in bash, and to REFUSE to run while any pool/quoter
 * is still a placeholder (so the harness fails loudly rather than quoting a fake pool).
 *
 * A value is a PLACEHOLDER when it is empty, not a 0x..40-hex address, or an obvious
 * stand-in like 0xPANCAKE_V3_WETH_USDC_ARBITRUM. The Uniswap candidate is a real-shaped
 * address and so is NOT treated as a placeholder (it is merely UNVERIFIED - the user is
 * told to --check it), but Pancake must be filled in before the harness will run.
 *
 * SAFETY: no network, no key material, no transactions. Read-only.
 */
import fs from "node:fs";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function loadConfig(path) {
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  return cfg;
}

// Is a single address value a placeholder (must be replaced before running)?
export function isPlaceholder(value) {
  if (value == null) return true;
  const v = String(value).trim();
  if (v === "") return true;
  if (!HEX40.test(v)) return true; // e.g. 0xPANCAKE_... or any non-address stand-in
  return false;
}

// Validate every pool + quoter. Returns { ok, problems: [string], pools: {...} }.
export function validateConfig(cfg) {
  const problems = [];
  const labels = Object.keys(cfg.pools || {});
  if (labels.length < 2) problems.push("need at least pools A and B configured");
  for (const label of labels) {
    const p = cfg.pools[label];
    if (isPlaceholder(p.pool)) {
      problems.push(`pool ${label} (${p.dex}) address is a placeholder: "${p.pool}" - replace it with the real address`);
    }
    if (isPlaceholder(p.quoter)) {
      problems.push(`pool ${label} (${p.dex}) quoter is a placeholder: "${p.quoter}" - replace it with the DEX's real quoter`);
    }
  }
  if (isPlaceholder(cfg.weth)) problems.push(`weth is a placeholder: "${cfg.weth}"`);
  if (isPlaceholder(cfg.usdc)) problems.push(`usdc is a placeholder: "${cfg.usdc}"`);
  return { ok: problems.length === 0, problems, pools: cfg.pools };
}

// Flatten config to the watcher CLI arguments (as an array of strings).
export function watcherArgs(cfg) {
  const a = ["--chain", cfg.chain];
  const map = { A: ["--poolA", "--quoterA"], B: ["--poolB", "--quoterB"], C: ["--poolC", "--quoterC"] };
  for (const label of Object.keys(cfg.pools)) {
    const [poolFlag, quoterFlag] = map[label] || [];
    if (!poolFlag) continue;
    a.push(poolFlag, cfg.pools[label].pool);
    a.push(quoterFlag, cfg.pools[label].quoter);
  }
  if (cfg.sizes) a.push("--sizes", String(cfg.sizes));
  if (cfg.min_profit_usd != null) a.push("--min-profit-usd", String(cfg.min_profit_usd));
  return a;
}

// CLI dispatcher for the shell scripts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, path, ...rest] = process.argv.slice(2);
  if (!cmd || !path) {
    console.error("usage: node harness/config.mjs {validate|watcher-args|get <key>|pools-check-args} <config.json>");
    process.exit(2);
  }
  const cfg = loadConfig(path);
  if (cmd === "validate") {
    const v = validateConfig(cfg);
    if (v.ok) { console.log("CONFIG OK"); process.exit(0); }
    console.error("CONFIG INVALID - the harness will not run until these are fixed:");
    for (const p of v.problems) console.error("  - " + p);
    process.exit(1);
  } else if (cmd === "watcher-args") {
    // print each arg on its own line so the shell can read into an array safely
    for (const a of watcherArgs(cfg)) console.log(a);
  } else if (cmd === "pools-check-args") {
    // args for the watcher --check preflight (pools + quoters only, no sizes)
    const out = ["--chain", cfg.chain, "--check"];
    const map = { A: ["--poolA", "--quoterA"], B: ["--poolB", "--quoterB"], C: ["--poolC", "--quoterC"] };
    for (const label of Object.keys(cfg.pools)) {
      const [poolFlag, quoterFlag] = map[label] || [];
      if (!poolFlag) continue;
      out.push(poolFlag, cfg.pools[label].pool, quoterFlag, cfg.pools[label].quoter);
    }
    for (const a of out) console.log(a);
  } else if (cmd === "get") {
    const key = rest[0];
    const val = key.split(".").reduce((o, k) => (o == null ? o : o[k]), cfg);
    console.log(val == null ? "" : String(val));
  } else {
    console.error("unknown command: " + cmd);
    process.exit(2);
  }
}

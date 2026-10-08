#!/usr/bin/env node
/*
 * watchlist.mjs - load + validate + expand the search WATCHLIST (harness/watchlist.json).
 *
 * PURE helpers (no network, no key material, no transactions) plus a small CLI the
 * shell scripts call to validate / expand / read values without inlining a JSON parser.
 *
 * The watchlist describes the search space: which chains are enabled (each naming an
 * ENV VAR for its RPC URL, never a key in the file), which token pairs to look for, and
 * which DEXes to compare cross-DEX. expandWatchlist() turns that into the concrete list
 * of markets to scan, dropping any pair whose base/quote token is not available on a
 * chain (e.g. ARB only exists on arbitrum, cbETH only on base) rather than erroring.
 *
 * Token symbols resolve against sim/dex_registry.mjs TOKENS per chain. This file holds
 * only the thin fs read + the pure transforms; the registry stays pure data.
 *
 * SAFETY: read-only. No RPC, no key material, no transactions.
 */
import fs from "node:fs";
import { getTokens, listDexes } from "../sim/dex_registry.mjs";

// loadWatchlist(path) -> parsed JSON object. Thin I/O wrapper (the only fs touch).
export function loadWatchlist(path) {
    return JSON.parse(fs.readFileSync(path, "utf8"));
}

// normDex(d) -> lowercased dex key.
const normDex = (d) => String(d ?? "").toLowerCase();

// enabledChains(watchlist) -> array of chain names whose { enabled } is truthy. PURE.
export function enabledChains(watchlist) {
    const chains = (watchlist && watchlist.chains) || {};
    return Object.keys(chains).filter((c) => chains[c] && chains[c].enabled);
}

// pairAllowedOnChain(pair, chain) -> true unless the pair restricts itself to other
// chains via an optional pair.chains allow-list. PURE.
function pairAllowedOnChain(pair, chain) {
    if (!Array.isArray(pair.chains) || pair.chains.length === 0) return true;
    return pair.chains.map((c) => String(c).toLowerCase()).includes(String(chain).toLowerCase());
}

// resolvePairTokens(pair, tokens) -> { base, quote } token addresses, or null when
// either symbol is not present in the chain's token map. PURE.
function resolvePairTokens(pair, tokens) {
    const baseAddr = tokens[pair.base];
    const quoteAddr = tokens[pair.quote];
    if (!baseAddr || !quoteAddr) return null;
    return { base: baseAddr, quote: quoteAddr };
}

// expandWatchlist(watchlist, registry?) -> the concrete market definitions to scan:
//   [{ chain, pair: { base, quote, baseAddr, quoteAddr }, dexes: [...] }]
// PURE. Filters to ENABLED chains and DROPS any pair whose base/quote token is not
// available on a chain (resolved from the registry's TOKENS). dexes are filtered to the
// ones the registry actually knows for that chain. A dropped pair is NOT an error.
//
// The optional `registry` argument lets tests inject a token source; by default it uses
// sim/dex_registry.mjs via getTokens()/listDexes(). A registry override must expose
// getTokens(chain) and listDexes(chain).
export function expandWatchlist(watchlist, registry = { getTokens, listDexes }) {
    const out = [];
    if (!watchlist || !watchlist.chains) return out;
    const wantDexes = Array.isArray(watchlist.dexes) ? watchlist.dexes.map(normDex) : [];
    const pairs = Array.isArray(watchlist.pairs) ? watchlist.pairs : [];

    for (const chain of enabledChains(watchlist)) {
        let tokens, knownDexes;
        try {
            tokens = registry.getTokens(chain);
            knownDexes = registry.listDexes(chain).map(normDex);
        } catch {
            // unknown chain in the registry -> skip it gracefully, never throw
            continue;
        }
        // keep only the requested dexes the registry actually supports on this chain
        const dexes = wantDexes.filter((d) => knownDexes.includes(d));
        if (dexes.length < 2) continue; // need >=2 DEXes to form a cross-DEX pairing

        for (const pair of pairs) {
            if (!pairAllowedOnChain(pair, chain)) continue; // pair not meant for this chain
            const resolved = resolvePairTokens(pair, tokens);
            if (!resolved) continue; // token not on this chain (e.g. ARB on base) -> drop
            out.push({
                chain,
                pair: {
                    base: pair.base,
                    quote: pair.quote,
                    baseAddr: resolved.base,
                    quoteAddr: resolved.quote,
                },
                dexes,
            });
        }
    }
    return out;
}

// validateWatchlist(watchlist) -> { ok, problems: [string] }. PURE.
export function validateWatchlist(watchlist) {
    const problems = [];
    if (!watchlist || typeof watchlist !== "object") {
        return { ok: false, problems: ["watchlist is empty or not an object"] };
    }
    const chains = watchlist.chains || {};
    if (!Object.keys(chains).length) problems.push("no chains configured");
    for (const [name, c] of Object.entries(chains)) {
        if (!c || typeof c !== "object") { problems.push(`chain ${name} is not an object`); continue; }
        if (c.enabled && !c.rpc_env) problems.push(`chain ${name} is enabled but has no rpc_env (name an env var, never a key)`);
    }
    if (!enabledChains(watchlist).length) problems.push("no chains are enabled");

    const pairs = watchlist.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) problems.push("no pairs configured");
    else {
        pairs.forEach((p, i) => {
            if (!p || !p.base || !p.quote) problems.push(`pair[${i}] needs both base and quote`);
            if (p && p.base && p.quote && p.base === p.quote) problems.push(`pair[${i}] base equals quote (${p.base})`);
        });
    }

    const dexes = watchlist.dexes;
    if (!Array.isArray(dexes) || dexes.length < 2) problems.push("need at least 2 dexes for a cross-DEX comparison");

    const nums = [
        ["batch_size", watchlist.batch_size],
        ["blocks_per_market", watchlist.blocks_per_market],
        ["base_delay_ms", watchlist.base_delay_ms],
        ["max_delay_ms", watchlist.max_delay_ms],
        ["net_threshold_usd", watchlist.net_threshold_usd],
    ];
    for (const [k, v] of nums) {
        if (v == null || !Number.isFinite(Number(v)) || Number(v) < 0) problems.push(`${k} must be a non-negative number`);
    }
    if (!Array.isArray(watchlist.sizes) || watchlist.sizes.length === 0) problems.push("sizes must be a non-empty array");

    return { ok: problems.length === 0, problems };
}

// CLI dispatcher for the shell scripts (guarded so the module stays importable).
if (import.meta.url === `file://${process.argv[1]}`) {
    const [cmd, path, ...rest] = process.argv.slice(2);
    if (!cmd || !path) {
        console.error("usage: node harness/watchlist.mjs {validate|expand|get <key>} <watchlist.json>");
        process.exit(2);
    }
    const wl = loadWatchlist(path);
    if (cmd === "validate") {
        const v = validateWatchlist(wl);
        if (v.ok) { console.log("WATCHLIST OK"); process.exit(0); }
        console.error("WATCHLIST INVALID - fix these before running the search:");
        for (const p of v.problems) console.error("  - " + p);
        process.exit(1);
    } else if (cmd === "expand") {
        const markets = expandWatchlist(wl);
        for (const m of markets) {
            console.log(`${m.chain}\t${m.pair.base}/${m.pair.quote}\t${m.dexes.join(",")}`);
        }
    } else if (cmd === "get") {
        const key = rest[0];
        const val = key.split(".").reduce((o, k) => (o == null ? o : o[k]), wl);
        console.log(val == null ? "" : (typeof val === "object" ? JSON.stringify(val) : String(val)));
    } else {
        console.error("unknown command: " + cmd);
        process.exit(2);
    }
}

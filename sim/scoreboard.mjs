#!/usr/bin/env node
/*
 * SCOREBOARD (pure, immutable) — a persistent record of how each market has behaved
 * over time plus the adaptive batch selector that decides what to scan next.
 *
 * SAFETY: pure functions only. No I/O, no network, no key material, no transactions.
 * The persistence (reading/writing the board as JSON) lives in the I/O layer; here the
 * board is just a plain object transformed by pure functions that NEVER mutate inputs.
 *
 * A "market" is one measurable gap: a chain + token pair + the pair of DEXes compared
 * (e.g. arbitrum WETH/USDC uniswap<->sushi). Each market tracks:
 *   timesChecked - how many observations have been recorded
 *   bestGap      - the maximum gap ever seen (bps)
 *   medianGap    - the median of a capped window of recent gaps
 *   lastGap      - the most recent gap
 *   lastChecked  - the ts of the most recent observation
 *   samples      - the capped (last N) window of recent gaps used for the median
 */

const SAMPLE_CAP = 50; // keep the last N gaps per market for the running median

// marketKey({ chain, pair, dexPair }) -> a stable string id. PURE.
// pair is e.g. "WETH/USDC"; dexPair is e.g. "uniswap<->sushi". The parts are lowercased
// and joined so the same market always maps to the same key regardless of input casing.
export function marketKey({ chain, pair, dexPair }) {
    return [chain, pair, dexPair].map((p) => String(p ?? "").toLowerCase()).join("|");
}

// emptyScoreboard() -> a fresh board. PURE.
export function emptyScoreboard() {
    return { version: 1, markets: {} };
}

// median(nums) -> the median of a numeric array (0 for empty). PURE helper.
function median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// updateScoreboard(board, observation) -> a NEW board (input is NOT mutated).
// observation = { key?, chain, pair, dexPair, gapBps (or gapUsd), ts }.
// If `key` is omitted it is derived via marketKey(). The gap used for stats is gapBps
// when present, else gapUsd (so the board works for either metric; keep one consistent).
export function updateScoreboard(board, observation) {
    const base = board && board.markets ? board : emptyScoreboard();
    const key = observation.key ?? marketKey(observation);
    const gap = observation.gapBps != null ? observation.gapBps : (observation.gapUsd != null ? observation.gapUsd : 0);
    const ts = observation.ts ?? 0;

    const prev = base.markets[key];
    const prevSamples = prev && Array.isArray(prev.samples) ? prev.samples : [];
    // append the new gap and cap the window to the last SAMPLE_CAP entries
    const samples = [...prevSamples, gap].slice(-SAMPLE_CAP);

    const updated = {
        key,
        chain: observation.chain ?? (prev && prev.chain) ?? null,
        pair: observation.pair ?? (prev && prev.pair) ?? null,
        dexPair: observation.dexPair ?? (prev && prev.dexPair) ?? null,
        timesChecked: (prev ? prev.timesChecked : 0) + 1,
        bestGap: prev ? Math.max(prev.bestGap, gap) : gap,
        medianGap: median(samples),
        lastGap: gap,
        lastChecked: ts,
        samples,
    };

    // return a brand-new board object with a new markets map (immutability)
    return {
        version: base.version ?? 1,
        markets: { ...base.markets, [key]: updated },
    };
}

// rankMarkets(board) -> array of market entries sorted by rank score, each annotated
// with a 1-based `rank`. PURE. Rank score: bestGap DESC, tie-broken by medianGap DESC,
// then by timesChecked DESC, then by key ASC for full determinism.
export function rankMarkets(board) {
    const base = board && board.markets ? board.markets : {};
    const entries = Object.values(base).map((m) => ({ ...m }));
    entries.sort((a, b) => {
        if (b.bestGap !== a.bestGap) return b.bestGap - a.bestGap;
        if (b.medianGap !== a.medianGap) return b.medianGap - a.medianGap;
        if (b.timesChecked !== a.timesChecked) return b.timesChecked - a.timesChecked;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return entries.map((m, i) => ({ ...m, rank: i + 1 }));
}

// selectBatch(board, { batchSize, allKeys, now, staleMs }) -> an ordered array of at
// most batchSize UNIQUE market keys to scan next. PURE.
//
// SELECTION POLICY (adaptive, starvation-free):
//   1) EXPLOIT — fill the first ceil(batchSize/2) slots from the highest-RANKED markets
//      (rankMarkets order). This biases scanning toward the markets that have shown the
//      biggest gaps, so a live edge is re-measured promptly.
//   2) EXPLORE — fill the remaining slots by least-recently-seen first, guaranteeing
//      round-robin coverage of the long tail so nothing is starved. A market that is
//      not yet in the board, or whose lastChecked is older than `staleMs` before `now`,
//      is treated as MAXIMALLY stale (lastChecked = -Infinity) so brand-new and stale
//      markets are picked up. allKeys is the full universe of candidate keys (including
//      never-before-seen ones); the board may cover only a subset.
//   No key is ever duplicated within a batch.
export function selectBatch(board, { batchSize, allKeys, now = 0, staleMs = 0 } = {}) {
    const size = Math.max(0, Number(batchSize) || 0);
    if (size === 0) return [];
    const markets = board && board.markets ? board.markets : {};

    // candidate universe: explicit allKeys when provided, else the keys already on the board
    const universe = Array.isArray(allKeys) && allKeys.length ? [...new Set(allKeys)] : Object.keys(markets);
    if (!universe.length) return [];
    const universeSet = new Set(universe);

    const picked = [];
    const taken = new Set();
    const push = (k) => {
        if (k != null && universeSet.has(k) && !taken.has(k)) {
            taken.add(k);
            picked.push(k);
        }
    };

    // ---- 1) EXPLOIT: top-ranked markets first ----
    const exploitSlots = Math.ceil(size / 2);
    const ranked = rankMarkets(board);
    for (const m of ranked) {
        if (picked.length >= exploitSlots) break;
        push(m.key);
    }

    // ---- 2) EXPLORE: least-recently-seen (never-seen counts as maximally stale) ----
    // staleness key: never-seen OR older than staleMs -> -Infinity (highest priority);
    // otherwise the actual lastChecked (older = picked first).
    const staleness = (k) => {
        const m = markets[k];
        if (!m) return -Infinity; // never seen -> maximally stale
        if (staleMs > 0 && m.lastChecked <= now - staleMs) return -Infinity; // past the stale cutoff
        return m.lastChecked ?? -Infinity;
    };
    const byStale = universe
        .filter((k) => !taken.has(k))
        .sort((a, b) => {
            const sa = staleness(a), sb = staleness(b);
            if (sa !== sb) return sa - sb; // oldest / never-seen first
            return a < b ? -1 : a > b ? 1 : 0; // deterministic tie-break
        });
    for (const k of byStale) {
        if (picked.length >= size) break;
        push(k);
    }

    // ---- 3) BACKFILL: if exploit under-filled and slots remain, top up from ranked ----
    if (picked.length < size) {
        for (const m of ranked) {
            if (picked.length >= size) break;
            push(m.key);
        }
    }

    return picked.slice(0, size);
}

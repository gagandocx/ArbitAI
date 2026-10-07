// Pure candidate ranking. NO network, NO I/O, NO imports from evm/rpc.
//
// rankCandidates takes the net-after-costs result plus the trap verdict for
// each candidate pair and produces an ordered, annotated list for display:
//   - rows whose trap verdict is 'avoid' are demoted to the bottom and clearly
//     flagged (they are never actionable), optionally excluded entirely;
//   - the remaining rows are sorted by net descending (best edge first);
//   - every row gets a final per-row verdict combining net sign and trap
//     verdict: 'profitable' | 'marginal' | 'unprofitable' | 'trap/avoid'.

export const DEFAULT_RANK_CONFIG = Object.freeze({
  // Net below this (quote currency) but >= 0 is "marginal" rather than clearly
  // profitable. Lets callers avoid chasing dust edges.
  marginalNetFloor: 1,
  // When true, 'avoid' rows are dropped from the result entirely instead of
  // being demoted to the bottom. Default keeps them (demoted + flagged).
  excludeAvoid: false,
});

/**
 * Derive a per-row verdict from the net result and the trap verdict.
 * @param {number} net net-after-costs in quote currency.
 * @param {string} trapVerdict 'ok' | 'suspicious' | 'avoid'.
 * @param {number} marginalNetFloor threshold between marginal and profitable.
 * @returns {'profitable'|'marginal'|'unprofitable'|'trap/avoid'}
 */
export function rowVerdict(net, trapVerdict, marginalNetFloor) {
  if (trapVerdict === 'avoid') return 'trap/avoid';
  if (net <= 0) return 'unprofitable';
  if (net < marginalNetFloor) return 'marginal';
  return 'profitable';
}

/**
 * Rank arbitrage candidates for display.
 *
 * @param {Array<object>} candidates each candidate should carry at least:
 *   { net:number, trap?:{verdict:string}, ...any other fields }.
 *   `net` is the net-after-costs (quote currency); `trap.verdict` is the trap
 *   classification. Extra fields (pair, rawGap, flags, ...) pass through.
 * @param {object} [config] overrides (see DEFAULT_RANK_CONFIG).
 * @returns {Array<object>} new array of annotated rows. Each row gains
 *   `rowVerdict` and `actionable` (boolean). Non-avoid rows come first sorted
 *   by net descending; avoid rows come last (unless excludeAvoid is set).
 */
export function rankCandidates(candidates = [], config = {}) {
  const cfg = { ...DEFAULT_RANK_CONFIG, ...config };

  const annotated = candidates.map((c) => {
    const trapVerdict = c.trap?.verdict ?? c.trapVerdict ?? 'ok';
    const net = Number(c.net);
    const isAvoid = trapVerdict === 'avoid';
    const verdict = rowVerdict(net, trapVerdict, cfg.marginalNetFloor);
    return {
      ...c,
      net,
      trapVerdict,
      rowVerdict: verdict,
      actionable: !isAvoid && net > 0,
    };
  });

  const survivors = annotated.filter((r) => r.trapVerdict !== 'avoid');
  const avoided = annotated.filter((r) => r.trapVerdict === 'avoid');

  // Best net first among survivors. Deterministic tie-break keeps order stable.
  survivors.sort((a, b) => {
    if (b.net !== a.net) return b.net - a.net;
    return 0;
  });
  // Avoid rows: also net-desc among themselves, purely for readable output.
  avoided.sort((a, b) => b.net - a.net);

  if (cfg.excludeAvoid) return survivors;
  return [...survivors, ...avoided];
}

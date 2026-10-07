// Pure candidate ranking. NO network, NO I/O, NO imports from evm/rpc.
//
// rankCandidates takes the net-after-costs result plus the trap verdict for
// each candidate pair and produces an ordered, annotated list for display.
// There are THREE tiers, strongest-to-weakest:
//   1. clean survivors (trap verdict 'ok')      — sorted by net descending;
//   2. suspicious survivors (soft traps: thin /  — demoted below ALL clean
//      one-sided / low-pool-count)                 survivors but still visible,
//                                                   sorted by net among
//                                                   themselves, labelled
//                                                   'suspicious';
//   3. avoid rows (hard traps: sell-blocked /    — demoted to the very bottom,
//      fee-on-transfer)                             never actionable, optionally
//                                                   excluded entirely.
// This keeps a thin/one-sided/low-pool pair OFF the top "clean opportunity"
// line even when its (slippage-light) net is high: a soft-trap pair can never
// outrank a clean profitable survivor.
//
// Every row gets a final per-row verdict combining net sign and trap verdict:
//   'profitable' | 'marginal' | 'unprofitable' | 'suspicious' | 'trap/avoid'.

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
 *
 * A hard trap ('avoid') always wins. A soft trap ('suspicious') yields the
 * dedicated 'suspicious' verdict so a thin / one-sided / low-pool pair is NEVER
 * presented as a clean 'profitable' opportunity, regardless of its (often
 * slippage-light, overstated) net. Only genuinely clean rows reach the net-sign
 * ladder of profitable / marginal / unprofitable.
 *
 * @param {number} net net-after-costs in quote currency.
 * @param {string} trapVerdict 'ok' | 'suspicious' | 'avoid'.
 * @param {number} marginalNetFloor threshold between marginal and profitable.
 * @returns {'profitable'|'marginal'|'unprofitable'|'suspicious'|'trap/avoid'}
 */
export function rowVerdict(net, trapVerdict, marginalNetFloor) {
  if (trapVerdict === 'avoid') return 'trap/avoid';
  if (trapVerdict === 'suspicious') return 'suspicious';
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
 *   `rowVerdict` and `actionable` (boolean). Ordering is three-tiered: clean
 *   survivors (net desc) first, then suspicious soft-trap rows (net desc),
 *   then avoid rows (net desc, unless excludeAvoid drops them). Only clean rows
 *   with positive net are `actionable`.
 */
export function rankCandidates(candidates = [], config = {}) {
  const cfg = { ...DEFAULT_RANK_CONFIG, ...config };

  const annotated = candidates.map((c) => {
    const trapVerdict = c.trap?.verdict ?? c.trapVerdict ?? 'ok';
    const net = Number(c.net);
    const isAvoid = trapVerdict === 'avoid';
    const isSuspicious = trapVerdict === 'suspicious';
    const verdict = rowVerdict(net, trapVerdict, cfg.marginalNetFloor);
    return {
      ...c,
      net,
      trapVerdict,
      rowVerdict: verdict,
      // Only a clean (non-trap) row with a positive net is a real opportunity.
      // Suspicious rows stay visible but are NOT actionable: their net is
      // typically overstated (shallow/one-sided depth) and must not be chased.
      actionable: !isAvoid && !isSuspicious && net > 0,
    };
  });

  const clean = annotated.filter((r) => r.trapVerdict === 'ok');
  const suspicious = annotated.filter((r) => r.trapVerdict === 'suspicious');
  const avoided = annotated.filter((r) => r.trapVerdict === 'avoid');

  // Net descending within each tier. Deterministic tie-break keeps order stable.
  const byNetDesc = (a, b) => (b.net !== a.net ? b.net - a.net : 0);
  clean.sort(byNetDesc);
  suspicious.sort(byNetDesc);
  avoided.sort(byNetDesc);

  if (cfg.excludeAvoid) return [...clean, ...suspicious];
  return [...clean, ...suspicious, ...avoided];
}

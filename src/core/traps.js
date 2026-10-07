// Pure honeypot / trap heuristics. NO network, NO I/O, NO imports from
// evm/rpc. evaluateTraps takes data that was ALREADY fetched elsewhere (pool
// reserves, a simulated buy output, a simulated sell result) and classifies
// the token with flags + a verdict. The evm layer is responsible for doing the
// eth_call simulations; this module only interprets the outcomes.
//
// Verdict mapping:
//   - any SELL_BLOCKED/NON_SELLABLE or FEE_ON_TRANSFER => 'avoid'
//   - thin or one-sided liquidity alone                => 'suspicious'
//   - nothing flagged                                  => 'ok'
//
// All thresholds come in through the config argument with sane defaults so the
// heuristics are tunable without code changes.

export const FLAGS = Object.freeze({
  FEE_ON_TRANSFER: 'FEE_ON_TRANSFER',
  SELL_BLOCKED: 'SELL_BLOCKED',
  NON_SELLABLE: 'NON_SELLABLE',
  THIN_LIQUIDITY: 'THIN_LIQUIDITY',
  ONE_SIDED_LIQUIDITY: 'ONE_SIDED_LIQUIDITY',
  LOW_POOL_COUNT: 'LOW_POOL_COUNT',
});

export const DEFAULT_TRAP_CONFIG = Object.freeze({
  // Relative mismatch between expected and simulated output above which we
  // treat the token as taking a cut on transfer (fee-on-transfer). 2%.
  feeOnTransferTolerance: 0.02,
  // Minimum acceptable pool depth (reserve or TVL) in the quote currency.
  // Below this a pool is "thin" and prone to manipulation / huge slippage.
  minLiquidityFloor: 10000,
  // Maximum acceptable reserve ratio (larger / smaller). Beyond this the pool
  // is "one-sided" and the price is unreliable. 50x by default.
  maxReserveSkew: 50,
  // Minimum number of discoverable pools before we flag LOW_POOL_COUNT.
  minPoolCount: 2,
});

function toNum(v) {
  if (typeof v === 'bigint') return Number(v);
  return Number(v);
}

/**
 * Evaluate honeypot/trap heuristics for a token.
 *
 * @param {object} tokenData already-fetched signals:
 *   @param {bigint|number} [tokenData.expectedOut] amount a normal sell should
 *     return (from the AMM math).
 *   @param {bigint|number} [tokenData.simulatedOut] amount the simulated sell
 *     actually returned (eth_call). Mismatch => fee-on-transfer.
 *   @param {boolean} [tokenData.sellReverted] true if the simulated sell call
 *     reverted => sell is blocked.
 *   @param {bigint|number} [tokenData.simulatedSellOut] output of the simulated
 *     sell; zero (with a non-zero input) => non-sellable.
 *   @param {bigint|number} [tokenData.liquidity] pool depth / TVL in the quote
 *     currency used for the thin-liquidity test.
 *   @param {bigint|number} [tokenData.reserve0] raw reserve of token0.
 *   @param {bigint|number} [tokenData.reserve1] raw reserve of token1.
 *   @param {number} [tokenData.poolCount] number of discoverable pools.
 * @param {object} [config] threshold overrides (see DEFAULT_TRAP_CONFIG).
 * @returns {{ flags: string[], verdict: 'ok'|'suspicious'|'avoid',
 *             reasons: string[] }}
 */
export function evaluateTraps(tokenData = {}, config = {}) {
  const cfg = { ...DEFAULT_TRAP_CONFIG, ...config };
  const flags = [];
  const reasons = [];

  // (b) SELL_BLOCKED — a reverted simulated sell means the token cannot be
  // sold on-chain (classic honeypot).
  if (tokenData.sellReverted === true) {
    flags.push(FLAGS.SELL_BLOCKED);
    reasons.push('Simulated sell reverted: token appears non-sellable.');
  }

  // NON_SELLABLE — the simulated sell returned zero output for a non-zero
  // input, which is functionally the same as a blocked sell.
  if (tokenData.simulatedSellOut !== undefined) {
    const out = toNum(tokenData.simulatedSellOut);
    if (out === 0) {
      flags.push(FLAGS.NON_SELLABLE);
      reasons.push('Simulated sell returned zero output: token non-sellable.');
    }
  }

  // (a) FEE_ON_TRANSFER — the simulated output falls short of the expected
  // output by more than the tolerance, implying the transfer takes a cut.
  if (
    tokenData.expectedOut !== undefined &&
    tokenData.simulatedOut !== undefined
  ) {
    const expected = toNum(tokenData.expectedOut);
    const simulated = toNum(tokenData.simulatedOut);
    if (expected > 0) {
      const shortfall = (expected - simulated) / expected;
      if (shortfall > cfg.feeOnTransferTolerance) {
        flags.push(FLAGS.FEE_ON_TRANSFER);
        reasons.push(
          `Simulated output ${(shortfall * 100).toFixed(2)}% below expected: ` +
            'fee-on-transfer suspected.',
        );
      }
    }
  }

  // (c) THIN_LIQUIDITY — pool depth below the configured floor.
  if (tokenData.liquidity !== undefined) {
    const liq = toNum(tokenData.liquidity);
    if (liq < cfg.minLiquidityFloor) {
      flags.push(FLAGS.THIN_LIQUIDITY);
      reasons.push(
        `Liquidity ${liq} below floor ${cfg.minLiquidityFloor}: thin pool.`,
      );
    }
  }

  // (d) ONE_SIDED_LIQUIDITY — reserve ratio beyond the skew bound.
  if (tokenData.reserve0 !== undefined && tokenData.reserve1 !== undefined) {
    const r0 = toNum(tokenData.reserve0);
    const r1 = toNum(tokenData.reserve1);
    if (r0 > 0 && r1 > 0) {
      const skew = Math.max(r0, r1) / Math.min(r0, r1);
      if (skew > cfg.maxReserveSkew) {
        flags.push(FLAGS.ONE_SIDED_LIQUIDITY);
        reasons.push(
          `Reserve skew ${skew.toFixed(1)}x exceeds ${cfg.maxReserveSkew}x: ` +
            'one-sided liquidity.',
        );
      }
    }
  }

  // (e) LOW_POOL_COUNT (optional) — too few pools to be confident.
  if (tokenData.poolCount !== undefined) {
    if (Number(tokenData.poolCount) < cfg.minPoolCount) {
      flags.push(FLAGS.LOW_POOL_COUNT);
      reasons.push(
        `Only ${tokenData.poolCount} pool(s) found (<${cfg.minPoolCount}).`,
      );
    }
  }

  // --- verdict -------------------------------------------------------------
  const hardTrap =
    flags.includes(FLAGS.SELL_BLOCKED) ||
    flags.includes(FLAGS.NON_SELLABLE) ||
    flags.includes(FLAGS.FEE_ON_TRANSFER);

  const softTrap =
    flags.includes(FLAGS.THIN_LIQUIDITY) ||
    flags.includes(FLAGS.ONE_SIDED_LIQUIDITY) ||
    flags.includes(FLAGS.LOW_POOL_COUNT);

  let verdict = 'ok';
  if (hardTrap) verdict = 'avoid';
  else if (softTrap) verdict = 'suspicious';

  return { flags, verdict, reasons };
}

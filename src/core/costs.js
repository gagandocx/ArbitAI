// Pure net-after-costs math. NO network, NO I/O, NO imports from evm/rpc.
//
// A positive cross-DEX "raw gap" is meaningless on its own: executing the
// round-trip burns the buy-side DEX fee, the sell-side DEX fee, slippage
// (price impact that grows with trade size relative to pool depth), and gas.
// computeNetResult subtracts ALL of those so the scanner reports a realistic
// NET edge rather than a false positive.
//
// Everything here is deterministic. Monetary results are Numbers expressed in
// the quote currency (e.g. USD). Trade size is also in the quote currency.
// Where pool depth is supplied as raw BigInt reserves we fold them into the
// price-impact model; the impact itself is a dimensionless fraction so the
// BigInt -> Number conversion only affects display-level precision.

import { amountOutV2 } from './pricing.js';

/**
 * Price-impact fraction for one constant-product leg, derived from the actual
 * V2 output curve. Impact = 1 - (realizedPrice / midPrice), i.e. how much
 * worse than the no-slippage mid price this trade executes at.
 *
 * midOut   = amountIn * reserveOut / reserveIn            (no fee, no impact)
 * realOut  = amountOutV2(amountIn, reserveIn, reserveOut, feeBps)
 * impact   = (midOut - realOut) / midOut                  (includes fee+impact)
 *
 * To isolate SLIPPAGE from the fee we compute the fee-free output curve for
 * the impact portion (feeBps = 0) and let the explicit fee terms handle fees.
 *
 * @returns {number} slippage fraction in [0, 1) for this leg.
 */
export function legSlippageFraction(amountIn, reserveIn, reserveOut) {
  const aIn = BigInt(amountIn);
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  if (aIn <= 0n) return 0;
  if (rIn <= 0n || rOut <= 0n) {
    throw new Error('costs: reserves must be positive for slippage');
  }
  // Fee-free mid output (linear, no impact): amountIn * rOut / rIn.
  const midOut = (aIn * rOut) / rIn;
  // Fee-free realized output along the curve (feeBps = 0) isolates impact.
  const realOut = amountOutV2(aIn, rIn, rOut, 0);
  if (midOut <= 0n) return 0;
  // Dimensionless fraction; Number conversion is display-precision only.
  const impact = Number(midOut - realOut) / Number(midOut);
  return impact < 0 ? 0 : impact;
}

/**
 * Compute the realistic net result of a round-trip arbitrage after fees,
 * slippage, and gas.
 *
 * @param {object} params
 * @param {number} params.tradeSize notional trade size in the quote currency
 *   (e.g. USD). Alias: params.amountInUsd.
 * @param {number} params.rawGapFraction fractional price gap between the two
 *   DEXes before costs (e.g. 0.012 for 1.2%).
 * @param {number} params.buyFeeBps buy-side DEX fee in basis points.
 * @param {number} params.sellFeeBps sell-side DEX fee in basis points.
 * @param {number} [params.gasUsdEstimate=0] estimated gas cost already in the
 *   quote currency. Mutually exclusive-ish with gasUnits/gasPrice below.
 * @param {number} [params.gasUnits] gas units for the round-trip (optional).
 * @param {number} [params.gasPrice] gas price in the quote currency PER gas
 *   unit (already converted). If both gasUnits and gasPrice are supplied the
 *   gas cost is gasUnits * gasPrice; otherwise gasUsdEstimate is used.
 * @param {object} [params.slippageModel] optional explicit depth model:
 *   { buyReserveIn, buyReserveOut, sellReserveIn, sellReserveOut, amountIn }
 *   where amountIn is in the SAME base units as the reserves. When provided,
 *   slippage is derived from the constant-product price impact on BOTH legs.
 * @param {number} [params.slippageFraction] fallback flat slippage fraction if
 *   no depth model is supplied (defaults to 0).
 * @param {number} [params.slippageFloor] a minimum slippage fraction applied
 *   even when a depth model IS supplied. Guards against understating impact
 *   when one leg (e.g. a V3 quoter) exposes no reserves to model. The final
 *   slippage fraction is max(modelled-or-flat, floor).
 * @param {string} [params.buyDex] label, carried through for reporting.
 * @param {string} [params.sellDex] label, carried through for reporting.
 * @returns {{ rawGap:number, grossGap:number, feeCost:number,
 *   slippageCost:number, gasCost:number, net:number, netFraction:number }}
 *   All monetary fields are in the quote currency; fractions are dimensionless.
 */
export function computeNetResult(params) {
  const {
    tradeSize,
    amountInUsd,
    rawGapFraction,
    buyFeeBps = 0,
    sellFeeBps = 0,
    gasUsdEstimate = 0,
    gasUnits,
    gasPrice,
    slippageModel,
    slippageFraction = 0,
    slippageFloor = 0,
    buyDex = null,
    sellDex = null,
  } = params;

  const size = Number(tradeSize ?? amountInUsd);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('costs: tradeSize (or amountInUsd) must be a positive number');
  }
  if (!Number.isFinite(rawGapFraction)) {
    throw new Error('costs: rawGapFraction must be a finite number');
  }

  // Raw gap and gross gap are both the pre-cost edge in quote currency. We keep
  // them as distinct fields so callers can report the fraction vs the amount.
  const rawGap = rawGapFraction * size;
  const grossGap = rawGap;

  // --- fee cost: BOTH legs pay their DEX fee on the trade size -------------
  const buyFeeFraction = Number(buyFeeBps) / 10000;
  const sellFeeFraction = Number(sellFeeBps) / 10000;
  const feeCost = (buyFeeFraction + sellFeeFraction) * size;

  // --- slippage cost: price impact on each leg from pool depth -------------
  let slipFraction;
  if (slippageModel) {
    const {
      buyReserveIn,
      buyReserveOut,
      sellReserveIn,
      sellReserveOut,
      amountIn,
    } = slippageModel;
    const buySlip = legSlippageFraction(amountIn, buyReserveIn, buyReserveOut);
    const sellSlip = legSlippageFraction(amountIn, sellReserveIn, sellReserveOut);
    slipFraction = buySlip + sellSlip; // impact compounds across both legs
  } else {
    slipFraction = Number(slippageFraction) || 0;
  }
  // Floor guards against understating impact when depth is only partially
  // modelled (e.g. one leg is a reserve-less V3 quoter): never charge less
  // than the configured tolerance.
  const floor = Number(slippageFloor) || 0;
  if (floor > slipFraction) slipFraction = floor;
  const slippageCost = slipFraction * size;

  // --- gas cost: always included, even on cheap chains like Base -----------
  let gasCost;
  if (Number.isFinite(gasUnits) && Number.isFinite(gasPrice)) {
    gasCost = Number(gasUnits) * Number(gasPrice);
  } else {
    gasCost = Number(gasUsdEstimate) || 0;
  }

  const net = grossGap - feeCost - slippageCost - gasCost;
  const netFraction = net / size;

  return {
    rawGap,
    grossGap,
    feeCost,
    slippageCost,
    gasCost,
    net,
    netFraction,
    buyDex,
    sellDex,
  };
}

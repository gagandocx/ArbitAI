// Scanner orchestration. Wires an injected DataSource into the pure FEAT-002
// pipeline (pricing -> traps -> costs -> rank). scan() takes the dataSource by
// injection so it behaves identically for live (RpcDataSource) and offline
// (FixtureDataSource) runs. There are NO direct network calls here: all data
// comes through dataSource.getPairData().

import { evaluateTraps } from './core/traps.js';
import { computeNetResult } from './core/costs.js';
import { rankCandidates } from './core/rank.js';

/**
 * Compute the fractional cross-DEX gap for a pair from per-DEX prices.
 * Returns the best (buy-low / sell-high) opportunity and which DEX is which.
 *
 * @param {Array<{name:string, price:number}>} dexes per-DEX price rows.
 * @returns {{ rawGapFraction:number, buyDex:object, sellDex:object }|null}
 */
export function crossDexGap(dexes) {
  const priced = dexes.filter((d) => Number.isFinite(d.price) && d.price > 0);
  if (priced.length < 2) return null;

  // Price is "quote per 1 base". Buying the base where it is CHEAP (lowest
  // quote-per-base) and selling where it is EXPENSIVE (highest) is the edge.
  let cheapest = priced[0];
  let dearest = priced[0];
  for (const d of priced) {
    if (d.price < cheapest.price) cheapest = d;
    if (d.price > dearest.price) dearest = d;
  }
  if (cheapest === dearest) return null;

  const rawGapFraction = (dearest.price - cheapest.price) / cheapest.price;
  return { rawGapFraction, buyDex: cheapest, sellDex: dearest };
}

/**
 * Scan every configured pair and return ranked candidates.
 *
 * @param {object} config DEFAULT_CONFIG-shaped config.
 * @param {{getPairData: Function}} dataSource injected source (live or fixture).
 * @returns {Promise<Array<object>>} ranked candidate rows (see rank.js).
 */
export async function scan(config, dataSource) {
  if (!config || !Array.isArray(config.pairs)) {
    throw new Error('scan: config with a pairs array is required');
  }
  if (!dataSource || typeof dataSource.getPairData !== 'function') {
    throw new Error('scan: a dataSource with getPairData() is required');
  }

  const trapCfg = config.trap ?? {};
  const rankCfg = config.rank ?? {};
  const tradeSize = config.tradeSize ?? 1000;
  const gasUsdEstimate = config.gasUsdEstimate ?? 0;

  const candidates = [];

  for (const pair of config.pairs) {
    const data = await dataSource.getPairData(pair);
    const pairLabel = `${data.base}/${data.quote}`;

    // --- trap evaluation (uses sell-sim + reserves/liquidity) --------------
    const v2 = data.dexes.find((d) => d.reserveBase != null && d.reserveQuote != null);
    const trap = evaluateTraps(
      {
        sellReverted: data.sell?.sellReverted,
        simulatedSellOut: data.sell?.simulatedSellOut,
        expectedOut: data.sell?.expectedOut,
        simulatedOut: data.sell?.simulatedOut,
        liquidity: data.liquidity,
        reserve0: v2 ? v2.reserveBase : undefined,
        reserve1: v2 ? v2.reserveQuote : undefined,
        poolCount: data.poolCount,
      },
      trapCfg,
    );

    // --- cross-DEX gap -----------------------------------------------------
    const gap = crossDexGap(data.dexes);
    if (!gap) {
      // Not enough priced DEXes to form an opportunity. Still surface the pair
      // so trap-only verdicts (e.g. thin liquidity) are visible.
      candidates.push({
        pair: pairLabel,
        base: data.base,
        quote: data.quote,
        rawGapFraction: 0,
        rawGap: 0,
        net: 0,
        trap,
        flags: trap.flags,
        buyDex: null,
        sellDex: null,
      });
      continue;
    }

    // --- net-after-costs ---------------------------------------------------
    const slippageModel = buildSlippageModel(gap, data, tradeSize);
    const costResult = computeNetResult({
      tradeSize,
      rawGapFraction: gap.rawGapFraction,
      buyFeeBps: gap.buyDex.feeBps ?? 0,
      sellFeeBps: gap.sellDex.feeBps ?? 0,
      gasUsdEstimate,
      slippageModel,
      buyDex: gap.buyDex.name,
      sellDex: gap.sellDex.name,
    });

    candidates.push({
      pair: pairLabel,
      base: data.base,
      quote: data.quote,
      rawGapFraction: gap.rawGapFraction,
      rawGap: costResult.rawGap,
      feeCost: costResult.feeCost,
      slippageCost: costResult.slippageCost,
      gasCost: costResult.gasCost,
      net: costResult.net,
      netFraction: costResult.netFraction,
      buyDex: gap.buyDex.name,
      sellDex: gap.sellDex.name,
      trap,
      flags: trap.flags,
    });
  }

  return rankCandidates(candidates, rankCfg);
}

/**
 * Build the depth-based slippage model for computeNetResult when both legs have
 * V2-style reserves. Falls back to undefined (flat 0 slippage) when reserves
 * are not available (e.g. a V3-only leg), letting fees + gas dominate.
 */
function buildSlippageModel(gap, data, tradeSize) {
  const { buyDex, sellDex } = gap;
  if (
    buyDex.reserveBase == null ||
    buyDex.reserveQuote == null ||
    sellDex.reserveBase == null ||
    sellDex.reserveQuote == null
  ) {
    return undefined;
  }
  // amountIn expressed in base units of the base token, approximated from the
  // trade size and the buy-side price (quote per base).
  const price = buyDex.price > 0 ? buyDex.price : 1;
  const baseUnits = tradeSize / price; // human base tokens
  const amountIn = BigInt(Math.max(0, Math.round(baseUnits * 10 ** data.decimalsBase)));
  return {
    buyReserveIn: buyDex.reserveQuote, // paying quote to receive base
    buyReserveOut: buyDex.reserveBase,
    sellReserveIn: sellDex.reserveBase, // selling base to receive quote
    sellReserveOut: sellDex.reserveQuote,
    amountIn,
  };
}

export default scan;

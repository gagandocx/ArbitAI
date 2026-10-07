// DataSource abstraction: the single seam between the pure scanner pipeline
// and where pool data comes from. The scanner (src/scanner.js) consumes a
// normalized shape and never cares whether it came from a live RPC or a bundled
// fixture. This keeps the scanner identical for live vs offline runs and keeps
// ALL network access behind the RpcDataSource.
//
// Normalized per-pair shape returned by getPairData():
//   {
//     base, quote,                         // token symbols
//     decimalsBase, decimalsQuote,
//     dexes: [
//       {
//         name, kind, feeBps,
//         price,                           // quote per 1 base (Number)
//         reserveBase, reserveQuote,       // raw BigInt reserves (for slippage)
//       }, ...
//     ],
//     sell: {                              // sell-simulation signals per pair
//       sellReverted,                      // boolean (SELL_BLOCKED)
//       simulatedSellOut,                  // bigint (0 => NON_SELLABLE)
//       expectedOut,                       // bigint (vs simulatedOut => FoT)
//       simulatedOut,                      // bigint
//     },
//     liquidity,                           // quote-currency depth (thin check)
//     poolCount,                           // discoverable pool count
//   }
//
// Both implementations return exactly this shape.

import {
  readV2Reserves,
  readV2AmountsOut,
  readV3Quote,
  simulateSell,
} from './evm/pools.js';
import { priceFromReservesV2, priceFromQuote, toHuman } from './core/pricing.js';

/**
 * Base DataSource interface. Concrete sources implement getPairData(pair).
 */
export class DataSource {
  // eslint-disable-next-line no-unused-vars
  async getPairData(pair) {
    throw new Error('DataSource.getPairData must be implemented by a subclass');
  }
}

/**
 * Live data source. Reads reserves/quotes/sell-sim via the read-only provider
 * and pools.js, then normalizes. All network access is confined here.
 */
export class RpcDataSource extends DataSource {
  /**
   * @param {{call: Function}} provider read-only provider (src/evm/rpc.js).
   * @param {object} config a config in the DEFAULT_CONFIG shape.
   * @param {object} [options]
   * @param {(msg:string)=>void} [options.onWarn] sink for non-fatal warnings
   *   (e.g. a V2 leg skipped for lack of a pair address). Defaults to a no-op
   *   so the scanner stays quiet unless a caller wires it up (the CLI routes it
   *   to stderr). Injectable so tests can capture the signal.
   */
  constructor(provider, config, options = {}) {
    super();
    this.provider = provider;
    this.config = config;
    this.onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
  }

  async getPairData(pair) {
    const { tokens, dexes } = this.config;
    const base = tokens[pair.base];
    const quote = tokens[pair.quote];
    if (!base || !quote) {
      throw new Error(`RpcDataSource: unknown token in pair ${pair.base}/${pair.quote}`);
    }

    // A probe amount of 1 base token for mid-price style quotes.
    const probeIn = 10n ** BigInt(base.decimals);

    const dexData = [];
    for (const dex of dexes) {
      if (dex.kind === 'v3') {
        const amountOut = await readV3Quote(this.provider, dex.quoter, {
          tokenIn: base.address,
          tokenOut: quote.address,
          fee: dex.feeBps * 100, // bps -> V3 fee units (0.05% = 500)
          amountIn: probeIn,
        });
        const { price } = priceFromQuote(
          probeIn,
          amountOut,
          base.decimals,
          quote.decimals,
        );
        dexData.push({
          name: dex.name,
          kind: dex.kind,
          feeBps: dex.feeBps,
          price,
          reserveBase: null,
          reserveQuote: null,
        });
      } else {
        // V2: read reserves for an exact mid-price and slippage depth. pair
        // address resolution is config-provided per DEX in a fuller build; here
        // we expect dex.pairs[`${base}/${quote}`] to carry the pair address.
        //
        // When no pair address is configured for this DEX we SKIP this leg
        // rather than abort the whole pair. A reachable RPC can then still
        // return the V3 quote (and any other priced leg) for the pair, so a
        // live scan degrades to a one-sided but useful result instead of
        // throwing a plain Error on the first pair. The scanner treats a pair
        // with fewer than two priced legs as "no cross-DEX opportunity" and
        // still surfaces it for trap-only visibility (see crossDexGap in
        // src/scanner.js). The skip is announced via onWarn so the omission is
        // an explicit signal, never a silent gap.
        const pairAddr = dex.pairs?.[`${pair.base}/${pair.quote}`];
        if (!pairAddr) {
          this.onWarn(
            `RpcDataSource: skipping ${dex.name} leg for ${pair.base}/${pair.quote} ` +
              `(no V2 pair address configured for ${dex.name}); reporting the ` +
              'remaining leg(s) only.',
          );
          continue;
        }
        const { reserve0, reserve1 } = await readV2Reserves(this.provider, pairAddr);
        const { price } = priceFromReservesV2(
          reserve0,
          reserve1,
          base.decimals,
          quote.decimals,
        );
        dexData.push({
          name: dex.name,
          kind: dex.kind,
          feeBps: dex.feeBps,
          price,
          reserveBase: reserve0,
          reserveQuote: reserve1,
        });
      }
    }

    // Sell simulation against the first DEX that can sell (router or quoter).
    const sellDex = dexes.find((d) => d.router || d.quoter) ?? dexes[0];
    const sellIn = probeIn;
    const sellResult = await simulateSell(this.provider, {
      kind: sellDex.kind,
      router: sellDex.router,
      quoter: sellDex.quoter,
      token: base.address,
      referenceToken: quote.address,
      amountIn: sellIn,
      fee: sellDex.feeBps * 100,
    });

    // Expected out from the best V2 reserves we have, used for FoT comparison.
    const v2 = dexData.find((d) => d.reserveBase != null);
    const expectedOut = v2 ? BigInt(Math.round(v2.price * Number(toHuman(sellIn, base.decimals)) * 10 ** quote.decimals)) : undefined;

    const liquidity = v2
      ? toHuman(v2.reserveQuote, quote.decimals)
      : undefined;

    return {
      base: pair.base,
      quote: pair.quote,
      decimalsBase: base.decimals,
      decimalsQuote: quote.decimals,
      dexes: dexData,
      sell: {
        sellReverted: sellResult.sellReverted,
        simulatedSellOut: sellResult.simulatedSellOut,
        expectedOut,
        simulatedOut: sellResult.simulatedSellOut,
      },
      liquidity,
      poolCount: dexData.length,
    };
  }
}

/**
 * Offline data source. Returns the same normalized shape straight from a
 * bundled fixture JSON. Reserve-like fields that must be BigInt are coerced
 * from their JSON string/number form here so the scanner sees a uniform shape.
 */
export class FixtureDataSource extends DataSource {
  /**
   * @param {object} fixtureJson parsed fixture (see test/fixtures/base_sample.json).
   */
  constructor(fixtureJson) {
    super();
    if (!fixtureJson || !Array.isArray(fixtureJson.pairs)) {
      throw new Error('FixtureDataSource: fixture must have a pairs array');
    }
    this.fixture = fixtureJson;
    this._byKey = new Map();
    for (const p of fixtureJson.pairs) {
      this._byKey.set(`${p.base}/${p.quote}`, p);
    }
  }

  async getPairData(pair) {
    const key = `${pair.base}/${pair.quote}`;
    const raw = this._byKey.get(key);
    if (!raw) {
      throw new Error(`FixtureDataSource: no fixture data for pair ${key}`);
    }
    return normalizeFixturePair(raw);
  }
}

function toBigIntOrUndef(v) {
  if (v === undefined || v === null) return undefined;
  return BigInt(v);
}

function normalizeFixturePair(raw) {
  const dexes = (raw.dexes ?? []).map((d) => ({
    name: d.name,
    kind: d.kind,
    feeBps: d.feeBps,
    price: Number(d.price),
    reserveBase: toBigIntOrUndef(d.reserveBase) ?? null,
    reserveQuote: toBigIntOrUndef(d.reserveQuote) ?? null,
  }));

  const sellRaw = raw.sell ?? {};
  return {
    base: raw.base,
    quote: raw.quote,
    decimalsBase: raw.decimalsBase,
    decimalsQuote: raw.decimalsQuote,
    dexes,
    sell: {
      sellReverted: sellRaw.sellReverted === true,
      simulatedSellOut: toBigIntOrUndef(sellRaw.simulatedSellOut) ?? 0n,
      expectedOut: toBigIntOrUndef(sellRaw.expectedOut),
      simulatedOut: toBigIntOrUndef(sellRaw.simulatedOut),
    },
    liquidity: raw.liquidity === undefined ? undefined : Number(raw.liquidity),
    poolCount: raw.poolCount === undefined ? dexes.length : Number(raw.poolCount),
  };
}

export default DataSource;

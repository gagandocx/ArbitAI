// Default configuration used to drive scan() and the scanner test.
//
// This now composes the chain / DEX / token definitions from the dedicated
// config modules (chains.js, dexes.js, tokens.js) rather than duplicating them,
// while preserving the exact exported shape earlier features depend on
// (TOKENS, DEXES, PAIRS, DEFAULT_CONFIG). The user-facing config entrypoint
// (buildConfig + CLI env/flag resolution) lives in index.js and builds on this.
//
// STRICTLY READ-ONLY: this config holds no secrets and drives read-only calls.

import { BASE } from './chains.js';
import { BASE_DEXES } from './dexes.js';
import { BASE_TOKENS, BASE_PAIRS } from './tokens.js';

// Curated majors (+ a couple of mid-caps) on Base with their correct decimals.
export const TOKENS = BASE_TOKENS;

// The two DEXes compared by default (one V3-style quoter, one V2-style router).
export const DEXES = BASE_DEXES;

// Pairs to scan (base/quote). The fixture provides data for each of these.
export const PAIRS = BASE_PAIRS;

// Default thresholds for the pure trap/rank layers (surfaced here so the CLI
// can expose them as flags).
export const DEFAULT_TRAP = Object.freeze({
  feeOnTransferTolerance: 0.02,
  minLiquidityFloor: 10000,
  maxReserveSkew: 50,
  minPoolCount: 2,
});

export const DEFAULT_RANK = Object.freeze({
  marginalNetFloor: 1,
  excludeAvoid: false,
});

export const DEFAULT_CONFIG = Object.freeze({
  chain: Object.freeze({ name: BASE.name, chainId: BASE.chainId }),
  tokens: TOKENS,
  dexes: DEXES,
  pairs: PAIRS,

  // Notional trade size (quote currency) used for net-after-costs + slippage.
  tradeSize: 10000,
  // Slippage tolerance (fraction) the user is willing to accept; informational
  // for reporting (the realistic slippage cost is derived from pool depth).
  slippageTolerance: 0.005,
  // Gas estimate for a round-trip, in the quote currency.
  gasUsdEstimate: 0.5,
  // Rough gas units for a two-leg round-trip (used when a gas price is known).
  gasUnitsEstimate: 400000,

  trap: DEFAULT_TRAP,
  rank: DEFAULT_RANK,
});

export default DEFAULT_CONFIG;

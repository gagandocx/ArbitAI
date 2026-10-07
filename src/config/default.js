// Minimal default configuration used to drive scan() and the scanner test.
//
// This is intentionally small: it carries just enough to describe the Base
// chain, two DEXes to compare (Uniswap V3 vs Aerodrome), a curated set of
// major tokens, the pairs to scan, and the cost/trap/rank knobs the pure
// pipeline needs. A full user-facing config module (CLI flags, env-var RPC key,
// multiple chains) arrives in FEAT-004 and will build on this shape.
//
// STRICTLY READ-ONLY: this config holds no secrets and drives read-only calls.

// Curated majors on Base with their correct decimals.
export const TOKENS = Object.freeze({
  WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  USDC: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  USDT: { symbol: 'USDT', address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6 },
  DAI: { symbol: 'DAI', address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', decimals: 18 },
  cbETH: { symbol: 'cbETH', address: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', decimals: 18 },
});

// The two DEXes compared by default. One V3-style (quoter) and one V2-style
// (reserves + router) to exercise both read paths.
export const DEXES = Object.freeze([
  {
    name: 'UniswapV3',
    kind: 'v3',
    feeBps: 5, // 0.05% tier used for stable/major pairs
    quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
  },
  {
    name: 'Aerodrome',
    kind: 'v2',
    feeBps: 30, // 0.30% classic V2 fee
    router: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    factory: '0x420dd381b31aef6683db6b902084cb0ffece40da',
  },
]);

// Pairs to scan (base/quote). The fixture provides data for each of these.
export const PAIRS = Object.freeze([
  { base: 'WETH', quote: 'USDC' }, // profitable-after-costs
  { base: 'cbETH', quote: 'WETH' }, // positive raw gap but negative net
  { base: 'DAI', quote: 'USDC' }, // fee-on-transfer trap
  { base: 'USDT', quote: 'USDC' }, // sell-blocked trap
  { base: 'USDC', quote: 'WETH' }, // thin / one-sided liquidity
]);

export const DEFAULT_CONFIG = Object.freeze({
  chain: Object.freeze({ name: 'Base', chainId: 8453 }),
  tokens: TOKENS,
  dexes: DEXES,
  pairs: PAIRS,

  // Notional trade size (quote currency) used for net-after-costs + slippage.
  tradeSize: 10000,
  // Gas estimate for a round-trip, in the quote currency.
  gasUsdEstimate: 0.5,

  // Thresholds for the pure layers. Each defaults inside its module too; these
  // are surfaced here so FEAT-004 can expose them as flags.
  trap: Object.freeze({
    feeOnTransferTolerance: 0.02,
    minLiquidityFloor: 10000,
    maxReserveSkew: 50,
    minPoolCount: 2,
  }),
  rank: Object.freeze({
    marginalNetFloor: 1,
    excludeAvoid: false,
  }),
});

export default DEFAULT_CONFIG;

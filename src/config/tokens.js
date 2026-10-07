// Curated token lists per chain, with correct addresses and decimals. The tool
// deliberately scans a SMALL curated set of majors plus a couple of liquid
// mid-caps rather than micro-caps, so the cross-DEX gaps it reports are real
// and not just thin-pool noise.
//
// Addresses are checksummed-lowercased; decimals are the on-chain values.

// Base majors + a couple of liquid mid-caps.
export const BASE_TOKENS = Object.freeze({
  // --- majors --------------------------------------------------------------
  WETH: Object.freeze({ symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 }),
  USDC: Object.freeze({ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 }),
  USDT: Object.freeze({ symbol: 'USDT', address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6 }),
  DAI: Object.freeze({ symbol: 'DAI', address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', decimals: 18 }),
  cbETH: Object.freeze({ symbol: 'cbETH', address: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', decimals: 18 }),
  // --- liquid mid-caps -----------------------------------------------------
  AERO: Object.freeze({ symbol: 'AERO', address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', decimals: 18 }),
  DEGEN: Object.freeze({ symbol: 'DEGEN', address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', decimals: 18 }),
});

// Default pairs to scan on Base (base/quote). Keep this aligned with the
// bundled fixture so the offline demo exercises every scanner outcome.
export const BASE_PAIRS = Object.freeze([
  Object.freeze({ base: 'WETH', quote: 'USDC' }), // profitable-after-costs
  Object.freeze({ base: 'cbETH', quote: 'WETH' }), // positive raw gap, negative net
  Object.freeze({ base: 'DAI', quote: 'USDC' }), // fee-on-transfer trap
  Object.freeze({ base: 'USDT', quote: 'USDC' }), // sell-blocked trap
  Object.freeze({ base: 'USDC', quote: 'WETH' }), // thin / one-sided liquidity
]);

export const TOKENS_BY_CHAIN = Object.freeze({
  base: BASE_TOKENS,
});

export const PAIRS_BY_CHAIN = Object.freeze({
  base: BASE_PAIRS,
});

// ---------------------------------------------------------------------------
// SWAPPABILITY STUBS (commented). Define the chain's majors + mid-caps and its
// default pairs, then register them in TOKENS_BY_CHAIN / PAIRS_BY_CHAIN.
// ---------------------------------------------------------------------------
//
// export const BSC_TOKENS = Object.freeze({
//   WBNB: Object.freeze({ symbol: 'WBNB', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', decimals: 18 }),
//   USDT: Object.freeze({ symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 }),
//   BUSD: Object.freeze({ symbol: 'BUSD', address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', decimals: 18 }),
// });
//
// export const ARBITRUM_TOKENS = Object.freeze({
//   WETH: Object.freeze({ symbol: 'WETH', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 }),
//   USDC: Object.freeze({ symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 }),
//   ARB: Object.freeze({ symbol: 'ARB', address: '0x912ce59144191c1204e64559fe8253a0e49e6548', decimals: 18 }),
// });

export default TOKENS_BY_CHAIN;

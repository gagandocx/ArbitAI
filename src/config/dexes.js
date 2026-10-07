// DEX definitions per chain. Each DEX carries its name, read style ('v3' with a
// quoter, or 'v2' with reserves + router + factory), and its fee tier(s) in
// basis points. The scanner reads prices/reserves from these ONLY via eth_call.
//
// Base defaults to comparing TWO DEXes:
//   - Uniswap V3 (quoter + factory, 0.05% tier for stable/major pairs)
//   - Aerodrome  (classic V2 reserves + router + factory, 0.30% fee)
//
// BSC/PancakeSwap and Arbitrum/Camelot stubs are provided (commented) below to
// show how to swap the DEX set without touching the pipeline.

export const BASE_DEXES = Object.freeze([
  Object.freeze({
    name: 'UniswapV3',
    kind: 'v3',
    feeBps: 5, // 0.05% tier used for stable/major pairs
    // Fee tiers available on Uniswap V3 (bps). The scanner uses feeBps above
    // by default; multi-tier scanning can iterate these.
    feeTiersBps: Object.freeze([1, 5, 30, 100]),
    quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
    factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  }),
  Object.freeze({
    name: 'Aerodrome',
    kind: 'v2',
    feeBps: 30, // 0.30% classic V2 fee
    router: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    factory: '0x420dd381b31aef6683db6b902084cb0ffece40da',
    // Optional per-pair address map (base/quote -> pair address) for V2 reads.
    // Populated per deployment; live reads require these to be filled in.
    pairs: Object.freeze({}),
  }),
]);

// DEX sets keyed by chain.
export const DEXES_BY_CHAIN = Object.freeze({
  base: BASE_DEXES,
});

// ---------------------------------------------------------------------------
// SWAPPABILITY STUBS (commented).
// ---------------------------------------------------------------------------
//
// export const BSC_DEXES = Object.freeze([
//   Object.freeze({
//     name: 'PancakeSwapV3',
//     kind: 'v3',
//     feeBps: 5,
//     feeTiersBps: Object.freeze([1, 5, 25, 100]),
//     quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
//     factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
//   }),
//   Object.freeze({
//     name: 'PancakeSwapV2',
//     kind: 'v2',
//     feeBps: 25, // 0.25%
//     router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
//     factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
//     pairs: Object.freeze({}),
//   }),
// ]);
//
// export const ARBITRUM_DEXES = Object.freeze([
//   Object.freeze({
//     name: 'UniswapV3',
//     kind: 'v3',
//     feeBps: 5,
//     feeTiersBps: Object.freeze([1, 5, 30, 100]),
//     quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
//     factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
//   }),
//   Object.freeze({
//     name: 'Camelot',
//     kind: 'v2',
//     feeBps: 30,
//     router: '0xc873fecbd354f5a56e00e710b90ef4201db2448d',
//     factory: '0x6eccab422d763ac031210895c81787e87b43a652',
//     pairs: Object.freeze({}),
//   }),
// ]);

export default DEXES_BY_CHAIN;

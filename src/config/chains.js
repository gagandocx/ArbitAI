// Chain definitions. Each chain carries its id, a human name, the quote
// currency symbol used for cost/gas accounting, and a default RPC endpoint.
//
// Base is the DEFAULT: a cheap, high-liquidity L2 that is ideal for a read-only
// cross-DEX scanner. BSC and Arbitrum are provided as COMMENTED stubs further
// down to demonstrate that swapping chains is purely a config change.
//
// STRICTLY READ-ONLY: these endpoints are used for eth_call / view reads only.

/**
 * Resolve the Base RPC endpoint. Priority:
 *   1. process.env.RPC_URL                       (explicit override)
 *   2. composed Alchemy URL when ALCHEMY_KEY set (no secret hardcoded)
 *   3. a free public Base endpoint               (default)
 *
 * @param {object} [env=process.env] environment to read from (injectable).
 * @returns {string} the resolved RPC URL.
 */
export function resolveBaseRpcUrl(env = process.env) {
  if (env && typeof env.RPC_URL === 'string' && env.RPC_URL.trim() !== '') {
    return env.RPC_URL.trim();
  }
  if (env && typeof env.ALCHEMY_KEY === 'string' && env.ALCHEMY_KEY.trim() !== '') {
    return `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY.trim()}`;
  }
  return PUBLIC_BASE_RPC_URL;
}

// A free, public Base mainnet endpoint. No key required.
export const PUBLIC_BASE_RPC_URL = 'https://mainnet.base.org';

export const BASE = Object.freeze({
  key: 'base',
  name: 'Base',
  chainId: 8453,
  quoteSymbol: 'USDC',
  // Resolved lazily by the config index so env changes are honored per run.
  defaultRpcUrl: PUBLIC_BASE_RPC_URL,
});

// All chains known to the tool, keyed by their CLI --chain value.
export const CHAINS = Object.freeze({
  base: BASE,
});

// The chain used when --chain is not supplied.
export const DEFAULT_CHAIN_KEY = 'base';

// ---------------------------------------------------------------------------
// SWAPPABILITY STUBS (commented). To scan another chain, uncomment the block,
// add the matching DEX + token definitions (see dexes.js / tokens.js), and
// register it in CHAINS above. Nothing else in the pipeline needs to change.
// ---------------------------------------------------------------------------
//
// export const BSC = Object.freeze({
//   key: 'bsc',
//   name: 'BNB Smart Chain',
//   chainId: 56,
//   quoteSymbol: 'USDT',
//   defaultRpcUrl: 'https://bsc-dataseed.binance.org',
// });
//
// export const ARBITRUM = Object.freeze({
//   key: 'arbitrum',
//   name: 'Arbitrum One',
//   chainId: 42161,
//   quoteSymbol: 'USDC',
//   defaultRpcUrl: 'https://arb1.arbitrum.io/rpc',
// });

export default CHAINS;

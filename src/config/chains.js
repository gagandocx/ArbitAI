// Chain definitions. Each chain carries its id, a human name, the quote
// currency symbol used for cost/gas accounting, and a default RPC endpoint.
//
// Base is the DEFAULT: a cheap, high-liquidity L2 that is ideal for a read-only
// cross-DEX scanner. BNB Smart Chain and Arbitrum One are also supported; each
// chain is purely a config change (chain descriptor + DEX set + token list).
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

// Free, public mainnet endpoints. No key required.
export const PUBLIC_BASE_RPC_URL = 'https://mainnet.base.org';
export const PUBLIC_BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
export const PUBLIC_ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';

export const BASE = Object.freeze({
  key: 'base',
  name: 'Base',
  chainId: 8453,
  quoteSymbol: 'USDC',
  // Resolved lazily by the config index so env changes are honored per run.
  defaultRpcUrl: PUBLIC_BASE_RPC_URL,
  // Alchemy subdomain used when ALCHEMY_KEY is set (no secret hardcoded).
  alchemyHost: 'base-mainnet.g.alchemy.com',
  // Gas accounting fallbacks (native is ETH on this L2). buildConfig reads
  // these when overrides are not supplied.
  defaultGasPriceGwei: 0.02,
  nativeQuotePrice: 3000,
});

export const BSC = Object.freeze({
  key: 'bsc',
  name: 'BNB Smart Chain',
  chainId: 56,
  quoteSymbol: 'USDT',
  defaultRpcUrl: PUBLIC_BSC_RPC_URL,
  alchemyHost: 'bnb-mainnet.g.alchemy.com',
  // Native token is BNB; quote is USDT. BSC gas is denominated in BNB, so
  // nativeQuotePrice is BNB priced in USDT.
  defaultGasPriceGwei: 1,
  nativeQuotePrice: 600,
});

export const ARBITRUM = Object.freeze({
  key: 'arbitrum',
  name: 'Arbitrum One',
  chainId: 42161,
  quoteSymbol: 'USDC',
  defaultRpcUrl: PUBLIC_ARBITRUM_RPC_URL,
  alchemyHost: 'arb-mainnet.g.alchemy.com',
  // Native token is ETH; quote is USDC.
  defaultGasPriceGwei: 0.1,
  nativeQuotePrice: 3000,
});

// All chains known to the tool, keyed by their CLI --chain value.
export const CHAINS = Object.freeze({
  base: BASE,
  bsc: BSC,
  arbitrum: ARBITRUM,
});

// The chain used when --chain is not supplied.
export const DEFAULT_CHAIN_KEY = 'base';

export default CHAINS;

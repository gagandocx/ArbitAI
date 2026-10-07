// Config entrypoint. Composes a run-ready config from the chain / DEX / token
// modules and applies environment + CLI overrides. This is the single place the
// CLI imports from to get a resolved config and RPC URL.
//
// STRICTLY READ-ONLY: no secrets are stored here; the RPC URL is resolved from
// the environment at call time and used only for read calls.

import { CHAINS, DEFAULT_CHAIN_KEY, resolveBaseRpcUrl } from './chains.js';
import { DEXES_BY_CHAIN } from './dexes.js';
import { TOKENS_BY_CHAIN, PAIRS_BY_CHAIN } from './tokens.js';
import { DEFAULT_TRAP, DEFAULT_RANK } from './default.js';

export { DEFAULT_CONFIG, TOKENS, DEXES, PAIRS } from './default.js';
export { CHAINS, DEFAULT_CHAIN_KEY, resolveBaseRpcUrl, PUBLIC_BASE_RPC_URL } from './chains.js';

/**
 * Resolve the RPC URL for any chain. Priority (per chain):
 *   1. env.RPC_URL                                (explicit override)
 *   2. composed Alchemy URL when ALCHEMY_KEY set  (per-chain hostname)
 *   3. the chain's public defaultRpcUrl           (no key required)
 *
 * No secret is ever hardcoded: ALCHEMY_KEY is read from the injected env only,
 * and when it is unset the public endpoint is used instead.
 *
 * @param {object} chain a chain descriptor from CHAINS.
 * @param {object} [env=process.env] environment to read overrides from.
 * @returns {string} the resolved RPC URL.
 */
export function resolveRpcUrl(chain, env = process.env) {
  // Base keeps its dedicated resolver for backward compatibility; it applies
  // the same RPC_URL -> Alchemy -> public priority.
  if (chain && chain.key === 'base') return resolveBaseRpcUrl(env);

  // (1) Explicit override wins for any chain.
  if (env && typeof env.RPC_URL === 'string' && env.RPC_URL.trim() !== '') {
    return env.RPC_URL.trim();
  }
  // (2) Compose a per-chain Alchemy URL when a key is present.
  if (
    chain &&
    chain.alchemyHost &&
    env &&
    typeof env.ALCHEMY_KEY === 'string' &&
    env.ALCHEMY_KEY.trim() !== ''
  ) {
    return `https://${chain.alchemyHost}/v2/${env.ALCHEMY_KEY.trim()}`;
  }
  // (3) Public default endpoint.
  return chain ? chain.defaultRpcUrl : undefined;
}

/**
 * Build a run-ready config for a given chain plus optional overrides.
 *
 * @param {object} [opts]
 * @param {string} [opts.chainKey] CLI --chain value (defaults to Base).
 * @param {object} [opts.env=process.env] environment for RPC resolution.
 * @param {object} [opts.overrides] field overrides (tradeSize, slippage, pairs,
 *   rpcUrl, trap/rank knobs).
 * @returns {object} a config in the DEFAULT_CONFIG shape, plus `rpcUrl`,
 *   `chainKey`, and a resolved `trap`/`rank`.
 */
export function buildConfig(opts = {}) {
  const { chainKey = DEFAULT_CHAIN_KEY, env = process.env, overrides = {} } = opts;

  const chain = CHAINS[chainKey];
  if (!chain) {
    const known = Object.keys(CHAINS).join(', ');
    throw new Error(`Unknown chain "${chainKey}". Known chains: ${known}.`);
  }

  const tokens = TOKENS_BY_CHAIN[chainKey];
  const dexes = DEXES_BY_CHAIN[chainKey];
  const defaultPairs = PAIRS_BY_CHAIN[chainKey];
  if (!tokens || !dexes || !defaultPairs) {
    throw new Error(`Chain "${chainKey}" is registered but missing token/DEX config.`);
  }

  const pairs = overrides.pairs ?? defaultPairs;
  const rpcUrl = overrides.rpcUrl ?? resolveRpcUrl(chain, env);

  return {
    chainKey,
    chain: { key: chain.key, name: chain.name, chainId: chain.chainId },
    quoteSymbol: chain.quoteSymbol,
    rpcUrl,
    tokens,
    dexes,
    pairs,
    tradeSize: overrides.tradeSize ?? 10000,
    slippageTolerance: overrides.slippageTolerance ?? 0.005,
    gasUsdEstimate: overrides.gasUsdEstimate ?? 0.5,
    gasUnitsEstimate: overrides.gasUnitsEstimate ?? 400000,
    // Gas price (gwei) and native-token price (quote currency) drive the
    // functional units*price gas path. The live RpcDataSource overrides the
    // gas price via provider.getGasPrice(); for offline/fixture runs these
    // supply a realistic, configurable gas cost instead of the flat fallback.
    gasPriceGwei: overrides.gasPriceGwei ?? chain.defaultGasPriceGwei ?? 0.02,
    nativeQuotePrice: overrides.nativeQuotePrice ?? chain.nativeQuotePrice ?? 3000,
    trap: { ...DEFAULT_TRAP, ...(overrides.trap ?? {}) },
    rank: { ...DEFAULT_RANK, ...(overrides.rank ?? {}) },
  };
}

export default buildConfig;

// Read-only pool / quote readers. Every function here performs ONLY eth_call
// reads through an injected provider (see src/evm/rpc.js) and encodes/decodes
// calldata with the bounded ABI codec in src/evm/abi.js. Nothing in this file
// sends a transaction, signs, or holds keys of any kind.
//
// The provider is passed in so tests can supply a stub whose call() returns
// canned hex, allowing the whole module to be exercised offline.
//
// Supported reads:
//   - readV2Reserves  : Uniswap-V2 getReserves() -> (uint112,uint112,uint32)
//   - readV2AmountsOut : getAmountsOut(uint256,address[]) -> uint256[]
//   - readV3Quote      : quoteExactInputSingle(...) -> uint256 amountOut
//   - simulateSell     : read-only sellability probe used by the trap filter

import { encodeFunctionCall, decodeResult } from './abi.js';

/**
 * Read Uniswap-V2 style reserves from a pair contract.
 * getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 ts).
 * The uint32 timestamp occupies a full 32-byte word on the wire, so we decode
 * it with the uint256 codec and keep only the value.
 *
 * @param {{call: Function}} provider read-only provider.
 * @param {string} pairAddress V2 pair contract address.
 * @param {string} [blockTag='latest']
 * @returns {Promise<{reserve0: bigint, reserve1: bigint, blockTimestampLast: bigint}>}
 */
export async function readV2Reserves(provider, pairAddress, blockTag = 'latest') {
  const data = encodeFunctionCall('getReserves()', [], []);
  const raw = await provider.call(pairAddress, data, blockTag);
  const [reserve0, reserve1, blockTimestampLast] = decodeResult(
    ['uint112', 'uint112', 'uint256'],
    raw,
  );
  return { reserve0, reserve1, blockTimestampLast };
}

/**
 * Read getAmountsOut(amountIn, path) from a V2 router.
 * path is an array of token addresses; the bounded codec models address[] as a
 * uint256[] of the address integer values (identical wire layout).
 *
 * @param {{call: Function}} provider read-only provider.
 * @param {string} router V2 router address.
 * @param {bigint|number|string} amountIn raw input amount (base units).
 * @param {string[]} path token address path (length >= 2).
 * @param {string} [blockTag='latest']
 * @returns {Promise<bigint[]>} amounts array (amounts[last] is the final out).
 */
export async function readV2AmountsOut(
  provider,
  router,
  amountIn,
  path,
  blockTag = 'latest',
) {
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('pools: path must have at least 2 addresses');
  }
  const pathAsUints = path.map((addr) => BigInt(addr));
  const data = encodeFunctionCall(
    'getAmountsOut(uint256,address[])',
    ['uint256', 'uint256[]'],
    [BigInt(amountIn), pathAsUints],
  );
  const raw = await provider.call(router, data, blockTag);
  const [amounts] = decodeResult(['uint256[]'], raw);
  return amounts;
}

/**
 * Read a Uniswap-V3 quoter's quoteExactInputSingle. The canonical signature is
 * quoteExactInputSingle(address,address,uint24,uint256,uint160) returning
 * uint256 amountOut. The fee (uint24) and sqrtPriceLimit (uint160) ride in full
 * 32-byte words, so they are encoded with the uint256 codec.
 *
 * @param {{call: Function}} provider read-only provider.
 * @param {string} quoter V3 quoter address.
 * @param {object} params
 * @param {string} params.tokenIn input token address.
 * @param {string} params.tokenOut output token address.
 * @param {number|bigint} params.fee pool fee tier (e.g. 500, 3000).
 * @param {bigint|number|string} params.amountIn raw input amount.
 * @param {bigint|number|string} [params.sqrtPriceLimitX96=0]
 * @param {string} [blockTag='latest']
 * @returns {Promise<bigint>} amountOut (raw base units).
 */
export async function readV3Quote(provider, quoter, params, blockTag = 'latest') {
  const {
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    sqrtPriceLimitX96 = 0,
  } = params;
  const data = encodeFunctionCall(
    'quoteExactInputSingle(address,address,uint24,uint256,uint160)',
    ['address', 'address', 'uint256', 'uint256', 'uint256'],
    [tokenIn, tokenOut, BigInt(fee), BigInt(amountIn), BigInt(sqrtPriceLimitX96)],
  );
  const raw = await provider.call(quoter, data, blockTag);
  const [amountOut] = decodeResult(['uint256'], raw);
  return amountOut;
}

/**
 * Read-only sellability probe. Performs an eth_call that quotes selling
 * `amountIn` of `token` back to a reference token (e.g. WETH/USDC) WITHOUT ever
 * sending a transaction. The result feeds the trap filter:
 *   - a reverting call               => sellReverted = true (SELL_BLOCKED)
 *   - a zero output for non-zero in  => simulatedSellOut = 0n (NON_SELLABLE)
 *
 * The probe works for both router (getAmountsOut) and V3 quoter styles,
 * selected by `kind`. Either way it is a pure read.
 *
 * @param {{call: Function}} provider read-only provider.
 * @param {object} opts
 * @param {'v2'|'v3'} [opts.kind='v2'] which read style to use.
 * @param {string} [opts.router] V2 router (for kind 'v2').
 * @param {string} [opts.quoter] V3 quoter (for kind 'v3').
 * @param {string} opts.token token being sold.
 * @param {string} [opts.referenceToken] token to receive (v2 path target).
 * @param {bigint|number|string} opts.amountIn raw sell amount.
 * @param {number|bigint} [opts.fee] V3 fee tier (for kind 'v3').
 * @param {string} [blockTag='latest']
 * @returns {Promise<{sellReverted: boolean, simulatedSellOut: bigint, error?: string}>}
 */
export async function simulateSell(provider, opts, blockTag = 'latest') {
  const {
    kind = 'v2',
    router,
    quoter,
    token,
    referenceToken,
    amountIn,
    fee,
  } = opts;

  try {
    let out;
    if (kind === 'v3') {
      out = await readV3Quote(
        provider,
        quoter,
        { tokenIn: token, tokenOut: referenceToken, fee, amountIn },
        blockTag,
      );
    } else {
      const amounts = await readV2AmountsOut(
        provider,
        router,
        amountIn,
        [token, referenceToken],
        blockTag,
      );
      out = amounts.length ? amounts[amounts.length - 1] : 0n;
    }
    const simulatedSellOut = BigInt(out);
    return { sellReverted: false, simulatedSellOut };
  } catch (err) {
    // A reverting / failing read means the sell path does not work: classic
    // honeypot behaviour. We surface it as a non-sellable signal rather than
    // propagating, so the trap filter can classify it.
    return {
      sellReverted: true,
      simulatedSellOut: 0n,
      error: err && err.message ? err.message : String(err),
    };
  }
}

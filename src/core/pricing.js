// Pure pricing math for AMM pools. NO network, NO I/O, NO imports from the
// evm/rpc layer. These functions operate purely on numbers/BigInts already
// fetched elsewhere so they can be unit tested fully offline.
//
// Two pool families share one interface here:
//   - Uniswap-V2 style pools expose getReserves() -> (reserve0, reserve1).
//     Mid price and swap output are derived from the constant-product curve.
//   - Uniswap-V3 style pools do NOT expose simple reserves; instead a quoter
//     contract is called (quoteExactInputSingle) and returns amountOut for a
//     given amountIn. priceFromQuote adapts that output to the same shape.
//
// The actual on-chain calls (getReserves / quoteExactInputSingle) live in the
// evm layer. This module only interprets their already-decoded results.
//
// Precision note: on-chain token amounts are integers (BigInt). We keep swap
// math (amountOutV2) in BigInt so it is exact. Human-facing "mid price" and
// decimal-adjusted ratios are returned as Number because display and fraction
// math tolerate the tiny floating-point error; those spots are marked below.

const BPS_DENOMINATOR = 10000n;

/**
 * Scale a raw integer token amount by its decimals into a human Number.
 * Precision: converts BigInt -> Number, acceptable for display/ratio math.
 * @param {bigint|number|string} rawAmount integer base units.
 * @param {number} decimals token decimals (e.g. 18 for WETH, 6 for USDC).
 * @returns {number} human-scaled amount.
 */
export function toHuman(rawAmount, decimals) {
  const raw = BigInt(rawAmount);
  const d = Number(decimals);
  // Number(raw) can lose precision for very large reserves, but for display
  // and price ratios that error is negligible relative to the quantities.
  return Number(raw) / 10 ** d;
}

/**
 * Mid price (output tokens per 1 input token) from V2 reserves, adjusted for
 * each token's decimals. Returns both the display Number price and the raw
 * BigInt reserves so callers that need exactness can keep them.
 *
 * price = (reserveOut / 10^decimalsOut) / (reserveIn / 10^decimalsIn)
 *
 * @param {bigint|number|string} reserveIn raw reserve of the input token.
 * @param {bigint|number|string} reserveOut raw reserve of the output token.
 * @param {number} decimalsIn input token decimals.
 * @param {number} decimalsOut output token decimals.
 * @returns {{ price: number, reserveIn: bigint, reserveOut: bigint,
 *             decimalsIn: number, decimalsOut: number }}
 */
export function priceFromReservesV2(reserveIn, reserveOut, decimalsIn, decimalsOut) {
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  if (rIn <= 0n || rOut <= 0n) {
    throw new Error('pricing: reserves must be positive');
  }
  const humanIn = toHuman(rIn, decimalsIn);
  const humanOut = toHuman(rOut, decimalsOut);
  return {
    price: humanOut / humanIn, // output per input (Number, display precision)
    reserveIn: rIn,
    reserveOut: rOut,
    decimalsIn: Number(decimalsIn),
    decimalsOut: Number(decimalsOut),
  };
}

/**
 * Constant-product (x*y=k) output amount WITH a swap fee, in base units.
 * This mirrors the Uniswap-V2 getAmountOut formula exactly:
 *
 *   amountInWithFee = amountIn * (10000 - feeBps)
 *   amountOut = (amountInWithFee * reserveOut)
 *               / (reserveIn * 10000 + amountInWithFee)
 *
 * All arithmetic is BigInt so the result is exact (no float drift). feeBps is
 * the fee in basis points (30 => 0.30%, the classic V2 fee).
 *
 * @param {bigint|number|string} amountIn raw input amount (base units).
 * @param {bigint|number|string} reserveIn raw input reserve.
 * @param {bigint|number|string} reserveOut raw output reserve.
 * @param {number} feeBps fee in basis points (e.g. 30 for 0.30%).
 * @returns {bigint} raw output amount (base units).
 */
export function amountOutV2(amountIn, reserveIn, reserveOut, feeBps) {
  const aIn = BigInt(amountIn);
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  const fee = BigInt(feeBps);
  if (aIn < 0n) throw new Error('pricing: amountIn must be non-negative');
  if (rIn <= 0n || rOut <= 0n) {
    throw new Error('pricing: reserves must be positive');
  }
  if (fee < 0n || fee >= BPS_DENOMINATOR) {
    throw new Error('pricing: feeBps must be in [0, 10000)');
  }
  if (aIn === 0n) return 0n;

  const amountInWithFee = aIn * (BPS_DENOMINATOR - fee);
  const numerator = amountInWithFee * rOut;
  const denominator = rIn * BPS_DENOMINATOR + amountInWithFee;
  return numerator / denominator; // BigInt division truncates, like Solidity
}

/**
 * Adapt a V3 quoter result (amountIn -> amountOut) into the same decimal-aware
 * price shape used by V2 pools, so downstream gap/cost math treats both the
 * same way.
 *
 * The effective price returned is the realized output-per-input for THIS trade
 * size (i.e. it already includes the pool's price impact and fee for that
 * amount, since the quoter simulates the swap). Decimals convert both legs to
 * human units first.
 *
 * @param {bigint|number|string} amountIn raw input amount (base units).
 * @param {bigint|number|string} amountOut raw output amount from the quoter.
 * @param {number} decimalsIn input token decimals.
 * @param {number} decimalsOut output token decimals.
 * @returns {{ price: number, amountIn: bigint, amountOut: bigint,
 *             decimalsIn: number, decimalsOut: number }}
 */
export function priceFromQuote(amountIn, amountOut, decimalsIn, decimalsOut) {
  const aIn = BigInt(amountIn);
  const aOut = BigInt(amountOut);
  if (aIn <= 0n) throw new Error('pricing: quote amountIn must be positive');
  const humanIn = toHuman(aIn, decimalsIn);
  const humanOut = toHuman(aOut, decimalsOut);
  return {
    price: humanOut / humanIn, // realized output per input (Number)
    amountIn: aIn,
    amountOut: aOut,
    decimalsIn: Number(decimalsIn),
    decimalsOut: Number(decimalsOut),
  };
}

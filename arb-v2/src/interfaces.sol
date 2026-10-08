// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

// Uniswap-V3 / PancakeSwap-V3 / Aerodrome-Slipstream style pool.
// All three expose the same swap() shape and a callback; only the callback
// NAME differs, which is why the executor implements all three names below.
interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    // amountSpecified > 0 = exact-in of the input token
    // zeroForOne = true means swapping token0 -> token1
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

// Morpho Blue — free flash loans (no fee). Repaid inside the callback.
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

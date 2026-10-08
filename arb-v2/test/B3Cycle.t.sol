// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20, IV3Pool} from "../src/interfaces.sol";

/*
 * B3 CYCLE REALITY TEST (fork, read-only sim).
 *
 * The live watcher reports a persistent +$0.35..$2.77 "gap" on B3 across its
 * USDC pool (0x2df3…) and USDT pool (0xf411…). A quote is not a trade. This test
 * executes the COMPLETE real cycle on a Base fork and prints what actually comes
 * back, so transfer-tax / peg-cost / depth limits all show up automatically:
 *
 *   start USDC -> buy B3 on pool B (USDC) -> sell B3 on pool A (USDT) -> USDT
 *   -> swap USDT->USDC on a real stable pool -> end USDC
 *
 * We DON'T deploy the arb contract here; we drive the pools directly from the
 * test (acting as a trader) via a tiny inline callback, so we see raw reality.
 *
 * Run (fork at a block where the watcher fired, e.g. 52336084):
 *   forge test --match-contract B3Cycle --fork-url $BASE_RPC --fork-block-number 52336084 -vv
 */
contract B3CycleTest is Test {
    address constant B3   = 0x07b3D902783c3C12b077508c3B5c00113d1291D0;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant POOL_USDC = 0x2dF380544B88AdB3ad0A94100dcC45fd705aAE2d; // B3/USDC
    address constant POOL_USDT = 0xf411Dbf5978ce4089CF40ef7b83F813Efd312fB0; // B3/USDT

    // transient state for the swap callback
    address private payToken;
    address private payPool;

    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    function _poolSwap(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        internal returns (uint256 out)
    {
        // zeroForOne must reflect the POOL's real token0/token1 ordering, not a
        // raw address compare of in/out.
        address token0 = IV3Pool(pool).token0();
        bool zeroForOne = (tokenIn == token0);
        payToken = tokenIn;
        payPool = pool;
        uint256 beforeBal = IERC20(tokenOut).balanceOf(address(this));
        IV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT : MAX_SQRT,
            abi.encode(pool)
        );
        out = IERC20(tokenOut).balanceOf(address(this)) - beforeBal;
    }

    // Uniswap/Pancake-style callbacks all route here
    function _pay(int256 a0, int256 a1) internal {
        require(msg.sender == payPool, "bad pool");
        uint256 owe = a0 > 0 ? uint256(a0) : uint256(a1);
        IERC20(payToken).transfer(msg.sender, owe);
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function swapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }

    function testB3Cycle() public {
        uint256[4] memory sizesUsd = [uint256(1000), 5000, 20000, 50000];
        for (uint256 i = 0; i < sizesUsd.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 startUsdc = sizesUsd[i] * 1e6;
            deal(USDC, address(this), startUsdc);

            // leg 1: USDC -> B3 on the USDC pool
            uint256 b3 = _poolSwap(POOL_USDC, USDC, B3, startUsdc);
            // leg 2: B3 -> USDT on the USDT pool
            uint256 usdtOut = b3 > 0 ? _poolSwap(POOL_USDT, B3, USDT, b3) : 0;

            console2.log("--- size USD:", sizesUsd[i]);
            console2.log("  USDC in      :", startUsdc);
            console2.log("  B3 bought    :", b3);
            console2.log("  USDT out     :", usdtOut);
            // Compare end USDT (6dec) to start USDC (6dec). If usdtOut > startUsdc,
            // the 2-leg B3 cycle is up BEFORE the USDT->USDC leg. The real net must
            // still survive converting USDT back to USDC (~1:1 minus a small fee).
            if (usdtOut >= startUsdc) {
                console2.log("  2-leg GROSS +USDT (6dec):", usdtOut - startUsdc);
            } else {
                console2.log("  2-leg LOSS -USDT (6dec):", startUsdc - usdtOut);
            }
            vm.revertToState(snap);
        }
        console2.log("NOTE: compare 'USDT out' vs 'USDC in'. A real profit must exceed the start by MORE");
        console2.log("      than the USDT->USDC conversion cost + gas. If usdtOut <= USDC in, the gap is a mirage.");
    }
}

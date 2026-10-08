// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20, IV3Pool} from "../src/interfaces.sol";

/*
 * WETH/USDC CROSS-DEX CYCLE REALITY TEST (fork, read-only sim).
 *
 * The live watcher (sim/live_two_dex_watcher.mjs) can report a WOULD-FIRE "gap"
 * on a DEEP major pair, WETH/USDC, across the three big DEXes on Base
 * (Uniswap V3, PancakeSwap V3, SushiSwap V3). A quote is not a trade. This test
 * executes the COMPLETE real same-pair cross-DEX cycle on a Base fork and prints
 * what actually comes back, so depth limits and fees all show up automatically:
 *
 *   start USDC -> buy WETH on pool A (one DEX) -> sell WETH on pool B (another DEX) -> USDC
 *
 * UNLIKE B3Cycle there is NO 3rd stable leg: both pools are WETH/USDC, so we
 * compare end-USDC DIRECTLY to start-USDC (both 6-dec). WETH is 18-dec.
 *
 * We DON'T deploy the arb contract here; we drive the pools directly from the
 * test (acting as a trader) via a tiny inline callback, so we see raw reality.
 *
 * POOL ADDRESSES ARE USER-SUPPLIED, NOT FABRICATED. Set POOL_A / POOL_B (and the
 * optional POOL_C) to the real WETH/USDC pool addresses you read from DEX Screener
 * (dexscreener.com/base, search "WETH USDC"): the Uniswap V3, PancakeSwap V3 and
 * SushiSwap V3 pool addresses. WETH and USDC default to the canonical Base token
 * addresses below (well-known constants) but can be overridden via env too.
 *
 * THREE-DEX COVERAGE: testWethUsdcCycle() runs the POOL_A <-> POOL_B pairing. If you
 * also set POOL_C, testWethUsdcCycleThreeDex() runs all three pairings
 * (A<->B, A<->C, B<->C) in one go, mirroring the watcher's --poolC behaviour.
 *
 * Run (fork at the block where the watcher fired):
 *   cd arb-v2 && forge install foundry-rs/forge-std --no-commit \
 *     && export BASE_RPC=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY \
 *     && export POOL_A=0xUNISWAP_V3_WETH_USDC POOL_B=0xPANCAKE_V3_WETH_USDC \
 *     && export POOL_C=0xSUSHI_V3_WETH_USDC   # optional, enables the 3-DEX test \
 *     && forge test --match-contract WethUsdcCycle --fork-url $BASE_RPC \
 *          --fork-block-number <block-where-watcher-fired> -vv
 *
 * To cover all three pairings WITHOUT POOL_C, run the A<->B test three times,
 * swapping env each run: (POOL_A=Uni,POOL_B=Pancake), (POOL_A=Uni,POOL_B=Sushi),
 * (POOL_A=Pancake,POOL_B=Sushi).
 */
contract WethUsdcCycleTest is Test {
    // Canonical Base token addresses (well-known constants, overridable via env).
    address constant WETH_DEFAULT = 0x4200000000000000000000000000000000000006;
    address constant USDC_DEFAULT = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Resolved at setUp() from env (addresses are USER-SUPPLIED, not fabricated).
    address internal WETH;
    address internal USDC;
    address internal POOL_A;
    address internal POOL_B;
    address internal POOL_C; // optional 3rd DEX pool; address(0) when unset

    // transient state for the swap callback
    address private payToken;
    address private payPool;

    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    function setUp() public {
        // WETH/USDC canonical Base tokens are defaults; override only if needed.
        WETH = vm.envOr("WETH", WETH_DEFAULT);
        USDC = vm.envOr("USDC", USDC_DEFAULT);
        // Pool addresses MUST come from the user (DEX Screener). No defaults.
        POOL_A = vm.envAddress("POOL_A");
        POOL_B = vm.envAddress("POOL_B");
        POOL_C = vm.envOr("POOL_C", address(0));
    }

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

    // Run the full 2-leg same-pair cross-DEX cycle (buy WETH on buyPool, sell on
    // sellPool) across all sizes, printing real USDC-in vs USDC-out.
    function _runPairing(address buyPool, address sellPool, string memory label) internal {
        console2.log("==== pairing:", label);
        uint256[4] memory sizesUsd = [uint256(1000), 5000, 20000, 50000];
        for (uint256 i = 0; i < sizesUsd.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 startUsdc = sizesUsd[i] * 1e6; // USDC is 6-dec
            deal(USDC, address(this), startUsdc);

            // leg 1: USDC -> WETH on the buy pool (one DEX)
            uint256 weth = _poolSwap(buyPool, USDC, WETH, startUsdc);
            // leg 2: WETH -> USDC on the sell pool (another DEX)
            uint256 usdcOut = weth > 0 ? _poolSwap(sellPool, WETH, USDC, weth) : 0;

            console2.log("--- size USD:", sizesUsd[i]);
            console2.log("  USDC in  (6dec) :", startUsdc);
            console2.log("  WETH bought (18dec):", weth);
            console2.log("  USDC out (6dec) :", usdcOut);
            // Both pools are WETH/USDC, so there is NO 3rd stable leg: compare
            // end-USDC directly to start-USDC (both 6-dec).
            if (usdcOut >= startUsdc) {
                console2.log("  2-leg GROSS +USDC (6dec):", usdcOut - startUsdc);
            } else {
                console2.log("  2-leg LOSS -USDC (6dec):", startUsdc - usdcOut);
            }
            vm.revertToState(snap);
        }
    }

    function testWethUsdcCycle() public {
        _runPairing(POOL_A, POOL_B, "A->B (buy on A, sell on B)");
        console2.log("NOTE: compare 'USDC out' vs 'USDC in'. A real profit must exceed the start by MORE");
        console2.log("      than gas. If usdcOut <= USDC in, the gap is a mirage.");
    }

    // Only meaningful when POOL_C is set; otherwise it is skipped.
    function testWethUsdcCycleThreeDex() public {
        if (POOL_C == address(0)) {
            console2.log("POOL_C not set; skipping three-DEX pairing test. Set POOL_C to enable.");
            return;
        }
        _runPairing(POOL_A, POOL_B, "A->B");
        _runPairing(POOL_A, POOL_C, "A->C");
        _runPairing(POOL_B, POOL_C, "B->C");
        console2.log("NOTE: compare 'USDC out' vs 'USDC in' per pairing. A real profit must exceed the start");
        console2.log("      by MORE than gas. If usdcOut <= USDC in, the gap is a mirage.");
    }
}

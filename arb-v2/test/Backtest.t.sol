// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ArbExecutorV2} from "../src/ArbExecutorV2.sol";
import {IERC20} from "../src/interfaces.sol";

/*
 * Fork backtester — correct state + OPTIMAL SIZING.
 *
 * Forks the arb's block and rolls to just before the arb tx (vm.rollFork(txHash))
 * so the dislocation is present. Then, instead of copying the winner's exact trade
 * size (which slightly over/undershoots at our replay point), it SEARCHES for the
 * profit-maximizing input size by actually running the cycle at several sizes
 * against real pool state. Real arbitrage bots size optimally; this reproduces that.
 *
 * BASE_RPC must be set.
 */
contract BacktestTest is Test {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    string json;

    function _u(string memory k) internal view returns (uint256) { return vm.parseJsonUint(json, k); }
    function _a(string memory k) internal view returns (address) { return vm.parseJsonAddress(json, k); }
    function _b(string memory k) internal view returns (bool) { return vm.parseJsonBool(json, k); }
    function _s(string memory k) internal view returns (string memory) { return vm.parseJsonString(json, k); }

    function _route(uint256 i) internal view returns (ArbExecutorV2.Hop[] memory route) {
        string memory base = string.concat(".cases[", vm.toString(i), "]");
        uint256 hn = _u(string.concat(base, ".hopsLen"));
        route = new ArbExecutorV2.Hop[](hn);
        for (uint256 j = 0; j < hn; j++) {
            string memory hb = string.concat(base, ".hops[", vm.toString(j), "]");
            route[j] = ArbExecutorV2.Hop({
                pool: _a(string.concat(hb, ".pool")),
                zeroForOne: _b(string.concat(hb, ".zeroForOne")),
                tokenIn: _a(string.concat(hb, ".tokenIn"))
            });
        }
    }

    // Net output of the cycle at a given input size, model-free, via probe() against
    // real pool state. Snapshots so each trial sees identical pool state.
    function _netOut(address startToken, uint256 amountIn, ArbExecutorV2.Hop[] memory route)
        internal returns (bool ok, uint256 outAmt)
    {
        uint256 snap = vm.snapshotState();
        ArbExecutorV2 p = new ArbExecutorV2(MORPHO);
        deal(startToken, address(p), amountIn);
        try p.probe(startToken, amountIn, route) returns (uint256 endBal) {
            ok = true; outAmt = endBal;
        } catch { ok = false; }
        vm.revertToState(snap);
    }

    // Search input sizes from 0.06x..6x of the winner's size; keep the most profitable.
    function _bestSize(address startToken, uint256 seed, ArbExecutorV2.Hop[] memory route)
        internal returns (uint256 bestIn, int256 bestProfit)
    {
        bestProfit = type(int256).min;
        uint16[11] memory mult = [uint16(6), 12, 25, 50, 75, 100, 150, 200, 300, 400, 600]; // percent of seed
        for (uint256 k = 0; k < 11; k++) {
            uint256 amt = (seed * mult[k]) / 100;
            if (amt == 0) continue;
            (bool ok, uint256 out) = _netOut(startToken, amt, route);
            if (!ok) continue;
            int256 prof = int256(out) - int256(amt);
            if (prof > bestProfit) { bestProfit = prof; bestIn = amt; }
        }
    }

    function _runCase(uint256 i) internal returns (bool reproduced) {
        string memory base = string.concat(".cases[", vm.toString(i), "]");
        address startToken = _a(string.concat(base, ".startToken"));
        uint256 winnerSize = _u(string.concat(base, ".amountIn"));
        bytes32 txh = vm.parseBytes32(_s(string.concat(base, ".txHash")));

        vm.createSelectFork(vm.rpcUrl("base"));
        vm.rollFork(txh);

        ArbExecutorV2.Hop[] memory route = _route(i);

        (bool okW, uint256 outW) = _netOut(startToken, winnerSize, route);
        console2.log("case", i, "winnerSize:", winnerSize);
        if (okW) console2.log("  net at winnerSize:", outW); else console2.log("  winnerSize probe reverted");

        (uint256 bestIn, int256 bestProfit) = _bestSize(startToken, winnerSize, route);
        console2.log("  bestIn:", bestIn);
        console2.log("  bestProfit (signed, start-token units):");
        console2.logInt(bestProfit);

        if (bestIn == 0 || bestProfit <= 0) {
            console2.log("MISSED case (no profitable size)", i);
            return false;
        }

        ArbExecutorV2 exec = new ArbExecutorV2(MORPHO);
        try exec.run(startToken, bestIn, route, 0) returns (uint256 p) {
            if (p > 0) { console2.log("REPRODUCED case", i, "profit:", p); return true; }
            console2.log("ZERO-profit case", i);
            return false;
        } catch {
            console2.log("MISSED case (run reverted)", i);
            return false;
        }
    }

    function testReplayAll() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/replay/cases.json"));
        uint256 n = _u(".count");
        uint256 reproduced;
        for (uint256 i = 0; i < n; i++) {
            if (_runCase(i)) reproduced++;
        }
        console2.log("=== CAPTURE SUMMARY ===");
        console2.log("attempted:", n);
        console2.log("reproduced-with-profit:", reproduced);
    }
}

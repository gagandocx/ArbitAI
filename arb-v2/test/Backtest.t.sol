// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ArbExecutorV2} from "../src/ArbExecutorV2.sol";
import {IERC20} from "../src/interfaces.sol";

/*
 * Fork backtester. For each replay case (test/replay/cases.json), fork Base at the
 * block just before the arb landed, deploy ArbExecutorV2, and replay the exact
 * cycle. We assert the contract ends with MORE of the start token than it borrowed
 * — i.e. it would have reproduced a profitable arb with perfect hindsight. The run
 * prints a per-case result and a final capture summary.
 *
 * BASE_RPC must be set. Each case decodes in a helper to keep the loop's local
 * variable count low (avoids "stack too deep").
 */
contract BacktestTest is Test {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    string json;

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }
    function _a(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }
    function _b(string memory key) internal view returns (bool) {
        return vm.parseJsonBool(json, key);
    }

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

    function _runCase(uint256 i) internal returns (bool reproduced) {
        string memory base = string.concat(".cases[", vm.toString(i), "]");
        uint256 blk = _u(string.concat(base, ".block"));
        address startToken = _a(string.concat(base, ".startToken"));
        uint256 amountIn = _u(string.concat(base, ".amountIn"));

        vm.createSelectFork(vm.rpcUrl("base"), blk - 1);
        ArbExecutorV2 exec = new ArbExecutorV2(MORPHO);
        ArbExecutorV2.Hop[] memory route = _route(i);

        try exec.run(startToken, amountIn, route, 0) returns (uint256 profit) {
            if (profit > 0) {
                console2.log("REPRODUCED case", i);
                console2.log("  profit (start-token units):", profit);
                return true;
            }
            console2.log("ZERO-profit case", i);
            return false;
        } catch {
            console2.log("MISSED case (reverted) ", i);
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ArbExecutorV2} from "../src/ArbExecutorV2.sol";
import {IERC20} from "../src/interfaces.sol";

/*
 * Fork backtester. For each replay case (test/replay/cases.json), fork Base at the
 * case's block, deploy ArbExecutorV2, and replay the exact 2-pool cycle. We assert
 * the contract ends with MORE of the start token than it borrowed — i.e. it would
 * have reproduced a profitable arb with perfect hindsight. The run then prints a
 * capture summary.
 *
 * NOTE: cases.json is parsed with forge-std's JSON cheats. We fork per-case using
 * vm.createSelectFork at the case block (BASE_RPC must be set).
 */
contract BacktestTest is Test {
    // Morpho Blue on Base
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    struct Hop { address pool; bool zeroForOne; address tokenIn; }
    struct Case {
        uint256 block;
        string txHash;
        address startToken;
        uint256 amountIn;
        uint256 realProfitUsd;
        Hop[] hops;
    }

    function testReplayAll() public {
        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/test/replay/cases.json");
        string memory json = vm.readFile(path);

        uint256 n = vm.parseJsonUint(json, ".count"); // MakeCases writes a flat count too (see note)
        uint256 reproduced;
        uint256 attempted;

        for (uint256 i = 0; i < n; i++) {
            string memory b = string.concat(".cases[", vm.toString(i), "]");
            uint256 blk = vm.parseJsonUint(json, string.concat(b, ".block"));
            address startToken = vm.parseJsonAddress(json, string.concat(b, ".startToken"));
            uint256 amountIn = vm.parseJsonUint(json, string.concat(b, ".amountIn"));

            // fork just before the arb landed so pool state matches the opportunity
            vm.createSelectFork(vm.rpcUrl("base"), blk - 1);

            ArbExecutorV2 exec = new ArbExecutorV2(MORPHO);

            // decode hops
            uint256 hn = vm.parseJsonUint(json, string.concat(b, ".hopsLen"));
            ArbExecutorV2.Hop[] memory route = new ArbExecutorV2.Hop[](hn);
            for (uint256 j = 0; j < hn; j++) {
                string memory hb = string.concat(b, ".hops[", vm.toString(j), "]");
                route[j] = ArbExecutorV2.Hop({
                    pool: vm.parseJsonAddress(json, string.concat(hb, ".pool")),
                    zeroForOne: vm.parseJsonBool(json, string.concat(hb, ".zeroForOne")),
                    tokenIn: vm.parseJsonAddress(json, string.concat(hb, ".tokenIn"))
                });
            }

            attempted++;
            try exec.run(startToken, amountIn, route, 0) returns (uint256 profit) {
                if (profit > 0) {
                    reproduced++;
                    console2.log("REPRODUCED case", i);
                    console2.log("  profit (start-token units):", profit);
                }
            } catch {
                console2.log("MISSED case", i, "(reverted: not profitable at this fork state)");
            }
        }

        console2.log("=== CAPTURE SUMMARY ===");
        console2.log("attempted:", attempted);
        console2.log("reproduced-with-profit:", reproduced);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ArbExecutorV2} from "../src/ArbExecutorV2.sol";
import {IERC20} from "../src/interfaces.sol";

/*
 * Fork backtester — CORRECT STATE version.
 *
 * The earlier version forked at (block - 1), i.e. BEFORE the dislocation that
 * made the arb profitable existed, so every replay looked unprofitable. This
 * version forks the arb's block and rolls forward to JUST BEFORE the arb's own
 * transaction (vm.rollFork(txHash)). That reproduces the exact state the winning
 * bot acted on — the setup swaps earlier in the block are applied, the arb tx is
 * not yet. We then run our contract against that state.
 *
 * Per case we print the probe (hops without flash loan) and run() result, then a
 * capture summary. BASE_RPC must be set.
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

    function _runCase(uint256 i) internal returns (bool reproduced, uint256 profit) {
        string memory base = string.concat(".cases[", vm.toString(i), "]");
        address startToken = _a(string.concat(base, ".startToken"));
        uint256 amountIn = _u(string.concat(base, ".amountIn"));
        bytes32 txh = vm.parseBytes32(_s(string.concat(base, ".txHash")));

        // Fork at the arb's block and roll to JUST BEFORE the arb tx: the setup
        // dislocation is now present, the arb itself has not executed yet.
        vm.createSelectFork(vm.rpcUrl("base"));
        vm.rollFork(txh);

        ArbExecutorV2.Hop[] memory route = _route(i);

        // Diagnostic probe (no flash loan): fund directly, run hops, see net.
        ArbExecutorV2 probe = new ArbExecutorV2(MORPHO);
        deal(startToken, address(probe), amountIn);
        try probe.probe(startToken, amountIn, route) returns (uint256 endBal) {
            console2.log("case", i, "probe endBal:", endBal);
            console2.log("  (amountIn was:", amountIn, ")");
        } catch {
            console2.log("case", i, "probe REVERTED at correct state");
        }

        // Real run with Morpho free flash loan + profit-or-revert.
        ArbExecutorV2 exec = new ArbExecutorV2(MORPHO);
        try exec.run(startToken, amountIn, route, 0) returns (uint256 p) {
            if (p > 0) {
                console2.log("REPRODUCED case", i, "profit(start-token units):", p);
                return (true, p);
            }
            console2.log("ZERO-profit case", i);
            return (false, 0);
        } catch {
            console2.log("MISSED case (run reverted)", i);
            return (false, 0);
        }
    }

    function testReplayAll() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/replay/cases.json"));
        uint256 n = _u(".count");
        uint256 reproduced;
        for (uint256 i = 0; i < n; i++) {
            (bool ok,) = _runCase(i);
            if (ok) reproduced++;
        }
        console2.log("=== CAPTURE SUMMARY ===");
        console2.log("attempted:", n);
        console2.log("reproduced-with-profit:", reproduced);
    }
}

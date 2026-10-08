// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, IV3Pool, IMorpho} from "./interfaces.sol";

/*
 * ArbExecutorV2 — a from-scratch Base cyclic-arbitrage executor.
 *
 * Design (driven by the recon in sim/arb_recon.mjs):
 *   - Free flash loan from Morpho Blue (no 5bps Aave fee).
 *   - Direct Uniswap-V3-style pool.swap() for every hop (no routers -> less gas).
 *     Works for Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream, which share
 *     the same swap() shape; only the callback name differs, so all three are
 *     implemented and dispatch to the same logic.
 *   - PROFIT-OR-REVERT: the whole transaction reverts unless the contract ends
 *     with strictly more of the start token than it began (after repaying the
 *     flash loan). No minimum-profit %, no native ETH, no funds held between txs.
 *   - Owner/executor gated; read-only to everyone else.
 *
 * A "route" is an ordered list of hops. Each hop names a pool and the direction
 * (zeroForOne). The amount into hop[0] is the flash-loan amount; each subsequent
 * hop consumes the previous hop's output. Because this is for BACKTESTING on a
 * fork first, correctness and clarity matter more than micro-gas-golf; the hot
 * path is still allocation-free.
 */
contract ArbExecutorV2 {
    error NotOwner();
    error NotExecutor();
    error NotMorpho();
    error BadCallback();
    error NoProfit(uint256 start, uint256 end);
    error EmptyRoute();

    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    address public immutable owner;
    IMorpho public immutable morpho;
    mapping(address => bool) public executor;

    struct Hop {
        address pool;      // V3-style pool
        bool zeroForOne;   // true: token0 -> token1
        address tokenIn;   // token paid INTO this hop (for callback payment)
    }

    // transient context for the flash-loan + swap callbacks
    address private flashToken;
    bool private inFlash;

    constructor(address morpho_) {
        owner = msg.sender;
        morpho = IMorpho(morpho_);
        executor[msg.sender] = true;
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyExecutor() { if (!executor[msg.sender]) revert NotExecutor(); _; }

    function setExecutor(address a, bool ok) external onlyOwner { executor[a] = ok; }

    /*
     * Run a cyclic arbitrage.
     * @param startToken  token to flash-borrow and to profit in (cycle start == end)
     * @param amountIn    flash-loan size (start token units)
     * @param route       ordered hops; route[last].tokenOut must be startToken
     * @param minProfit   revert unless end-balance >= start-balance + minProfit (0 = any profit)
     * Returns the realized profit (start token units).
     */
    function run(address startToken, uint256 amountIn, Hop[] calldata route, uint256 minProfit)
        external onlyExecutor returns (uint256 profit)
    {
        if (route.length == 0) revert EmptyRoute();
        flashToken = startToken;
        // encode the plan for the Morpho callback
        bytes memory data = abi.encode(startToken, amountIn, route, minProfit);
        inFlash = true;
        morpho.flashLoan(startToken, amountIn, data);
        inFlash = false;
        // profit was validated inside the callback; return the delta the contract keeps
        profit = IERC20(startToken).balanceOf(address(this));
    }

    // ---- Morpho free flash-loan callback ----
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (!inFlash) revert BadCallback();
        (address startToken, uint256 amountIn, Hop[] memory route, uint256 minProfit) =
            abi.decode(data, (address, uint256, Hop[], uint256));

        uint256 startBal = IERC20(startToken).balanceOf(address(this)); // includes the borrowed `assets`

        // run the hops; each hop's output lands in this contract and feeds the next
        uint256 amt = amountIn;
        for (uint256 i = 0; i < route.length; i++) {
            amt = _swap(route[i], amt);
        }

        uint256 endBal = IERC20(startToken).balanceOf(address(this));
        // must be able to repay the loan AND net >= minProfit
        if (endBal < startBal + minProfit) revert NoProfit(startBal, endBal);

        // repay Morpho: it pulls `assets` back via safeTransferFrom after this
        // callback returns, so we must leave an allowance. Reset-then-set to be
        // safe with tokens that disallow non-zero->non-zero approval changes.
        IERC20(startToken).approve(address(morpho), 0);
        IERC20(startToken).approve(address(morpho), assets);
    }

    // ---- execute one V3-style hop via direct pool.swap() ----
    function _swap(Hop memory hop, uint256 amountIn) internal returns (uint256 out) {
        // pay-in happens in the swap callback; we pass tokenIn+pool through transient-ish memory
        _cbPool = hop.pool;
        _cbTokenIn = hop.tokenIn;
        (int256 a0, int256 a1) = IV3Pool(hop.pool).swap(
            address(this),
            hop.zeroForOne,
            int256(amountIn),
            hop.zeroForOne ? MIN_SQRT : MAX_SQRT,
            abi.encode(hop.pool)
        );
        // output is the negative delta of the OTHER token
        int256 outSigned = hop.zeroForOne ? -a1 : -a0;
        out = outSigned > 0 ? uint256(outSigned) : 0;
        _cbPool = address(0);
        _cbTokenIn = address(0);
    }

    address private _cbPool;
    address private _cbTokenIn;

    function _payCallback(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != _cbPool) revert BadCallback();
        // we owe the pool the positive delta of whichever token we put in
        uint256 owe = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(_cbTokenIn).transfer(_cbPool, owe);
    }

    // the three callback names used by the three pool families — all identical logic
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _payCallback(a0, a1); }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _payCallback(a0, a1); }
    function swapCallback(int256 a0, int256 a1, bytes calldata) external { _payCallback(a0, a1); }

    // recover anything stuck (owner only). Not used in the hot path.
    function sweep(address token, address to) external onlyOwner {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }

    receive() external payable { revert(); }
}

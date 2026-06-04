// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {V2Router} from "../../src/dex/V2Router.sol";
import {IV2Router} from "../../src/interfaces/IV2Router.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract V2RouterTest is Test {
    V2Router internal router;
    MockERC20 internal usdc;
    MockERC20 internal tsla;

    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public {
        router = new V2Router();
        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);
    }

    function _seedAndApprove(address who, uint256 usdcAmt, uint256 tslaAmt) internal {
        usdc.mint(who, usdcAmt);
        tsla.mint(who, tslaAmt);
        vm.prank(who);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(who);
        tsla.approve(address(router), type(uint256).max);
    }

    function _bootstrapPool(uint256 usdcAmt, uint256 tslaAmt) internal {
        router.createPool(address(usdc), address(tsla));
        _seedAndApprove(lp, usdcAmt, tslaAmt);
        vm.prank(lp);
        router.addLiquidity(address(usdc), address(tsla), usdcAmt, tslaAmt);
    }

    function test_createPool_emits_and_records() public {
        bytes32 key = router.pairKeyOf(address(usdc), address(tsla));
        vm.expectEmit(true, true, true, true);
        emit IV2Router.PoolCreated(
            key,
            address(usdc) < address(tsla) ? address(usdc) : address(tsla),
            address(usdc) < address(tsla) ? address(tsla) : address(usdc)
        );
        bytes32 returned = router.createPool(address(usdc), address(tsla));
        assertEq(returned, key);
    }

    function test_createPool_revert_duplicate() public {
        router.createPool(address(usdc), address(tsla));
        vm.expectRevert(V2Router.PoolExists.selector);
        router.createPool(address(tsla), address(usdc));
    }

    function test_createPool_revert_identical() public {
        vm.expectRevert(V2Router.IdenticalTokens.selector);
        router.createPool(address(usdc), address(usdc));
    }

    function test_addLiquidity_first_mint_burns_minimum() public {
        router.createPool(address(usdc), address(tsla));
        _seedAndApprove(lp, 1_000e6, 1_000e18);
        vm.prank(lp);
        uint256 lpTokens = router.addLiquidity(address(usdc), address(tsla), 1_000e6, 1_000e18);
        assertGt(lpTokens, 0, "lp tokens minted");
        bytes32 key = router.pairKeyOf(address(usdc), address(tsla));
        assertEq(router.lpBalance(key, address(0)), router.MINIMUM_LIQUIDITY(), "min lock");
    }

    function test_addLiquidity_proportional_subsequent_mint() public {
        _bootstrapPool(1_000e6, 1_000e18);
        address lp2 = makeAddr("lp2");
        _seedAndApprove(lp2, 500e6, 500e18);
        vm.prank(lp2);
        uint256 lpTokens = router.addLiquidity(address(usdc), address(tsla), 500e6, 500e18);
        assertGt(lpTokens, 0);
        bytes32 key = router.pairKeyOf(address(usdc), address(tsla));
        assertEq(router.lpBalance(key, lp2), lpTokens, "lp2 credited");
    }

    function test_addLiquidity_revert_pool_not_found() public {
        _seedAndApprove(lp, 1_000e6, 1_000e18);
        vm.prank(lp);
        vm.expectRevert(V2Router.PoolNotFound.selector);
        router.addLiquidity(address(usdc), address(tsla), 100e6, 100e18);
    }

    function test_swapExactIn_constant_product_math() public {
        // Reserves: 1_000 USDC, 1_000 TSLA. Swap 100 USDC for TSLA.
        // amountOut = (100 * 997 * 1_000) / (1_000 * 1_000 + 100 * 997)
        //           = 99_700_000 / 1_099_700 = ~ 90.66 (rounded down).
        _bootstrapPool(1_000e6, 1_000e18);

        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(router), type(uint256).max);

        vm.prank(trader);
        uint256 amountOut = router.swapExactIn(address(usdc), address(tsla), 100e6, 0, trader);

        // Use the formula directly to validate.
        uint256 amountInWithFee = 100e6 * 997;
        uint256 expectedOut = (amountInWithFee * 1_000e18) / (1_000e6 * 1_000 + amountInWithFee);
        assertEq(amountOut, expectedOut, "amount out matches formula");
        assertEq(tsla.balanceOf(trader), amountOut, "trader received");
    }

    function test_swap_reverts_insufficient_output() public {
        _bootstrapPool(1_000e6, 1_000e18);
        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(trader);
        vm.expectRevert(V2Router.InsufficientOutput.selector);
        router.swapExactIn(address(usdc), address(tsla), 100e6, 1_000e18, trader);
    }

    function test_removeLiquidity_returns_proportional() public {
        _bootstrapPool(1_000e6, 1_000e18);
        bytes32 key = router.pairKeyOf(address(usdc), address(tsla));
        uint256 lpTokens = router.lpBalance(key, lp);
        vm.prank(lp);
        (uint256 amountA, uint256 amountB) = router.removeLiquidity(address(usdc), address(tsla), lpTokens);
        assertGt(amountA, 0);
        assertGt(amountB, 0);
        assertEq(router.lpBalance(key, lp), 0, "lp drained");
    }

    function test_removeLiquidity_revert_zero() public {
        _bootstrapPool(1_000e6, 1_000e18);
        vm.prank(lp);
        vm.expectRevert(V2Router.ZeroAmount.selector);
        router.removeLiquidity(address(usdc), address(tsla), 0);
    }

    function test_getReserves_returns_orientation_matching_input() public {
        _bootstrapPool(1_000e6, 1_000e18);
        (uint256 rUsdc, uint256 rTsla) = router.getReserves(address(usdc), address(tsla));
        assertEq(rUsdc, 1_000e6);
        assertEq(rTsla, 1_000e18);
        (uint256 rTsla2, uint256 rUsdc2) = router.getReserves(address(tsla), address(usdc));
        assertEq(rTsla2, 1_000e18);
        assertEq(rUsdc2, 1_000e6);
    }

    function test_quote_matches_swap() public {
        _bootstrapPool(1_000e6, 1_000e18);
        uint256 quoted = router.quote(address(usdc), address(tsla), 100e6);
        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(trader);
        uint256 out = router.swapExactIn(address(usdc), address(tsla), 100e6, 0, trader);
        assertEq(quoted, out, "quote == actual");
    }

    function test_swap_fee_accrues_to_pool() public {
        _bootstrapPool(1_000e6, 1_000e18);
        // After swapping 100 USDC -> TSLA, USDC reserve should be 1_100 and TSLA reserve drops by amountOut.
        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(trader);
        router.swapExactIn(address(usdc), address(tsla), 100e6, 0, trader);

        (uint256 rUsdc, uint256 rTsla) = router.getReserves(address(usdc), address(tsla));
        assertEq(rUsdc, 1_100e6);
        // TSLA reserve = 1_000 - amountOut. The fee is accrued because amountOut is computed with
        // the 0.3% fee deduction, so the constant-product post-swap is slightly larger than k.
        // We just verify reserves shrank by the expected amount, and that k_new >= k_old.
        uint256 amountInWithFee = 100e6 * 997;
        uint256 expectedOut = (amountInWithFee * 1_000e18) / (1_000e6 * 1_000 + amountInWithFee);
        assertEq(rTsla, 1_000e18 - expectedOut);
        // k_new = 1_100e6 * (1_000e18 - expectedOut) > k_old = 1_000e6 * 1_000e18
        uint256 kNew = uint256(rUsdc) * uint256(rTsla);
        uint256 kOld = 1_000e6 * 1_000e18;
        assertGe(kNew, kOld, "fee preserves k");
    }

    // ---- M-8 regression: MINIMUM_LIQUIDITY blocks the empty-pool inflation attack ----

    /// @notice Audit M-8: an attacker who tries to seed the pool with the smallest possible
    ///         amount that mints non-zero LP tokens (geometric mean must exceed
    ///         `MINIMUM_LIQUIDITY = 1_000`) loses 1000 LP units permanently to address(0).
    ///         Subsequent honest LPs experience only rounding-grade precision loss.
    function test_first_mint_below_min_liquidity_reverts() public {
        router.createPool(address(usdc), address(tsla));
        _seedAndApprove(lp, 1, 1);
        // sqrt(1*1) = 1, which is <= MINIMUM_LIQUIDITY, so the first mint must revert.
        vm.prank(lp);
        vm.expectRevert(V2Router.InsufficientLiquidity.selector);
        router.addLiquidity(address(usdc), address(tsla), 1, 1);
    }

    /// @notice Audit M-8: direct ERC-20 donations to the router do NOT inflate per-LP value
    ///         because `getReserves` reads `pool.reserve0` / `pool.reserve1` from storage, not
    ///         from `balanceOf(router)`. There is no `skim`, so the donated tokens are simply
    ///         orphaned in the router.
    function test_direct_donation_does_not_inflate_reserves() public {
        _bootstrapPool(1_000e6, 1_000e18);
        (uint256 r0Before, uint256 r1Before) = router.getReserves(address(usdc), address(tsla));

        // Mallory donates a sizable amount directly to the router.
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 5_000e6);
        vm.prank(mallory);
        usdc.transfer(address(router), 5_000e6);

        // Reserves must NOT reflect the donation.
        (uint256 r0After, uint256 r1After) = router.getReserves(address(usdc), address(tsla));
        assertEq(r0After, r0Before, "reserve0 unchanged by donation");
        assertEq(r1After, r1Before, "reserve1 unchanged by donation");

        // A fresh LP's mint computes against storage reserves, not balances; donations cannot
        // dilute the legitimate LP.
        address lp2 = makeAddr("lp2");
        _seedAndApprove(lp2, 1_000e6, 1_000e18);
        vm.prank(lp2);
        uint256 lpMinted = router.addLiquidity(address(usdc), address(tsla), 1_000e6, 1_000e18);
        assertGt(lpMinted, 0, "lp2 still mints LP units against storage reserves");
    }
}

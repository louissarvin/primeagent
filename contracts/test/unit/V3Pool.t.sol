// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {V3Pool} from "../../src/dex/V3Pool.sol";
import {IV3Pool, IV3MintCallback, IV3SwapCallback} from "../../src/interfaces/IV3Pool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Lightweight test harness that fulfils the V3 mint+swap callbacks for tests.
contract V3PoolCaller is IV3MintCallback, IV3SwapCallback {
    address public token0;
    address public token1;
    V3Pool public pool;
    address public payer;

    constructor(address t0, address t1, address p) {
        token0 = t0;
        token1 = t1;
        pool = V3Pool(p);
        payer = msg.sender;
    }

    function doMint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, address payer_)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        payer = payer_;
        (amount0, amount1) = pool.mint(recipient, tickLower, tickUpper, amount, abi.encode(payer_));
    }

    function doSwap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address payer_
    )
        external
        returns (int256 amount0, int256 amount1)
    {
        payer = payer_;
        (amount0, amount1) = pool.swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, abi.encode(payer_));
    }

    function doBurn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256) {
        return pool.burn(tickLower, tickUpper, amount);
    }

    function doCollect(address recipient, int24 tickLower, int24 tickUpper, uint128 a0, uint128 a1)
        external
        returns (uint128, uint128)
    {
        return pool.collect(recipient, tickLower, tickUpper, a0, a1);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        address p = abi.decode(data, (address));
        if (amount0Owed > 0) IERC20(token0).transferFrom(p, msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).transferFrom(p, msg.sender, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        address p = abi.decode(data, (address));
        if (amount0Delta > 0) IERC20(token0).transferFrom(p, msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).transferFrom(p, msg.sender, uint256(amount1Delta));
    }
}

contract V3PoolTest is Test {
    V3Pool internal pool;
    MockERC20 internal t0;
    MockERC20 internal t1;
    V3PoolCaller internal caller;

    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    uint160 internal constant START_SQRT = 79_228_162_514_264_337_593_543_950_336; // ~= 1.0 in Q96

    function setUp() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        // Sort.
        if (address(a) < address(b)) {
            t0 = a;
            t1 = b;
        } else {
            t0 = b;
            t1 = a;
        }
        pool = new V3Pool(address(t0), address(t1), 3_000);
        caller = new V3PoolCaller(address(t0), address(t1), address(pool));
    }

    function _mint(address recipient, int24 lo, int24 hi, uint128 amount, address payer) internal {
        t0.mint(payer, amount);
        t1.mint(payer, amount);
        vm.prank(payer);
        t0.approve(address(caller), type(uint256).max);
        vm.prank(payer);
        t1.approve(address(caller), type(uint256).max);
        caller.doMint(recipient, lo, hi, amount, payer);
    }

    function test_constructor_requires_sorted_tokens() public {
        vm.expectRevert(V3Pool.InvalidAmount.selector);
        new V3Pool(address(t1), address(t0), 3_000);
    }

    function test_constructor_requires_3000_fee() public {
        vm.expectRevert(V3Pool.InvalidAmount.selector);
        new V3Pool(address(t0), address(t1), 500);
    }

    function test_initialize_sets_price() public {
        pool.initialize(START_SQRT);
        assertEq(pool.sqrtPriceX96(), START_SQRT);
        assertTrue(pool.initialized());
    }

    function test_initialize_twice_reverts() public {
        pool.initialize(START_SQRT);
        vm.expectRevert(V3Pool.AlreadyInitialized.selector);
        pool.initialize(START_SQRT);
    }

    function test_mint_reverts_uninitialized() public {
        t0.mint(lp, 1_000);
        t1.mint(lp, 1_000);
        vm.prank(lp);
        t0.approve(address(caller), type(uint256).max);
        vm.prank(lp);
        t1.approve(address(caller), type(uint256).max);
        vm.expectRevert(V3Pool.NotInitialized.selector);
        caller.doMint(address(caller), -10, 10, 1_000, lp);
    }

    function test_mint_grows_liquidity_and_pulls_tokens() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -10, 10, 1_000, lp);
        assertEq(pool.liquidity(), 1_000, "global liquidity");
        bytes32 key = pool.positionKey(address(caller), -10, 10);
        (uint128 liq,,) = pool.positions(key);
        assertEq(liq, 1_000, "position liquidity");
        assertEq(t0.balanceOf(address(pool)), 1_000);
        assertEq(t1.balanceOf(address(pool)), 1_000);
    }

    function test_mint_reverts_invalid_tick() public {
        pool.initialize(START_SQRT);
        t0.mint(lp, 1_000);
        t1.mint(lp, 1_000);
        vm.prank(lp);
        t0.approve(address(caller), type(uint256).max);
        vm.prank(lp);
        t1.approve(address(caller), type(uint256).max);
        vm.expectRevert(V3Pool.InvalidTick.selector);
        caller.doMint(address(caller), 10, 10, 1_000, lp);
    }

    function test_swap_zeroForOne_moves_price_down() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 1_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        uint160 priceBefore = pool.sqrtPriceX96();
        (int256 amount0, int256 amount1) = caller.doSwap(trader, true, 1_000, 1, trader);
        assertGt(amount0, 0, "user paid t0");
        assertLt(amount1, 0, "user received t1");
        assertLt(pool.sqrtPriceX96(), priceBefore, "price moved down");
    }

    function test_swap_oneForZero_moves_price_up() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t1.mint(trader, 1_000);
        vm.prank(trader);
        t1.approve(address(caller), type(uint256).max);

        uint160 priceBefore = pool.sqrtPriceX96();
        (int256 amount0, int256 amount1) =
            caller.doSwap(trader, false, 1_000, type(uint160).max - 1, trader);
        assertLt(amount0, 0, "user received t0");
        assertGt(amount1, 0, "user paid t1");
        assertGt(pool.sqrtPriceX96(), priceBefore, "price moved up");
    }

    function test_swap_reverts_price_limit() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 100_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);
        // Limit set just below the current price will reject the swap.
        uint160 currentPrice = pool.sqrtPriceX96();
        vm.expectRevert(V3Pool.PriceLimitExceeded.selector);
        caller.doSwap(trader, true, 50_000, currentPrice - 1, trader);
    }

    function test_swap_reverts_uninitialized() public {
        // Not initialized => InsufficientLiquidity triggers first because liquidity == 0.
        vm.expectRevert(V3Pool.NotInitialized.selector);
        caller.doSwap(trader, true, 1_000, 1, trader);
    }

    function test_burn_decreases_liquidity() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -10, 10, 1_000, lp);
        vm.prank(address(caller));
        // burn must be called from caller (the position owner).
        caller.doBurn(-10, 10, 500);
        assertEq(pool.liquidity(), 500);
        bytes32 key = pool.positionKey(address(caller), -10, 10);
        (uint128 liq, uint256 owed0, uint256 owed1) = pool.positions(key);
        assertEq(liq, 500);
        assertEq(owed0, 500);
        assertEq(owed1, 500);
    }

    function test_collect_pays_out_owed() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -10, 10, 1_000, lp);
        caller.doBurn(-10, 10, 1_000);
        (uint128 a0, uint128 a1) = caller.doCollect(lp, -10, 10, type(uint128).max, type(uint128).max);
        assertEq(a0, 1_000);
        assertEq(a1, 1_000);
        assertEq(t0.balanceOf(lp), 1_000);
        assertEq(t1.balanceOf(lp), 1_000);
    }

    function test_burn_reverts_insufficient_liquidity() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -10, 10, 1_000, lp);
        vm.expectRevert(V3Pool.InsufficientLiquidity.selector);
        caller.doBurn(-10, 10, 2_000);
    }

    function test_position_key_roundtrip() public view {
        bytes32 k1 = pool.positionKey(address(this), -50, 50);
        bytes32 k2 = pool.positionKey(address(this), -50, 50);
        assertEq(k1, k2);
        bytes32 k3 = pool.positionKey(address(this), -51, 50);
        assertTrue(k1 != k3);
    }

    // ---- C-3 + H-2 regression: swap math + transient callback storage ----

    /// @notice Audit C-3 regression. The original swap math kept `liquidity` constant on swaps
    ///         even though tokens actually left the pool, so a mint -> swap loop -> burn flow
    ///         could let the burner walk away with more than they deposited. The fix tracks
    ///         virtual reserves separately and never decrements `liquidity` on swap. This test
    ///         pre-loads liquidity, performs a series of swap+repay roundtrips, then burns and
    ///         collects, and asserts that the pool's invariant (the amount actually paid out on
    ///         collect <= amount deposited on mint) holds.
    function test_swap_does_not_drain_liquidity_via_mint_swap_burn_loop() public {
        pool.initialize(START_SQRT);
        // LP deposits 100_000 each token.
        _mint(address(caller), -100, 100, 100_000, lp);
        uint256 t0PoolAfterMint = t0.balanceOf(address(pool));
        uint256 t1PoolAfterMint = t1.balanceOf(address(pool));

        // Run several swaps using the trader.
        t0.mint(trader, 30_000);
        t1.mint(trader, 30_000);
        vm.startPrank(trader);
        t0.approve(address(caller), type(uint256).max);
        t1.approve(address(caller), type(uint256).max);
        vm.stopPrank();

        // 3 small zeroForOne swaps and 3 oneForZero swaps.
        for (uint256 i; i < 3; ++i) {
            caller.doSwap(trader, true, 1_000, 1, trader);
            caller.doSwap(trader, false, 1_000, type(uint160).max - 1, trader);
        }

        // Now the LP burns and collects.
        caller.doBurn(-100, 100, 100_000);
        (uint128 a0, uint128 a1) =
            caller.doCollect(lp, -100, 100, type(uint128).max, type(uint128).max);

        // The LP receives ONLY what the pool's virtual reserves track, never more than the pool
        // actually holds. Specifically, a0 + a1 must be <= (t0PoolAfterMint + t1PoolAfterMint),
        // i.e. the LP cannot extract more than they originally deposited.
        assertLe(uint256(a0) + uint256(a1), t0PoolAfterMint + t1PoolAfterMint, "no free extraction");
        // And the pool's real ERC-20 balances after collect cannot go negative (would revert).
        // We additionally check that liquidity tracked from mint/burn is now zero, confirming
        // the burn went through and the global counter was not double-counted by the swap path.
        assertEq(pool.liquidity(), 0, "liquidity zeroed by burn");
    }

    /// @notice Audit H-2 regression. The pool's amount-owed values for the in-flight swap MUST
    ///         live in transient storage. A direct read after the swap completes returns zero
    ///         because tstore data is cleared at the end of the transaction (or at the end of
    ///         the swap's explicit cleanup).
    function test_swap_callback_uses_transient_storage() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 1_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        // Execute the swap; after it returns, the transient slots should be cleared.
        caller.doSwap(trader, true, 1_000, 1, trader);
        (uint256 owed0, uint256 owed1) = pool.getCallbackAmountsOwed();
        assertEq(owed0, 0, "transient amount0 cleared post-swap");
        assertEq(owed1, 0, "transient amount1 cleared post-swap");
    }

    /// @notice Audit C-3 regression. A zeroForOne swap must respect a sqrtPriceLimitX96 that
    ///         is set just below the current price.
    function test_swap_respects_sqrtPriceLimit_zeroForOne() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 50_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        uint160 currentPrice = pool.sqrtPriceX96();
        // A limit just below current must reject because the swap will push the price below it.
        vm.expectRevert(V3Pool.PriceLimitExceeded.selector);
        caller.doSwap(trader, true, 50_000, currentPrice - 1, trader);
    }

    /// @notice Audit C-3 regression. A oneForZero swap must respect a sqrtPriceLimitX96 that is
    ///         set just above the current price.
    function test_swap_respects_sqrtPriceLimit_oneForZero() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t1.mint(trader, 50_000);
        vm.prank(trader);
        t1.approve(address(caller), type(uint256).max);

        uint160 currentPrice = pool.sqrtPriceX96();
        // A limit just above current must reject because the swap will push the price above it.
        vm.expectRevert(V3Pool.PriceLimitExceeded.selector);
        caller.doSwap(trader, false, 50_000, currentPrice + 1, trader);
    }

    /// @notice Static-analysis S-M-1 regression. Sub-`MIN_SWAP_AMOUNT` inputs must revert at the
    ///         pool entry point so the 30 bps fee math never rounds the fee to zero.
    function test_swap_below_min_amount_reverts() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 10_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        vm.expectRevert(V3Pool.AmountTooSmall.selector);
        caller.doSwap(trader, true, 999, 1, trader);
    }

    /// @notice Static-analysis S-M-1 boundary regression. Exactly `MIN_SWAP_AMOUNT` (1_000) is
    ///         accepted; the fee is computed honestly above this floor.
    function test_swap_at_min_amount_succeeds() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 10_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        (int256 amount0, int256 amount1) = caller.doSwap(trader, true, 1_000, 1, trader);
        assertEq(amount0, int256(1_000), "exact-in 1_000 consumed");
        assertLt(amount1, 0, "trader received t1");
    }

    /// @notice Audit C-3 regression. Repeated zeroForOne swaps MUST monotonically drain the
    ///         token1 virtual reserve and increase the token0 virtual reserve, proving the
    ///         swap math now updates virtual reserves on every call (the original bug left
    ///         `liquidity` unchanged so reserves were inferred as constant).
    function test_repeated_swaps_progressively_drain_output_reserve() public {
        pool.initialize(START_SQRT);
        _mint(address(caller), -100, 100, 100_000, lp);
        t0.mint(trader, 1_000_000);
        vm.prank(trader);
        t0.approve(address(caller), type(uint256).max);

        uint256 r1Before = pool.reserve1();
        uint256 r0Before = pool.reserve0();
        // Two swaps in a row.
        caller.doSwap(trader, true, 5_000, 1, trader);
        uint256 r1Mid = pool.reserve1();
        uint256 r0Mid = pool.reserve0();
        caller.doSwap(trader, true, 5_000, 1, trader);
        uint256 r1After = pool.reserve1();
        uint256 r0After = pool.reserve0();

        // r1 should fall monotonically; r0 should grow.
        assertLt(r1Mid, r1Before, "reserve1 drained on first swap");
        assertLt(r1After, r1Mid, "reserve1 drained on second swap");
        assertGt(r0Mid, r0Before, "reserve0 grew on first swap");
        assertGt(r0After, r0Mid, "reserve0 grew on second swap");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {V3Pool} from "../../src/dex/V3Pool.sol";
import {V3PositionManager} from "../../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../../src/interfaces/IV3PositionManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract V3PositionManagerTest is Test {
    V3Pool internal pool;
    V3PositionManager internal posMgr;
    MockERC20 internal t0;
    MockERC20 internal t1;

    address internal lp = makeAddr("lp");

    uint160 internal constant START_SQRT = 79_228_162_514_264_337_593_543_950_336;

    function setUp() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        if (address(a) < address(b)) {
            t0 = a;
            t1 = b;
        } else {
            t0 = b;
            t1 = a;
        }
        pool = new V3Pool(address(t0), address(t1), 3_000);
        pool.initialize(START_SQRT);
        posMgr = new V3PositionManager(address(pool));
    }

    function _mintPosition(address to, uint256 amt) internal returns (uint256 tokenId, uint128 liq) {
        t0.mint(lp, amt);
        t1.mint(lp, amt);
        vm.prank(lp);
        t0.approve(address(posMgr), type(uint256).max);
        vm.prank(lp);
        t1.approve(address(posMgr), type(uint256).max);

        IV3PositionManager.MintParams memory p = IV3PositionManager.MintParams({
            token0: address(t0),
            token1: address(t1),
            fee: 3_000,
            tickLower: -100,
            tickUpper: 100,
            amount0Desired: amt,
            amount1Desired: amt,
            recipient: to
        });
        vm.prank(lp);
        (tokenId, liq) = posMgr.mint(p);
    }

    function test_mint_creates_nft_and_supplies_pool() public {
        (uint256 tokenId, uint128 liq) = _mintPosition(lp, 10_000);
        assertEq(tokenId, 1);
        assertEq(liq, 10_000);
        assertEq(posMgr.ownerOf(tokenId), lp);
        (int24 lo, int24 hi, uint128 storedLiq,,) = posMgr.positionsOf(tokenId);
        assertEq(lo, -100);
        assertEq(hi, 100);
        assertEq(storedLiq, 10_000);
    }

    function test_mint_revert_pool_mismatch() public {
        IV3PositionManager.MintParams memory p = IV3PositionManager.MintParams({
            token0: address(0xdead),
            token1: address(t1),
            fee: 3_000,
            tickLower: -10,
            tickUpper: 10,
            amount0Desired: 10,
            amount1Desired: 10,
            recipient: lp
        });
        vm.expectRevert(V3PositionManager.PoolMismatch.selector);
        posMgr.mint(p);
    }

    function test_mint_revert_zero_recipient() public {
        IV3PositionManager.MintParams memory p = IV3PositionManager.MintParams({
            token0: address(t0),
            token1: address(t1),
            fee: 3_000,
            tickLower: -10,
            tickUpper: 10,
            amount0Desired: 10,
            amount1Desired: 10,
            recipient: address(0)
        });
        vm.expectRevert(V3PositionManager.InvalidAmount.selector);
        posMgr.mint(p);
    }

    function test_decreaseLiquidity_credits_owed() public {
        (uint256 tokenId,) = _mintPosition(lp, 10_000);
        vm.prank(lp);
        (uint256 a0, uint256 a1) = posMgr.decreaseLiquidity(tokenId, 5_000);
        assertEq(a0, 5_000);
        assertEq(a1, 5_000);
        (, , uint128 liq, uint256 owed0, uint256 owed1) = posMgr.positionsOf(tokenId);
        assertEq(liq, 5_000);
        assertEq(owed0, 5_000);
        assertEq(owed1, 5_000);
    }

    function test_collect_pays_out() public {
        (uint256 tokenId,) = _mintPosition(lp, 10_000);
        vm.prank(lp);
        posMgr.decreaseLiquidity(tokenId, 5_000);
        vm.prank(lp);
        (uint256 a0, uint256 a1) = posMgr.collect(tokenId, lp);
        assertEq(a0, 5_000);
        assertEq(a1, 5_000);
        assertEq(t0.balanceOf(lp), 5_000);
        assertEq(t1.balanceOf(lp), 5_000);
    }

    function test_burn_clears_position() public {
        (uint256 tokenId,) = _mintPosition(lp, 1_000);
        vm.prank(lp);
        posMgr.decreaseLiquidity(tokenId, 1_000);
        vm.prank(lp);
        posMgr.collect(tokenId, lp);
        vm.prank(lp);
        posMgr.burn(tokenId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        posMgr.ownerOf(tokenId);
    }

    function test_burn_revert_not_empty() public {
        (uint256 tokenId,) = _mintPosition(lp, 1_000);
        vm.prank(lp);
        vm.expectRevert(V3PositionManager.PositionNotEmpty.selector);
        posMgr.burn(tokenId);
    }

    function test_decrease_only_owner_or_approved() public {
        (uint256 tokenId,) = _mintPosition(lp, 1_000);
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(V3PositionManager.NotOwnerOrApproved.selector);
        posMgr.decreaseLiquidity(tokenId, 500);
    }

    function test_erc721_supports_interface() public view {
        // OZ ERC721 supportsInterface
        assertTrue(posMgr.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(posMgr.supportsInterface(0x01ffc9a7)); // ERC165
    }

    /// @notice Static-analysis S-M-3 regression. If the underlying `pool.collect` returns a
    ///         different (amount0, amount1) than the `burn` step reported, the position manager
    ///         must revert `CollectMismatch` rather than silently drift its `tokensOwed` ledger.
    ///         We use `vm.mockCall` to make the pool return `(amount0 - 1, amount1)` instead of
    ///         the full burn amounts.
    function test_collect_reverts_on_amount_mismatch_with_pool() public {
        (uint256 tokenId,) = _mintPosition(lp, 10_000);

        // Mock the pool's collect to return a value lower than requested.
        // The PositionManager calls pool.collect(this, tickLower, tickUpper, u128(5000), u128(5000))
        // expecting (5000, 5000). We make it return (4999, 5000).
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(V3Pool.collect.selector),
            abi.encode(uint128(4_999), uint128(5_000))
        );

        vm.prank(lp);
        vm.expectRevert(V3PositionManager.CollectMismatch.selector);
        posMgr.decreaseLiquidity(tokenId, 5_000);
    }

    /// @notice Static-analysis S-M-3 happy path. When the pool's collect returns exactly the
    ///         burn amounts, `decreaseLiquidity` succeeds and the position manager's
    ///         `tokensOwed` is credited the full amount.
    function test_collect_succeeds_when_expected_equals_actual() public {
        (uint256 tokenId,) = _mintPosition(lp, 10_000);
        vm.prank(lp);
        (uint256 a0, uint256 a1) = posMgr.decreaseLiquidity(tokenId, 5_000);
        assertEq(a0, 5_000, "amount0 matches burn");
        assertEq(a1, 5_000, "amount1 matches burn");
        (, , uint128 storedLiq, uint256 owed0, uint256 owed1) = posMgr.positionsOf(tokenId);
        assertEq(storedLiq, 5_000);
        assertEq(owed0, 5_000);
        assertEq(owed1, 5_000);
    }
}

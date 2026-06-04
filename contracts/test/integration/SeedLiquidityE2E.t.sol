// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {V2Router} from "../../src/dex/V2Router.sol";
import {V3Pool} from "../../src/dex/V3Pool.sol";
import {V3PositionManager} from "../../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../../src/interfaces/IV3PositionManager.sol";
import {IV3Pool, IV3SwapCallback} from "../../src/interfaces/IV3Pool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title SeedLiquidityE2ETest
/// @notice In-process end-to-end test that mirrors the `script/SeedLiquidity.s.sol` workflow:
///         deploy USDC + 5 stock mocks, create V2 + V3 pools at $100k notional each, then sanity
///         check that a buy of TSLA via V2 and a buy of TSLA via V3 both quote and execute.
/// @dev    We intentionally do NOT call the script's `run()` here because Foundry's broadcast
///         system wraps the deploy in `vm.startBroadcast` which complicates assertions about the
///         intermediate state. The seeding sequence is identical so the test is a faithful
///         in-process mirror.
contract SeedLiquidityE2ETest is Test, IV3SwapCallback, IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    uint256 internal constant LIQUIDITY_USDC_PER_POOL = 100_000 * 1e6;

    MockERC20 internal usdc;
    V2Router internal v2;
    MockERC20 internal tsla;
    V3Pool internal tslaV3;
    V3PositionManager internal tslaPosMgr;
    address internal v3Payer; // for the swap callback

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        v2 = new V2Router();

        // TSLA path only -- the V2 / V3 logic is identical for the other four stocks.
        tsla = new MockERC20("Tesla", "TSLA", 18);
        // 363.636... TSLA at $275 per share, for $100k notional.
        uint256 tslaSeed = Math.mulDiv(LIQUIDITY_USDC_PER_POOL, 1e12, 275);

        // Mint enough for V2 + V3 + spare for the swap leg.
        usdc.mint(address(this), LIQUIDITY_USDC_PER_POOL * 5);
        tsla.mint(address(this), tslaSeed * 5);

        // --- V2 ---
        v2.createPool(address(usdc), address(tsla));
        usdc.approve(address(v2), type(uint256).max);
        tsla.approve(address(v2), type(uint256).max);
        v2.addLiquidity(address(usdc), address(tsla), LIQUIDITY_USDC_PER_POOL, tslaSeed);

        // --- V3 ---
        (address t0, address t1) =
            address(usdc) < address(tsla) ? (address(usdc), address(tsla)) : (address(tsla), address(usdc));
        tslaV3 = new V3Pool(t0, t1, 3_000);
        tslaPosMgr = new V3PositionManager(address(tslaV3));
        tslaV3.initialize(uint160(1 << 96));

        uint256 v3Amount = LIQUIDITY_USDC_PER_POOL < tslaSeed ? LIQUIDITY_USDC_PER_POOL : tslaSeed;
        IERC20(t0).approve(address(tslaPosMgr), type(uint256).max);
        IERC20(t1).approve(address(tslaPosMgr), type(uint256).max);

        tslaPosMgr.mint(
            IV3PositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: 3_000,
                tickLower: -887_220,
                tickUpper: 887_220,
                amount0Desired: v3Amount,
                amount1Desired: v3Amount,
                recipient: address(this)
            })
        );
    }

    /*//////////////////////////////////////////////////////////////
                        SETUP INVARIANT ASSERTIONS
    //////////////////////////////////////////////////////////////*/

    function test_v2_reserves_match_seed_amount() public view {
        (uint256 rUsdc, uint256 rTsla) = v2.getReserves(address(usdc), address(tsla));
        assertEq(rUsdc, LIQUIDITY_USDC_PER_POOL, "USDC reserve seeded to $100k");
        // 363.636363... TSLA == 100_000 * 1e12 / 275
        uint256 expectedTsla = Math.mulDiv(LIQUIDITY_USDC_PER_POOL, 1e12, 275);
        assertEq(rTsla, expectedTsla, "TSLA reserve seeded");
    }

    function test_v3_pool_initialized_and_holds_liquidity() public view {
        assertTrue(tslaV3.initialized(), "v3 initialized");
        assertGt(uint256(tslaV3.liquidity()), 0, "v3 liquidity nonzero");
    }

    /*//////////////////////////////////////////////////////////////
                              V2 SWAP TEST
    //////////////////////////////////////////////////////////////*/

    function test_v2_swap_usdc_for_tsla_succeeds() public {
        address buyer = makeAddr("v2buyer");
        uint256 inAmt = 1_000 * 1e6; // buy with $1k USDC

        usdc.mint(buyer, inAmt);
        vm.prank(buyer);
        usdc.approve(address(v2), inAmt);

        uint256 quoted = v2.quote(address(usdc), address(tsla), inAmt);
        assertGt(quoted, 0, "quote > 0");

        vm.prank(buyer);
        uint256 out = v2.swapExactIn(address(usdc), address(tsla), inAmt, 1, buyer);
        assertEq(out, quoted, "swap output matches quote");
        assertEq(tsla.balanceOf(buyer), out, "buyer received TSLA");

        // Sanity: at $275 spot with $1k notional, the buyer should receive ~3.6 TSLA. Allow a
        // generous bound for the constant-product slippage on a $100k pool.
        // 1k / 275 ~ 3.636 TSLA. In 1e18: ~3.636e18. Lower bound 3e18, upper 4e18.
        assertGt(out, 3 * 1e18, "v2 buyer got at least 3 TSLA");
        assertLt(out, 4 * 1e18, "v2 buyer got less than 4 TSLA (slippage)");
    }

    /*//////////////////////////////////////////////////////////////
                              V3 SWAP TEST
    //////////////////////////////////////////////////////////////*/

    /// @notice We call `swap` directly on the pool, fulfilling the callback in this contract.
    ///         The PositionManager only exposes mint/burn/collect; swapping in the in-house V3
    ///         fork is done at the pool level.
    function test_v3_swap_zeroForOne_succeeds() public {
        // Determine which token is token0/token1 to know swap direction. zeroForOne means we
        // pay token0 in and receive token1 out. We always want to buy TSLA so we pay USDC.
        bool zeroForOne = (tslaV3.token0() == address(usdc));
        uint256 inAmt = 1_000 * 1e6;

        // Fund this contract so the callback can pay the pool.
        usdc.mint(address(this), inAmt);
        v3Payer = address(this);

        uint256 tslaBefore = tsla.balanceOf(address(this));
        // sqrtPriceLimitX96: pick 0 (min) when zeroForOne == true means "no limit on price
        // decrease"; the pool enforces MIN/MAX bounds internally. We pass MIN for zeroForOne
        // and MAX otherwise.
        uint160 limit = zeroForOne ? uint160(4_295_128_739) : type(uint128).max;
        (int256 a0, int256 a1) =
            tslaV3.swap(address(this), zeroForOne, int256(inAmt), limit, abi.encode(address(this)));

        // amountSpecified is always positive (exactIn). zeroForOne -> a0 == +inAmt, a1 negative.
        if (zeroForOne) {
            assertEq(uint256(a0), inAmt, "v3 paid input");
            assertGt(uint256(-a1), 0, "v3 received output");
        } else {
            assertEq(uint256(a1), inAmt, "v3 paid input");
            assertGt(uint256(-a0), 0, "v3 received output");
        }
        assertGt(tsla.balanceOf(address(this)), tslaBefore, "tsla balance up");
    }

    /// @inheritdoc IV3SwapCallback
    /// @dev The pool calls back to the swap initiator (this contract) to pull the input token.
    ///      One of `amount0Delta` / `amount1Delta` is positive (the side we owe); the other is
    ///      negative (the side we received). We forward the positive side's tokens to the pool.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        // Must be invoked by the pool we just called.
        require(msg.sender == address(tslaV3), "callback: not pool");
        if (amount0Delta > 0) {
            IERC20(tslaV3.token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(tslaV3.token1()).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }
}

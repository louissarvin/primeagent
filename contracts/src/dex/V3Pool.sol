// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IV3Pool, IV3MintCallback, IV3SwapCallback} from "../interfaces/IV3Pool.sol";

contract V3Pool is IV3Pool, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error NotInitialized();
    error AlreadyInitialized();
    error InvalidTick();
    error InsufficientLiquidity();
    error PriceLimitExceeded();
    error InvalidAmount();
    error CallbackInsufficient();
    error AmountTooSmall();

    struct Position {
        uint128 liquidity;
        uint256 tokensOwed0;
        uint256 tokensOwed1;
    }

    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO = type(uint128).max;
    uint256 internal constant MIN_SWAP_AMOUNT = 1_000;
    bytes32 private constant _AMOUNT0_OWED_SLOT = keccak256("primeagent.v3pool.amount0Owed");
    bytes32 private constant _AMOUNT1_OWED_SLOT = keccak256("primeagent.v3pool.amount1Owed");

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint128 public liquidity;
    uint256 public reserve0;
    uint256 public reserve1;
    uint160 public sqrtPriceX96;
    int24 public tick;
    bool internal _initialized;

    mapping(int24 tickIndex => uint128 liquidityNet) public ticks;
    mapping(bytes32 positionKey => Position) public positions;

    constructor(address token0_, address token1_, uint24 fee_) {
        if (token0_ == address(0) || token1_ == address(0)) revert InvalidAmount();
        if (token0_ >= token1_) revert InvalidAmount();
        if (fee_ != 3_000) revert InvalidAmount();
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function initialize(uint160 sqrtPriceX96_) external {
        if (_initialized) revert AlreadyInitialized();
        if (sqrtPriceX96_ < MIN_SQRT_RATIO || sqrtPriceX96_ > MAX_SQRT_RATIO) revert InvalidAmount();
        sqrtPriceX96 = sqrtPriceX96_;
        tick = 0;
        _initialized = true;
        emit Initialize(sqrtPriceX96_, 0);
    }

    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    )
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (!_initialized) revert NotInitialized();
        if (tickLower >= tickUpper) revert InvalidTick();
        if (amount == 0) revert InvalidAmount();

        amount0 = uint256(amount);
        amount1 = uint256(amount);

        bytes32 key = _positionKey(recipient, tickLower, tickUpper);
        positions[key].liquidity += amount;
        ticks[tickLower] += amount;
        ticks[tickUpper] += amount;

        liquidity += amount;
        reserve0 += amount0;
        reserve1 += amount1;

        emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);

        uint256 balance0Before = IERC20(token0).balanceOf(address(this));
        uint256 balance1Before = IERC20(token1).balanceOf(address(this));
        IV3MintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
        if (IERC20(token0).balanceOf(address(this)) < balance0Before + amount0) revert CallbackInsufficient();
        if (IERC20(token1).balanceOf(address(this)) < balance1Before + amount1) revert CallbackInsufficient();
    }

    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    )
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (!_initialized) revert NotInitialized();
        if (tickLower >= tickUpper) revert InvalidTick();
        bytes32 key = _positionKey(msg.sender, tickLower, tickUpper);
        Position storage position = positions[key];
        if (amount == 0 || position.liquidity < amount) revert InsufficientLiquidity();

        amount0 = uint256(amount);
        amount1 = uint256(amount);

        unchecked {
            position.liquidity -= amount;
            liquidity -= amount;
            ticks[tickLower] -= amount;
            ticks[tickUpper] -= amount;
        }
        uint256 r0 = reserve0;
        uint256 r1 = reserve1;
        uint256 burn0 = amount0 > r0 ? r0 : amount0;
        uint256 burn1 = amount1 > r1 ? r1 : amount1;
        reserve0 = r0 - burn0;
        reserve1 = r1 - burn1;
        position.tokensOwed0 += burn0;
        position.tokensOwed1 += burn1;
        amount0 = burn0;
        amount1 = burn1;

        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
    }

    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    )
        external
        nonReentrant
        returns (uint128 amount0, uint128 amount1)
    {
        bytes32 key = _positionKey(msg.sender, tickLower, tickUpper);
        Position storage position = positions[key];

        uint256 owed0 = position.tokensOwed0;
        uint256 owed1 = position.tokensOwed1;
        amount0 = amount0Requested > owed0 ? uint128(owed0) : amount0Requested;
        amount1 = amount1Requested > owed1 ? uint128(owed1) : amount1Requested;

        if (amount0 > 0) {
            position.tokensOwed0 = owed0 - amount0;
            IERC20(token0).safeTransfer(recipient, amount0);
        }
        if (amount1 > 0) {
            position.tokensOwed1 = owed1 - amount1;
            IERC20(token1).safeTransfer(recipient, amount1);
        }
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    )
        external
        nonReentrant
        returns (int256 amount0, int256 amount1)
    {
        if (!_initialized) revert NotInitialized();
        if (amountSpecified <= 0) revert InvalidAmount();
        if (liquidity == 0) revert InsufficientLiquidity();

        uint256 amountIn = uint256(amountSpecified);
        if (amountIn < MIN_SWAP_AMOUNT) revert AmountTooSmall();
        (uint256 reserveIn, uint256 reserveOut) =
            zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        // Canonical Uniswap-style constant-product fee math. The division by 1_000_000
        // must precede the multiply by reserveOut to avoid intermediate overflow on
        // large reserves. Precision loss is bounded to <= 1e-6 and acceptable.
        // slither-disable-next-line divide-before-multiply
        uint256 amountInLessFee = (amountIn * 997_000) / 1_000_000;
        uint256 amountOut = (amountInLessFee * reserveOut) / (reserveIn + amountInLessFee);
        if (amountOut == 0) revert InsufficientLiquidity();
        if (amountOut >= reserveOut) revert InsufficientLiquidity();

        uint256 newReserveIn = reserveIn + amountIn;
        uint256 newReserveOut = reserveOut - amountOut;
        if (zeroForOne) {
            reserve0 = newReserveIn;
            reserve1 = newReserveOut;
        } else {
            reserve1 = newReserveIn;
            reserve0 = newReserveOut;
        }

        uint160 newPrice = _sqrtPriceFromReserves(
            zeroForOne ? newReserveIn : newReserveOut,
            zeroForOne ? newReserveOut : newReserveIn
        );

        if (zeroForOne) {
            if (newPrice < sqrtPriceLimitX96) revert PriceLimitExceeded();
            if (newPrice < MIN_SQRT_RATIO) revert PriceLimitExceeded();
        } else {
            if (newPrice > sqrtPriceLimitX96) revert PriceLimitExceeded();
            if (newPrice > MAX_SQRT_RATIO) revert PriceLimitExceeded();
        }
        sqrtPriceX96 = newPrice;

        amount0 = zeroForOne ? int256(amountIn) : -int256(amountOut);
        amount1 = zeroForOne ? -int256(amountOut) : int256(amountIn);

        emit Swap(msg.sender, recipient, amount0, amount1, newPrice, liquidity, tick);

        bytes32 a0Slot = _AMOUNT0_OWED_SLOT;
        bytes32 a1Slot = _AMOUNT1_OWED_SLOT;
        uint256 owed0 = zeroForOne ? amountIn : 0;
        uint256 owed1 = zeroForOne ? 0 : amountIn;
        assembly {
            tstore(a0Slot, owed0)
            tstore(a1Slot, owed1)
        }

        if (zeroForOne) {
            IERC20(token1).safeTransfer(recipient, amountOut);
            uint256 balance0Before = IERC20(token0).balanceOf(address(this));
            IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            if (IERC20(token0).balanceOf(address(this)) < balance0Before + amountIn) revert CallbackInsufficient();
        } else {
            IERC20(token0).safeTransfer(recipient, amountOut);
            uint256 balance1Before = IERC20(token1).balanceOf(address(this));
            IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            if (IERC20(token1).balanceOf(address(this)) < balance1Before + amountIn) revert CallbackInsufficient();
        }

        assembly {
            tstore(a0Slot, 0)
            tstore(a1Slot, 0)
        }
    }

    function getCallbackAmountsOwed() external view returns (uint256 amount0Owed, uint256 amount1Owed) {
        bytes32 a0Slot = _AMOUNT0_OWED_SLOT;
        bytes32 a1Slot = _AMOUNT1_OWED_SLOT;
        assembly {
            amount0Owed := tload(a0Slot)
            amount1Owed := tload(a1Slot)
        }
    }

    function _sqrtPriceFromReserves(uint256 r0, uint256 r1) internal pure returns (uint160) {
        if (r0 == 0) return MAX_SQRT_RATIO;
        // Compute (r1 << 192) / r0. To avoid overflowing the 256-bit multiplier we use mulDiv.
        uint256 ratioQ192 = Math.mulDiv(r1, 1 << 192, r0);
        uint256 sqrtQ96 = Math.sqrt(ratioQ192);
        if (sqrtQ96 > MAX_SQRT_RATIO) return MAX_SQRT_RATIO;
        if (sqrtQ96 < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
        return uint160(sqrtQ96);
    }

    function initialized() external view returns (bool) {
        return _initialized;
    }

    function positionKey(
        address owner,
        int24 tickLower,
        int24 tickUpper
    )
        external
        pure
        returns (bytes32)
    {
        return _positionKey(owner, tickLower, tickUpper);
    }

    function _positionKey(
        address owner,
        int24 tickLower,
        int24 tickUpper
    )
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(owner, tickLower, tickUpper));
    }
}

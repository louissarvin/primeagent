// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IV2Router} from "../interfaces/IV2Router.sol";

contract V2Router is IV2Router, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error IdenticalTokens();
    error ZeroAmount();
    error PoolExists();
    error PoolNotFound();
    error InsufficientLiquidity();
    error InsufficientOutput();
    error InsufficientLpBalance();

    struct Pool {
        uint128 reserve0;
        uint128 reserve1;
        address token0;
        address token1;
        uint256 totalLp;
    }

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1_000;

    mapping(bytes32 pairKey => Pool) internal _pools;
    mapping(bytes32 pairKey => mapping(address provider => uint256)) public lpBalance;

    function createPool(address tokenA, address tokenB) external returns (bytes32 key) {
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        key = _pairKey(t0, t1);
        if (_pools[key].token0 != address(0)) revert PoolExists();
        _pools[key].token0 = t0;
        _pools[key].token1 = t1;
        emit PoolCreated(key, t0, t1);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB
    )
        external
        nonReentrant
        returns (uint256 lpTokens)
    {
        if (amountA == 0 || amountB == 0) revert ZeroAmount();
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        if (pool.token0 == address(0)) revert PoolNotFound();

        (uint256 amount0, uint256 amount1) = tokenA == t0 ? (amountA, amountB) : (amountB, amountA);

        uint256 totalLp = pool.totalLp;
        if (totalLp == 0) {
            uint256 sqrtK = Math.sqrt(amount0 * amount1);
            if (sqrtK <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            unchecked {
                lpTokens = sqrtK - MINIMUM_LIQUIDITY;
            }
            lpBalance[key][address(0)] = MINIMUM_LIQUIDITY;
            pool.totalLp = sqrtK;
        } else {
            uint256 fromAmount0 = Math.mulDiv(amount0, totalLp, pool.reserve0);
            uint256 fromAmount1 = Math.mulDiv(amount1, totalLp, pool.reserve1);
            lpTokens = fromAmount0 < fromAmount1 ? fromAmount0 : fromAmount1;
            if (lpTokens == 0) revert InsufficientLiquidity();
            pool.totalLp = totalLp + lpTokens;
        }

        lpBalance[key][msg.sender] += lpTokens;
        pool.reserve0 = uint128(uint256(pool.reserve0) + amount0);
        pool.reserve1 = uint128(uint256(pool.reserve1) + amount1);
        emit LiquidityAdded(key, msg.sender, amount0, amount1, lpTokens);

        IERC20(t0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(t1).safeTransferFrom(msg.sender, address(this), amount1);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 lpTokens
    )
        external
        nonReentrant
        returns (uint256 amountA, uint256 amountB)
    {
        if (lpTokens == 0) revert ZeroAmount();
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        if (pool.token0 == address(0)) revert PoolNotFound();

        uint256 callerBalance = lpBalance[key][msg.sender];
        if (lpTokens > callerBalance) revert InsufficientLpBalance();

        uint256 totalLp = pool.totalLp;
        uint256 amount0 = Math.mulDiv(lpTokens, pool.reserve0, totalLp);
        uint256 amount1 = Math.mulDiv(lpTokens, pool.reserve1, totalLp);
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        unchecked {
            lpBalance[key][msg.sender] = callerBalance - lpTokens;
            pool.totalLp = totalLp - lpTokens;
            pool.reserve0 = uint128(uint256(pool.reserve0) - amount0);
            pool.reserve1 = uint128(uint256(pool.reserve1) - amount1);
        }
        emit LiquidityRemoved(key, msg.sender, amount0, amount1, lpTokens);

        (amountA, amountB) = tokenA == t0 ? (amount0, amount1) : (amount1, amount0);

        IERC20(t0).safeTransfer(msg.sender, amount0);
        IERC20(t1).safeTransfer(msg.sender, amount1);
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address to
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        (address t0, address t1) = _sortTokens(tokenIn, tokenOut);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        if (pool.token0 == address(0)) revert PoolNotFound();
        if (pool.reserve0 == 0 || pool.reserve1 == 0) revert InsufficientLiquidity();

        (uint256 reserveIn, uint256 reserveOut) =
            tokenIn == t0 ? (uint256(pool.reserve0), uint256(pool.reserve1)) : (uint256(pool.reserve1), uint256(pool.reserve0));

        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minOut) revert InsufficientOutput();

        if (tokenIn == t0) {
            pool.reserve0 = uint128(reserveIn + amountIn);
            pool.reserve1 = uint128(reserveOut - amountOut);
        } else {
            pool.reserve1 = uint128(reserveIn + amountIn);
            pool.reserve0 = uint128(reserveOut - amountOut);
        }
        emit Swap(key, msg.sender, to, tokenIn, tokenOut, amountIn, amountOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(to, amountOut);
    }

    function getReserves(
        address tokenA,
        address tokenB
    )
        external
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        if (pool.token0 == address(0)) revert PoolNotFound();
        (reserveA, reserveB) =
            tokenA == t0 ? (uint256(pool.reserve0), uint256(pool.reserve1)) : (uint256(pool.reserve1), uint256(pool.reserve0));
    }

    function quote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    )
        external
        view
        returns (uint256 amountOut)
    {
        (address t0, address t1) = _sortTokens(tokenIn, tokenOut);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        if (pool.token0 == address(0)) revert PoolNotFound();
        if (pool.reserve0 == 0 || pool.reserve1 == 0) revert InsufficientLiquidity();
        (uint256 reserveIn, uint256 reserveOut) =
            tokenIn == t0 ? (uint256(pool.reserve0), uint256(pool.reserve1)) : (uint256(pool.reserve1), uint256(pool.reserve0));
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function pairKeyOf(address tokenA, address tokenB) external pure returns (bytes32) {
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        return _pairKey(t0, t1);
    }

    function poolOf(
        address tokenA,
        address tokenB
    )
        external
        view
        returns (uint128 reserve0, uint128 reserve1, address token0, address token1, uint256 totalLp)
    {
        (address t0, address t1) = _sortTokens(tokenA, tokenB);
        bytes32 key = _pairKey(t0, t1);
        Pool storage pool = _pools[key];
        return (pool.reserve0, pool.reserve1, pool.token0, pool.token1, pool.totalLp);
    }

    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    )
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
        amountOut = numerator / denominator;
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address t0, address t1) {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (tokenA == tokenB) revert IdenticalTokens();
        (t0, t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function _pairKey(address t0, address t1) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(t0, t1));
    }
}

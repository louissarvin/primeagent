// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IV2Router {
    event PoolCreated(bytes32 indexed pairKey, address indexed token0, address indexed token1);
    event LiquidityAdded(
        bytes32 indexed pairKey,
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 lpTokens
    );
    event LiquidityRemoved(
        bytes32 indexed pairKey,
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 lpTokens
    );
    event Swap(
        bytes32 indexed pairKey,
        address indexed sender,
        address indexed to,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    function createPool(address tokenA, address tokenB) external returns (bytes32 key);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB
    )
        external
        returns (uint256 lpTokens);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 lpTokens
    )
        external
        returns (uint256 amountA, uint256 amountB);

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address to
    )
        external
        returns (uint256 amountOut);

    function getReserves(
        address tokenA,
        address tokenB
    )
        external
        view
        returns (uint256 reserveA, uint256 reserveB);

    function quote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    )
        external
        view
        returns (uint256 amountOut);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        address recipient;
    }

    event PositionMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event LiquidityDecreased(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Collected(uint256 indexed tokenId, address indexed recipient, uint256 amount0, uint256 amount1);
    event PositionBurned(uint256 indexed tokenId);

    function mint(MintParams calldata p) external returns (uint256 tokenId, uint128 liquidity);

    function decreaseLiquidity(
        uint256 tokenId,
        uint128 liquidity
    )
        external
        returns (uint256 amount0, uint256 amount1);

    function collect(
        uint256 tokenId,
        address recipient
    )
        external
        returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external;
}

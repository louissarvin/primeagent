// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IRobinhoodChainAdapter {
    event SwapExecuted(
        uint256 indexed tokenId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint8 venue
    );

    function swap(
        uint256 tokenId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata routeData
    )
        external
        returns (uint256 amountOut);

    function quote(
        uint256 tokenId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes calldata routeData
    )
        external
        view
        returns (uint256 amountOut);
}

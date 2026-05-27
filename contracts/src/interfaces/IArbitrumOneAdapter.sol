// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IArbitrumOneAdapter {
    event PerpOpened(
        uint256 indexed tokenId,
        bytes32 indexed positionKey,
        address indexToken,
        bool isLong,
        uint256 sizeUsdQ96,
        uint256 collateralAmount
    );
    event PerpClosed(uint256 indexed tokenId, bytes32 indexed positionKey, int256 realizedPnl);
    event Borrowed(uint256 indexed tokenId, address indexed asset, uint256 amount);
    event Repaid(uint256 indexed tokenId, address indexed asset, uint256 amount);
    event RepayResidualPushed(uint256 indexed tokenId, address indexed asset, uint256 residual);
    event Supplied(uint256 indexed tokenId, address indexed asset, uint256 amount);
    event Withdrawn(uint256 indexed tokenId, address indexed asset, uint256 amount);

    function openPerp(
        uint256 tokenId,
        address indexToken,
        uint256 sizeUsdQ96,
        bool isLong,
        uint256 collateralUsdcAmount,
        uint256 acceptablePriceQ96
    )
        external
        returns (bytes32 positionKey);

    function closePerp(
        uint256 tokenId,
        bytes32 positionKey,
        uint256 acceptablePriceQ96
    )
        external
        returns (int256 realizedPnl);

    function borrow(uint256 tokenId, address asset, uint256 amount) external;

    function repay(uint256 tokenId, address asset, uint256 amount) external;

    function supply(uint256 tokenId, address asset, uint256 amount) external;

    function withdraw(uint256 tokenId, address asset, uint256 amount) external;
}

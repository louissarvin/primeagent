// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IGmxRouter {
    function createIncreasePosition(
        address indexToken,
        address collateralToken,
        uint256 sizeUsdQ96,
        bool isLong,
        uint256 collateralAmount,
        uint256 acceptablePriceQ96,
        address account
    )
        external
        returns (bytes32 positionKey);

    function createDecreasePosition(
        bytes32 positionKey,
        uint256 acceptablePriceQ96,
        address account
    )
        external
        returns (int256 realizedPnl);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPriceOracle {
    function getPrice(address asset) external view returns (uint256 priceQ96);
    function activeSigners(address signer) external view returns (bool);
    function MAX_AGE() external view returns (uint256);
}

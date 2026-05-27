// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPrimeAgentCallPolicyValidator {
    event ValidatorInstalled(address indexed kernel, uint256 indexed tokenId, address diamond, address owner);
    event ValidatorUninstalled(address indexed kernel);
    event UserOpRejected(address indexed kernel, uint256 indexed tokenId, bytes32 reason);
    event PolicyCacheSynced(address indexed kernel, uint256 indexed tokenId);

    function tokenIdOf(address kernel) external view returns (uint256);
    function diamondOf(address kernel) external view returns (address);
    function ownerOf(address kernel) external view returns (address);

    function getDailySpent(address kernel) external view returns (uint256 spentQ96, uint64 windowStart);
}

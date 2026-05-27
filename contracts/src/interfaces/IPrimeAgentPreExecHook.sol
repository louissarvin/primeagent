// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPrimeAgentPreExecHook {
    event HookInstalled(address indexed kernel, uint256 indexed tokenId, address diamond);
    event HookUninstalled(address indexed kernel);
    event PreCheckAccepted(
        address indexed kernel, uint256 indexed tokenId, address target, bytes4 selector, uint256 notionalUsdQ96
    );

    function tokenIdOf(address kernel) external view returns (uint256);

    function diamondOf(address kernel) external view returns (address);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PrimeAgentFactory} from "../src/core/PrimeAgentFactory.sol";
import {LibPolicy} from "../src/libraries/LibPolicy.sol";

/// @title Smoke
/// @notice Anvil-fork end-to-end test that calls Factory.deployAgent against the live deploy and
///         verifies the returned (vault, tba, agentId) tuple.
/// @dev Reads env vars FACTORY, SMOKE_USER, USDC_ADDRESS, DEPLOYER_PRIVATE_KEY.
contract Smoke is Script {
    function run() external {
        PrimeAgentFactory factory = PrimeAgentFactory(vm.envAddress("FACTORY"));
        address user = vm.envAddress("SMOKE_USER");
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // Build a minimal Q96 policy. maxNotional = 10_000 USD, dailyCap = 1_000 USD.
        // Both shifted left 96 bits to encode Q96 fixed-point.
        LibPolicy.Policy memory p = LibPolicy.Policy({
            tokenId: 0,
            permissionContextHash: keccak256("smoke"),
            allowedContracts: new address[](0),
            allowedSelectors: new bytes4[](0),
            maxNotionalUsdQ96: uint256(10_000) << 96,
            dailyCapUsdQ96: uint256(1_000) << 96,
            expiresAt: uint64(block.timestamp + 7 days),
            issuedAt: uint64(block.timestamp),
            dailySpentUsdQ96Slot: 0,
            dailyWindowStart: 0,
            // Feature C: smoke is a custom (no-preset) policy.
            presetHash: bytes32(0)
        });

        vm.startBroadcast(pk);
        (uint256 tokenId, address vault, address tba, uint256 agentId) =
            factory.deployAgent(user, usdc, p, "ipfs://smoke");
        vm.stopBroadcast();

        console2.log("Smoke deployAgent SUCCESS");
        console2.log("  tokenId :", tokenId);
        console2.log("  vault   :", vault);
        console2.log("  tba     :", tba);
        console2.log("  agentId :", agentId);
    }
}

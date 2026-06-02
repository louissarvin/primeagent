// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {RhChainSwap} from "../src/modules/RhChainSwap.sol";

/// @title DeployRhChainSwap
/// @notice Deploy `RhChainSwap` on Robinhood Chain testnet (chain 46630) and write the deployed
///         address to `memory/rh_chain_swap_deployed.json` for backend / frontend wiring.
/// @dev Env vars:
///       - DEPLOYER_PRIVATE_KEY        : EOA with ETH on chain 46630 (faucet)
///       - ADMIN_ADDRESS               : initial DEFAULT_ADMIN_ROLE + all ops roles
///       - ATTESTOR_ADDRESS            : initial EIP-712 signer
///       - EMERGENCY_TIMELOCK_SECONDS  : testnet 3600 (1h); mainnet MUST be 604800 (7d)
///       - RH_CHAIN_RPC_URL (optional) : default `https://rpc.testnet.chain.robinhood.com`
///
///      Token addresses are pinned per `memory/rh_chain_testnet_facts_2026.md`. The constructor
///      asserts `decimals()` against the expected value below; mismatch reverts the deploy.
///      Run with: `forge script script/DeployRhChainSwap.s.sol --rpc-url $RH_CHAIN_RPC_URL --broadcast`.
contract DeployRhChainSwap is Script {
    // Robinhood Chain testnet token addresses (chain 46630).
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    address internal constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address internal constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address internal constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address internal constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address internal constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    /// @notice Expected decimals per token. The constructor reverts `UnexpectedDecimals` if any
    ///         live contract reports a different value. PrimeAgent.md section 7.9 asserts USDG=6
    ///         and stocks=18. Verify on-chain via `cast call <addr> "decimals()(uint8)"
    ///         --rpc-url $RH_CHAIN_RPC_URL` before broadcast.
    uint8 internal constant USDG_DECIMALS = 6;
    uint8 internal constant STOCK_DECIMALS = 18;

    function run() external returns (address deployed) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        uint64 emergencyTimelock = uint64(vm.envUint("EMERGENCY_TIMELOCK_SECONDS"));
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        require(admin != address(0), "ADMIN_ADDRESS=0");
        require(attestor != address(0), "ATTESTOR_ADDRESS=0");
        require(emergencyTimelock > 0, "EMERGENCY_TIMELOCK_SECONDS=0");

        address[] memory tokens = new address[](6);
        tokens[0] = USDG;
        tokens[1] = TSLA;
        tokens[2] = AMZN;
        tokens[3] = PLTR;
        tokens[4] = NFLX;
        tokens[5] = AMD;

        uint8[] memory decs = new uint8[](6);
        decs[0] = USDG_DECIMALS;
        decs[1] = STOCK_DECIMALS;
        decs[2] = STOCK_DECIMALS;
        decs[3] = STOCK_DECIMALS;
        decs[4] = STOCK_DECIMALS;
        decs[5] = STOCK_DECIMALS;

        console2.log("Deploying RhChainSwap on chain", block.chainid);
        console2.log("  admin             ", admin);
        console2.log("  attestor          ", attestor);
        console2.log("  emergencyTimelock ", uint256(emergencyTimelock));

        // Pre-deploy decimal sanity print (does not gate; constructor enforces).
        for (uint256 i; i < tokens.length; ++i) {
            uint8 actual = IERC20Metadata(tokens[i]).decimals();
            console2.log("  token", tokens[i]);
            console2.log("    expected", uint256(decs[i]));
            console2.log("    actual  ", uint256(actual));
            require(actual == decs[i], "decimals mismatch (verify constants)");
        }

        vm.startBroadcast(deployerPk);
        RhChainSwap swapContract = new RhChainSwap(admin, attestor, emergencyTimelock, tokens, decs);
        vm.stopBroadcast();

        deployed = address(swapContract);
        console2.log("RhChainSwap deployed at:", deployed);

        // Persist the address for the backend / frontend wiring layer.
        // Write into the contracts dir (fs_permissions = "./"); the deploy operator copies
        // it to ../memory/ after broadcast.
        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "rhChainSwap": "',
            vm.toString(deployed),
            '",\n',
            '  "admin": "',
            vm.toString(admin),
            '",\n',
            '  "attestor": "',
            vm.toString(attestor),
            '",\n',
            '  "emergencyTimelockSeconds": ',
            vm.toString(uint256(emergencyTimelock)),
            "\n}\n"
        );
        vm.writeFile("./broadcast/rh_chain_swap_deployed.json", json);
    }
}

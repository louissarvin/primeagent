// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockGmxRouter} from "../test/mocks/MockGmxRouter.sol";
import {MockAavePool} from "../test/mocks/MockAavePool.sol";

/// @title DeployMocks
/// @notice Testnet-only mocks deploy: USDC (6 decimals), 5 stock tokens (18 decimals each),
///         MockGmxRouter, MockAavePool. Re-runnable: any EXISTING_<NAME> env var skips that step.
/// @dev    DO NOT USE ON MAINNET. The MockERC20 has an unrestricted `mint(address,uint256)` and
///         is intended only for SetupTestnet's faucet path on Arbitrum Sepolia (chain id 421614).
contract DeployMocks is Script {
    struct MockDeployment {
        address usdc;
        address tsla;
        address amzn;
        address pltr;
        address nflx;
        address amd;
        address gmxRouter;
        address aavePool;
    }

    function run() external returns (MockDeployment memory dep) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        console2.log("=== DeployMocks ===");
        console2.log("Deployer:", deployer);
        console2.log("Chain id:", block.chainid);

        vm.startBroadcast(deployerPk);

        dep.usdc = _deployToken("USDC", "USD Coin Sepolia Mock", "USDC", 6);
        dep.tsla = _deployToken("TSLA", "Tesla Inc (Mock)", "TSLA", 18);
        dep.amzn = _deployToken("AMZN", "Amazon.com Inc (Mock)", "AMZN", 18);
        dep.pltr = _deployToken("PLTR", "Palantir Technologies (Mock)", "PLTR", 18);
        dep.nflx = _deployToken("NFLX", "Netflix Inc (Mock)", "NFLX", 18);
        dep.amd = _deployToken("AMD", "Advanced Micro Devices (Mock)", "AMD", 18);

        dep.gmxRouter = _deployGmxRouter();
        dep.aavePool = _deployAavePool();

        vm.stopBroadcast();

        console2.log("=== Summary ===");
        console2.log("USDC_ADDRESS    :", dep.usdc);
        console2.log("TSLA_ADDRESS    :", dep.tsla);
        console2.log("AMZN_ADDRESS    :", dep.amzn);
        console2.log("PLTR_ADDRESS    :", dep.pltr);
        console2.log("NFLX_ADDRESS    :", dep.nflx);
        console2.log("AMD_ADDRESS     :", dep.amd);
        console2.log("GMX_ROUTER      :", dep.gmxRouter);
        console2.log("AAVE_POOL       :", dep.aavePool);
    }

    function _deployToken(string memory key, string memory name_, string memory symbol_, uint8 decimals_)
        internal
        returns (address out)
    {
        string memory envName = string.concat("EXISTING_", key);
        address existing = vm.envOr(envName, address(0));
        if (existing != address(0)) {
            console2.log(string.concat("Reusing ", key, " at"), existing);
            return existing;
        }
        out = address(new MockERC20(name_, symbol_, decimals_));
        console2.log(string.concat("Deployed ", key, " at"), out);
    }

    function _deployGmxRouter() internal returns (address out) {
        address existing = vm.envOr("EXISTING_GMX_ROUTER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing GMX_ROUTER at", existing);
            return existing;
        }
        out = address(new MockGmxRouter());
        console2.log("Deployed GMX_ROUTER at", out);
    }

    function _deployAavePool() internal returns (address out) {
        address existing = vm.envOr("EXISTING_AAVE_POOL", address(0));
        if (existing != address(0)) {
            console2.log("Reusing AAVE_POOL at", existing);
            return existing;
        }
        out = address(new MockAavePool());
        console2.log("Deployed AAVE_POOL at", out);
    }
}

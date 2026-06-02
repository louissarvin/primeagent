// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PriceOracle} from "../src/periphery/PriceOracle.sol";
import {V2Router} from "../src/dex/V2Router.sol";
import {V3Pool} from "../src/dex/V3Pool.sol";
import {V3PositionManager} from "../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../src/interfaces/IV3PositionManager.sol";
import {EmergencyShutdown} from "../src/modules/EmergencyShutdown.sol";

/// @title SetupTestnet
/// @notice Post-deploy bootstrap for Arbitrum Sepolia (chain 421614). Runs AFTER
///         `script/Deploy.s.sol` has placed the contracts. Wires the testnet faucet, seeds
///         pool liquidity, and stakes the paymaster.
///
/// @dev Operations performed (all `vm.broadcast` wrapped):
///        1. Mint a configurable amount of test USDC + each test stock (TSLA / AMZN / PLTR /
///           NFTX / AMD) to each address in `TEST_USERS`. Uses the MockERC20 `mint(to, amount)`
///           surface that test deployments expose.
///        2. Propose the PriceOracle signer set (5 signers) via `proposeSignerChange`. Because
///           the contract enforces a 48h timelock, the corresponding `executeSignerChange` is
///           NOT done here; the operator must follow up after the timelock elapses.
///        3. Seed V2Router pool liquidity for every stock/USDC pair so the demo has a price
///           and a swap path on day one.
///        4. Mint a V3PositionManager NFT for the singleton (token0, token1) pair (typically
///           TSLA/USDC sorted). Pool is initialized via `V3Pool.initialize(sqrtPriceX96)` if it
///           has not been initialized yet.
///        5. Call `EmergencyShutdown.registerComponent(vault)` for every address in
///           `INITIAL_VAULTS`. No-op when the env list is empty.
///
///      Why we do NOT call `paymaster.addStake` here: the canonical ERC-4337 v0.7 EntryPoint
///      receives stake via `IEntryPoint(entryPoint).addStake{value: amount}(unstakeDelaySec)`.
///      We expose a wrapper on PaymasterRelay that the OWNER can call, but the stake amount and
///      unstake delay are policy decisions and live in ops runbooks; not in a bootstrap script.
///      The ops runbook records `cast send <paymaster> "addStake(uint32)" <delay> --value <ETH>`.
///
/// @dev Env vars consumed:
///        - DEPLOYER_PRIVATE_KEY         (uint256)
///        - USDC_ADDRESS                 (address)
///        - PRICE_ORACLE                 (address)
///        - V2_ROUTER                    (address)
///        - V3_POOL                      (address)
///        - V3_POSITION_MANAGER          (address)
///        - EMERGENCY_SHUTDOWN           (address)
///        - TSLA_ADDRESS / AMZN_ADDRESS / PLTR_ADDRESS / NFLX_ADDRESS / AMD_ADDRESS (address)
///        - TEST_USERS                   (string, comma-separated addresses)
///        - INITIAL_VAULTS               (string, comma-separated addresses, optional)
///        - FAUCET_USDC_AMOUNT           (uint256, defaults to 100_000 * 10^6)
///        - FAUCET_STOCK_AMOUNT          (uint256, defaults to 1_000 * 10^18)
///        - SEED_V2_USDC                 (uint256, defaults to 10_000 * 10^6)
///        - SEED_V2_STOCK                (uint256, defaults to 100 * 10^18)
///        - V3_INIT_SQRT_PRICE_X96       (uint160, defaults to 2**96 == price 1.0)
///        - V3_SEED_AMOUNT0              (uint256, defaults to 10_000 * 10^6)
///        - V3_SEED_AMOUNT1              (uint256, defaults to 100 * 10^18)
///        - PRICE_SIGNER_1..5            (address) initial PriceOracle signer set (proposal only).
contract SetupTestnet is Script {

    // --- Faucet config defaults ---
    uint256 internal constant DEFAULT_FAUCET_USDC = 100_000 * 1e6;
    uint256 internal constant DEFAULT_FAUCET_STOCK = 1_000 * 1e18;
    uint256 internal constant DEFAULT_SEED_V2_USDC = 10_000 * 1e6;
    uint256 internal constant DEFAULT_SEED_V2_STOCK = 100 * 1e18;
    uint256 internal constant DEFAULT_V3_SEED0 = 10_000 * 1e6;
    uint256 internal constant DEFAULT_V3_SEED1 = 100 * 1e18;

    /// @notice Default sqrt price = 1.0 (Q96). Tests can override via env.
    uint160 internal constant DEFAULT_SQRT_PRICE_X96 = uint160(1 << 96);

    /// @notice Minimal MockERC20 surface for faucet calls.
    /// @dev We declare it inline (interface, not import) so this script does not pull the test
    ///      directory into the script build. The mint surface is identical across the project's
    ///      MockERC20.
    function _mintMock(address token, address to, uint256 amount) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        require(ok, "SetupTestnet: mint() not exposed on token");
    }

    /// @dev Deployer EOA address; broadcaster identity used in place of `address(this)`.
    address internal _deployer;

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer = vm.addr(deployerPk);
        vm.startBroadcast(deployerPk);

        address usdc = vm.envAddress("USDC_ADDRESS");
        address priceOracle = vm.envAddress("PRICE_ORACLE");
        address v2Router = vm.envAddress("V2_ROUTER");
        address v3Pool = vm.envAddress("V3_POOL");
        address v3PositionManager = vm.envAddress("V3_POSITION_MANAGER");
        address emergencyShutdown = vm.envAddress("EMERGENCY_SHUTDOWN");

        address[] memory stocks = _stocksFromEnv();
        address[] memory users = _addressesFromEnv("TEST_USERS");

        // --- 1. Faucet ---
        uint256 usdcAmt = vm.envOr("FAUCET_USDC_AMOUNT", DEFAULT_FAUCET_USDC);
        uint256 stockAmt = vm.envOr("FAUCET_STOCK_AMOUNT", DEFAULT_FAUCET_STOCK);
        _mintFaucet(users, usdc, usdcAmt, stocks, stockAmt);

        // --- 2. Propose PriceOracle signer set ---
        _proposeSigners(PriceOracle(priceOracle));

        // --- 3. Seed V2 pool liquidity per stock/USDC pair ---
        uint256 seedUsdc = vm.envOr("SEED_V2_USDC", DEFAULT_SEED_V2_USDC);
        uint256 seedStock = vm.envOr("SEED_V2_STOCK", DEFAULT_SEED_V2_STOCK);
        _seedV2(V2Router(v2Router), usdc, stocks, seedUsdc, seedStock);

        // --- 4. Seed V3 pool: initialize + mint a single owner LP NFT ---
        _seedV3(V3Pool(v3Pool), V3PositionManager(v3PositionManager));

        // --- 5. Register initial vaults (if any) ---
        address[] memory vaults = _addressesFromEnvOptional("INITIAL_VAULTS");
        _registerVaults(EmergencyShutdown(emergencyShutdown), vaults);

        vm.stopBroadcast();
        console2.log("==== SetupTestnet complete ====");
    }

    // ---------------------------------------------------------------------
    // Step bodies
    // ---------------------------------------------------------------------

    function _mintFaucet(
        address[] memory users,
        address usdc,
        uint256 usdcAmt,
        address[] memory stocks,
        uint256 stockAmt
    )
        internal
    {
        for (uint256 i; i < users.length; ++i) {
            _mintMock(usdc, users[i], usdcAmt);
            for (uint256 j; j < stocks.length; ++j) {
                if (stocks[j] == address(0)) continue;
                _mintMock(stocks[j], users[i], stockAmt);
            }
        }
        console2.log("Minted faucet to", users.length, "users");
    }

    function _proposeSigners(PriceOracle priceOracle) internal {
        address[5] memory signers;
        signers[0] = vm.envOr("PRICE_SIGNER_1", address(0));
        signers[1] = vm.envOr("PRICE_SIGNER_2", address(0));
        signers[2] = vm.envOr("PRICE_SIGNER_3", address(0));
        signers[3] = vm.envOr("PRICE_SIGNER_4", address(0));
        signers[4] = vm.envOr("PRICE_SIGNER_5", address(0));
        for (uint256 i; i < signers.length; ++i) {
            if (signers[i] == address(0)) continue;
            priceOracle.proposeSignerChange(signers[i], true);
        }
        console2.log("Proposed PriceOracle signer set (executeSignerChange after 48h timelock)");
    }

    function _seedV2(
        V2Router router,
        address usdc,
        address[] memory stocks,
        uint256 seedUsdc,
        uint256 seedStock
    )
        internal
    {
        // Foundry forbids using `address(this)` in a Script (the script contract is ephemeral
        // and its address is not stable). We mint to the broadcaster (msg.sender == tx.origin
        // under vm.broadcast) and call the router from that EOA's authority. The router uses
        // msg.sender as the liquidity provider, so this matches the on-chain semantics we want.
        address provider = _deployer;
        for (uint256 i; i < stocks.length; ++i) {
            address stock = stocks[i];
            if (stock == address(0)) continue;
            try router.createPool(usdc, stock) returns (bytes32) {
                // created
            } catch {
                // pool already exists -- ok
            }
            _mintMock(usdc, provider, seedUsdc);
            _mintMock(stock, provider, seedStock);
            // Use raw approve (not SafeERC20) so the broadcast call originates from the deployer EOA.
            // SafeERC20 helpers read `token.allowance(address(this), ...)` which trips Foundry's
            // ephemeral-script-address guard. Mocks are standard ERC20 (return bool).
            IERC20(usdc).approve(address(router), seedUsdc);
            IERC20(stock).approve(address(router), seedStock);
            router.addLiquidity(usdc, stock, seedUsdc, seedStock);
        }
        console2.log("Seeded V2 pools for", stocks.length, "stock/USDC pairs");
    }

    function _seedV3(V3Pool pool, V3PositionManager manager) internal {
        uint160 sqrtPrice = uint160(vm.envOr("V3_INIT_SQRT_PRICE_X96", uint256(DEFAULT_SQRT_PRICE_X96)));
        try pool.initialize(sqrtPrice) {
            // initialised
        } catch {
            // already initialised
        }

        address t0 = pool.token0();
        address t1 = pool.token1();
        // Skip V3 seeding when either token is the Deploy.s.sol placeholder marker (a
        // synthetic (usdc, usdc+1) pair used when V3_POOL_TOKEN0/1 env vars weren't set).
        // Operators must re-deploy V3Pool with real tokens, or run a separate setup with
        // V3_POOL_TOKEN0/1 wired up, before production traffic. We log + return so the rest
        // of SetupTestnet (vault registration) still runs.
        if (t0.code.length == 0 || t1.code.length == 0) {
            console2.log("Skipping V3 seed: placeholder token has no code", t0, t1);
            return;
        }
        uint256 amt0 = vm.envOr("V3_SEED_AMOUNT0", DEFAULT_V3_SEED0);
        uint256 amt1 = vm.envOr("V3_SEED_AMOUNT1", DEFAULT_V3_SEED1);

        // Same rationale as `_seedV2`: mint to broadcaster, approve from broadcaster.
        address provider = _deployer;
        _mintMock(t0, provider, amt0);
        _mintMock(t1, provider, amt1);
        // Raw approve (see note in _seedV2 about the ephemeral-script guard).
        IERC20(t0).approve(address(manager), amt0);
        IERC20(t1).approve(address(manager), amt1);

        manager.mint(
            IV3PositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: pool.fee(),
                tickLower: -887_220,
                tickUpper: 887_220,
                amount0Desired: amt0,
                amount1Desired: amt1,
                recipient: _deployer
            })
        );
        console2.log("Seeded V3 pool position");
    }

    function _registerVaults(EmergencyShutdown shutdown, address[] memory vaults) internal {
        for (uint256 i; i < vaults.length; ++i) {
            address v = vaults[i];
            if (v == address(0)) continue;
            shutdown.registerComponent(v);
        }
        if (vaults.length > 0) {
            console2.log("Registered", vaults.length, "initial vaults with EmergencyShutdown");
        }
    }

    // ---------------------------------------------------------------------
    // Env parsing helpers
    // ---------------------------------------------------------------------

    function _stocksFromEnv() internal view returns (address[] memory stocks) {
        stocks = new address[](5);
        stocks[0] = vm.envOr("TSLA_ADDRESS", address(0));
        stocks[1] = vm.envOr("AMZN_ADDRESS", address(0));
        stocks[2] = vm.envOr("PLTR_ADDRESS", address(0));
        stocks[3] = vm.envOr("NFLX_ADDRESS", address(0));
        stocks[4] = vm.envOr("AMD_ADDRESS", address(0));
    }

    function _addressesFromEnv(string memory name) internal view returns (address[] memory list) {
        return vm.envAddress(name, ",");
    }

    function _addressesFromEnvOptional(string memory name) internal view returns (address[] memory list) {
        // Probe with `vm.envOr` (does NOT revert when key is missing) and only call the array
        // parser when the value is non-empty. We avoid `this.` external indirection because
        // Foundry's script-contract guard treats it as `address(this)` usage.
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) {
            return new address[](0);
        }
        return vm.envAddress(name, ",");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

// Core
import {PositionNFT} from "../src/core/PositionNFT.sol";
import {AgentRegistry} from "../src/core/AgentRegistry.sol";
import {AgentVault} from "../src/core/AgentVault.sol";
import {PrimeAgentFactory} from "../src/core/PrimeAgentFactory.sol";
import {PrimeAgentDiamond} from "../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../src/core/DiamondInit.sol";

// Diamond facet + cut interface
import {Erc7715PolicyAuditFacet} from "../src/modules/Erc7715PolicyAuditFacet.sol";
import {DiamondCutFacet} from "../src/core/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../src/core/DiamondLoupeFacet.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";

// Modules (Group C + D)
import {RobinhoodChainAdapter} from "../src/modules/RobinhoodChainAdapter.sol";
import {ArbitrumOneAdapter} from "../src/modules/ArbitrumOneAdapter.sol";
import {PaymasterRelay} from "../src/modules/PaymasterRelay.sol";
import {FeeCollector} from "../src/modules/FeeCollector.sol";
import {EmergencyShutdown} from "../src/modules/EmergencyShutdown.sol";
import {PrimeAgentPreExecHook} from "../src/modules/PrimeAgentPreExecHook.sol";
import {PrimeAgentCallPolicyValidator} from "../src/modules/PrimeAgentCallPolicyValidator.sol";
import {RobinhoodMcpAttestor} from "../src/modules/RobinhoodMcpAttestor.sol";

// Periphery + validation
import {PriceOracle} from "../src/periphery/PriceOracle.sol";
import {StakedValidator} from "../src/validation/StakedValidator.sol";

// DEX (Group C)
import {V2Router} from "../src/dex/V2Router.sol";
import {V3Pool} from "../src/dex/V3Pool.sol";
import {V3PositionManager} from "../src/dex/V3PositionManager.sol";

// Upgradeable beacon (re-used by tests + ops)
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @title Deploy
/// @notice Production deployment script for the PrimeAgent contract stack.
///
/// @dev Sequence (mirrors `PrimeAgent.md` Section 6.4 / 6.5 migration plan):
///        1.  External canonical addresses (ERC-6551 Registry, ERC-4337 EntryPoint, ERC-8004
///            Identity + Reputation), per `block.chainid`.
///        2.  USDC base asset address (from env).
///        3.  PriceOracle (signer set seeded via 48h timelock post-deploy; see SetupTestnet).
///        4.  PositionNFT + AgentRegistry.
///        5.  AgentVault implementation. The factory deploys its OWN UpgradeableBeacon in the
///            constructor, so we deploy only the implementation here.
///        6.  AuditFacet + DiamondInit + PrimeAgentDiamond (with the initial cut and audit init).
///        7.  Stylus margin engine address (off-chain deploy; read from env, may be address(0)).
///        8.  DEX: V2Router, V3Pool, V3PositionManager.
///        9.  Adapters: RobinhoodChainAdapter (RH leg) + ArbitrumOneAdapter (Arb leg).
///        10. Treasury + safety: PaymasterRelay, FeeCollector, EmergencyShutdown.
///        11. Kernel modules: PreExecHook, CallPolicyValidator (deployed once per chain; bound
///            per-agent via the Kernel install flow).
///        12. Attestor + StakedValidator (FIP1).
///        13. Tokenbound v0.3.1 TBA implementation (canonical address read from constants).
///        14. PrimeAgentFactory (last; depends on everything above).
///        15. Wire factory permissions on PositionNFT + AgentRegistry.
///        16. Configure FeeCollector streams (protocol / treasury / paymaster_reserve = 50/30/20).
///        17. PaymasterRelay setup (sponsored callers, EntryPoint deposit) — deposit topup is
///            performed here from `PAYMASTER_INITIAL_DEPOSIT`. EntryPoint stake (`addStake`) is
///            deliberately left for ops because the bundler stake timelock binding is policy.
///        18. Console summary so the operator sees a clean address list.
///
/// @dev Env vars (every entry below MUST be set unless marked optional):
///        - DEPLOYER_PRIVATE_KEY      (uint256)
///        - USDC_ADDRESS              (address) base asset for the vault accounting + fees.
///        - STYLUS_MARGIN_ENGINE_ADDRESS (address) deployed Stylus margin engine; may be 0.
///        - GMX_ROUTER                (address) GMX V2 router shim (or MockGmxRouter for tests).
///        - AAVE_POOL                 (address) Aave V3 pool (or MockAavePool for tests).
///        - ATTESTOR_SIGNER           (address) initial RobinhoodMcpAttestor signer EOA.
///        - STREAM_PROTOCOL_RECIPIENT (address) FeeCollector "protocol" stream sink.
///        - STREAM_TREASURY_RECIPIENT (address) FeeCollector "treasury" stream sink.
///        - V3_POOL_TOKEN0            (address) optional: token0 for the singleton V3 pool.
///        - V3_POOL_TOKEN1            (address) optional: token1 for the singleton V3 pool.
///                                    Both V3_POOL_* must be set together if you want a real pool.
///                                    Otherwise the script deploys a placeholder pool against the
///                                    sorted (USDC, MARKER) pair so deployment can complete.
///        - PAYMASTER_INITIAL_DEPOSIT (uint256, wei) optional, defaults to 0.1 ether.
///        - PAYMASTER_MAX_SPONSORED_OPS_PER_BLOCK (uint256) optional, defaults to 100.
///        - GUARDIAN_ADDRESS          (address) optional, defaults to deployer for v1.
///
/// @dev Idempotency: if an env var `EXISTING_<NAME>` is set to a non-zero address, the
///      corresponding deployment step is skipped and the existing address is reused. The script
///      logs which addresses were reused vs. newly deployed.
contract Deploy is Script {
    // --- Canonical addresses (chain-agnostic) ---

    /// @notice ERC-6551 Registry (singleton across every EVM chain).
    address internal constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;

    /// @notice ERC-4337 v0.7 EntryPoint (singleton across every EVM chain).
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /// @notice Tokenbound v0.3.1 account implementation (canonical CREATE2 address).
    address internal constant TBA_IMPL_V031 = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;

    // --- Deployment record ---

    struct Deployment {
        address positionNFT;
        address agentRegistry;
        address agentVaultImpl;
        address auditFacet;
        address diamondCutFacet;
        address diamondLoupeFacet;
        address diamondInit;
        address diamond;
        address priceOracle;
        address marginEngine;
        address v2Router;
        address v3Pool;
        address v3PositionManager;
        address robinhoodAdapter;
        address arbitrumAdapter;
        address paymasterRelay;
        address feeCollector;
        address emergencyShutdown;
        address preExecHook;
        address callPolicyValidator;
        address attestor;
        address stakedValidator;
        address factory;
    }

    /// @notice Emitted at the end of `run` for off-chain pickup.
    /// @dev Indexed fields kept minimal; address list is data-only.
    event Deployed(
        uint256 indexed chainId,
        address indexed deployer,
        address factory,
        address diamond,
        address positionNFT,
        address agentRegistry
    );

    // --- Entry point ---

    function run() external returns (Deployment memory d) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        console2.log("==== PrimeAgent Deployment ====");
        console2.log("Chain ID :", block.chainid);
        console2.log("Deployer :", deployer);

        vm.startBroadcast(deployerPk);

        // 1. External canonical addresses for this chain.
        address erc6551Registry = ERC6551_REGISTRY;
        address entryPoint = ENTRY_POINT_V07;
        address identityRegistry = _erc8004IdentityFor(block.chainid);
        address reputationRegistry = _erc8004ReputationFor(block.chainid);

        // 2. USDC.
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS unset");

        // 3. PriceOracle (signers added via 48h timelock; see SetupTestnet.s.sol).
        d.priceOracle = _deployOrReusePriceOracle(deployer);

        // 4. PositionNFT + AgentRegistry.
        d.positionNFT = _deployOrReusePositionNFT(deployer);
        d.agentRegistry = _deployOrReuseAgentRegistry(identityRegistry, reputationRegistry, deployer);

        // 5. AgentVault implementation.
        d.agentVaultImpl = _deployOrReuseAgentVaultImpl();

        // 6. Audit facet + DiamondInit (Diamond itself is deferred until step 13 because the
        //    audit facet's `factory` slot is seeded with the PREDICTED factory address. We need
        //    every other deploy to land BEFORE the Diamond so we can predict the factory
        //    address as exactly `broadcasterNonce + 1` at the time we deploy the Diamond).
        d.auditFacet = _deployOrReuseAuditFacet();
        d.diamondInit = _deployOrReuseDiamondInit();

        // 6a. Canonical EIP-2535 facets. Deployed as STATELESS singletons so future PrimeAgent
        //     diamonds (e.g. tests, side-chain deployments) can cut them in. NOT cut into the
        //     production Diamond at construction because `PrimeAgentDiamond` implements
        //     `diamondCut` + loupe inline behind a 48h timelock; the selectors would collide.
        //     We deploy them here so the addresses are emitted in the run summary for tooling.
        d.diamondCutFacet = _deployOrReuseDiamondCutFacet();
        d.diamondLoupeFacet = _deployOrReuseDiamondLoupeFacet();

        // 7. Stylus margin engine (may be address(0) on chains without Stylus).
        d.marginEngine = vm.envOr("STYLUS_MARGIN_ENGINE_ADDRESS", address(0));

        // 8. DEX. V3 needs a token pair; we pick from env or fall back to USDC + a stub pair.
        d.v2Router = _deployOrReuseV2Router();
        (address t0, address t1) = _v3PairOrFallback(usdc);
        d.v3Pool = _deployOrReuseV3Pool(t0, t1);
        d.v3PositionManager = _deployOrReuseV3PositionManager(d.v3Pool);

        // 9. Adapters.
        d.robinhoodAdapter = _deployOrReuseRobinhoodAdapter(d.positionNFT, d.v2Router, d.v3Pool, d.priceOracle);
        d.arbitrumAdapter = _deployOrReuseArbitrumAdapter(d.positionNFT, d.priceOracle);

        // 10. Treasury + safety.
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        uint256 maxOps = vm.envOr("PAYMASTER_MAX_SPONSORED_OPS_PER_BLOCK", uint256(100));
        d.paymasterRelay = _deployOrReusePaymasterRelay(entryPoint, deployer, guardian, maxOps);
        d.feeCollector = _deployOrReuseFeeCollector(usdc, deployer);
        d.emergencyShutdown = _deployOrReuseEmergencyShutdown(deployer);

        // 11. Kernel modules (chain-singletons).
        d.preExecHook = _deployOrReusePreExecHook();
        d.callPolicyValidator = _deployOrReuseCallPolicyValidator();

        // 12. Attestor + StakedValidator.
        d.attestor = _deployOrReuseAttestor(deployer, vm.envAddress("ATTESTOR_SIGNER"));
        d.stakedValidator = _deployOrReuseStakedValidator(deployer, usdc);

        // 13. Diamond (deployed immediately before the Factory so the predicted factory address
        //     is exactly `broadcasterNonce + 1` at the time of Diamond construction, matching
        //     the test pattern in `PrimeAgentFactoryTest`).
        d.diamond = _deployDiamond(deployer, d.auditFacet, d.diamondInit, d.positionNFT);

        // 14. Tokenbound TBA implementation (canonical address).
        address tbaImpl = TBA_IMPL_V031;

        // 15. Factory (last; depends on everything above).
        d.factory = _deployFactory(deployer, d, tbaImpl, erc6551Registry);

        // 15. Wire factory permissions on NFT + AgentRegistry, and grant the factory the
        //     EmergencyShutdown registrar role so `deployAgent` can atomically register each new
        //     vault. The registrar role is enrol-only: it cannot trigger shutdown.
        PositionNFT(d.positionNFT).setFactory(d.factory);
        AgentRegistry(d.agentRegistry).setFactory(d.factory);
        EmergencyShutdown(d.emergencyShutdown).setRegistrar(d.factory, true);

        // 16. Configure FeeCollector streams (50/30/20 split). Recipients are deployer if the
        //     env-driven recipient is unset (the deployer can rotate post-launch via the timelock
        //     on FeeCollector's configureStreams). The paymaster_reserve stream points at the
        //     PaymasterRelay so off-chain bridging can pull straight from there.
        _configureFeeStreams(FeeCollector(d.feeCollector), d.paymasterRelay);

        // 17. PaymasterRelay topup. Sponsored callers are seeded empty; ops adds per-Kernel
        //     addresses after each agent's Kernel deploys.
        uint256 initialDeposit = vm.envOr("PAYMASTER_INITIAL_DEPOSIT", uint256(0.1 ether));
        if (initialDeposit > 0) {
            PaymasterRelay(payable(d.paymasterRelay)).topUp{value: initialDeposit}();
        }

        emit Deployed(block.chainid, deployer, d.factory, d.diamond, d.positionNFT, d.agentRegistry);

        vm.stopBroadcast();

        // 18. Summary.
        _printSummary(d, tbaImpl, erc6551Registry, entryPoint, identityRegistry, reputationRegistry);
        return d;
    }

    // ---------------------------------------------------------------------
    // Per-step deploy-or-reuse helpers.
    //
    // The pattern: read EXISTING_<NAME> from env. If a non-zero address is found, reuse it.
    // Otherwise, deploy fresh and log the new address. Each helper is small enough that the
    // operator can re-read the script and verify the call shape.
    // ---------------------------------------------------------------------

    function _deployOrReusePriceOracle(address owner) internal returns (address) {
        address existing = vm.envOr("EXISTING_PRICE_ORACLE", address(0));
        if (existing != address(0)) {
            console2.log("Reusing PriceOracle at", existing);
            return existing;
        }
        PriceOracle deployed = new PriceOracle(owner);
        console2.log("Deployed PriceOracle ", address(deployed));
        return address(deployed);
    }

    function _deployOrReusePositionNFT(address owner) internal returns (address) {
        address existing = vm.envOr("EXISTING_POSITION_NFT", address(0));
        if (existing != address(0)) {
            console2.log("Reusing PositionNFT at", existing);
            return existing;
        }
        PositionNFT deployed = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        console2.log("Deployed PositionNFT ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseAgentRegistry(
        address identity,
        address reputation,
        address owner
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_AGENT_REGISTRY", address(0));
        if (existing != address(0)) {
            console2.log("Reusing AgentRegistry at", existing);
            return existing;
        }
        AgentRegistry deployed = new AgentRegistry(identity, reputation, owner);
        console2.log("Deployed AgentRegistry ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseAgentVaultImpl() internal returns (address) {
        address existing = vm.envOr("EXISTING_AGENT_VAULT_IMPL", address(0));
        if (existing != address(0)) {
            console2.log("Reusing AgentVault impl at", existing);
            return existing;
        }
        AgentVault deployed = new AgentVault();
        console2.log("Deployed AgentVault impl", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseAuditFacet() internal returns (address) {
        address existing = vm.envOr("EXISTING_AUDIT_FACET", address(0));
        if (existing != address(0)) {
            console2.log("Reusing AuditFacet at", existing);
            return existing;
        }
        Erc7715PolicyAuditFacet deployed = new Erc7715PolicyAuditFacet();
        console2.log("Deployed AuditFacet ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseDiamondInit() internal returns (address) {
        address existing = vm.envOr("EXISTING_DIAMOND_INIT", address(0));
        if (existing != address(0)) {
            console2.log("Reusing DiamondInit at", existing);
            return existing;
        }
        DiamondInit deployed = new DiamondInit();
        console2.log("Deployed DiamondInit ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseDiamondCutFacet() internal returns (address) {
        address existing = vm.envOr("EXISTING_DIAMOND_CUT_FACET", address(0));
        if (existing != address(0)) {
            console2.log("Reusing DiamondCutFacet at", existing);
            return existing;
        }
        DiamondCutFacet deployed = new DiamondCutFacet();
        console2.log("Deployed DiamondCutFacet ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseDiamondLoupeFacet() internal returns (address) {
        address existing = vm.envOr("EXISTING_DIAMOND_LOUPE_FACET", address(0));
        if (existing != address(0)) {
            console2.log("Reusing DiamondLoupeFacet at", existing);
            return existing;
        }
        DiamondLoupeFacet deployed = new DiamondLoupeFacet();
        console2.log("Deployed DiamondLoupeFacet", address(deployed));
        return address(deployed);
    }

    function _deployDiamond(
        address owner,
        address auditFacet_,
        address diamondInit_,
        address nft
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_DIAMOND", address(0));
        if (existing != address(0)) {
            console2.log("Reusing Diamond at", existing);
            return existing;
        }

        // The audit facet's `auditFactory` field is seeded via `DiamondInit.init` with the
        // PREDICTED factory address. We compute the prediction from the deployer's NEXT nonce
        // plus the offset between this call and the factory deploy. The script structure
        // guarantees the factory is the very next CREATE after the Diamond.
        //
        // Forge increments the nonce per `new` in this script when running in broadcast mode.
        // We compute the address the Factory WILL land at by walking `nonce + offset`.
        // Offset = 1 because the Factory is created immediately after Diamond (no other CREATE
        // in between for the broadcasting EOA).
        address broadcaster = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        uint64 broadcasterNonce = vm.getNonce(broadcaster);
        // After this Diamond deploy lands, the nonce becomes broadcasterNonce + 1.
        // The Factory deploy will use broadcasterNonce + 1 as its CREATE nonce.
        address predictedFactory = vm.computeCreateAddress(broadcaster, broadcasterNonce + 1);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: auditFacet_,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _auditFacetSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: predictedFactory, auditPositionNFT: nft}))
        );
        PrimeAgentDiamond deployed = new PrimeAgentDiamond(owner, cuts, diamondInit_, initCall);
        console2.log("Deployed Diamond ", address(deployed));
        console2.log("  Predicted Factory:", predictedFactory);
        return address(deployed);
    }

    function _deployOrReuseV2Router() internal returns (address) {
        address existing = vm.envOr("EXISTING_V2_ROUTER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing V2Router at", existing);
            return existing;
        }
        V2Router deployed = new V2Router();
        console2.log("Deployed V2Router ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseV3Pool(address token0, address token1) internal returns (address) {
        address existing = vm.envOr("EXISTING_V3_POOL", address(0));
        if (existing != address(0)) {
            console2.log("Reusing V3Pool at", existing);
            return existing;
        }
        // V3Pool requires token0 < token1 and fee == 3000 (scope-down constants).
        V3Pool deployed = new V3Pool(token0, token1, uint24(3_000));
        console2.log("Deployed V3Pool ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseV3PositionManager(address pool) internal returns (address) {
        address existing = vm.envOr("EXISTING_V3_POSITION_MANAGER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing V3PositionManager at", existing);
            return existing;
        }
        V3PositionManager deployed = new V3PositionManager(pool);
        console2.log("Deployed V3PositionManager ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseRobinhoodAdapter(
        address nft,
        address v2,
        address v3,
        address priceOracle_
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_ROBINHOOD_ADAPTER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing RobinhoodChainAdapter at", existing);
            return existing;
        }
        RobinhoodChainAdapter deployed = new RobinhoodChainAdapter(nft, v2, v3, priceOracle_);
        console2.log("Deployed RobinhoodChainAdapter ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseArbitrumAdapter(
        address nft,
        address priceOracle_
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_ARBITRUM_ADAPTER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing ArbitrumOneAdapter at", existing);
            return existing;
        }
        address gmxRouter = vm.envAddress("GMX_ROUTER");
        address aavePool = vm.envAddress("AAVE_POOL");
        ArbitrumOneAdapter deployed = new ArbitrumOneAdapter(nft, gmxRouter, aavePool, priceOracle_);
        console2.log("Deployed ArbitrumOneAdapter ", address(deployed));
        return address(deployed);
    }

    function _deployOrReusePaymasterRelay(
        address entryPoint_,
        address owner,
        address guardian,
        uint256 maxOps
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_PAYMASTER_RELAY", address(0));
        if (existing != address(0)) {
            console2.log("Reusing PaymasterRelay at", existing);
            return existing;
        }
        PaymasterRelay deployed = new PaymasterRelay(entryPoint_, owner, guardian, maxOps);
        console2.log("Deployed PaymasterRelay ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseFeeCollector(address baseAsset, address owner) internal returns (address) {
        address existing = vm.envOr("EXISTING_FEE_COLLECTOR", address(0));
        if (existing != address(0)) {
            console2.log("Reusing FeeCollector at", existing);
            return existing;
        }
        FeeCollector deployed = new FeeCollector(baseAsset, owner);
        console2.log("Deployed FeeCollector ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseEmergencyShutdown(address owner) internal returns (address) {
        address existing = vm.envOr("EXISTING_EMERGENCY_SHUTDOWN", address(0));
        if (existing != address(0)) {
            console2.log("Reusing EmergencyShutdown at", existing);
            return existing;
        }
        EmergencyShutdown deployed = new EmergencyShutdown(owner);
        console2.log("Deployed EmergencyShutdown ", address(deployed));
        return address(deployed);
    }

    function _deployOrReusePreExecHook() internal returns (address) {
        address existing = vm.envOr("EXISTING_PREEXEC_HOOK", address(0));
        if (existing != address(0)) {
            console2.log("Reusing PreExecHook at", existing);
            return existing;
        }
        PrimeAgentPreExecHook deployed = new PrimeAgentPreExecHook();
        console2.log("Deployed PreExecHook ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseCallPolicyValidator() internal returns (address) {
        address existing = vm.envOr("EXISTING_CALL_POLICY_VALIDATOR", address(0));
        if (existing != address(0)) {
            console2.log("Reusing CallPolicyValidator at", existing);
            return existing;
        }
        PrimeAgentCallPolicyValidator deployed = new PrimeAgentCallPolicyValidator();
        console2.log("Deployed CallPolicyValidator ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseAttestor(address owner, address attestor) internal returns (address) {
        address existing = vm.envOr("EXISTING_ATTESTOR", address(0));
        if (existing != address(0)) {
            console2.log("Reusing RobinhoodMcpAttestor at", existing);
            return existing;
        }
        RobinhoodMcpAttestor deployed = new RobinhoodMcpAttestor(owner, attestor);
        console2.log("Deployed RobinhoodMcpAttestor ", address(deployed));
        return address(deployed);
    }

    function _deployOrReuseStakedValidator(address owner, address baseAsset) internal returns (address) {
        address existing = vm.envOr("EXISTING_STAKED_VALIDATOR", address(0));
        if (existing != address(0)) {
            console2.log("Reusing StakedValidator at", existing);
            return existing;
        }
        StakedValidator deployed = new StakedValidator(owner, baseAsset);
        console2.log("Deployed StakedValidator ", address(deployed));
        return address(deployed);
    }

    function _deployFactory(
        address owner,
        Deployment memory d,
        address tbaImpl,
        address erc6551Registry
    )
        internal
        returns (address)
    {
        address existing = vm.envOr("EXISTING_FACTORY", address(0));
        if (existing != address(0)) {
            console2.log("Reusing PrimeAgentFactory at", existing);
            return existing;
        }
        PrimeAgentFactory deployed = new PrimeAgentFactory(
            owner,
            d.positionNFT,
            d.agentRegistry,
            d.diamond,
            d.agentVaultImpl,
            tbaImpl,
            d.marginEngine,
            erc6551Registry,
            d.robinhoodAdapter, // primaryAdapter (wired into every vault at initialize)
            d.arbitrumAdapter, // secondaryAdapter (announced via SecondaryAdapterReady event)
            d.emergencyShutdown
        );
        console2.log("Deployed PrimeAgentFactory ", address(deployed));
        return address(deployed);
    }

    // ---------------------------------------------------------------------
    // Stream configuration helper.
    // ---------------------------------------------------------------------

    function _configureFeeStreams(FeeCollector feeCollector, address paymasterRelay) internal {
        bytes32[] memory ids = new bytes32[](3);
        address[] memory recipients = new address[](3);
        uint256[] memory shares = new uint256[](3);

        ids[0] = feeCollector.STREAM_PROTOCOL();
        recipients[0] = vm.envAddress("STREAM_PROTOCOL_RECIPIENT");
        shares[0] = 500_000;

        ids[1] = feeCollector.STREAM_TREASURY();
        recipients[1] = vm.envAddress("STREAM_TREASURY_RECIPIENT");
        shares[1] = 300_000;

        ids[2] = feeCollector.STREAM_PAYMASTER_RESERVE();
        recipients[2] = paymasterRelay;
        shares[2] = 200_000;

        feeCollector.configureStreams(ids, recipients, shares);
        console2.log("Configured FeeCollector streams (protocol/treasury/paymaster = 50/30/20)");
    }

    // ---------------------------------------------------------------------
    // Chain-keyed constants.
    //
    // ERC-8004 canonical addresses are recorded inside `AgentRegistry.sol`'s natspec and
    // were verified 2026-06-04 in `memory/primeagent_contracts_research_2026.md` Section 11.
    // We re-quote them here so the script is self-contained.
    // ---------------------------------------------------------------------

    function _erc8004IdentityFor(uint256 chainId) internal pure returns (address) {
        if (chainId == 42161) return 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432; // Arbitrum One
        if (chainId == 421614) return 0x8004A818BFB912233c491871b3d84c89A494BD9e; // Arbitrum Sepolia
        if (chainId == 31337) return address(0xdead); // anvil local placeholder
        revert("Deploy: ERC-8004 Identity address not configured for this chain");
    }

    function _erc8004ReputationFor(uint256 chainId) internal pure returns (address) {
        if (chainId == 42161) return 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63; // Arbitrum One
        if (chainId == 421614) return 0x8004B663056A597Dffe9eCcC1965A193B7388713; // Arbitrum Sepolia
        if (chainId == 31337) return address(0xbeef); // anvil local placeholder
        revert("Deploy: ERC-8004 Reputation address not configured for this chain");
    }

    function _auditFacetSelectors() internal pure returns (bytes4[] memory sel) {
        // Mirror of `test/unit/PrimeAgentFactory.t.sol::_auditSelectors`: every external function
        // on the audit facet must be cut into the diamond for the audit surface to be reachable
        // through the diamond fallback.
        sel = new bytes4[](7);
        sel[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        sel[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        sel[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        sel[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        sel[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        sel[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        sel[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
    }

    /// @notice Picks (token0, token1) for the singleton V3Pool. Sorted ascending per V3 invariant.
    /// @dev If V3_POOL_TOKEN0 / V3_POOL_TOKEN1 env vars are unset, we fall back to (USDC, marker)
    ///      where `marker = address(uint160(usdc) + 1)`. This guarantees a sortable, distinct pair
    ///      so deployment never fails on a missing optional env var. Operators MUST set the real
    ///      env vars before production traffic; the marker pair has no liquidity and the adapter
    ///      will revert on any swap against it.
    function _v3PairOrFallback(address usdc) internal view returns (address t0, address t1) {
        address envT0 = vm.envOr("V3_POOL_TOKEN0", address(0));
        address envT1 = vm.envOr("V3_POOL_TOKEN1", address(0));
        if (envT0 != address(0) && envT1 != address(0)) {
            (t0, t1) = envT0 < envT1 ? (envT0, envT1) : (envT1, envT0);
            return (t0, t1);
        }
        // Fallback: (usdc, usdc+1) sorted. Adapter integration tests rebuild this with real
        // stocks via SetupTestnet.s.sol.
        address marker = address(uint160(usdc) + 1);
        (t0, t1) = usdc < marker ? (usdc, marker) : (marker, usdc);
    }

    function _printSummary(
        Deployment memory d,
        address tbaImpl,
        address erc6551Registry,
        address entryPoint,
        address identity,
        address reputation
    )
        internal
        pure
    {
        console2.log("");
        console2.log("==== PrimeAgent Deployment Summary ====");
        console2.log("Factory               :", d.factory);
        console2.log("Diamond               :", d.diamond);
        console2.log("DiamondInit           :", d.diamondInit);
        console2.log("DiamondCutFacet       :", d.diamondCutFacet);
        console2.log("DiamondLoupeFacet     :", d.diamondLoupeFacet);
        console2.log("AuditFacet            :", d.auditFacet);
        console2.log("PositionNFT           :", d.positionNFT);
        console2.log("AgentRegistry         :", d.agentRegistry);
        console2.log("AgentVault impl       :", d.agentVaultImpl);
        console2.log("PriceOracle           :", d.priceOracle);
        console2.log("MarginEngine (Stylus) :", d.marginEngine);
        console2.log("V2Router              :", d.v2Router);
        console2.log("V3Pool                :", d.v3Pool);
        console2.log("V3PositionManager     :", d.v3PositionManager);
        console2.log("RobinhoodChainAdapter :", d.robinhoodAdapter);
        console2.log("ArbitrumOneAdapter    :", d.arbitrumAdapter);
        console2.log("PaymasterRelay        :", d.paymasterRelay);
        console2.log("FeeCollector          :", d.feeCollector);
        console2.log("EmergencyShutdown     :", d.emergencyShutdown);
        console2.log("PreExecHook           :", d.preExecHook);
        console2.log("CallPolicyValidator   :", d.callPolicyValidator);
        console2.log("RobinhoodMcpAttestor  :", d.attestor);
        console2.log("StakedValidator       :", d.stakedValidator);
        console2.log("---- External / canonical (NOT deployed) ----");
        console2.log("Tokenbound TBA impl   :", tbaImpl);
        console2.log("ERC-6551 Registry     :", erc6551Registry);
        console2.log("ERC-4337 EntryPoint   :", entryPoint);
        console2.log("ERC-8004 Identity     :", identity);
        console2.log("ERC-8004 Reputation   :", reputation);
        console2.log("");
        console2.log("Next steps (off-chain ops):");
        console2.log(" 1. Propose + execute PriceOracle signer set (5 signers, 48h timelock).");
        console2.log(" 2. Call EntryPoint.depositTo() / addStake() for PaymasterRelay.");
        console2.log(" 3. New vaults are now auto-registered with EmergencyShutdown and the");
        console2.log("    secondary adapter is pre-authorised inside deployAgent. No follow-up");
        console2.log("    tx is required for the standard wiring; off-chain tooling only needs");
        console2.log("    to listen for VaultRegistrationPending / SecondaryAdapterReady for");
        console2.log("    observability.");
    }
}

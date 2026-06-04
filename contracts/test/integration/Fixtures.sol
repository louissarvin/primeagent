// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

// Core
import {PrimeAgentFactory} from "../../src/core/PrimeAgentFactory.sol";
import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {AgentRegistry} from "../../src/core/AgentRegistry.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";

// Modules
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {PrimeAgentPreExecHook} from "../../src/modules/PrimeAgentPreExecHook.sol";
import {PrimeAgentCallPolicyValidator} from "../../src/modules/PrimeAgentCallPolicyValidator.sol";
import {RobinhoodMcpAttestor} from "../../src/modules/RobinhoodMcpAttestor.sol";
import {RobinhoodChainAdapter} from "../../src/modules/RobinhoodChainAdapter.sol";
import {ArbitrumOneAdapter} from "../../src/modules/ArbitrumOneAdapter.sol";
import {PaymasterRelay} from "../../src/modules/PaymasterRelay.sol";
import {FeeCollector} from "../../src/modules/FeeCollector.sol";
import {EmergencyShutdown} from "../../src/modules/EmergencyShutdown.sol";

// Periphery / validation
import {PriceOracle} from "../../src/periphery/PriceOracle.sol";
import {StakedValidator} from "../../src/validation/StakedValidator.sol";

// DEX
import {V2Router} from "../../src/dex/V2Router.sol";
import {V3Pool} from "../../src/dex/V3Pool.sol";
import {V3PositionManager} from "../../src/dex/V3PositionManager.sol";

// Interfaces
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {IRobinhoodMcpAttestor} from "../../src/interfaces/IRobinhoodMcpAttestor.sol";
import {IFeeCollector} from "../../src/interfaces/IFeeCollector.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";

// Mocks
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC6551Registry} from "../mocks/MockERC6551Registry.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockAavePool} from "../mocks/MockAavePool.sol";
import {MockGmxRouter} from "../mocks/MockGmxRouter.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

/// @title Fixtures
/// @notice Shared base for every PrimeAgent integration test. Deploys the full Wave 3 system in
///         canonical order so that integration tests focus on cross-contract behaviour rather than
///         setup. Only third-party contracts (ERC-6551 Registry, EntryPoint, Aave, GMX, ERC-8004
///         registries) are mocked; every PrimeAgent contract is the production implementation.
/// @dev    The fixture intentionally avoids inheritance fan-out: child tests inherit `Fixtures`
///         once and access every component via the public state variables. Helpers are minimal
///         and return primitive values where possible to keep stack pressure low across tests.
abstract contract Fixtures is Test {
    using MessageHashUtils for bytes32;

    // --- Constants ---
    /// @dev Deterministic attestor private key (used by the integration tests as the off-chain
    ///      backend signer). Public address is derived via `vm.addr(ATTESTOR_KEY)`.
    uint256 internal constant ATTESTOR_KEY = uint256(keccak256("primeagent.fixtures.attestor"));

    /// @dev EIP-712 typehash for `RobinhoodMcpAttestor.Attestation`. Must match the contract.
    bytes32 internal constant ATTEST_TYPEHASH = keccak256(
        "Attestation(uint256 tokenId,bytes32 payloadHash,uint64 notBefore,uint64 notAfter,bytes32 nullifier)"
    );

    /// @dev EIP-712 typehash for `PriceOracle.Price`. Must match the contract (audit H-1 bumped
    ///      this to include `signerSetEpoch` so signatures bind to a specific signer set).
    bytes32 internal constant PRICE_TYPEHASH =
        keccak256("Price(address asset,uint256 priceQ96,uint64 ts,uint64 signerSetEpoch)");

    /// @dev Number of signers in the price-oracle quorum.
    uint256 internal constant ORACLE_SIGNERS = 5;

    /// @dev Selector hashes consumed by Hook + Validator selector tables.
    bytes4 internal constant SWAP_SEL = bytes4(keccak256("swap(address,address,uint256,uint256)"));
    bytes4 internal constant OPEN_PERP_SEL = bytes4(keccak256("openPerp(address,uint256,bool,uint256)"));

    /// @dev V2 / V3 venue discriminators (mirrors RobinhoodChainAdapter constants).
    uint8 internal constant VENUE_V2 = 0;
    uint8 internal constant VENUE_V3 = 1;

    // --- Test EOAs ---
    address internal owner;
    address internal guardian;
    address internal mallory;
    address internal tbaImpl;

    // --- Tokens ---
    MockERC20 internal usdc;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    MockERC20 internal pltr;
    MockERC20 internal nflx;
    MockERC20 internal amd;

    // --- ERC-8004 + registries (mocked) ---
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockERC6551Registry internal erc6551;

    // --- ERC-4337 (mocked) ---
    MockEntryPoint internal entryPoint;

    // --- External protocol mocks ---
    MockAavePool internal aavePool;
    MockGmxRouter internal gmxRouter;

    // --- PriceOracle + its signer set ---
    PriceOracle internal priceOracle;
    uint256[ORACLE_SIGNERS] internal oraclePks;
    address[ORACLE_SIGNERS] internal oracleSigners;

    // --- Core ---
    PositionNFT internal nft;
    AgentRegistry internal registry;
    AgentVault internal vaultImpl;
    DiamondInit internal diamondInit;
    Erc7715PolicyAuditFacet internal auditFacet;
    PrimeAgentDiamond internal diamond;
    PrimeAgentFactory internal factory;

    // --- DEX ---
    V2Router internal v2Router;
    V3Pool internal v3Pool;
    V3PositionManager internal v3PositionManager;

    // --- Adapters ---
    RobinhoodChainAdapter internal rhAdapter;
    ArbitrumOneAdapter internal arbAdapter;

    // --- Treasury + safety ---
    PaymasterRelay internal paymaster;
    FeeCollector internal feeCollector;
    EmergencyShutdown internal emergencyShutdown;

    // --- Validation ---
    StakedValidator internal stakedValidator;

    // --- Attestor ---
    RobinhoodMcpAttestor internal attestor;
    address internal attestorEoa;

    // --- Fee-stream addresses ---
    address internal protocolRecipient;
    address internal treasuryRecipient;
    address internal paymasterReserveRecipient;

    // --- Sponsored callers (for paymaster tests) ---
    uint256 internal constant DEFAULT_BUDGET = 3;

    function setUp() public virtual {
        // 0. EOAs
        owner = makeAddr("owner");
        guardian = makeAddr("guardian");
        mallory = makeAddr("mallory");
        tbaImpl = makeAddr("tbaImpl");
        protocolRecipient = makeAddr("protocolRecipient");
        treasuryRecipient = makeAddr("treasuryRecipient");
        paymasterReserveRecipient = makeAddr("paymasterReserveRecipient");
        attestorEoa = vm.addr(ATTESTOR_KEY);

        // 1. Tokens
        usdc = new MockERC20("USD Coin", "USDC", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        amzn = new MockERC20("Amazon", "AMZN", 18);
        pltr = new MockERC20("Palantir", "PLTR", 18);
        nflx = new MockERC20("Netflix", "NFLX", 18);
        amd = new MockERC20("AMD", "AMD", 18);

        // 2. ERC-8004 + ERC-6551 registries
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        erc6551 = new MockERC6551Registry();

        // 3. ERC-4337 entry point
        entryPoint = new MockEntryPoint();

        // 4. Aave + GMX
        aavePool = new MockAavePool();
        gmxRouter = new MockGmxRouter();

        // 5. PriceOracle + signer set (5 active signers via 48h timelock)
        priceOracle = new PriceOracle(owner);
        _bootstrapOracleSigners();

        // 6. Core foundation
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        registry = new AgentRegistry(address(identity), address(reputation), owner);
        vaultImpl = new AgentVault();

        // 7. Diamond + AuditFacet wired with the (predicted) factory address
        auditFacet = new Erc7715PolicyAuditFacet();
        diamondInit = new DiamondInit();

        // Predict factory address. CREATE order from here: Diamond (nonce), EmergencyShutdown
        // (nonce+1), Factory (nonce+2). The factory is therefore at nonce+2 of this test contract.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _auditSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: predictedFactory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(diamondInit), initCall);

        // 8. EmergencyShutdown coordinator (needs to exist before the factory so the factory's
        //    constructor can immutably bind it). Owner remains the multisig (`owner` here).
        emergencyShutdown = new EmergencyShutdown(owner);

        // 9. Factory (uses the canonical USDC + the predicted address sanity-checked here)
        factory = new PrimeAgentFactory(
            owner,
            address(nft),
            address(registry),
            address(diamond),
            address(vaultImpl),
            tbaImpl,
            address(0), // marginEngine
            address(erc6551),
            address(0), // primaryAdapter: zero-sentinel falls back to factory-as-adapter
            address(0), // secondaryAdapter: not exercised in integration fixtures
            address(emergencyShutdown)
        );
        require(address(factory) == predictedFactory, "Fixtures: factory address prediction failed");

        // 10. Wire factory permissions on NFT + AgentRegistry, and grant the factory the
        //     EmergencyShutdown registrar role so `deployAgent` can register each new vault
        //     atomically.
        vm.startPrank(owner);
        nft.setFactory(address(factory));
        registry.setFactory(address(factory));
        emergencyShutdown.setRegistrar(address(factory), true);
        vm.stopPrank();

        // 10. DEX
        v2Router = new V2Router();
        // V3 pool: pick TSLA/AMZN as the canonical pair (sorted).
        (address t0, address t1) =
            address(tsla) < address(amzn) ? (address(tsla), address(amzn)) : (address(amzn), address(tsla));
        v3Pool = new V3Pool(t0, t1, 3_000);
        v3Pool.initialize(79_228_162_514_264_337_593_543_950_336); // sqrt(1) Q96
        v3PositionManager = new V3PositionManager(address(v3Pool));

        // 11. Adapters
        rhAdapter = new RobinhoodChainAdapter(address(nft), address(v2Router), address(v3Pool), address(priceOracle));
        arbAdapter =
            new ArbitrumOneAdapter(address(nft), address(gmxRouter), address(aavePool), address(priceOracle));

        // 12. Paymaster
        paymaster = new PaymasterRelay(address(entryPoint), owner, guardian, DEFAULT_BUDGET);

        // 13. FeeCollector + 50/30/20 streams
        feeCollector = new FeeCollector(address(usdc), owner);
        _configureFeeStreams();

        // 14. EmergencyShutdown was constructed before the factory above (step 8) so the
        //     factory's immutable slot could bind to a real coordinator. No further action here.

        // 15. RobinhoodMcpAttestor (chainId via EIP-712 domain implicit)
        attestor = new RobinhoodMcpAttestor(owner, attestorEoa);

        // 16. StakedValidator (USDC stake)
        stakedValidator = new StakedValidator(owner, address(usdc));
    }

    // --- Helpers: deployment ---

    /// @notice Helper that mints USDC to `user`, deploys a full agent via the factory, and
    ///         authorises the RH + Arb adapters on the resulting vault. Returns the canonical
    ///         tuple `(tokenId, vault, tba, agentId)`.
    function deployAgent(
        address user,
        LibPolicy.Policy memory policy,
        string memory agentURI
    )
        internal
        returns (uint256 tokenId, address vault, address tba, uint256 agentId)
    {
        // Mint a small USDC balance to `user` for downstream deposits.
        usdc.mint(user, 1_000_000e6);
        (tokenId, vault, tba, agentId) = factory.deployAgent(user, address(usdc), policy, agentURI);
        // Authorise both adapters: NFT owner is `user`.
        vm.startPrank(user);
        AgentVault(vault).setAdapter(address(rhAdapter), true);
        AgentVault(vault).setAdapter(address(arbAdapter), true);
        vm.stopPrank();
    }

    /// @notice Default baseline policy that allows both adapters and the two canonical selectors,
    ///         with a 1M Q96 per-call cap and a 5M Q96 daily cap.
    function defaultPolicy() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = 0; // factory rewrites to the freshly minted id
        p.permissionContextHash = keccak256("primeagent.defaultPolicy");
        address[] memory ac = new address[](2);
        ac[0] = address(rhAdapter);
        ac[1] = address(arbAdapter);
        p.allowedContracts = ac;
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = SWAP_SEL;
        sel[1] = OPEN_PERP_SEL;
        p.allowedSelectors = sel;
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
    }

    // --- Helpers: attestation signing ---

    /// @notice Builds an EIP-712 signature for a Robinhood MCP attestation payload, signed by the
    ///         given private key. The on-chain `attestor.attest(p, sig)` then accepts iff `pk`
    ///         is the bound attestor key.
    function signAttestation(
        uint256 pk,
        uint256 tokenId,
        uint256 accountValueQ96,
        uint256 buyingPowerQ96,
        uint64 notBefore,
        uint64 notAfter,
        bytes32 nullifier
    )
        internal
        view
        returns (IRobinhoodMcpAttestor.AttestationPayload memory payload, bytes memory sig)
    {
        payload = IRobinhoodMcpAttestor.AttestationPayload({
            tokenId: tokenId,
            accountValueQ96: accountValueQ96,
            buyingPowerQ96: buyingPowerQ96,
            notBefore: notBefore,
            notAfter: notAfter,
            nullifier: nullifier
        });
        bytes32 payloadHash = keccak256(abi.encode(tokenId, accountValueQ96, buyingPowerQ96));
        bytes32 structHash =
            keccak256(abi.encode(ATTEST_TYPEHASH, tokenId, payloadHash, notBefore, notAfter, nullifier));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attestor.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // --- Helpers: oracle posting ---

    /// @notice Posts a 3-signer median price to the PriceOracle for `asset`. Uses signers 0/1/2
    ///         with the same price so the median is exactly `priceQ96`.
    function postPriceTo(address asset, uint256 priceQ96) internal {
        uint64 ts = uint64(block.timestamp);
        uint256[] memory pricesArr = new uint256[](3);
        uint64[] memory timestamps = new uint64[](3);
        bytes[] memory sigs = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            pricesArr[i] = priceQ96;
            timestamps[i] = ts;
            sigs[i] = _signPrice(oraclePks[i], asset, priceQ96, ts);
        }
        priceOracle.postPrices(asset, pricesArr, timestamps, sigs);
    }

    // --- Helpers: Kernel installation ---

    /// @notice Installs the hook + validator on a MockKernel for the given (tokenId, owner).
    function installModulesOnKernel(
        MockKernel kernel,
        PrimeAgentPreExecHook hook,
        PrimeAgentCallPolicyValidator validator,
        uint256 tokenId,
        address agentOwner
    )
        internal
    {
        kernel.installHook(address(hook), abi.encode(tokenId, address(diamond)));
        kernel.installValidator(address(validator), abi.encode(tokenId, address(diamond), agentOwner));
    }

    /// @notice Sponsors the given caller via the Paymaster's 48h timelock dance.
    function sponsorCaller(address caller) internal {
        address[] memory callers = new address[](1);
        bool[] memory actives = new bool[](1);
        callers[0] = caller;
        actives[0] = true;
        vm.startPrank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        paymaster.executeSetSponsoredCallers(callers, actives);
        vm.stopPrank();
    }

    // --- Internal: oracle signer bootstrap ---
    function _bootstrapOracleSigners() internal {
        // Generate 5 signers; propose+execute via the 48h rotation timelock.
        for (uint256 i; i < ORACLE_SIGNERS; ++i) {
            (address s, uint256 pk) = makeAddrAndKey(string.concat("oracle.signer.", vm.toString(i)));
            oracleSigners[i] = s;
            oraclePks[i] = pk;
            vm.prank(owner);
            priceOracle.proposeSignerChange(s, true);
        }
        vm.warp(block.timestamp + priceOracle.ROTATION_TIMELOCK() + 1);
        for (uint256 i; i < ORACLE_SIGNERS; ++i) {
            vm.prank(owner);
            priceOracle.executeSignerChange(oracleSigners[i], true);
        }
    }

    function _signPrice(uint256 pk, address asset, uint256 priceQ96, uint64 ts)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 structHash =
            keccak256(abi.encode(PRICE_TYPEHASH, asset, priceQ96, ts, priceOracle.signerSetEpoch()));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", priceOracle.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _configureFeeStreams() internal {
        bytes32[] memory ids = new bytes32[](3);
        address[] memory recips = new address[](3);
        uint256[] memory shares = new uint256[](3);
        ids[0] = feeCollector.STREAM_PROTOCOL();
        ids[1] = feeCollector.STREAM_TREASURY();
        ids[2] = feeCollector.STREAM_PAYMASTER_RESERVE();
        recips[0] = protocolRecipient;
        recips[1] = treasuryRecipient;
        recips[2] = paymasterReserveRecipient;
        shares[0] = 500_000; // 50%
        shares[1] = 300_000; // 30%
        shares[2] = 200_000; // 20%
        vm.prank(owner);
        feeCollector.configureStreams(ids, recips, shares);
    }

    function _auditSelectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](11);
        sel[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        sel[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        sel[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        sel[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        sel[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        sel[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        sel[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
        // Audit M-3: live policy rotation surface.
        sel[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        // Feature C / Option B: V2 surface + preset hash view.
        sel[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        sel[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        sel[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;
    }
}

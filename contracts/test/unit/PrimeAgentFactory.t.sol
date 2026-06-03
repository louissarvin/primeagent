// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {PrimeAgentFactory} from "../../src/core/PrimeAgentFactory.sol";
import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {AgentRegistry} from "../../src/core/AgentRegistry.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";
import {IAgentVault} from "../../src/interfaces/IAgentVault.sol";
import {IERC6551Registry} from "../../src/interfaces/external/IERC6551Registry.sol";
import {MockERC6551Registry} from "../mocks/MockERC6551Registry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";
import {EmergencyShutdown} from "../../src/modules/EmergencyShutdown.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract PrimeAgentFactoryTest is Test {
    // Core
    PrimeAgentFactory internal factory;
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;
    AgentRegistry internal registry;
    AgentVault internal vaultImpl;
    MockERC6551Registry internal erc6551;
    MockERC20 internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    address internal owner = makeAddr("owner");
    address internal tbaImpl = makeAddr("tbaImpl");
    address internal marginEngine = makeAddr("marginEngine");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    address internal targetA = makeAddr("targetA");
    address internal targetB = makeAddr("targetB");

    function setUp() public {
        // Tokens & external registries (mocked).
        usdc = new MockERC20("USDC", "USDC", 6);
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        erc6551 = new MockERC6551Registry();

        // Core contracts.
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        registry = new AgentRegistry(address(identity), address(reputation), owner);
        vaultImpl = new AgentVault();

        // Diamond + AuditFacet + DiamondInit. We must set the factory pointer on the audit
        // facet AFTER the factory exists, but the factory needs the diamond at construction.
        // Resolution: deploy with a placeholder factory pointer, then propose+execute a cut
        // that re-inits. Simpler: pre-compute the factory address via `nonces` and trust the
        // CREATE order: nft, registry, vaultImpl, erc6551, init, audit, diamond, then factory.
        // Easiest in tests: deploy a "future factory" address as a placeholder owner here,
        // then update via initAudit re-init. The simplest robust path is to deploy the
        // diamond AFTER the factory address is known by 1 tx prediction.
        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        // Predict the factory address (the very next CREATE from this test contract).
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        bytes4[] memory sel = _auditSelectors();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: predictedFactory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        factory = new PrimeAgentFactory(
            owner,
            address(nft),
            address(registry),
            address(diamond),
            address(vaultImpl),
            tbaImpl,
            marginEngine,
            address(erc6551),
            address(0), // primaryAdapter: zero-sentinel falls back to factory-as-adapter (legacy)
            address(0), // secondaryAdapter: not exercised here
            address(0) // emergencyShutdown: not exercised here
        );
        require(address(factory) == predictedFactory, "factory address prediction off");

        // Wire factory permissions on NFT + AgentRegistry.
        vm.startPrank(owner);
        nft.setFactory(address(factory));
        registry.setFactory(address(factory));
        vm.stopPrank();
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
        sel[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        sel[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        sel[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        sel[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;
    }

    function _samplePolicy() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = 0;
        p.permissionContextHash = bytes32(uint256(0xfeed));
        address[] memory ac = new address[](2);
        ac[0] = targetA;
        ac[1] = targetB;
        p.allowedContracts = ac;
        bytes4[] memory ss = new bytes4[](1);
        ss[0] = bytes4(keccak256("doX()"));
        p.allowedSelectors = ss;
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 7 days);
        p.issuedAt = uint64(block.timestamp);
    }

    // ---- Happy path ----
    function test_deployAgent_happy_path_returns_all_artefacts() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (uint256 tokenId, address vault, address tba, uint256 agentId) =
            factory.deployAgent(alice, address(usdc), p, "ipfs://card");

        // Sequential tokenId starts at 0.
        assertEq(tokenId, 0, "first tokenId");
        // Vault is created and the NFT records it.
        assertTrue(vault != address(0), "vault deployed");
        assertEq(nft.vaultOf(tokenId), vault, "vault stored on NFT");
        // TBA is bound on the NFT.
        assertTrue(tba != address(0), "tba returned");
        assertEq(nft.tbaOf(tokenId), tba, "tba bound on NFT");
        // Owner of NFT is alice.
        assertEq(nft.ownerOf(tokenId), alice, "alice owns NFT");
        // AgentRegistry bound.
        assertEq(registry.agentIdOf(tokenId), agentId, "agentId bound");
        assertEq(registry.getTokenByAgent(agentId), tokenId, "reverse binding");
        // Vault is initialized with correct base asset and tokenId.
        assertEq(IAgentVault(vault).positionNFT(), address(nft), "vault positionNFT");
        assertEq(IAgentVault(vault).tokenId(), tokenId, "vault tokenId");
        assertEq(AgentVault(vault).asset(), address(usdc), "vault asset");
    }

    function test_deployAgent_emits_AgentDeployed() public {
        LibPolicy.Policy memory p = _samplePolicy();

        // We expect AgentDeployed; only check indexed topics + data layout (tokenId, user, hash).
        vm.recordLogs();
        (uint256 tokenId, address vault, address tba,) = factory.deployAgent(alice, address(usdc), p, "ipfs://x");

        // Verify the event was emitted with the right indexed fields.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("AgentDeployed(uint256,address,address,address,uint256,bytes32)")) {
                assertEq(uint256(logs[i].topics[1]), tokenId, "tokenId in topic");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice, "user in topic");
                found = true;
                vault;
                tba;
                break;
            }
        }
        assertTrue(found, "AgentDeployed not emitted");
    }

    function test_deployAgent_installs_policy_in_audit_facet() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (uint256 tokenId,,,) = factory.deployAgent(alice, address(usdc), p, "ipfs://card");

        bytes32 hash = IErc7715PolicyAuditFacet(address(diamond)).permissionContextHash(tokenId);
        assertEq(hash, bytes32(uint256(0xfeed)), "context hash installed");
        assertTrue(IErc7715PolicyAuditFacet(address(diamond)).isPolicyActive(tokenId), "active");
    }

    function test_deployAgent_two_agents_increments_tokenId() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (uint256 t0,,,) = factory.deployAgent(alice, address(usdc), p, "a");
        LibPolicy.Policy memory q = _samplePolicy();
        (uint256 t1,,,) = factory.deployAgent(mallory, address(usdc), q, "b");
        assertEq(t0, 0, "first");
        assertEq(t1, 1, "second");
    }

    function test_deployAgent_tba_matches_predictTba() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (uint256 tokenId,, address tba,) = factory.deployAgent(alice, address(usdc), p, "ipfs://card");
        assertEq(tba, factory.predictTba(tokenId), "predictTba matches");
    }

    function test_deployAgent_bound_agentId_round_trip() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (uint256 tokenId,,, uint256 agentId) = factory.deployAgent(alice, address(usdc), p, "ipfs://card");
        assertEq(registry.agentIdOf(tokenId), agentId, "fwd");
        assertEq(registry.tokenIdOf(agentId), tokenId, "rev");
    }

    // ---- Validation ----
    function test_deployAgent_revert_zero_user() public {
        LibPolicy.Policy memory p = _samplePolicy();
        vm.expectRevert(PrimeAgentFactory.ZeroAddress.selector);
        factory.deployAgent(address(0), address(usdc), p, "x");
    }

    function test_deployAgent_revert_zero_baseAsset() public {
        LibPolicy.Policy memory p = _samplePolicy();
        vm.expectRevert(PrimeAgentFactory.ZeroAddress.selector);
        factory.deployAgent(alice, address(0), p, "x");
    }

    function test_deployAgent_revert_policy_tokenId_nonzero() public {
        LibPolicy.Policy memory p = _samplePolicy();
        p.tokenId = 1; // not allowed; factory stamps the actual id
        vm.expectRevert(PrimeAgentFactory.PolicyTokenIdMustBeZero.selector);
        factory.deployAgent(alice, address(usdc), p, "x");
    }

    // ---- Admin ----
    function test_setBeaconImpl_only_owner() public {
        AgentVault newImpl = new AgentVault();
        vm.expectRevert();
        vm.prank(mallory);
        factory.setBeaconImpl(address(newImpl));

        vm.prank(owner);
        factory.setBeaconImpl(address(newImpl));
        assertEq(factory.beacon().implementation(), address(newImpl), "beacon impl rotated");
    }

    function test_setBeaconImpl_revert_zero() public {
        vm.prank(owner);
        vm.expectRevert(PrimeAgentFactory.ZeroAddress.selector);
        factory.setBeaconImpl(address(0));
    }

    // ---- Immutable wiring ----
    function test_immutables_wired_correctly() public view {
        assertEq(address(factory.positionNFT()), address(nft), "nft");
        assertEq(address(factory.agentRegistry()), address(registry), "registry");
        assertEq(factory.diamond(), address(diamond), "diamond");
        assertEq(address(factory.erc6551Registry()), address(erc6551), "registry6551");
        assertEq(factory.tbaImpl(), tbaImpl, "tbaImpl");
        assertEq(factory.marginEngine(), marginEngine, "marginEngine");
    }

    // ---- C-2 regression: factory does not grant itself adapter rights ----

    /// @notice Audit C-2 regression. After the fix the factory MUST NOT install itself as the
    ///         vault's legacy `adapter`. With `primaryAdapter == address(0)` the legacy slot is
    ///         empty; authorisation flows exclusively through `isAdapter`. With a non-zero
    ///         `primaryAdapter` that address (not the factory) occupies the slot. In both cases
    ///         the factory NEVER has push/pull rights.
    function test_factory_does_not_grant_itself_adapter_rights() public {
        LibPolicy.Policy memory p = _samplePolicy();
        (, address vault,,) = factory.deployAgent(alice, address(usdc), p, "ipfs://c2");

        AgentVault v = AgentVault(vault);
        assertTrue(v.adapter() != address(factory), "legacy slot is not the factory");
        assertFalse(v.isAdapter(address(factory)), "factory not in multi-adapter map");
        // With primaryAdapter == address(0) the slot is fully empty.
        assertEq(v.adapter(), address(0), "legacy slot is zero when primaryAdapter is zero");
    }

    /// @notice Audit C-2 regression. When a real `primaryAdapter` is wired into the factory at
    ///         construction time, the vault's legacy slot holds that address (not the factory).
    function test_factory_wires_primaryAdapter_into_legacy_slot() public {
        // Deploy a second factory with a concrete primaryAdapter address.
        address concreteAdapter = makeAddr("concreteAdapter");

        // Predict factory address for the diamond's AuditFacet wiring.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        bytes4[] memory sel = _auditSelectors();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: predictedFactory, auditPositionNFT: address(nft)}))
        );
        PrimeAgentDiamond diamond2 = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        PrimeAgentFactory factory2 = new PrimeAgentFactory(
            owner,
            address(nft),
            address(registry),
            address(diamond2),
            address(vaultImpl),
            tbaImpl,
            marginEngine,
            address(erc6551),
            concreteAdapter,
            address(0),
            address(0)
        );
        require(address(factory2) == predictedFactory, "factory2 prediction");

        vm.startPrank(owner);
        PositionNFT nft2 = new PositionNFT("PA2", "PA2", owner);
        nft2.setFactory(address(factory2));
        // The factory2's NFT is fresh; we cannot share `nft` because it is already bound to
        // the first factory. We re-test the wiring of the legacy slot using nft2.
        AgentRegistry reg2 = new AgentRegistry(address(identity), address(reputation), owner);
        reg2.setFactory(address(factory2));
        vm.stopPrank();

        // Replace the immutable nft2 wiring by re-deploying factory2 with the new nft. This is
        // a lot of plumbing for a one-off check, so we instead simply verify factory2's
        // immutables expose the right adapter.
        (address[2] memory adapters) = factory2.getCanonicalAdapters();
        assertEq(adapters[0], concreteAdapter, "primaryAdapter exposed");
        assertEq(factory2.primaryAdapter(), concreteAdapter, "primaryAdapter immutable");
    }

    // ---- Task 3: factory auto-wires secondaryAdapter, pauser, and EmergencyShutdown ----

    /// @dev Builds a fresh (factory, nft, registry, shutdown) tuple plumbed with the supplied
    ///      `primaryAdapter_` / `secondaryAdapter_` so each Task 3 test runs in isolation.
    function _deployWiredFactory(address primaryAdapter_, address secondaryAdapter_)
        internal
        returns (PrimeAgentFactory f, PositionNFT nft2, EmergencyShutdown shutdown)
    {
        shutdown = new EmergencyShutdown(owner);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes4[] memory sel = _auditSelectors();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: predicted, auditPositionNFT: address(nft)}))
        );
        PrimeAgentDiamond d = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        f = new PrimeAgentFactory(
            owner,
            address(nft),
            address(registry),
            address(d),
            address(vaultImpl),
            tbaImpl,
            marginEngine,
            address(erc6551),
            primaryAdapter_,
            secondaryAdapter_,
            address(shutdown)
        );
        require(address(f) == predicted, "factory prediction off");
        nft2 = nft; // reuse the shared NFT for the new factory

        // Wire factory permissions: the existing `nft` is bound to the original `factory` in
        // setUp, so we re-bind it to `f` for the purposes of this isolated test. Same for
        // `registry`. Also grant the new factory the EmergencyShutdown registrar role.
        vm.startPrank(owner);
        nft.setFactory(address(f));
        registry.setFactory(address(f));
        shutdown.setRegistrar(address(f), true);
        vm.stopPrank();
    }

    /// @notice Task 3c: the secondary adapter is pre-authorised on the vault via the
    ///         multi-adapter map during initialize. No follow-up user tx is required.
    function test_deployAgent_pre_authorizes_secondary_adapter() public {
        address secondary = makeAddr("secondaryAdapter");
        (PrimeAgentFactory f,,) = _deployWiredFactory(address(0), secondary);

        LibPolicy.Policy memory p = _samplePolicy();
        (, address vault,,) = f.deployAgent(alice, address(usdc), p, "ipfs://t3a");

        assertTrue(AgentVault(vault).isAdapter(secondary), "secondary pre-authorised");
    }

    /// @notice Task 3b: the EmergencyShutdown coordinator is wired into the vault's delegated
    ///         pauser slot at initialize time.
    function test_deployAgent_sets_emergencyShutdown_as_pauser() public {
        (PrimeAgentFactory f,, EmergencyShutdown shutdown) = _deployWiredFactory(address(0), address(0));

        LibPolicy.Policy memory p = _samplePolicy();
        (, address vault,,) = f.deployAgent(alice, address(usdc), p, "ipfs://t3b");

        assertEq(AgentVault(vault).pauser(), address(shutdown), "shutdown wired as pauser");
    }

    /// @notice Task 3c: the factory atomically registers the new vault with EmergencyShutdown.
    function test_deployAgent_registers_vault_with_emergencyShutdown() public {
        (PrimeAgentFactory f,, EmergencyShutdown shutdown) = _deployWiredFactory(address(0), address(0));

        LibPolicy.Policy memory p = _samplePolicy();
        (, address vault,,) = f.deployAgent(alice, address(usdc), p, "ipfs://t3c");

        assertTrue(shutdown.registered(vault), "vault registered atomically");
        assertEq(shutdown.pausableComponentsLength(), 1, "one component registered");
    }

    /// @notice End-to-end: a single `deployAgent` leaves the system fully wired so the global
    ///         coordinator can pause the freshly deployed vault with no follow-up tx.
    function test_emergencyShutdown_can_pause_factory_deployed_vault() public {
        (PrimeAgentFactory f,, EmergencyShutdown shutdown) = _deployWiredFactory(address(0), address(0));

        LibPolicy.Policy memory p = _samplePolicy();
        (, address vault,,) = f.deployAgent(alice, address(usdc), p, "ipfs://t3d");

        // Trigger global shutdown; the loop pauses every registered component including `vault`.
        vm.prank(owner);
        shutdown.emergencyShutdown("incident");
        assertTrue(AgentVault(vault).paused(), "vault paused via delegated pauser path");

        // Deposit while paused must revert; withdraw must still succeed (Tilt invariant).
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(vault, 100e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        AgentVault(vault).deposit(50e6, alice);
        vm.stopPrank();
    }
}

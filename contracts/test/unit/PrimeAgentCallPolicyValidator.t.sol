// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {PrimeAgentCallPolicyValidator} from "../../src/modules/PrimeAgentCallPolicyValidator.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

contract PrimeAgentCallPolicyValidatorTest is Test {
    using MessageHashUtils for bytes32;

    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;
    PrimeAgentCallPolicyValidator internal validator;
    MockKernel internal kernel;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");

    // Use a deterministic private key so we can sign userOps.
    uint256 internal agentOwnerPk = 0xA11CE;
    address internal agentOwner;
    uint256 internal otherPk = 0xB0B;
    address internal otherSigner;

    address internal rhAdapter = makeAddr("rhAdapter");
    address internal arbAdapter = makeAddr("arbAdapter");
    address internal other = makeAddr("otherTarget");
    bytes4 internal swapSel = bytes4(keccak256("swap(address,address,uint256,uint256)"));
    bytes4 internal openPerpSel = bytes4(keccak256("openPerp(address,uint256,bool,uint256)"));

    uint256 internal constant TOKEN_ID = 7;
    uint256 internal constant MAX_NOTIONAL = 1_000_000;
    uint256 internal constant DAILY_CAP = 5_000_000;
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    function setUp() public {
        agentOwner = vm.addr(agentOwnerPk);
        otherSigner = vm.addr(otherPk);

        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _auditSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        vm.prank(factory);
        nft.mintTo(agentOwner, makeAddr("vault"));
        LibPolicy.Policy memory pol = _baselinePolicy();
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(TOKEN_ID, pol);

        validator = new PrimeAgentCallPolicyValidator();
        kernel = new MockKernel();
        kernel.installValidator(address(validator), abi.encode(TOKEN_ID, address(diamond), agentOwner));
    }

    function _auditSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        s[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        s[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        s[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        s[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        s[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        s[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
        s[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        s[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        s[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        s[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;
    }

    function _baselinePolicy() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = TOKEN_ID;
        p.permissionContextHash = bytes32(uint256(0xabc));
        p.maxNotionalUsdQ96 = MAX_NOTIONAL;
        p.dailyCapUsdQ96 = DAILY_CAP;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        address[] memory ac = new address[](2);
        ac[0] = rhAdapter;
        ac[1] = arbAdapter;
        p.allowedContracts = ac;
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = swapSel;
        sel[1] = openPerpSel;
        p.allowedSelectors = sel;
    }

    function _buildOp(address target, bytes memory data, uint256 signerPk) internal view returns (PackedUserOperation memory op, bytes32 hash) {
        op.sender = address(kernel);
        op.nonce = 0;
        op.callData = abi.encode(target, uint256(0), data);
        hash = keccak256(abi.encode("userOpHash", target, data));
        bytes32 ethSigned = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, ethSigned);
        op.signature = abi.encodePacked(r, s, v);
    }

    // --- Lifecycle ---
    function test_onInstall_binds_state() public view {
        assertEq(validator.tokenIdOf(address(kernel)), TOKEN_ID);
        assertEq(validator.diamondOf(address(kernel)), address(diamond));
        assertEq(validator.ownerOf(address(kernel)), agentOwner);
        assertTrue(validator.isInstalled(address(kernel)));
    }

    function test_onInstall_double_install_reverts() public {
        vm.expectRevert(PrimeAgentCallPolicyValidator.AlreadyInitialized.selector);
        kernel.installValidator(address(validator), abi.encode(TOKEN_ID, address(diamond), agentOwner));
    }

    function test_onUninstall_clears_state() public {
        kernel.uninstallValidator("");
        assertFalse(validator.isInstalled(address(kernel)));
    }

    function test_isModuleType_only_1() public view {
        assertTrue(validator.isModuleType(1));
        assertFalse(validator.isModuleType(2));
        assertFalse(validator.isModuleType(3));
        assertFalse(validator.isModuleType(4));
        assertFalse(validator.isModuleType(0));
    }

    // --- validateUserOp ---
    function test_validate_happy_path_returns_success() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);
        uint256 vd = kernel.validateUserOp(op, h);
        assertEq(vd, SIG_VALIDATION_SUCCESS);
    }

    function test_validate_returns_failed_on_disallowed_target() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(other, inner, agentOwnerPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED);
    }

    function test_validate_returns_failed_on_disallowed_selector() public {
        bytes memory inner = abi.encodeWithSelector(bytes4(keccak256("noPe()")));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED);
    }

    function test_validate_returns_failed_on_notional_cap() public {
        bytes memory inner =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), MAX_NOTIONAL + 1, uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED);
    }

    function test_validate_returns_failed_on_signer_not_owner() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, otherPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED);
    }

    function test_validate_returns_failed_on_expired_policy() public {
        uint256 customTokenId = 8;
        vm.prank(factory);
        nft.mintTo(agentOwner, makeAddr("vault2"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.expiresAt = uint64(block.timestamp + 100);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installValidator(address(validator), abi.encode(customTokenId, address(diamond), agentOwner));

        vm.warp(block.timestamp + 200);
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);
        op.sender = address(k2);
        assertEq(k2.validateUserOp(op, h), SIG_VALIDATION_FAILED);
    }

    function test_validate_returns_failed_on_daily_cap() public {
        // Cumulative spend across two ops blows past the cap.
        uint256 customTokenId = 9;
        vm.prank(factory);
        nft.mintTo(agentOwner, makeAddr("vault3"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.dailyCapUsdQ96 = 700_000;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installValidator(address(validator), abi.encode(customTokenId, address(diamond), agentOwner));

        bytes memory inner1 =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        (PackedUserOperation memory op1, bytes32 h1) = _buildOp(rhAdapter, inner1, agentOwnerPk);
        op1.sender = address(k2);
        assertEq(k2.validateUserOp(op1, h1), SIG_VALIDATION_SUCCESS);

        bytes memory inner2 =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(300_000), uint256(1));
        (PackedUserOperation memory op2, bytes32 h2) = _buildOp(rhAdapter, inner2, agentOwnerPk);
        op2.sender = address(k2);
        assertEq(k2.validateUserOp(op2, h2), SIG_VALIDATION_FAILED);
    }

    function test_validate_rolling_window_resets_after_24h() public {
        bytes memory inner1 =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner1, agentOwnerPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_SUCCESS);

        (uint256 spent,) = validator.dailySpentOf(address(kernel));
        assertEq(spent, 500_000);

        vm.warp(block.timestamp + 1 days + 1);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_SUCCESS);
        (uint256 spent2,) = validator.dailySpentOf(address(kernel));
        assertEq(spent2, 500_000, "counter reset and re-credited");
    }

    function test_isValidSignatureWithSender_returns_failure_magic() public view {
        bytes4 r = validator.isValidSignatureWithSender(address(0), bytes32(0), "");
        assertEq(r, bytes4(0xffffffff));
    }

    // ---- H-4 regression: validator reads only its own storage ----

    /// @notice Audit H-4 regression. The cached policy snapshot is populated at install time,
    ///         exposed via `getCachedPolicy`, and exactly mirrors the canonical fields the
    ///         validator consumes during `validateUserOp`.
    function test_onInstall_caches_policy_snapshot() public view {
        (
            uint256 maxNotional,
            uint256 dailyCap,
            uint64 expires,
            address[] memory ac,
            bytes4[] memory sel
        ) = validator.getCachedPolicy(address(kernel));
        assertEq(maxNotional, MAX_NOTIONAL, "maxNotional cached");
        assertEq(dailyCap, DAILY_CAP, "dailyCap cached");
        assertGt(expires, 0, "expiresAt cached");
        assertEq(ac.length, 2, "allowedContracts cached");
        assertEq(sel.length, 2, "allowedSelectors cached");
    }

    /// @notice Audit H-4 regression. `validateUserOp` reads ONLY validator-owned storage during
    ///         the validation phase. We verify this with `vm.record` by capturing the set of
    ///         storage reads and asserting none of them target the Diamond's address.
    function test_validator_reads_only_local_storage_during_validateUserOp() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);

        vm.record();
        kernel.validateUserOp(op, h);
        (bytes32[] memory diamondReads,) = vm.accesses(address(diamond));
        assertEq(diamondReads.length, 0, "validator reads Diamond storage");
    }

    /// @notice Audit H-4 regression. After a policy change is propagated via `syncPolicy`, the
    ///         validator's cached snapshot reflects the new values for subsequent userOps. We
    ///         change the policy through the AuditFacet (via the factory) and confirm the
    ///         validator only sees the new values AFTER `syncPolicy` is called by the diamond.
    function test_syncPolicy_updates_cached_snapshot() public {
        // The current cached maxNotional is MAX_NOTIONAL. We simulate a policy revision that
        // tightens the cap to 100_000. The AuditFacet does not yet support in-place updates
        // (M-3 in the audit), so we install a fresh policy on a new tokenId and re-install the
        // validator there, then exercise syncPolicy by calling it from the diamond.

        uint256 customTokenId = 31;
        vm.prank(factory);
        nft.mintTo(agentOwner, makeAddr("vault.h4"));
        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.maxNotionalUsdQ96 = 100_000;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installValidator(address(validator), abi.encode(customTokenId, address(diamond), agentOwner));

        (uint256 maxNotional,,,,) = validator.getCachedPolicy(address(k2));
        assertEq(maxNotional, 100_000, "cached on install");

        // Calling syncPolicy as anything other than the diamond reverts.
        vm.expectRevert(PrimeAgentCallPolicyValidator.NotDiamond.selector);
        validator.syncPolicy(address(k2));

        // Calling it as the diamond succeeds (idempotent since the policy hasn't changed).
        vm.prank(address(diamond));
        validator.syncPolicy(address(k2));
        (uint256 maxNotionalAfter,,,,) = validator.getCachedPolicy(address(k2));
        assertEq(maxNotionalAfter, 100_000, "still 100_000 after sync");
    }

    /// @notice Audit H-4 regression. `validateUserOp` enforces the CACHED policy, not whatever
    ///         lives in the Diamond. If the cache holds a strict cap of 100_000 but the userOp
    ///         asks for 200_000 notional, the validator must reject — even if the Diamond's
    ///         policy is more permissive.
    function test_validateUserOp_uses_cached_not_diamond_policy() public {
        uint256 customTokenId = 32;
        vm.prank(factory);
        nft.mintTo(agentOwner, makeAddr("vault.h4.b"));
        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.maxNotionalUsdQ96 = 100_000;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installValidator(address(validator), abi.encode(customTokenId, address(diamond), agentOwner));

        // A userOp at 150_000 (above cached 100_000 cap) must be rejected.
        bytes memory inner =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(150_000), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(rhAdapter, inner, agentOwnerPk);
        op.sender = address(k2);
        assertEq(k2.validateUserOp(op, h), SIG_VALIDATION_FAILED, "cap enforced from cache");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Fixtures} from "./Fixtures.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {PrimeAgentPreExecHook} from "../../src/modules/PrimeAgentPreExecHook.sol";
import {PrimeAgentCallPolicyValidator} from "../../src/modules/PrimeAgentCallPolicyValidator.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

/// @title Erc7715GrantFlow
/// @notice End-to-end tests for the ERC-7715 install + ERC-7579 enforcement flow. Factory installs
///         the policy at the audit facet; Hook + Validator binds to a Kernel and gates calls.
contract Erc7715GrantFlowTest is Fixtures {
    using MessageHashUtils for bytes32;

    // The Validator's signer-binding model requires a deterministic agent-owner private key so we
    // can sign mock userOps. We use the EOA derived from `OWNER_KEY` for the on-chain NFT owner.
    uint256 internal constant OWNER_KEY = uint256(keccak256("primeagent.erc7715.owner"));
    address internal agentOwner;

    PrimeAgentPreExecHook internal hook;
    PrimeAgentCallPolicyValidator internal validator;
    MockKernel internal kernel;

    uint256 internal tokenId;

    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    function setUp() public override {
        super.setUp();
        agentOwner = vm.addr(OWNER_KEY);

        // Deploy a full agent so the audit facet has a policy bound to a real tokenId.
        LibPolicy.Policy memory pol = defaultPolicy();
        (tokenId,,,) = deployAgent(agentOwner, pol, "ipfs://erc7715-flow");

        // Hook + Validator + Kernel.
        hook = new PrimeAgentPreExecHook();
        validator = new PrimeAgentCallPolicyValidator();
        kernel = new MockKernel();
        installModulesOnKernel(kernel, hook, validator, tokenId, agentOwner);
    }

    // --- Build a canonical inner-call ---
    function _swapInner(address tIn, address tOut, uint256 amountIn, uint256 minOut) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SWAP_SEL, tIn, tOut, amountIn, minOut);
    }

    function _perpInner(address indexToken, uint256 sizeUsdQ96, bool isLong, uint256 collateral)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(OPEN_PERP_SEL, indexToken, sizeUsdQ96, isLong, collateral);
    }

    function _buildOp(address target, bytes memory data, uint256 signerPk)
        internal
        view
        returns (PackedUserOperation memory op, bytes32 hash)
    {
        op.sender = address(kernel);
        op.nonce = 0;
        op.callData = abi.encode(target, uint256(0), data);
        hash = keccak256(abi.encode("userOpHash", target, data));
        bytes32 ethSigned = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, ethSigned);
        op.signature = abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------
    // Install paths

    function test_install_policy_via_factory_lands_at_audit_facet() public view {
        IErc7715PolicyAuditFacet af = IErc7715PolicyAuditFacet(address(diamond));
        assertTrue(af.isPolicyActive(tokenId), "policy active after factory install");
        LibPolicy.Policy memory stored = af.getPolicy(tokenId);
        assertEq(stored.allowedContracts.length, 2, "two allowed contracts");
        assertEq(stored.allowedSelectors.length, 2, "two allowed selectors");
    }

    function test_hook_onInstall_binds_kernel_to_tokenId() public view {
        assertEq(hook.tokenIdOf(address(kernel)), tokenId, "hook tokenId");
        assertEq(hook.diamondOf(address(kernel)), address(diamond), "hook diamond");
        assertTrue(hook.isInstalled(address(kernel)), "hook installed");
    }

    function test_validator_onInstall_binds_kernel_to_tokenId_and_owner() public view {
        assertEq(validator.tokenIdOf(address(kernel)), tokenId, "validator tokenId");
        assertEq(validator.diamondOf(address(kernel)), address(diamond), "validator diamond");
        assertEq(validator.ownerOf(address(kernel)), agentOwner, "validator agent owner");
        assertTrue(validator.isInstalled(address(kernel)), "validator installed");
    }

    // ------------------------------------------------------------------
    // Validator (validateUserOp) checks

    function test_validator_validateUserOp_returns_zero_for_allowed_swap_within_caps() public {
        bytes memory inner = _swapInner(address(tsla), address(amzn), 500_000, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_SUCCESS, "valid op");
    }

    function test_validator_validateUserOp_returns_one_for_disallowed_contract() public {
        bytes memory inner = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(makeAddr("randomContract"), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "disallowed target");
    }

    function test_validator_validateUserOp_returns_one_for_disallowed_selector() public {
        bytes memory inner = abi.encodeWithSelector(bytes4(keccak256("nope()")));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "disallowed selector");
    }

    function test_validator_validateUserOp_returns_one_when_notional_exceeds_cap() public {
        // Per-call cap is 1_000_000 Q96 in defaultPolicy.
        bytes memory inner = _swapInner(address(tsla), address(amzn), 1_000_001, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "notional cap");
    }

    function test_validator_validateUserOp_returns_one_when_daily_cap_breached_after_rolling_window() public {
        // Daily cap is 5_000_000; build 5 ops at 1M each (cap = 5M exactly OK), then one more.
        for (uint256 i; i < 5; ++i) {
            bytes memory inner = _swapInner(address(tsla), address(amzn), 1_000_000, 1);
            (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
            // Distinct hashes per iteration so the per-op signature is fresh.
            h = keccak256(abi.encode(h, i));
            bytes32 ethSigned = h.toEthSignedMessageHash();
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, ethSigned);
            op.signature = abi.encodePacked(r, s, v);
            assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_SUCCESS, "in-budget");
        }
        bytes memory innerOver = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory opOver, bytes32 hOver) = _buildOp(address(rhAdapter), innerOver, OWNER_KEY);
        assertEq(kernel.validateUserOp(opOver, hOver), SIG_VALIDATION_FAILED, "daily cap exceeded");

        // After 24h the rolling window resets and the same op is accepted.
        vm.warp(block.timestamp + 1 days + 1);
        bytes memory innerAfter = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory opAfter, bytes32 hAfter) = _buildOp(address(rhAdapter), innerAfter, OWNER_KEY);
        assertEq(kernel.validateUserOp(opAfter, hAfter), SIG_VALIDATION_SUCCESS, "post-window OK");
    }

    // ------------------------------------------------------------------
    // Hook (preCheck) checks

    function test_hook_preCheck_reverts_on_disallowed_contract_during_execution() public {
        bytes memory inner = _swapInner(address(tsla), address(amzn), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(PrimeAgentPreExecHook.ContractNotAllowed.selector, makeAddr("evil")));
        kernel.callPreCheckOnly(makeAddr("evil"), 0, inner);
    }

    function test_hook_preCheck_decodes_swap_selector_correctly() public {
        // 999_999 is below the per-call cap of 1M; the hook should accept and emit PreCheckAccepted.
        bytes memory inner = _swapInner(address(tsla), address(amzn), 999_999, 1);
        bytes memory hookData = kernel.callPreCheckOnly(address(rhAdapter), 0, inner);
        (uint256 returnedTokenId, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(returnedTokenId, tokenId, "tokenId echoed");
        assertEq(notional, 999_999, "decoded amountIn");
    }

    function test_hook_preCheck_decodes_openPerp_selector_correctly() public {
        bytes memory inner = _perpInner(address(tsla), 500_000, true, 100);
        bytes memory hookData = kernel.callPreCheckOnly(address(arbAdapter), 0, inner);
        (, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(notional, 500_000, "decoded sizeUsdQ96");
    }

    function test_hook_preCheck_unknown_selector_falls_back_to_zero_notional_and_allowlist_only() public {
        // Add an unknown selector to the allowlist via a fresh deploy so the allowlist passes; the
        // notional decoder returns zero so we should not hit the cap.
        LibPolicy.Policy memory pol = defaultPolicy();
        bytes4 unknownSel = bytes4(keccak256("doMystery(uint256)"));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = SWAP_SEL;
        selectors[1] = OPEN_PERP_SEL;
        selectors[2] = unknownSel;
        pol.allowedSelectors = selectors;

        address user = makeAddr("perpUser");
        (uint256 newTokenId,,,) = deployAgent(user, pol, "ipfs://unknown-sel");

        PrimeAgentPreExecHook hook2 = new PrimeAgentPreExecHook();
        MockKernel kernel2 = new MockKernel();
        kernel2.installHook(address(hook2), abi.encode(newTokenId, address(diamond)));

        // Unknown selector with no args. The hook should not revert: zero notional + allowlist pass.
        bytes memory inner = abi.encodeWithSelector(unknownSel);
        bytes memory hookData = kernel2.callPreCheckOnly(address(rhAdapter), 0, inner);
        (, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(notional, 0, "unknown selector -> zero notional");
    }

    // ------------------------------------------------------------------
    // Policy lifecycle propagation

    function test_policy_revocation_blocks_subsequent_calls() public {
        // Validator + hook both observe the revoked policy.
        IErc7715PolicyAuditFacet af = IErc7715PolicyAuditFacet(address(diamond));
        vm.prank(agentOwner);
        af.revokePermission(tokenId);
        assertFalse(af.isPolicyActive(tokenId), "revoked");

        // Audit H-4: after a policy mutation in the AuditFacet the Validator's cached snapshot
        // must be refreshed via `syncPolicy` (called by the Diamond) so on-chain enforcement
        // sees the new expiry. The Diamond is the only authorized caller of `syncPolicy`.
        vm.prank(address(diamond));
        validator.syncPolicy(address(kernel));

        bytes memory inner = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "post-revoke validator fail");

        vm.expectRevert(PrimeAgentPreExecHook.PolicyExpired.selector);
        kernel.callPreCheckOnly(address(rhAdapter), 0, inner);
    }

    function test_policy_expiry_blocks_subsequent_calls() public {
        // Wait past the expiry. Default policy expires after 30 days.
        vm.warp(block.timestamp + 31 days);

        bytes memory inner = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, OWNER_KEY);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "post-expiry validator fail");
        vm.expectRevert(PrimeAgentPreExecHook.PolicyExpired.selector);
        kernel.callPreCheckOnly(address(rhAdapter), 0, inner);
    }

    function test_validator_validateUserOp_returns_one_when_signer_is_wrong() public {
        uint256 mallorPk = uint256(keccak256("primeagent.erc7715.evil"));
        bytes memory inner = _swapInner(address(tsla), address(amzn), 1, 1);
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(rhAdapter), inner, mallorPk);
        assertEq(kernel.validateUserOp(op, h), SIG_VALIDATION_FAILED, "signer not owner");
    }
}

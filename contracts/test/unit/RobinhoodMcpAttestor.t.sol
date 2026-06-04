// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {RobinhoodMcpAttestor} from "../../src/modules/RobinhoodMcpAttestor.sol";
import {IRobinhoodMcpAttestor} from "../../src/interfaces/IRobinhoodMcpAttestor.sol";

contract RobinhoodMcpAttestorTest is Test {
    RobinhoodMcpAttestor internal attestorContract;

    address internal owner = makeAddr("owner");
    uint256 internal attestorPk = 0xA77E5;
    address internal attestorEoa;
    uint256 internal mallPk = 0xB0B;

    bytes32 internal domainSeparator;
    bytes32 internal constant TYPEHASH = keccak256(
        "Attestation(uint256 tokenId,bytes32 payloadHash,uint64 notBefore,uint64 notAfter,bytes32 nullifier)"
    );

    function setUp() public {
        attestorEoa = vm.addr(attestorPk);
        attestorContract = new RobinhoodMcpAttestor(owner, attestorEoa);
        domainSeparator = attestorContract.domainSeparator();
    }

    function _digest(IRobinhoodMcpAttestor.AttestationPayload memory p) internal view returns (bytes32) {
        bytes32 payloadHash = keccak256(abi.encode(p.tokenId, p.accountValueQ96, p.buyingPowerQ96));
        bytes32 structHash = keccak256(
            abi.encode(TYPEHASH, p.tokenId, payloadHash, p.notBefore, p.notAfter, p.nullifier)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(IRobinhoodMcpAttestor.AttestationPayload memory p, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = _digest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _samplePayload() internal view returns (IRobinhoodMcpAttestor.AttestationPayload memory p) {
        p.tokenId = 7;
        p.accountValueQ96 = 1_000_000;
        p.buyingPowerQ96 = 500_000;
        p.notBefore = uint64(block.timestamp);
        p.notAfter = uint64(block.timestamp + 1 hours);
        p.nullifier = keccak256("nul1");
    }

    function test_attest_happy_path_updates_state() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, attestorPk);
        attestorContract.attest(p, sig);
        IRobinhoodMcpAttestor.OffChainState memory state = attestorContract.getOffChainState(p.tokenId);
        assertEq(state.accountValueQ96, p.accountValueQ96);
        assertEq(state.buyingPowerQ96, p.buyingPowerQ96);
        assertEq(state.notAfter, p.notAfter);
        assertEq(state.ts, uint64(block.timestamp));
        assertTrue(attestorContract.nullifiers(p.nullifier));
    }

    function test_attest_reverts_on_bad_signature() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, mallPk);
        vm.expectRevert(RobinhoodMcpAttestor.InvalidSignature.selector);
        attestorContract.attest(p, sig);
    }

    function test_attest_reverts_on_nullifier_reuse() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, attestorPk);
        attestorContract.attest(p, sig);
        vm.expectRevert(RobinhoodMcpAttestor.NullifierReused.selector);
        attestorContract.attest(p, sig);
    }

    function test_attest_reverts_on_stale_timestamp() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.warp(p.notAfter + 1);
        vm.expectRevert(RobinhoodMcpAttestor.AttestationStale.selector);
        attestorContract.attest(p, sig);
    }

    function test_attest_reverts_on_fresh_timestamp() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        p.notBefore = uint64(block.timestamp + 1 hours);
        p.notAfter = uint64(block.timestamp + 2 hours);
        bytes memory sig = _sign(p, attestorPk);
        vm.expectRevert(RobinhoodMcpAttestor.AttestationFresh.selector);
        attestorContract.attest(p, sig);
    }

    function test_getOffChainState_reverts_on_stale_state() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, attestorPk);
        attestorContract.attest(p, sig);
        vm.warp(p.notAfter + 1);
        vm.expectRevert(RobinhoodMcpAttestor.StateStale.selector);
        attestorContract.getOffChainState(p.tokenId);
    }

    function test_getOffChainState_reverts_when_state_not_set() public {
        vm.expectRevert(RobinhoodMcpAttestor.StateNotSet.selector);
        attestorContract.getOffChainState(99);
    }

    function test_getRawOffChainState_returns_stale_state() public {
        IRobinhoodMcpAttestor.AttestationPayload memory p = _samplePayload();
        bytes memory sig = _sign(p, attestorPk);
        attestorContract.attest(p, sig);
        vm.warp(p.notAfter + 1);
        IRobinhoodMcpAttestor.OffChainState memory s = attestorContract.getRawOffChainState(p.tokenId);
        assertEq(s.accountValueQ96, p.accountValueQ96);
    }

    function test_proposeAttestor_and_execute_after_timelock() public {
        address newAtt = makeAddr("newAttestor");
        vm.prank(owner);
        attestorContract.proposeAttestor(newAtt);
        // Cannot execute before timelock.
        vm.expectRevert(RobinhoodMcpAttestor.TimelockNotElapsed.selector);
        vm.prank(owner);
        attestorContract.executeAttestor(newAtt);
        // Warp past timelock.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(owner);
        attestorContract.executeAttestor(newAtt);
        assertEq(attestorContract.attestor(), newAtt);
    }

    function test_executeAttestor_reverts_on_mismatch() public {
        address newAtt = makeAddr("newAttestor");
        vm.prank(owner);
        attestorContract.proposeAttestor(newAtt);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert(RobinhoodMcpAttestor.PendingMismatch.selector);
        vm.prank(owner);
        attestorContract.executeAttestor(makeAddr("other"));
    }

    function test_executeAttestor_reverts_without_pending() public {
        vm.expectRevert(RobinhoodMcpAttestor.NoPending.selector);
        vm.prank(owner);
        attestorContract.executeAttestor(makeAddr("any"));
    }

    function test_proposeAttestor_only_owner() public {
        vm.expectRevert();
        attestorContract.proposeAttestor(makeAddr("x"));
    }

    // ---- M-2 regression: overwriting a pending proposal emits a distinct event ----

    /// @notice Audit M-2: `proposeAttestor` overwriting a prior pending change must surface
    ///         `AttestorChangeOverwritten(prevSigner, newSigner, prevEffectiveAt)` so
    ///         monitoring that watches only the standard event pair still detects the silent
    ///         timelock reset.
    function test_proposeAttestor_overwrite_emits_AttestorChangeOverwritten() public {
        address firstCandidate = makeAddr("firstCandidate");
        address secondCandidate = makeAddr("secondCandidate");
        vm.prank(owner);
        attestorContract.proposeAttestor(firstCandidate);
        uint64 firstEffectiveAt = uint64(block.timestamp + attestorContract.ROTATION_TIMELOCK());

        // The overwrite must emit the new event.
        vm.expectEmit(true, true, false, true, address(attestorContract));
        emit IRobinhoodMcpAttestor.AttestorChangeOverwritten(firstCandidate, secondCandidate, firstEffectiveAt);
        vm.prank(owner);
        attestorContract.proposeAttestor(secondCandidate);
    }

    /// @notice The first proposal must NOT emit the overwrite event (no prior pending).
    function test_proposeAttestor_first_proposal_does_not_emit_overwrite() public {
        address candidate = makeAddr("candidate");
        vm.recordLogs();
        vm.prank(owner);
        attestorContract.proposeAttestor(candidate);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 overwriteTopic = keccak256("AttestorChangeOverwritten(address,address,uint64)");
        for (uint256 i; i < entries.length; ++i) {
            assertNotEq(entries[i].topics[0], overwriteTopic, "first proposal should not log overwrite");
        }
    }

    function test_eip712_domain_matches_backend_expectations() public view {
        // Domain seed: name = "PrimeAgent.RobinhoodMcpAttestor", version = "1". Rebuild the
        // separator off-chain and verify it matches the on-chain value.
        bytes32 typeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 expected = keccak256(
            abi.encode(
                typeHash,
                keccak256(bytes("PrimeAgent.RobinhoodMcpAttestor")),
                keccak256(bytes("1")),
                block.chainid,
                address(attestorContract)
            )
        );
        assertEq(attestorContract.domainSeparator(), expected, "domain separator must match");
    }
}

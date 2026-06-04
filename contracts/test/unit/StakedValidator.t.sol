// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {StakedValidator} from "../../src/validation/StakedValidator.sol";
import {IStakedValidator} from "../../src/interfaces/IStakedValidator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract StakedValidatorTest is Test {
    StakedValidator internal sv;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant MIN_STAKE = 100 * 10 ** 6;

    bytes32 internal attHash = keccak256("attestation-1");
    bytes32 internal attHash2 = keccak256("attestation-2");

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        sv = new StakedValidator(owner, address(usdc));

        usdc.mint(alice, MIN_STAKE * 10);
        usdc.mint(bob, MIN_STAKE * 10);
        usdc.mint(carol, MIN_STAKE * 10);

        vm.prank(alice);
        usdc.approve(address(sv), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(sv), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(sv), type(uint256).max);
    }

    // --- Staking ---
    function test_stake_pulls_tokens_and_credits_balance() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        assertEq(sv.stakeOf(alice), MIN_STAKE);
        assertEq(usdc.balanceOf(address(sv)), MIN_STAKE);
    }

    function test_stake_reverts_on_zero() public {
        vm.expectRevert(StakedValidator.ZeroAmount.selector);
        vm.prank(alice);
        sv.stake(0);
    }

    function test_isStaker_true_at_min_stake() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        assertTrue(sv.isStaker(alice));
    }

    // --- validateAttestation ---
    function test_validateAttestation_locks_min_stake() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        assertEq(sv.lockedStakeOf(alice), MIN_STAKE);
        IStakedValidator.Attestation memory a = sv.getAttestation(attHash, alice);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.Validated));
    }

    function test_validateAttestation_reverts_without_stake() public {
        vm.expectRevert(StakedValidator.InsufficientStake.selector);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
    }

    function test_validateAttestation_reverts_double_validate_same_hash() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE * 2);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.expectRevert(StakedValidator.AttestationAlreadyValidated.selector);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
    }

    // --- challenge ---
    function test_challenge_within_window_transitions_status() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");

        vm.prank(bob);
        sv.challenge(attHash, alice, "");
        IStakedValidator.Attestation memory a = sv.getAttestation(attHash, alice);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.Challenged));
        assertEq(a.challenger, bob);
        assertEq(sv.pendingChallengesOf(alice), 1);
    }

    function test_challenge_reverts_after_window() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(StakedValidator.ChallengeWindowExpired.selector);
        vm.prank(bob);
        sv.challenge(attHash, alice, "");
    }

    function test_challenge_reverts_when_not_validated() public {
        vm.expectRevert(StakedValidator.AttestationNotValidated.selector);
        vm.prank(bob);
        sv.challenge(attHash, alice, "");
    }

    // --- adjudicate ---
    function test_adjudicate_slash_transfers_to_challenger() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.prank(bob);
        sv.challenge(attHash, alice, "");

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(owner);
        sv.adjudicate(attHash, alice, true);
        assertEq(usdc.balanceOf(bob), bobBefore + MIN_STAKE);
        assertEq(sv.stakeOf(alice), 0);
        assertEq(sv.lockedStakeOf(alice), 0);
        assertEq(sv.pendingChallengesOf(alice), 0);
        IStakedValidator.Attestation memory a = sv.getAttestation(attHash, alice);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.ResolvedSlashed));
    }

    function test_adjudicate_honest_unlocks_validator_stake() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.prank(bob);
        sv.challenge(attHash, alice, "");

        vm.prank(owner);
        sv.adjudicate(attHash, alice, false);
        assertEq(sv.stakeOf(alice), MIN_STAKE);
        assertEq(sv.lockedStakeOf(alice), 0);
        assertEq(sv.pendingChallengesOf(alice), 0);
    }

    function test_adjudicate_only_owner() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.prank(bob);
        sv.challenge(attHash, alice, "");

        vm.expectRevert();
        vm.prank(carol);
        sv.adjudicate(attHash, alice, false);
    }

    // --- withdraw ---
    function test_withdraw_blocked_when_pending_challenge() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE * 2);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.prank(bob);
        sv.challenge(attHash, alice, "");

        vm.expectRevert(StakedValidator.PendingChallenge.selector);
        vm.prank(alice);
        sv.withdraw(MIN_STAKE);
    }

    function test_withdraw_allowed_after_adjudication_honest() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE * 2);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        vm.prank(bob);
        sv.challenge(attHash, alice, "");
        vm.prank(owner);
        sv.adjudicate(attHash, alice, false);

        // Now alice can withdraw all stake.
        vm.prank(alice);
        sv.withdraw(MIN_STAKE * 2);
        assertEq(sv.stakeOf(alice), 0);
    }

    function test_withdraw_reverts_when_exceeds_free_stake() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE);
        vm.prank(alice);
        sv.validateAttestation(attHash, "");

        // The MIN_STAKE is locked behind the attestation; no free stake to withdraw.
        vm.expectRevert(StakedValidator.WithdrawExceedsFreeStake.selector);
        vm.prank(alice);
        sv.withdraw(1);
    }

    // ---- H-6 regression: concurrent validations + slash does not underflow ----
    /// @notice Audit H-6 regression. The validator stakes `MIN_STAKE * 3` and runs three
    ///         concurrent attestations, then the owner slashes ONE of them. The slash MUST
    ///         only reduce `stakeOf` and `lockedStakeOf` by exactly `MIN_STAKE`, leaving the
    ///         two remaining attestations untouched and the invariant `stake >= locked` intact.
    function test_concurrent_validations_and_slash_does_not_underflow() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE * 3);

        bytes32 h1 = keccak256("att.A");
        bytes32 h2 = keccak256("att.B");
        bytes32 h3 = keccak256("att.C");

        vm.startPrank(alice);
        sv.validateAttestation(h1, "");
        sv.validateAttestation(h2, "");
        sv.validateAttestation(h3, "");
        vm.stopPrank();

        // All three attestations are locked; stake and lock are equal at the cap.
        assertEq(sv.stakeOf(alice), MIN_STAKE * 3, "stake total");
        assertEq(sv.lockedStakeOf(alice), MIN_STAKE * 3, "locked total");

        // Bob challenges only h2.
        vm.prank(bob);
        sv.challenge(h2, alice, "");

        // Owner slashes the challenged attestation.
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(owner);
        sv.adjudicate(h2, alice, true);

        // Only one MIN_STAKE drained from each counter; the other two are intact.
        assertEq(sv.stakeOf(alice), MIN_STAKE * 2, "stake after slash");
        assertEq(sv.lockedStakeOf(alice), MIN_STAKE * 2, "locked after slash");
        assertEq(usdc.balanceOf(bob), bobBefore + MIN_STAKE, "bob received slash");
        // Invariant: stake >= locked.
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice), "stake >= locked invariant");
    }

    /// @notice Audit H-6 regression. After every state-mutating function (stake, validate,
    ///         challenge, adjudicate-honest, adjudicate-slash) the invariant
    ///         `stakeOf >= lockedStakeOf` MUST hold.
    function test_invariant_stake_gte_locked_through_full_lifecycle() public {
        vm.prank(alice);
        sv.stake(MIN_STAKE * 2);
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(alice);
        sv.validateAttestation(attHash, "");
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(alice);
        sv.validateAttestation(attHash2, "");
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(bob);
        sv.challenge(attHash, alice, "");
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(owner);
        sv.adjudicate(attHash, alice, false); // honest
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(bob);
        sv.challenge(attHash2, alice, "");
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));

        vm.prank(owner);
        sv.adjudicate(attHash2, alice, true); // slash
        assertGe(sv.stakeOf(alice), sv.lockedStakeOf(alice));
    }
}

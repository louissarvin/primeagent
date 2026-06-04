// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Fixtures} from "./Fixtures.sol";
import {StakedValidator} from "../../src/validation/StakedValidator.sol";
import {IStakedValidator} from "../../src/interfaces/IStakedValidator.sol";

/// @title StakedValidatorChallenge
/// @notice End-to-end stake / validate / challenge / adjudicate / withdraw cycle for the FIP1
///         stake stub. The validator's adjudication is performed by the protocol owner in v1;
///         the path to decentralized adjudication is documented and out of scope.
contract StakedValidatorChallengeTest is Fixtures {
    address internal validatorEoa;
    address internal challenger;
    address internal honestPath;

    bytes32 internal constant ATT_HASH = keccak256("primeagent.staked.attestation-1");
    bytes32 internal constant ATT_HASH_2 = keccak256("primeagent.staked.attestation-2");

    uint256 internal constant MIN_STAKE_AMOUNT = 100 * 10 ** 6;

    function setUp() public override {
        super.setUp();
        validatorEoa = makeAddr("validator");
        challenger = makeAddr("challenger");
        honestPath = makeAddr("honestPath");

        usdc.mint(validatorEoa, MIN_STAKE_AMOUNT * 10);
        usdc.mint(challenger, MIN_STAKE_AMOUNT * 10);
        usdc.mint(honestPath, MIN_STAKE_AMOUNT * 10);

        vm.prank(validatorEoa);
        usdc.approve(address(stakedValidator), type(uint256).max);
        vm.prank(challenger);
        usdc.approve(address(stakedValidator), type(uint256).max);
        vm.prank(honestPath);
        usdc.approve(address(stakedValidator), type(uint256).max);
    }

    function test_stake_then_validateAttestation_locks_stake() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");
        assertEq(stakedValidator.lockedStakeOf(validatorEoa), MIN_STAKE_AMOUNT, "locked stake");
        IStakedValidator.Attestation memory a = stakedValidator.getAttestation(ATT_HASH, validatorEoa);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.Validated), "status validated");
    }

    function test_challenge_within_window_triggers_pending_state() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");

        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH, validatorEoa, "");
        IStakedValidator.Attestation memory a = stakedValidator.getAttestation(ATT_HASH, validatorEoa);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.Challenged), "status challenged");
        assertEq(a.challenger, challenger, "challenger recorded");
        assertEq(stakedValidator.pendingChallengesOf(validatorEoa), 1, "pending challenge counter");
    }

    function test_owner_adjudicates_in_favor_of_challenger_slashes_validator() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");
        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH, validatorEoa, "");

        uint256 challengerBefore = usdc.balanceOf(challenger);
        vm.prank(owner);
        stakedValidator.adjudicate(ATT_HASH, validatorEoa, true);

        assertEq(usdc.balanceOf(challenger), challengerBefore + MIN_STAKE_AMOUNT, "challenger paid");
        assertEq(stakedValidator.stakeOf(validatorEoa), 0, "validator slashed");
        assertEq(stakedValidator.lockedStakeOf(validatorEoa), 0, "locked stake zeroed");
        assertEq(stakedValidator.pendingChallengesOf(validatorEoa), 0, "challenge resolved");
    }

    function test_owner_adjudicates_in_favor_of_validator_returns_locked_stake() public {
        vm.prank(honestPath);
        stakedValidator.stake(MIN_STAKE_AMOUNT);
        vm.prank(honestPath);
        stakedValidator.validateAttestation(ATT_HASH_2, "");
        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH_2, honestPath, "");

        vm.prank(owner);
        stakedValidator.adjudicate(ATT_HASH_2, honestPath, false);

        assertEq(stakedValidator.stakeOf(honestPath), MIN_STAKE_AMOUNT, "stake preserved");
        assertEq(stakedValidator.lockedStakeOf(honestPath), 0, "lock released");
        IStakedValidator.Attestation memory a = stakedValidator.getAttestation(ATT_HASH_2, honestPath);
        assertEq(uint256(a.status), uint256(IStakedValidator.AttestationStatus.ResolvedHonest), "honest path");
    }

    function test_challenge_after_24h_window_reverts() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(StakedValidator.ChallengeWindowExpired.selector);
        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH, validatorEoa, "");
    }

    function test_withdraw_blocked_while_challenge_pending() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT * 2);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");
        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH, validatorEoa, "");

        vm.expectRevert(StakedValidator.PendingChallenge.selector);
        vm.prank(validatorEoa);
        stakedValidator.withdraw(MIN_STAKE_AMOUNT);
    }

    function test_withdraw_succeeds_after_challenge_resolved() public {
        vm.prank(validatorEoa);
        stakedValidator.stake(MIN_STAKE_AMOUNT * 2);
        vm.prank(validatorEoa);
        stakedValidator.validateAttestation(ATT_HASH, "");
        vm.prank(challenger);
        stakedValidator.challenge(ATT_HASH, validatorEoa, "");
        vm.prank(owner);
        stakedValidator.adjudicate(ATT_HASH, validatorEoa, false);

        // Now alice can withdraw the full free + previously-locked stake.
        vm.prank(validatorEoa);
        stakedValidator.withdraw(MIN_STAKE_AMOUNT * 2);
        assertEq(stakedValidator.stakeOf(validatorEoa), 0, "fully withdrawn");
    }
}

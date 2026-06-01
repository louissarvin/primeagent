// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStakedValidator} from "../interfaces/IStakedValidator.sol";

contract StakedValidator is Ownable2Step, ReentrancyGuardTransient, IStakedValidator {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake();
    error NotStaker();
    error AttestationAlreadyValidated();
    error AttestationNotValidated();
    error AttestationAlreadyChallenged();
    error AttestationAlreadyResolved();
    error ChallengeWindowExpired();
    error PendingChallenge();
    error WithdrawExceedsFreeStake();
    error InvariantViolated();

    uint256 public constant MIN_STAKE = 100 * 10 ** 6;
    uint256 public constant CHALLENGE_WINDOW = 24 hours;

    IERC20 public immutable baseAsset;

    mapping(address staker => uint256) public stakeOf;
    mapping(address staker => uint256) public lockedStakeOf;
    mapping(bytes32 attestationHash => mapping(address validator => Attestation)) internal _attestations;
    mapping(address staker => uint256) public pendingChallengesOf;

    constructor(address owner_, address baseAsset_) Ownable(owner_) {
        if (owner_ == address(0) || baseAsset_ == address(0)) revert ZeroAddress();
        baseAsset = IERC20(baseAsset_);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 newTotal = stakeOf[msg.sender] + amount;
        stakeOf[msg.sender] = newTotal;
        baseAsset.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, newTotal);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (pendingChallengesOf[msg.sender] != 0) revert PendingChallenge();
        uint256 total = stakeOf[msg.sender];
        uint256 locked = lockedStakeOf[msg.sender];
        if (amount > total - locked) revert WithdrawExceedsFreeStake();
        uint256 newTotal = total - amount;
        stakeOf[msg.sender] = newTotal;
        baseAsset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, newTotal);
    }

    function validateAttestation(bytes32 attestationHash, bytes calldata /* evidence */ ) external {
        if (stakeOf[msg.sender] - lockedStakeOf[msg.sender] < MIN_STAKE) revert InsufficientStake();
        Attestation storage a = _attestations[attestationHash][msg.sender];
        if (a.status != AttestationStatus.None) revert AttestationAlreadyValidated();
        a.validator = msg.sender;
        a.validatedAt = uint64(block.timestamp);
        a.status = AttestationStatus.Validated;
        a.attestationHash = attestationHash;
        lockedStakeOf[msg.sender] += MIN_STAKE;
        emit ValidatedAttestation(attestationHash, msg.sender);
    }

    function challenge(
        bytes32 attestationHash,
        address validator,
        bytes calldata /* counterEvidence */
    )
        external
    {
        Attestation storage a = _attestations[attestationHash][validator];
        if (a.status != AttestationStatus.Validated) revert AttestationNotValidated();
        if (uint64(block.timestamp) > a.validatedAt + CHALLENGE_WINDOW) revert ChallengeWindowExpired();
        a.status = AttestationStatus.Challenged;
        a.challenger = msg.sender;
        a.challengedAt = uint64(block.timestamp);
        pendingChallengesOf[validator] += 1;
        emit Challenged(attestationHash, msg.sender);
    }

    function adjudicate(
        bytes32 attestationHash,
        address validator,
        bool challengeSucceeded
    )
        external
        onlyOwner
        nonReentrant
    {
        Attestation storage a = _attestations[attestationHash][validator];
        if (a.status != AttestationStatus.Challenged) revert AttestationAlreadyResolved();
        address challenger = a.challenger;

        uint256 lockedNow = lockedStakeOf[validator];
        uint256 unlockAmt = Math.min(lockedNow, MIN_STAKE);
        lockedStakeOf[validator] = lockedNow - unlockAmt;

        if (challengeSucceeded) {
            uint256 totalNow = stakeOf[validator];
            uint256 slashAmt = Math.min(totalNow, MIN_STAKE);
            stakeOf[validator] = totalNow - slashAmt;
            a.status = AttestationStatus.ResolvedSlashed;
            pendingChallengesOf[validator] -= 1;
            if (slashAmt != 0) {
                baseAsset.safeTransfer(challenger, slashAmt);
            }
        } else {
            a.status = AttestationStatus.ResolvedHonest;
            pendingChallengesOf[validator] -= 1;
        }

        if (stakeOf[validator] < lockedStakeOf[validator]) revert InvariantViolated();

        emit Adjudicated(attestationHash, validator, challengeSucceeded);
    }

    function isStaker(address account) external view returns (bool) {
        return stakeOf[account] >= MIN_STAKE;
    }

    function getAttestation(
        bytes32 attestationHash,
        address validator
    )
        external
        view
        returns (Attestation memory)
    {
        return _attestations[attestationHash][validator];
    }
}

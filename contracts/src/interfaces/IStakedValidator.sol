// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IStakedValidator {
    enum AttestationStatus {
        None,
        Validated,
        Challenged,
        ResolvedHonest,
        ResolvedSlashed
    }

    struct Attestation {
        address validator;
        address challenger;
        uint64 validatedAt;
        uint64 challengedAt;
        AttestationStatus status;
        bytes32 attestationHash;
    }

    event Staked(address indexed staker, uint256 amount, uint256 newTotal);
    event Withdrawn(address indexed staker, uint256 amount, uint256 newTotal);
    event ValidatedAttestation(bytes32 indexed attestationHash, address indexed validator);
    event Challenged(bytes32 indexed attestationHash, address indexed challenger);
    event Adjudicated(bytes32 indexed attestationHash, address indexed validator, bool challengeSucceeded);

    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function validateAttestation(bytes32 attestationHash, bytes calldata evidence) external;
    function challenge(bytes32 attestationHash, address validator, bytes calldata counterEvidence) external;
    function adjudicate(bytes32 attestationHash, address validator, bool challengeSucceeded) external;

    function stakeOf(address staker) external view returns (uint256);
    function isStaker(address account) external view returns (bool);
    function getAttestation(bytes32 attestationHash, address validator) external view returns (Attestation memory);
    function pendingChallengesOf(address staker) external view returns (uint256);
    function MIN_STAKE() external view returns (uint256);
    function CHALLENGE_WINDOW() external view returns (uint256);
}

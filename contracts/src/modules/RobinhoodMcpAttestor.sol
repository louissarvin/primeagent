// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IRobinhoodMcpAttestor} from "../interfaces/IRobinhoodMcpAttestor.sol";

contract RobinhoodMcpAttestor is Ownable2Step, EIP712, IRobinhoodMcpAttestor {
    error AttestationStale();
    error AttestationFresh();
    error NullifierReused();
    error InvalidSignature();
    error StateStale();
    error TimelockNotElapsed();
    error PendingMismatch();
    error NoPending();
    error ZeroAddress();
    error StateNotSet();

    struct PendingAttestor {
        address signer;
        uint64 effectiveAt;
        bool exists;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 tokenId,bytes32 payloadHash,uint64 notBefore,uint64 notAfter,bytes32 nullifier)"
    );
    uint256 public constant ROTATION_TIMELOCK = 48 hours;

    PendingAttestor public pendingAttestor;
    address public attestor;

    mapping(bytes32 nullifier => bool consumed) public nullifiers;
    mapping(uint256 tokenId => OffChainState state) internal _currentState;

    constructor(
        address owner_,
        address attestor_
    )
        Ownable(owner_)
        EIP712("PrimeAgent.RobinhoodMcpAttestor", "1")
    {
        if (owner_ == address(0) || attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorChanged(address(0), attestor_);
    }

    function attest(AttestationPayload calldata p, bytes calldata sig) external {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < p.notBefore) revert AttestationFresh();
        if (nowTs > p.notAfter) revert AttestationStale();

        if (nullifiers[p.nullifier]) revert NullifierReused();

        bytes32 payloadHash = keccak256(abi.encode(p.tokenId, p.accountValueQ96, p.buyingPowerQ96));
        bytes32 structHash =
            keccak256(abi.encode(ATTESTATION_TYPEHASH, p.tokenId, payloadHash, p.notBefore, p.notAfter, p.nullifier));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, sig);
        if (signer == address(0) || signer != attestor) revert InvalidSignature();

        nullifiers[p.nullifier] = true;
        _currentState[p.tokenId] = OffChainState({
            accountValueQ96: p.accountValueQ96,
            buyingPowerQ96: p.buyingPowerQ96,
            notAfter: p.notAfter,
            ts: nowTs,
            lastAttestationHash: payloadHash
        });

        emit StateAttested(p.tokenId, p.nullifier, p.accountValueQ96, p.buyingPowerQ96, nowTs);
    }

    function getOffChainState(uint256 tokenId) external view returns (OffChainState memory) {
        OffChainState memory s = _currentState[tokenId];
        // Sentinel check: s.ts == 0 means the struct was never populated by attest().
        // Once attest() runs, s.ts is set to block.timestamp (always non-zero).
        // slither-disable-next-line incorrect-equality
        if (s.ts == 0) revert StateNotSet();
        if (uint64(block.timestamp) > s.notAfter) revert StateStale();
        return s;
    }

    function getRawOffChainState(uint256 tokenId) external view returns (OffChainState memory) {
        return _currentState[tokenId];
    }

    function proposeAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        PendingAttestor memory prior = pendingAttestor;
        uint64 effectiveAt = uint64(block.timestamp + ROTATION_TIMELOCK);
        if (prior.exists) {
            emit AttestorChangeOverwritten(prior.signer, newAttestor, prior.effectiveAt);
        }
        pendingAttestor = PendingAttestor({signer: newAttestor, effectiveAt: effectiveAt, exists: true});
        emit AttestorChangeProposed(newAttestor, effectiveAt);
    }

    function executeAttestor(address newAttestor) external onlyOwner {
        PendingAttestor memory pending = pendingAttestor;
        if (!pending.exists) revert NoPending();
        if (pending.signer != newAttestor) revert PendingMismatch();
        if (uint64(block.timestamp) < pending.effectiveAt) revert TimelockNotElapsed();
        address old = attestor;
        attestor = newAttestor;
        delete pendingAttestor;
        emit AttestorChanged(old, newAttestor);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}

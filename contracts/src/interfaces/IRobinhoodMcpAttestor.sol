// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IRobinhoodMcpAttestor {
    struct OffChainState {
        uint256 accountValueQ96;
        uint256 buyingPowerQ96;
        uint64 notAfter;
        uint64 ts;
        bytes32 lastAttestationHash;
    }

    struct AttestationPayload {
        uint256 tokenId;
        uint256 accountValueQ96;
        uint256 buyingPowerQ96;
        uint64 notBefore;
        uint64 notAfter;
        bytes32 nullifier;
    }

    event StateAttested(
        uint256 indexed tokenId, bytes32 indexed nullifier, uint256 accountValueQ96, uint256 buyingPowerQ96, uint64 ts
    );
    event AttestorChangeProposed(address indexed newAttestor, uint64 effectiveAt);
    event AttestorChanged(address indexed oldAttestor, address indexed newAttestor);
    event AttestorChangeOverwritten(address indexed previousSigner, address indexed newSigner, uint64 previousEffectiveAt);

    function attest(AttestationPayload calldata p, bytes calldata sig) external;

    function getOffChainState(uint256 tokenId) external view returns (OffChainState memory);
    function attestor() external view returns (address);
    function nullifiers(bytes32 nullifier) external view returns (bool);

    function proposeAttestor(address newAttestor) external;
    function executeAttestor(address newAttestor) external;
}

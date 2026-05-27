// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LibPolicy} from "../libraries/LibPolicy.sol";

interface IErc7715PolicyAuditFacet {
    // --- Legacy events (kept verbatim for indexer back-compat) ---
    event PolicyInstalled(uint256 indexed tokenId, bytes32 indexed permissionContextHash, uint64 expiresAt);
    event PolicyRevoked(uint256 indexed tokenId);
    event AuditFacetInitialized(address indexed factory, address indexed positionNFT);
    event PolicyUpdated(uint256 indexed tokenId, bytes32 indexed permissionContextHash, uint64 expiresAt);

    // --- Feature C / Option B V2 events (carry the canonical presetHash) ---
    event PolicyInstalledV2(
        uint256 indexed tokenId, bytes32 indexed permissionContextHash, uint64 expiresAt, bytes32 indexed presetHash
    );
    event PolicyUpdatedV2(
        uint256 indexed tokenId, bytes32 indexed permissionContextHash, uint64 expiresAt, bytes32 indexed presetHash
    );

    // --- Legacy entry points (preserved selectors) ---
    function installPermission(uint256 tokenId, LibPolicy.LegacyPolicy calldata p) external;
    function updatePermission(uint256 tokenId, LibPolicy.LegacyPolicy calldata p) external;

    // --- Feature C V2 entry points (carry presetHash inside the struct) ---
    function installPermissionV2(uint256 tokenId, LibPolicy.Policy calldata p) external;
    function updatePermissionV2(uint256 tokenId, LibPolicy.Policy calldata p) external;

    function revokePermission(uint256 tokenId) external;
    function initAudit(address factory_, address positionNFT_) external;
    function getPolicy(uint256 tokenId) external view returns (LibPolicy.Policy memory);
    function permissionContextHash(uint256 tokenId) external view returns (bytes32);
    function getPresetHash(uint256 tokenId) external view returns (bytes32);
    function isPolicyActive(uint256 tokenId) external view returns (bool);
    function auditFactory() external view returns (address);
    function auditPositionNFT() external view returns (address);
}

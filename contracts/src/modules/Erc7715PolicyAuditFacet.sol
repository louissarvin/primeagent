// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {LibPolicy} from "../libraries/LibPolicy.sol";
import {LibRiskPresets} from "../libraries/LibRiskPresets.sol";
import {IErc7715PolicyAuditFacet} from "../interfaces/IErc7715PolicyAuditFacet.sol";

/// @title Erc7715PolicyAuditFacet
/// @notice Diamond facet that records the ERC-7715 permission grant for each PositionNFT.
///         Read by `PrimeAgentPreExecHook` (per-call enforcement) and the off-chain indexer.
///
/// @dev    Storage layout. The facet keeps its own per-slot keyspace (`AuditStorage`) keyed
///         off `keccak256("primeagent.audit.storage")`. After Feature C / Option B, the
///         `LibPolicy.Policy` storage struct grows one extra slot at the end (`presetHash`).
///         Solidity assigns the new field a fresh storage slot AFTER all existing slots,
///         so policies installed before the cut continue to read back correctly with the
///         new field defaulting to `bytes32(0)` (i.e. `LibRiskPresets.PRESET_CUSTOM`).
///         IMPORTANT: field order in `LibPolicy.Policy` MUST NOT change once any cut binds
///         this layout; only append-at-end is storage-safe across future upgrades.
///
/// @dev    Backwards compatibility for callers.
///         The OLD selectors are preserved by exposing the legacy entry points under their
///         original calldata shape (`LibPolicy.LegacyPolicy`). New callers SHOULD use the
///         `*V2` overloads to bind a `presetHash`. The legacy paths default the field to
///         `bytes32(0)` and emit the legacy `PolicyInstalled` / `PolicyUpdated` events;
///         the V2 paths additionally emit `PolicyInstalledV2` / `PolicyUpdatedV2` carrying
///         the preset hash so the indexer can certify each grant against
///         `LibRiskPresets.canonicalHashes`.
///
/// @dev    Atomic policy rotation (Feature B). The facet does NOT need a dedicated
///         "rotate" entry point: the operator's Kernel `executeBatch` calls
///         `revokePermission(tokenId)` followed by `installPermission*` in the same userOp,
///         which is atomic at the ERC-4337 layer (one userOp either applies both writes or
///         neither). No on-chain change is required to support that flow.
contract Erc7715PolicyAuditFacet is IErc7715PolicyAuditFacet {
    error AlreadyInitialized();
    error NotInitialized();
    error Unauthorized();
    error PolicyAlreadyInstalled();
    error PolicyNotFound();
    error AlreadyRevoked();
    error TokenIdMismatch();
    error InvalidPresetHash();

    struct AuditStorage {
        mapping(uint256 tokenId => LibPolicy.Policy) policies;
        mapping(uint256 tokenId => bool) installed;
        address factory;
        address positionNFT;
    }

    bytes32 internal constant AUDIT_STORAGE_POSITION = keccak256("primeagent.audit.storage");

    function _s() internal pure returns (AuditStorage storage s) {
        bytes32 slot = AUDIT_STORAGE_POSITION;
        assembly {
            s.slot := slot
        }
    }

    function initAudit(address factory_, address positionNFT_) external {
        AuditStorage storage s = _s();
        if (s.factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0) || positionNFT_ == address(0)) revert Unauthorized();
        s.factory = factory_;
        s.positionNFT = positionNFT_;
        emit AuditFacetInitialized(factory_, positionNFT_);
    }

    // --- Install ---

    /// @notice Legacy install entry point. Preserved verbatim for callers that have not
    ///         migrated to the V2 ABI. Stores `presetHash = bytes32(0)` (custom policy).
    function installPermission(uint256 tokenId, LibPolicy.LegacyPolicy calldata p) external {
        _installInternal(
            tokenId,
            p.permissionContextHash,
            p.maxNotionalUsdQ96,
            p.dailyCapUsdQ96,
            p.expiresAt,
            p.issuedAt,
            p.dailySpentUsdQ96Slot,
            p.dailyWindowStart,
            p.allowedContracts,
            p.allowedSelectors,
            LibRiskPresets.PRESET_CUSTOM,
            p.tokenId,
            false
        );
    }

    /// @notice V2 install entry point. The `presetHash` field on the calldata struct is
    ///         stored alongside the policy and emitted in `PolicyInstalledV2` so the
    ///         indexer can certify the grant against `LibRiskPresets.canonicalHashes`.
    /// @dev    Reverts with `InvalidPresetHash` if the hash is non-zero and not one of the
    ///         5 canonical preset hashes. `bytes32(0)` (custom) is always accepted.
    function installPermissionV2(uint256 tokenId, LibPolicy.Policy calldata p) external {
        _installInternal(
            tokenId,
            p.permissionContextHash,
            p.maxNotionalUsdQ96,
            p.dailyCapUsdQ96,
            p.expiresAt,
            p.issuedAt,
            p.dailySpentUsdQ96Slot,
            p.dailyWindowStart,
            p.allowedContracts,
            p.allowedSelectors,
            p.presetHash,
            p.tokenId,
            true
        );
    }

    // --- Update ---

    /// @notice Legacy update entry point. Preserved for callers that have not migrated to
    ///         the V2 ABI. Clears + replaces the allowlists and resets `presetHash` to
    ///         `bytes32(0)`. NFT-owner gated.
    function updatePermission(uint256 tokenId, LibPolicy.LegacyPolicy calldata p) external {
        _updateInternal(
            tokenId,
            p.permissionContextHash,
            p.maxNotionalUsdQ96,
            p.dailyCapUsdQ96,
            p.expiresAt,
            p.issuedAt,
            p.dailySpentUsdQ96Slot,
            p.dailyWindowStart,
            p.allowedContracts,
            p.allowedSelectors,
            LibRiskPresets.PRESET_CUSTOM,
            p.tokenId,
            false
        );
    }

    /// @notice V2 update entry point. Emits `PolicyUpdatedV2` carrying the new preset hash.
    /// @dev    Same access control as the legacy path: only the NFT owner can rotate.
    function updatePermissionV2(uint256 tokenId, LibPolicy.Policy calldata p) external {
        _updateInternal(
            tokenId,
            p.permissionContextHash,
            p.maxNotionalUsdQ96,
            p.dailyCapUsdQ96,
            p.expiresAt,
            p.issuedAt,
            p.dailySpentUsdQ96Slot,
            p.dailyWindowStart,
            p.allowedContracts,
            p.allowedSelectors,
            p.presetHash,
            p.tokenId,
            true
        );
    }

    function revokePermission(uint256 tokenId) external {
        AuditStorage storage s = _s();
        if (s.factory == address(0)) revert NotInitialized();
        if (!s.installed[tokenId]) revert PolicyNotFound();

        address nftOwner = IERC721(s.positionNFT).ownerOf(tokenId);
        if (msg.sender != nftOwner) revert Unauthorized();

        LibPolicy.Policy storage stored = s.policies[tokenId];
        uint64 nowTs = uint64(block.timestamp);
        if (stored.expiresAt != 0 && stored.expiresAt <= nowTs) revert AlreadyRevoked();

        stored.expiresAt = nowTs;
        emit PolicyRevoked(tokenId);
    }

    // --- Views ---

    function getPolicy(uint256 tokenId) external view returns (LibPolicy.Policy memory) {
        AuditStorage storage s = _s();
        if (!s.installed[tokenId]) revert PolicyNotFound();
        return s.policies[tokenId];
    }

    function permissionContextHash(uint256 tokenId) external view returns (bytes32) {
        AuditStorage storage s = _s();
        if (!s.installed[tokenId]) revert PolicyNotFound();
        return s.policies[tokenId].permissionContextHash;
    }

    /// @notice Returns the stored `presetHash` for `tokenId`. `bytes32(0)` means custom.
    /// @dev    Reverts `PolicyNotFound` for unknown tokens. The hash is always one of
    ///         `LibRiskPresets.canonicalHashes` OR `bytes32(0)` (custom) per the validation
    ///         performed at install / update time.
    function getPresetHash(uint256 tokenId) external view returns (bytes32) {
        AuditStorage storage s = _s();
        if (!s.installed[tokenId]) revert PolicyNotFound();
        return s.policies[tokenId].presetHash;
    }

    function isPolicyActive(uint256 tokenId) external view returns (bool) {
        AuditStorage storage s = _s();
        if (!s.installed[tokenId]) return false;
        LibPolicy.Policy storage p = s.policies[tokenId];
        if (p.expiresAt == 0) return true;
        return uint64(block.timestamp) < p.expiresAt;
    }

    function auditFactory() external view returns (address) {
        return _s().factory;
    }

    function auditPositionNFT() external view returns (address) {
        return _s().positionNFT;
    }

    // --- Internal: shared install / update bodies ---

    function _installInternal(
        uint256 tokenId,
        bytes32 contextHash,
        uint256 maxNotionalUsdQ96,
        uint256 dailyCapUsdQ96,
        uint64 expiresAt,
        uint64 issuedAt,
        uint64 dailySpentUsdQ96Slot,
        uint64 dailyWindowStart,
        address[] calldata allowedContracts,
        bytes4[] calldata allowedSelectors,
        bytes32 presetHash,
        uint256 policyTokenId,
        bool emitV2
    )
        internal
    {
        AuditStorage storage s = _s();
        if (s.factory == address(0)) revert NotInitialized();
        if (msg.sender != s.factory) revert Unauthorized();
        if (s.installed[tokenId]) revert PolicyAlreadyInstalled();
        if (policyTokenId != tokenId) revert TokenIdMismatch();
        if (!LibRiskPresets.isCanonicalPresetHash(presetHash)) revert InvalidPresetHash();

        LibPolicy.Policy storage stored = s.policies[tokenId];
        stored.tokenId = tokenId;
        stored.permissionContextHash = contextHash;
        stored.maxNotionalUsdQ96 = maxNotionalUsdQ96;
        stored.dailyCapUsdQ96 = dailyCapUsdQ96;
        stored.expiresAt = expiresAt;
        stored.issuedAt = issuedAt;
        stored.dailySpentUsdQ96Slot = dailySpentUsdQ96Slot;
        stored.dailyWindowStart = dailyWindowStart;
        stored.presetHash = presetHash;

        uint256 acLen = allowedContracts.length;
        for (uint256 i; i < acLen; ++i) {
            stored.allowedContracts.push(allowedContracts[i]);
        }
        uint256 selLen = allowedSelectors.length;
        for (uint256 i; i < selLen; ++i) {
            stored.allowedSelectors.push(allowedSelectors[i]);
        }

        s.installed[tokenId] = true;

        // Legacy event MUST always emit so the existing indexer continues to receive every
        // grant. The V2 event is additive and only fires from the V2 selector so legacy
        // installs don't accidentally promote a `bytes32(0)` presetHash to "canonical".
        emit PolicyInstalled(tokenId, contextHash, expiresAt);
        if (emitV2) {
            emit PolicyInstalledV2(tokenId, contextHash, expiresAt, presetHash);
        }
    }

    function _updateInternal(
        uint256 tokenId,
        bytes32 contextHash,
        uint256 maxNotionalUsdQ96,
        uint256 dailyCapUsdQ96,
        uint64 expiresAt,
        uint64 issuedAt,
        uint64 dailySpentUsdQ96Slot,
        uint64 dailyWindowStart,
        address[] calldata allowedContracts,
        bytes4[] calldata allowedSelectors,
        bytes32 presetHash,
        uint256 policyTokenId,
        bool emitV2
    )
        internal
    {
        AuditStorage storage s = _s();
        if (s.factory == address(0)) revert NotInitialized();
        if (!s.installed[tokenId]) revert PolicyNotFound();
        if (policyTokenId != tokenId) revert TokenIdMismatch();
        if (!LibRiskPresets.isCanonicalPresetHash(presetHash)) revert InvalidPresetHash();

        address nftOwner = IERC721(s.positionNFT).ownerOf(tokenId);
        if (msg.sender != nftOwner) revert Unauthorized();

        LibPolicy.Policy storage stored = s.policies[tokenId];
        stored.tokenId = tokenId;
        stored.permissionContextHash = contextHash;
        stored.maxNotionalUsdQ96 = maxNotionalUsdQ96;
        stored.dailyCapUsdQ96 = dailyCapUsdQ96;
        stored.expiresAt = expiresAt;
        stored.issuedAt = issuedAt;
        stored.dailySpentUsdQ96Slot = dailySpentUsdQ96Slot;
        stored.dailyWindowStart = dailyWindowStart;
        stored.presetHash = presetHash;

        // Replace the allowlists wholesale: clear then push the new entries.
        uint256 currentContractsLen = stored.allowedContracts.length;
        for (uint256 i; i < currentContractsLen; ++i) {
            stored.allowedContracts.pop();
        }
        uint256 currentSelectorsLen = stored.allowedSelectors.length;
        for (uint256 i; i < currentSelectorsLen; ++i) {
            stored.allowedSelectors.pop();
        }
        uint256 acLen = allowedContracts.length;
        for (uint256 i; i < acLen; ++i) {
            stored.allowedContracts.push(allowedContracts[i]);
        }
        uint256 selLen = allowedSelectors.length;
        for (uint256 i; i < selLen; ++i) {
            stored.allowedSelectors.push(allowedSelectors[i]);
        }

        emit PolicyUpdated(tokenId, contextHash, expiresAt);
        if (emitV2) {
            emit PolicyUpdatedV2(tokenId, contextHash, expiresAt, presetHash);
        }
    }
}

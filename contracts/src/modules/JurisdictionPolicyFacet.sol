// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IJurisdictionPolicyFacet} from "../interfaces/IJurisdictionPolicyFacet.sol";

/// @title JurisdictionPolicyFacet
/// @notice Per-tokenId, per-ISO-3166-1 alpha-2 country pause flag. The agent runtime
///         gates trading actions on this flag when the caller's resolved jurisdiction
///         matches a paused country. Withdrawals, redemptions, and liquidations are
///         NOT gated by this facet; see `AgentVault.withdraw` / `redeem`
///         (no `whenNotPaused` modifier) and the Tilt invariant in
///         `WithdrawNeverPausedByJurisdiction.t.sol`.
/// @dev    Storage. Uses Diamond AppStorage / namespaced storage at the hashed slot
///         `keccak256("primeagent.facets.jurisdictionpolicy.v1")`. Field order MUST
///         NOT change once any cut binds this layout; only append-at-end is safe across
///         future upgrades.
///
///         The facet reads the canonical `PositionNFT` address from the SAME Diamond's
///         existing `AuditStorage` (slot `keccak256("primeagent.audit.storage")`) so
///         we do NOT need a separate init call. The Erc7715PolicyAuditFacet seeds that
///         slot at Diamond construction via `DiamondInit.init`; that slot is read-only
///         to this facet.
contract JurisdictionPolicyFacet is IJurisdictionPolicyFacet {
    // --- Storage ---

    /// @dev Hashed namespace for this facet's storage. Stable across upgrades.
    bytes32 internal constant JURISDICTION_STORAGE_POSITION =
        keccak256("primeagent.facets.jurisdictionpolicy.v1");

    /// @dev Hashed namespace of the audit facet, used to read the PositionNFT address.
    bytes32 internal constant AUDIT_STORAGE_POSITION = keccak256("primeagent.audit.storage");

    struct JurisdictionStorage {
        /// @dev tokenId => isoCountry (bytes2) => paused
        mapping(uint256 => mapping(bytes2 => bool)) paused;
        /// @dev tokenId => monotonic per-token version counter
        mapping(uint256 => uint64) version;
    }

    /// @dev Mirror of `Erc7715PolicyAuditFacet.AuditStorage` purely for reading
    ///      `positionNFT`. The layout MUST match the audit facet exactly for the
    ///      fields we touch; we only read `positionNFT` which sits at slot+3.
    struct AuditStorageMirror {
        mapping(uint256 => bytes) policies; // opaque to us
        mapping(uint256 => bool) installed; // opaque to us
        address factory;
        address positionNFT;
    }

    function _s() internal pure returns (JurisdictionStorage storage s) {
        bytes32 slot = JURISDICTION_STORAGE_POSITION;
        assembly {
            s.slot := slot
        }
    }

    function _audit() internal pure returns (AuditStorageMirror storage s) {
        bytes32 slot = AUDIT_STORAGE_POSITION;
        assembly {
            s.slot := slot
        }
    }

    // --- Internal: ownership + validation ---

    /// @dev Revert if `caller` is not the NFT owner of `tokenId`.
    function _onlyTokenOwner(uint256 tokenId, address caller) internal view {
        address nft = _audit().positionNFT;
        // If the PositionNFT slot has not been seeded (uninitialized Diamond), no caller
        // can ever be the owner, so we fail closed with JurisdictionNotOwner.
        if (nft == address(0)) revert JurisdictionNotOwner(tokenId, caller);
        address owner = IERC721(nft).ownerOf(tokenId);
        if (owner != caller) revert JurisdictionNotOwner(tokenId, caller);
    }

    /// @dev Validate that `iso` is two uppercase ASCII letters A..Z (0x41..0x5A).
    function _validIso(bytes2 iso) internal pure returns (bool) {
        uint8 a = uint8(iso[0]);
        uint8 b = uint8(iso[1]);
        return (a >= 0x41 && a <= 0x5A) && (b >= 0x41 && b <= 0x5A);
    }

    // --- External: pause / unpause ---

    /// @inheritdoc IJurisdictionPolicyFacet
    function pauseForJurisdiction(uint256 tokenId, bytes2 isoCountry) external {
        if (!_validIso(isoCountry)) revert JurisdictionInvalidIso(isoCountry);
        _onlyTokenOwner(tokenId, msg.sender);

        JurisdictionStorage storage s = _s();
        if (s.paused[tokenId][isoCountry]) revert JurisdictionAlreadyPaused(tokenId, isoCountry);

        s.paused[tokenId][isoCountry] = true;
        // version bump uses unchecked: at 1 bump per call, uint64 overflow would
        // require ~5.8e11 years of contiguous calls. The bump is a strictly monotonic
        // cache key, not a value with security significance, so unchecked is safe.
        unchecked {
            s.version[tokenId] += 1;
        }
        emit JurisdictionPaused(tokenId, isoCountry, s.version[tokenId]);
    }

    /// @inheritdoc IJurisdictionPolicyFacet
    function unpauseForJurisdiction(uint256 tokenId, bytes2 isoCountry) external {
        if (!_validIso(isoCountry)) revert JurisdictionInvalidIso(isoCountry);
        _onlyTokenOwner(tokenId, msg.sender);

        JurisdictionStorage storage s = _s();
        if (!s.paused[tokenId][isoCountry]) revert JurisdictionNotPaused(tokenId, isoCountry);

        s.paused[tokenId][isoCountry] = false;
        unchecked {
            s.version[tokenId] += 1;
        }
        emit JurisdictionUnpaused(tokenId, isoCountry, s.version[tokenId]);
    }

    // --- External: views ---

    /// @inheritdoc IJurisdictionPolicyFacet
    function isPausedForJurisdiction(uint256 tokenId, bytes2 isoCountry) external view returns (bool) {
        return _s().paused[tokenId][isoCountry];
    }

    /// @inheritdoc IJurisdictionPolicyFacet
    function getPauseVersion(uint256 tokenId) external view returns (uint64) {
        return _s().version[tokenId];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library LibPolicy {
    error PolicyExpired();
    error NotionalExceedsPerCallCap();
    error DailyCapExceeded();
    error DailySpendOverflow();

    /// @dev Storage layout: existing fields keep their slot assignments verbatim. The
    ///      `presetHash` field (Feature C, Implementation Plan section 1.2 / Option B) is
    ///      appended at the end so old policies stored before the facet upgrade default to
    ///      `bytes32(0)` (the explicit "custom" sentinel in `LibRiskPresets.PRESET_CUSTOM`).
    ///      Order MUST NOT change once a Diamond facet has been deployed against this layout.
    struct Policy {
        uint256 tokenId;
        bytes32 permissionContextHash;
        address[] allowedContracts;
        bytes4[] allowedSelectors;
        uint256 maxNotionalUsdQ96;
        uint256 dailyCapUsdQ96;
        uint64 expiresAt;
        uint64 issuedAt;
        uint64 dailySpentUsdQ96Slot;
        uint64 dailyWindowStart;
        /// @dev Canonical risk-preset hash, or `bytes32(0)` for custom. See
        ///      `LibRiskPresets.isCanonicalPresetHash`.
        bytes32 presetHash;
    }

    /// @dev Legacy calldata shape (pre-Feature C / Option B). Identical field order to the
    ///      production storage struct minus `presetHash`. Used ONLY by the back-compat
    ///      `installPermission(uint256, LegacyPolicy)` / `updatePermission(uint256, LegacyPolicy)`
    ///      facet selectors so callers that have not yet adopted the new presetHash field do
    ///      not break after the 48h timelocked Diamond cut. Defaulting to
    ///      `presetHash = bytes32(0)` mirrors `LibRiskPresets.PRESET_CUSTOM`.
    struct LegacyPolicy {
        uint256 tokenId;
        bytes32 permissionContextHash;
        address[] allowedContracts;
        bytes4[] allowedSelectors;
        uint256 maxNotionalUsdQ96;
        uint256 dailyCapUsdQ96;
        uint64 expiresAt;
        uint64 issuedAt;
        uint64 dailySpentUsdQ96Slot;
        uint64 dailyWindowStart;
    }

    function isContractAllowed(Policy storage p, address target) internal view returns (bool) {
        address[] storage list = p.allowedContracts;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == target) return true;
        }
        return false;
    }

    function isSelectorAllowed(Policy storage p, bytes4 selector) internal view returns (bool) {
        bytes4[] storage list = p.allowedSelectors;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == selector) return true;
        }
        return false;
    }

    function checkNotional(Policy storage p, uint256 notionalUsdQ96) internal view returns (bool) {
        return notionalUsdQ96 <= p.maxNotionalUsdQ96;
    }

    function accrueDailySpend(Policy storage p, uint256 notionalUsdQ96) internal returns (bool ok) {
        uint64 windowStart = p.dailyWindowStart;
        uint64 nowTs = uint64(block.timestamp);
        uint256 spent;
        if (windowStart == 0 || nowTs - windowStart >= 1 days) {
            spent = 0;
            p.dailyWindowStart = nowTs;
        } else {
            spent = uint256(p.dailySpentUsdQ96Slot);
        }
        uint256 newSpent = spent + notionalUsdQ96;
        if (newSpent < spent) revert DailySpendOverflow();
        if (newSpent > p.dailyCapUsdQ96) return false;
        if (newSpent > type(uint64).max) revert DailySpendOverflow();
        p.dailySpentUsdQ96Slot = uint64(newSpent);
        return true;
    }

    function isExpired(Policy storage p) internal view returns (bool) {
        return p.expiresAt != 0 && uint64(block.timestamp) >= p.expiresAt;
    }

    function policyHash(Policy memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.tokenId,
                p.permissionContextHash,
                p.allowedContracts,
                p.allowedSelectors,
                p.maxNotionalUsdQ96,
                p.dailyCapUsdQ96,
                p.expiresAt,
                p.issuedAt,
                p.dailySpentUsdQ96Slot,
                p.dailyWindowStart,
                p.presetHash
            )
        );
    }
}

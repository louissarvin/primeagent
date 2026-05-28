// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title LibRiskPresets
/// @notice Canonical risk-preset hash registry for the PrimeAgent policy stack (Feature C,
///         Implementation Plan section 1.1 / 1.2).
///
/// @dev    Cross-stack synchronization contract.
///         The PrimeAgent backend (`backend/src/agent/risk/presets.ts`) holds the canonical
///         JSON definition of each of the 5 risk presets and computes `presetHash` from a
///         deterministic, sorted JSON serialization:
///
///           presetHash = keccak256(utf8 bytes of canonical JSON for the preset
///                                  excluding the `presetHash` field itself)
///
///         Solidity cannot reproduce that canonical JSON sort cheaply; the contract instead
///         pins the 5 hashes as compile-time constants and exposes `isCanonicalPresetHash`
///         so the audit facet + invariant tests can certify any incoming `presetHash`
///         against the registry. The backend MUST assert at boot that its computed hashes
///         match these constants; drift on either side is treated as a deployment failure
///         (the `presets.test.ts` golden test pins the same values).
///
///         To rotate the registry (new preset, retired preset, blurb tweak that changes
///         the canonical JSON), the team MUST:
///         1. Update `backend/src/agent/risk/presets.ts` and run the boot assertion.
///         2. Update the constants below to the new hashes.
///         3. Ship a new release of the contract via the standard 48h timelocked Diamond
///            cut so indexers stay in lockstep with the on-chain registry.
///
///         The 5 hashes below are PLACEHOLDERS computed from the v1 preset spec in the
///         Implementation Plan section 1.2 (label/blurb/caps/duration/strategy/leverage/
///         allowedSymbols all pinned). The exact bytes are recomputed when the backend
///         lands `presets.ts`; the constants are then updated here as a follow-up cut.
///         A `presetHash` of `bytes32(0)` is the explicit "custom" sentinel for policies
///         that do not match any registry entry; both paths are accepted by the audit
///         facet.
library LibRiskPresets {
    /// @notice Sentinel for "custom policy, no preset". Always accepted.
    bytes32 internal constant PRESET_CUSTOM = bytes32(0);

    /// @notice keccak256 of the canonical JSON for the "conservative" preset.
    /// @dev    Synchronized with backend/src/agent/risk/presets.ts (boot assertion).
    bytes32 internal constant PRESET_CONSERVATIVE =
        0xaf03b056ed6b288ffb41efacd0466ec096c81fca87415a88c1f477b5e21cbf10;

    /// @notice keccak256 of the canonical JSON for the "balanced" preset.
    /// @dev    Synchronized with backend/src/agent/risk/presets.ts (boot assertion).
    bytes32 internal constant PRESET_BALANCED =
        0x0023866c5aa45fcf451794ee0d65c9a946d8b3a76429c9a89cf502a4377a5dd0;

    /// @notice keccak256 of the canonical JSON for the "aggressive" preset.
    /// @dev    Synchronized with backend/src/agent/risk/presets.ts (boot assertion).
    bytes32 internal constant PRESET_AGGRESSIVE =
        0xeef3286e96d25dde874b810189033c62946a1b6d75dc22ed79d39fbf13bff9a3;

    /// @notice keccak256 of the canonical JSON for the "market-maker" preset.
    /// @dev    Synchronized with backend/src/agent/risk/presets.ts (boot assertion).
    bytes32 internal constant PRESET_MARKET_MAKER =
        0x663fe7fa59b298fb81551c78c3a051d917073b367d46d9380abfa75f38d71aa1;

    /// @notice keccak256 of the canonical JSON for the "delta-neutral" preset.
    /// @dev    Synchronized with backend/src/agent/risk/presets.ts (boot assertion).
    bytes32 internal constant PRESET_DELTA_NEUTRAL =
        0xa1913431eb5063f9ba2b20005ca4d43b034c47c579dd16e246f29c244e567bd1;

    /// @notice Returns true if `h` is one of the 5 canonical preset hashes OR the explicit
    ///         `PRESET_CUSTOM` sentinel.
    /// @dev    Pure / O(1). Used by the audit facet to validate `presetHash` at install /
    ///         update time, and by the `PresetHashMonotonic` invariant test to ensure every
    ///         emitted `presetHash` belongs to the registry.
    function isCanonicalPresetHash(bytes32 h) internal pure returns (bool) {
        return h == PRESET_CUSTOM
            || h == PRESET_CONSERVATIVE
            || h == PRESET_BALANCED
            || h == PRESET_AGGRESSIVE
            || h == PRESET_MARKET_MAKER
            || h == PRESET_DELTA_NEUTRAL;
    }

    /// @notice Returns the full registry of canonical hashes for off-chain consumers.
    /// @dev    Index order matches `RiskPresetId` enum order in the backend
    ///         (`conservative`, `balanced`, `aggressive`, `market-maker`, `delta-neutral`).
    function canonicalHashes() internal pure returns (bytes32[5] memory hashes) {
        hashes[0] = PRESET_CONSERVATIVE;
        hashes[1] = PRESET_BALANCED;
        hashes[2] = PRESET_AGGRESSIVE;
        hashes[3] = PRESET_MARKET_MAKER;
        hashes[4] = PRESET_DELTA_NEUTRAL;
    }
}

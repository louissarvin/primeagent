// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title IJurisdictionPolicyFacet
/// @notice Diamond facet that records per-tokenId, per-ISO-3166-1 alpha-2 country pause
///         flags. The agent runtime (off-chain) and the `PrimeAgentPreExecHook`
///         (on-chain) both gate trading actions on this flag when the caller's
///         resolved jurisdiction matches a paused country.
///
/// @dev    Withdrawals, redemptions, and liquidations are explicitly NOT gated by this
///         facet. See `AgentVault.sol` lines 386-410 (no `whenNotPaused` on `withdraw`
///         / `redeem`) and the Tilt invariant codified in
///         `WithdrawNeverPausedByJurisdiction.t.sol`.
interface IJurisdictionPolicyFacet {
    // --- Events ---

    /// @notice Emitted when an owner pauses a jurisdiction for an agent.
    /// @param tokenId The PositionNFT tokenId that identifies the agent.
    /// @param isoCountry ISO-3166-1 alpha-2 country code (e.g. "GB" = 0x4742).
    /// @param version Monotonic per-tokenId counter, bumped on every state change.
    event JurisdictionPaused(uint256 indexed tokenId, bytes2 indexed isoCountry, uint64 version);

    /// @notice Emitted when an owner unpauses a jurisdiction for an agent.
    /// @param tokenId The PositionNFT tokenId that identifies the agent.
    /// @param isoCountry ISO-3166-1 alpha-2 country code.
    /// @param version Monotonic per-tokenId counter, bumped on every state change.
    event JurisdictionUnpaused(uint256 indexed tokenId, bytes2 indexed isoCountry, uint64 version);

    // --- Errors ---

    /// @notice Caller is not the NFT owner of `tokenId`.
    error JurisdictionNotOwner(uint256 tokenId, address caller);

    /// @notice `isoCountry` is not a valid two-byte ISO-3166-1 alpha-2 code
    ///         (must be two uppercase ASCII letters A..Z).
    error JurisdictionInvalidIso(bytes2 isoCountry);

    /// @notice Attempted to pause a jurisdiction that is already paused.
    error JurisdictionAlreadyPaused(uint256 tokenId, bytes2 isoCountry);

    /// @notice Attempted to unpause a jurisdiction that is not currently paused.
    error JurisdictionNotPaused(uint256 tokenId, bytes2 isoCountry);

    // --- State-changing functions ---

    /// @notice Pause trading actions for `tokenId` when the caller's declared
    ///         jurisdiction is `isoCountry`. NFT-owner gated.
    /// @param tokenId The PositionNFT tokenId.
    /// @param isoCountry Two-byte uppercase ISO-3166-1 alpha-2 country code.
    function pauseForJurisdiction(uint256 tokenId, bytes2 isoCountry) external;

    /// @notice Unpause trading actions for `tokenId` when the caller's declared
    ///         jurisdiction is `isoCountry`. NFT-owner gated.
    /// @param tokenId The PositionNFT tokenId.
    /// @param isoCountry Two-byte uppercase ISO-3166-1 alpha-2 country code.
    function unpauseForJurisdiction(uint256 tokenId, bytes2 isoCountry) external;

    // --- Views ---

    /// @notice Returns true if trading is paused for `tokenId` when the caller's
    ///         resolved jurisdiction is `isoCountry`.
    /// @param tokenId The PositionNFT tokenId.
    /// @param isoCountry Two-byte ISO-3166-1 alpha-2 country code.
    /// @return paused True iff a pause is active for this (tokenId, isoCountry) pair.
    function isPausedForJurisdiction(uint256 tokenId, bytes2 isoCountry) external view returns (bool paused);

    /// @notice Returns the monotonic version counter for `tokenId`. Bumps once per
    ///         state-changing call so off-chain caches can invalidate cheaply.
    /// @param tokenId The PositionNFT tokenId.
    /// @return version The current version counter for the token's pause set.
    function getPauseVersion(uint256 tokenId) external view returns (uint64 version);
}

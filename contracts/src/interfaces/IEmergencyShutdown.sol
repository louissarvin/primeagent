// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title IEmergencyShutdown
/// @notice Public surface of `EmergencyShutdown`. Single contract that pauses every
///         registered OpenZeppelin-Pausable component in a single transaction, with a
///         48h timelock on resume to allow stakeholders to react to bad-pause scenarios.
interface IEmergencyShutdown {
    // --- Events ---

    event ComponentRegistered(address indexed component);
    event ComponentUnregistered(address indexed component);
    event ShutdownActivated(string reason, uint256 componentsPaused);
    event ShutdownPartial(uint256 componentsPaused, uint256 failures);
    event ResumeProposed(uint64 effectiveAt);
    event ResumeExecuted(uint256 componentsResumed);
    event ResumeCancelled();
    /// @notice Emitted when the owner grants or revokes the delegated registrar role.
    event RegistrarSet(address indexed registrar, bool active);
    /// @notice Emitted when the owner grants or revokes the delegated liquidator role used by
    ///         `liquidate`. Only the active liquidator may call `liquidate`.
    event LiquidatorSet(address indexed liquidator, bool active);
    /// @notice Emitted when a vault has been seized by the liquidator. `amountSwept` is the
    ///         USDC moved out of the vault into `recipient` (the executor / bounty wrapper).
    event VaultLiquidated(
        uint256 indexed tokenId,
        address indexed vault,
        address indexed recipient,
        uint256 amountSwept
    );

    // --- Errors ---

    error ZeroAddress();
    error AlreadyRegistered(address component);
    error NotRegistered(address component);
    error AlreadyShutdown();
    error NotShutdown();
    error ResumeTimelockNotElapsed(uint64 effectiveAt);
    error NoPendingResume();
    error BatchTooLarge(uint256 length, uint256 cap);
    error PauseCallFailed(address component, bytes data);
    error UnpauseCallFailed(address component, bytes data);
    error InvalidRange(uint256 from, uint256 to);
    error NotAContract(address component);
    /// @notice Reverts when a caller without the owner or registrar role attempts to register a
    ///         new component.
    error NotRegistrar(address caller);
    /// @notice Reverts when a caller without the active liquidator role attempts to call
    ///         `liquidate`. Liquidator is a single-address role granted by the owner.
    error NotLiquidator(address caller);
    /// @notice Reverts when `liquidate` is called against a vault that was never registered
    ///         with this coordinator. Sanity check to prevent the liquidator from being
    ///         pointed at an arbitrary address.
    error VaultNotRegistered(address vault);

    // --- Views ---

    function TIMELOCK() external view returns (uint256);
    function MAX_BATCH() external view returns (uint256);

    function globalShutdown() external view returns (bool);
    function pendingResumeAt() external view returns (uint64);
    function pausableComponents(uint256 index) external view returns (address);
    function pausableComponentsLength() external view returns (uint256);
    function registered(address component) external view returns (bool);

    function isShutdown() external view returns (bool);

    /// @notice Returns whether `registrar` is currently authorised to call `registerComponent`.
    function isRegistrar(address registrar) external view returns (bool);

    /// @notice Returns the single active liquidator address. Zero when no liquidator is wired.
    function liquidator() external view returns (address);

    // --- Admin ---

    function registerComponent(address c) external;
    function unregisterComponent(address c) external;
    /// @notice Grants or revokes the delegated registrar role. Owner-only.
    /// @param registrar The address to toggle.
    /// @param active True to grant, false to revoke.
    function setRegistrar(address registrar, bool active) external;

    function emergencyShutdown(string calldata reason) external;
    /// @notice Chunked variant of `emergencyShutdown`. Pauses components in the inclusive
    ///         half-open range `[from, to)`. Audit H-5: lets ops shutdown large registered
    ///         lists in multiple txs without ever forwarding more than a capped amount of gas
    ///         per `pause()` call.
    /// @param from Index of the first component to pause.
    /// @param to Index one past the last component to pause.
    /// @param reason Human-readable reason for the shutdown.
    function emergencyShutdownRange(uint256 from, uint256 to, string calldata reason) external;
    function proposeResume() external;
    function executeResume() external;
    function cancelResume() external;

    /// @notice Per-component gas cap for the looped `pause()` / `unpause()` calls.
    function PAUSE_CALL_GAS() external view returns (uint256);

    /// @notice Grants or revokes the delegated liquidator role. Owner-only.
    /// @param liquidator_ Address to toggle.
    /// @param active True to grant, false to revoke.
    function setLiquidator(address liquidator_, bool active) external;

    /// @notice Seizes the USDC balance of the vault bound to `tokenId` and transfers it to the
    ///         caller (the active liquidator). The vault is identified by the `vault` hint and
    ///         MUST be a previously registered component. Does NOT pause the vault: the Tilt
    ///         invariant requires that depositors can always redeem.
    /// @dev    Only callable by the address set as `liquidator()`. Reverts when the vault is
    ///         not registered or the inner `liquidateBaseAsset` call returns zero.
    /// @param tokenId Position NFT identifier used purely for the event indexing.
    /// @param vault Registered vault address to seize from.
    /// @return amountSwept USDC moved from the vault into `msg.sender`.
    function liquidate(uint256 tokenId, address vault) external returns (uint256 amountSwept);
}

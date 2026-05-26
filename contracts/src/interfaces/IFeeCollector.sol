// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title IFeeCollector
/// @notice Public surface of `FeeCollector`. Accumulates USDC fees collected from Adapters,
///         splits them across configurable revenue streams by parts-per-million share,
///         lets each stream recipient pull its accrued share, and supports an owner-only
///         manual bridge slot reserved for the v2 Paymaster self-funding flow.
interface IFeeCollector {
    // --- Types ---

    struct Stream {
        address recipient;
        uint256 sharePpm;
        uint256 accrued;
        bool exists;
    }

    // --- Events ---

    event FeeCollected(address indexed from, uint256 amount, uint256 totalAccrued);
    event StreamConfigured(bytes32 indexed streamId, address indexed recipient, uint256 sharePpm);
    event StreamRemoved(bytes32 indexed streamId);
    event StreamWithdrawn(bytes32 indexed streamId, address indexed to, uint256 amount);
    event PaymasterBridged(address indexed target, uint256 amount, bytes data);

    // --- Errors ---

    error ZeroAddress();
    error ZeroAmount();
    error SharesNotOneMillion(uint256 actual);
    error StreamNotFound(bytes32 streamId);
    error NotStreamRecipient();
    error InsufficientAccrued(uint256 requested, uint256 accrued);
    error NoActiveStreams();
    error LengthMismatch();
    /// @notice Audit M-6: raised when an accounting subtraction would underflow `totalAccrued`.
    ///         Signals a stream-vs-global drift; downstream ops should pause withdrawals and
    ///         reconcile.
    error AccruedUnderflow(uint256 requested, uint256 totalAccrued);

    // --- Reserved streamIds ---

    function STREAM_PROTOCOL() external view returns (bytes32);
    function STREAM_TREASURY() external view returns (bytes32);
    function STREAM_PAYMASTER_RESERVE() external view returns (bytes32);

    function PPM_DENOMINATOR() external view returns (uint256);

    function baseAsset() external view returns (address);

    function totalAccrued() external view returns (uint256);

    function streams(bytes32 streamId)
        external
        view
        returns (address recipient, uint256 sharePpm, uint256 accrued, bool exists);

    // --- Mutators ---

    function collectFee(uint256 amount) external;

    function configureStream(bytes32 streamId, address recipient, uint256 sharePpm) external;
    function configureStreams(
        bytes32[] calldata streamIds,
        address[] calldata recipients,
        uint256[] calldata sharesPpm
    )
        external;
    function removeStream(bytes32 streamId) external;

    function withdrawStream(bytes32 streamId) external;
    function withdrawTo(bytes32 streamId, address to, uint256 amount) external;

    function bridgeToPaymaster(address payable target, uint256 amount, bytes calldata data) external;
}

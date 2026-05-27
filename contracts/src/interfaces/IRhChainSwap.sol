// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IRhChainSwap {
    error NotAllowedToken(address token);
    error NotOwner(uint256 tokenId, address caller);
    error Revoked(uint256 tokenId);
    error StalePrice(uint64 validUntil);
    error TTLTooLong(uint64 ttl);
    error BadSignature();
    error InsufficientBalance(uint256 tokenId, address token, uint256 requested, uint256 available);
    error SlippageExceeded(uint256 expected, uint256 actual);
    error PriceOutOfBand(uint256 priceWad, uint256 maxPriceWad);
    error NonceMismatch(uint64 expected, uint64 actual);
    error UnexpectedDecimals(address token, uint8 expected, uint8 actual);
    error OwnerNotRegistered(uint256 tokenId);
    error OwnerAlreadyRegistered(uint256 tokenId);
    error InvalidRecipient(address to);
    error EmergencyTimelockActive(uint64 unlockAt);
    error ZeroAmount();
    error ZeroAddress();
    error SameToken();
    error LengthMismatch();
    error NotPaused();

    struct Position {
        uint256[] balances;
        uint64 swapNonce;
        uint64 withdrawNonce;
        uint64 revokedAt;
        bool paused;
        address owner;
    }

    event Deposit(uint256 indexed tokenId, address indexed token, address indexed from, uint256 amount);
    event Withdraw(
        uint256 indexed tokenId, address indexed token, address indexed to, uint256 amount, bool viaAuth
    );
    event Swap(
        uint256 indexed tokenId,
        address indexed fromToken,
        address indexed toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 priceWad,
        uint64 nonce
    );
    event OwnerRegistered(uint256 indexed tokenId, address indexed owner, bool firstTime);
    event AgentRevoked(uint256 indexed tokenId, address by);
    event TokenAllowlisted(address indexed token, bool allowed, uint8 expectedDecimals);
    event AttestorRotated(address indexed oldAttestor, address indexed newAttestor);
    event EmergencyWithdrawn(uint256 indexed tokenId, address indexed token, address to, uint256 amount);
    event PausedAt(address indexed by, uint64 timestamp);
    event UnpausedAt(address indexed by, uint64 timestamp);

    function deposit(uint256 tokenId, address token, uint256 amount) external;
    function withdraw(uint256 tokenId, address token, uint256 amount) external;
    function withdrawWithAuth(
        uint256 tokenId,
        address token,
        uint256 amount,
        address to,
        uint64 nonce,
        uint64 validUntil,
        bytes calldata signature
    )
        external;

    function registerOwner(
        uint256 tokenId,
        address newOwner,
        uint64 validUntil,
        bytes calldata attestorSig,
        bytes calldata existingOwnerSig
    )
        external;

    function swap(
        uint256 tokenId,
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 maxPriceWad,
        uint256 priceWad,
        uint64 priceNonce,
        uint64 validUntil,
        bytes calldata signature
    )
        external
        returns (uint256 amountOut);

    function pause() external;
    function unpause() external;
    function revoke(uint256 tokenId) external;
    function setAllowedToken(address token, bool allowed, uint8 expectedDec) external;
    function rotateAttestor(address newAttestor) external;
    function emergencyWithdraw(uint256 tokenId, address token) external;

    function balances(uint256 tokenId, address token) external view returns (uint256);
    function tokenIdOwner(uint256 tokenId) external view returns (address);
    function swapNonces(uint256 tokenId) external view returns (uint64);
    function withdrawNonces(uint256 tokenId) external view returns (uint64);
    function revokedAt(uint256 tokenId) external view returns (uint64);
    function allowedTokens(address token) external view returns (bool);
    function expectedDecimals(address token) external view returns (uint8);
    function attestor() external view returns (address);
    function pausedAt() external view returns (uint64);

    function getPosition(uint256 tokenId) external view returns (Position memory);
    function getAllowedTokens() external view returns (address[] memory);
    function domainSeparator() external view returns (bytes32);
}

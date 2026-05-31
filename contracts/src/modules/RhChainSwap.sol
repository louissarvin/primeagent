// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {IRhChainSwap} from "../interfaces/IRhChainSwap.sol";

contract RhChainSwap is
    IRhChainSwap,
    AccessControlDefaultAdminRules,
    Pausable,
    ReentrancyGuardTransient,
    EIP712
{
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");
    bytes32 public constant TOKEN_MANAGER_ROLE = keccak256("TOKEN_MANAGER_ROLE");
    bytes32 public constant ATTESTOR_MANAGER_ROLE = keccak256("ATTESTOR_MANAGER_ROLE");
    bytes32 public constant PRICE_TYPEHASH = keccak256(
        "Price(uint256 tokenId,address fromToken,address toToken,uint256 amountIn,uint256 minAmountOut,uint256 priceWad,uint64 nonce,uint64 validUntil)"
    );
    bytes32 public constant WITHDRAW_AUTH_TYPEHASH = keccak256(
        "WithdrawAuth(uint256 tokenId,address token,uint256 amount,address to,uint64 nonce,uint64 validUntil)"
    );
    bytes32 public constant OWNER_REGISTRATION_TYPEHASH =
        keccak256("OwnerRegistration(uint256 tokenId,address newOwner,uint64 validUntil)");
    uint64 public constant MAX_PRICE_TTL = 300;
    uint256 private constant _WAD = 1e18;

    uint64 public immutable EMERGENCY_TIMELOCK;

    mapping(uint256 tokenId => mapping(address token => uint256 amount)) private _balances;
    mapping(uint256 tokenId => address owner) private _tokenIdOwner;
    mapping(uint256 tokenId => uint64 nonce) private _swapNonces;
    mapping(uint256 tokenId => uint64 nonce) private _withdrawNonces;
    mapping(uint256 tokenId => uint64 ts) private _revokedAt;
    mapping(address token => bool allowed) private _allowedTokens;
    mapping(address token => uint8 dec) private _expectedDecimals;
    mapping(address token => uint256 indexPlusOne) private _allowedTokenIndex;

    uint64 private _pausedAt;
    address[] private _allowedTokenList;
    address private _attestor;

    constructor(
        address admin,
        address attestor_,
        uint64 emergencyTimelock_,
        address[] memory tokens,
        uint8[] memory expectedDec
    )
        AccessControlDefaultAdminRules(0, admin)
        EIP712("PrimeAgentRhChainSwap", "1")
    {
        if (admin == address(0) || attestor_ == address(0)) revert ZeroAddress();
        if (tokens.length != expectedDec.length) revert LengthMismatch();

        EMERGENCY_TIMELOCK = emergencyTimelock_;
        _attestor = attestor_;
        emit AttestorRotated(address(0), attestor_);

        _grantRole(PAUSER_ROLE, admin);
        _grantRole(REVOKER_ROLE, admin);
        _grantRole(TOKEN_MANAGER_ROLE, admin);
        _grantRole(ATTESTOR_MANAGER_ROLE, admin);

        uint256 tokensLength = tokens.length;
        for (uint256 i; i < tokensLength; ++i) {
            _setAllowedToken(tokens[i], true, expectedDec[i]);
        }
    }

    modifier whenNotRevoked(uint256 tokenId) {
        if (_revokedAt[tokenId] != 0) revert Revoked(tokenId);
        _;
    }

    modifier onlyAllowedToken(address token) {
        if (!_allowedTokens[token]) revert NotAllowedToken(token);
        _;
    }

    function deposit(
        uint256 tokenId,
        address token,
        uint256 amount
    )
        external
        nonReentrant
        whenNotPaused
        onlyAllowedToken(token)
    {
        if (amount == 0) revert ZeroAmount();

        _balances[tokenId][token] += amount;
        emit Deposit(tokenId, token, msg.sender, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(
        uint256 tokenId,
        address token,
        uint256 amount
    )
        external
        nonReentrant
        onlyAllowedToken(token)
    {
        if (amount == 0) revert ZeroAmount();

        address owner = _tokenIdOwner[tokenId];
        if (owner == address(0)) revert OwnerNotRegistered(tokenId);

        uint256 available = _balances[tokenId][token];
        if (amount > available) revert InsufficientBalance(tokenId, token, amount, available);

        unchecked {
            _balances[tokenId][token] = available - amount;
        }
        emit Withdraw(tokenId, token, owner, amount, false);

        IERC20(token).safeTransfer(owner, amount);
    }

    function withdrawWithAuth(
        uint256 tokenId,
        address token,
        uint256 amount,
        address to,
        uint64 nonce,
        uint64 validUntil,
        bytes calldata signature
    )
        external
        nonReentrant
        onlyAllowedToken(token)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        if (block.timestamp > validUntil) revert StalePrice(validUntil);

        uint64 expectedNonce = _withdrawNonces[tokenId];
        if (nonce != expectedNonce) revert NonceMismatch(expectedNonce, nonce);

        bytes32 structHash =
            keccak256(abi.encode(WITHDRAW_AUTH_TYPEHASH, tokenId, token, amount, to, nonce, validUntil));
        _verifyAttestor(structHash, signature);

        uint256 available = _balances[tokenId][token];
        if (amount > available) revert InsufficientBalance(tokenId, token, amount, available);

        unchecked {
            _balances[tokenId][token] = available - amount;
            _withdrawNonces[tokenId] = expectedNonce + 1;
        }
        emit Withdraw(tokenId, token, to, amount, true);

        IERC20(token).safeTransfer(to, amount);
    }

    function registerOwner(
        uint256 tokenId,
        address newOwner,
        uint64 validUntil,
        bytes calldata attestorSig,
        bytes calldata existingOwnerSig
    )
        external
        nonReentrant
    {
        if (newOwner == address(0)) revert ZeroAddress();
        if (block.timestamp > validUntil) revert StalePrice(validUntil);

        bytes32 structHash =
            keccak256(abi.encode(OWNER_REGISTRATION_TYPEHASH, tokenId, newOwner, validUntil));
        bytes32 digest = _hashTypedDataV4(structHash);

        address attestorSigner = digest.recover(attestorSig);
        if (attestorSigner == address(0) || attestorSigner != _attestor) revert BadSignature();

        address existing = _tokenIdOwner[tokenId];
        bool firstTime = (existing == address(0));

        if (!firstTime) {
            if (existingOwnerSig.length == 0) revert OwnerAlreadyRegistered(tokenId);
            address existingSigner = digest.recover(existingOwnerSig);
            if (existingSigner == address(0) || existingSigner != existing) revert BadSignature();
        }

        _tokenIdOwner[tokenId] = newOwner;
        emit OwnerRegistered(tokenId, newOwner, firstTime);
    }

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
        nonReentrant
        whenNotPaused
        whenNotRevoked(tokenId)
        returns (uint256 amountOut)
    {
        if (fromToken == toToken) revert SameToken();
        if (!_allowedTokens[fromToken]) revert NotAllowedToken(fromToken);
        if (!_allowedTokens[toToken]) revert NotAllowedToken(toToken);
        if (amountIn == 0) revert ZeroAmount();

        if (block.timestamp > validUntil) revert StalePrice(validUntil);
        if (validUntil > block.timestamp + MAX_PRICE_TTL) {
            revert TTLTooLong(validUntil - uint64(block.timestamp));
        }

        if (priceWad > maxPriceWad) revert PriceOutOfBand(priceWad, maxPriceWad);

        uint64 expectedNonce = _swapNonces[tokenId];
        if (priceNonce != expectedNonce) revert NonceMismatch(expectedNonce, priceNonce);

        bytes32 structHash = keccak256(
            abi.encode(
                PRICE_TYPEHASH,
                tokenId,
                fromToken,
                toToken,
                amountIn,
                minAmountOut,
                priceWad,
                priceNonce,
                validUntil
            )
        );
        _verifyAttestor(structHash, signature);

        amountOut = Math.mulDiv(amountIn, priceWad, _WAD);
        if (amountOut < minAmountOut) revert SlippageExceeded(minAmountOut, amountOut);
        if (amountOut == 0) revert ZeroAmount();

        uint256 available = _balances[tokenId][fromToken];
        if (amountIn > available) revert InsufficientBalance(tokenId, fromToken, amountIn, available);

        unchecked {
            _balances[tokenId][fromToken] = available - amountIn;
            _swapNonces[tokenId] = expectedNonce + 1;
        }
        _balances[tokenId][toToken] += amountOut;

        emit Swap(tokenId, fromToken, toToken, amountIn, amountOut, priceWad, priceNonce);
    }


    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        _pausedAt = uint64(block.timestamp);
        emit PausedAt(msg.sender, uint64(block.timestamp));
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        delete _pausedAt;
        emit UnpausedAt(msg.sender, uint64(block.timestamp));
    }

    function revoke(uint256 tokenId) external onlyRole(REVOKER_ROLE) {
        if (_revokedAt[tokenId] == 0) {
            _revokedAt[tokenId] = uint64(block.timestamp);
        }
        emit AgentRevoked(tokenId, msg.sender);
    }

    function setAllowedToken(
        address token,
        bool allowed,
        uint8 expectedDec
    )
        external
        onlyRole(TOKEN_MANAGER_ROLE)
    {
        _setAllowedToken(token, allowed, expectedDec);
    }

    function rotateAttestor(address newAttestor) external onlyRole(ATTESTOR_MANAGER_ROLE) {
        if (newAttestor == address(0)) revert ZeroAddress();
        address old = _attestor;
        _attestor = newAttestor;
        emit AttestorRotated(old, newAttestor);
    }

    function emergencyWithdraw(
        uint256 tokenId,
        address token
    )
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (!paused()) revert NotPaused();
        uint64 pausedAt_ = _pausedAt;
        uint64 unlockAt = pausedAt_ + EMERGENCY_TIMELOCK;
        if (block.timestamp < unlockAt) revert EmergencyTimelockActive(unlockAt);

        address owner = _tokenIdOwner[tokenId];
        if (owner == address(0)) revert OwnerNotRegistered(tokenId);

        uint256 amount = _balances[tokenId][token];
        if (amount == 0) revert ZeroAmount();

        _balances[tokenId][token] = 0;
        emit EmergencyWithdrawn(tokenId, token, owner, amount);

        IERC20(token).safeTransfer(owner, amount);
    }

    function _setAllowedToken(address token, bool allowed, uint8 expectedDec) internal {
        if (token == address(0)) revert ZeroAddress();

        if (allowed) {
            uint8 actual = IERC20Metadata(token).decimals();
            if (actual != expectedDec) revert UnexpectedDecimals(token, expectedDec, actual);

            _allowedTokens[token] = true;
            _expectedDecimals[token] = expectedDec;

            if (_allowedTokenIndex[token] == 0) {
                _allowedTokenList.push(token);
                _allowedTokenIndex[token] = _allowedTokenList.length;
            }
        } else {
            _allowedTokens[token] = false;
        }

        emit TokenAllowlisted(token, allowed, expectedDec);
    }

    function _verifyAttestor(bytes32 structHash, bytes calldata signature) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(signature);
        if (signer == address(0) || signer != _attestor) revert BadSignature();
    }

    function balances(uint256 tokenId, address token) external view returns (uint256) {
        return _balances[tokenId][token];
    }

    function tokenIdOwner(uint256 tokenId) external view returns (address) {
        return _tokenIdOwner[tokenId];
    }

    function swapNonces(uint256 tokenId) external view returns (uint64) {
        return _swapNonces[tokenId];
    }

    function withdrawNonces(uint256 tokenId) external view returns (uint64) {
        return _withdrawNonces[tokenId];
    }

    function revokedAt(uint256 tokenId) external view returns (uint64) {
        return _revokedAt[tokenId];
    }

    function allowedTokens(address token) external view returns (bool) {
        return _allowedTokens[token];
    }

    function expectedDecimals(address token) external view returns (uint8) {
        return _expectedDecimals[token];
    }

    function attestor() external view returns (address) {
        return _attestor;
    }

    function pausedAt() external view returns (uint64) {
        return _pausedAt;
    }

    function getPosition(uint256 tokenId) external view returns (Position memory pos) {
        uint256 len = _allowedTokenList.length;
        uint256[] memory bals = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            bals[i] = _balances[tokenId][_allowedTokenList[i]];
        }
        pos.balances = bals;
        pos.swapNonce = _swapNonces[tokenId];
        pos.withdrawNonce = _withdrawNonces[tokenId];
        pos.revokedAt = _revokedAt[tokenId];
        pos.paused = paused();
        pos.owner = _tokenIdOwner[tokenId];
    }

    function getAllowedTokens() external view returns (address[] memory) {
        return _allowedTokenList;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}

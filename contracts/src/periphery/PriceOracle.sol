// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract PriceOracle is Ownable2Step, EIP712 {
    error PriceStale();
    error PriceMissing();
    error InsufficientSigners();
    error DuplicateSigner();
    error StalePriceInput();
    error FuturePriceInput();
    error TimelockNotElapsed();
    error PendingChangeMissing();
    error PendingChangeMismatch();
    error TooManySigners();
    error InvalidSignature();
    error ZeroAddress();
    error LengthMismatch();
    error EmptyBatch();

    uint256 public constant MIN_SIGNERS = 3;
    uint256 public constant MAX_SIGNERS = 5;
    uint256 public constant MAX_AGE = 300;
    uint256 public constant ROTATION_TIMELOCK = 48 hours;
    uint256 public constant FUTURE_SKEW = 30;
    bytes32 public constant PRICE_TYPEHASH =
        keccak256("Price(address asset,uint256 priceQ96,uint64 ts,uint64 signerSetEpoch)");

    struct PriceData {
        uint256 priceQ96;
        uint64 ts;
    }

    struct PendingChange {
        uint64 effectiveAt;
        bool active;
        bool exists;
    }

    uint256 public activeSignerCount;
    uint64 public signerSetEpoch;

    mapping(address asset => PriceData) public prices;
    mapping(address signer => bool) public activeSigners;
    mapping(address signer => PendingChange) public pendingSignerChanges;

    event PricePosted(address indexed asset, uint256 priceQ96, uint64 ts, uint8 k, uint8 n);
    event SignerChangeProposed(address indexed signer, bool active, uint256 effectiveAt);
    event SignerChanged(address indexed signer, bool active);
    event SignerSetEpochBumped(uint64 newEpoch);

    constructor(address owner_) Ownable(owner_) EIP712("PrimeAgent.PriceOracle", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
        signerSetEpoch = 1;
    }

    function postPrices(
        address asset,
        uint256[] calldata pricesQ96,
        uint64[] calldata timestamps,
        bytes[] calldata sigs
    )
        external
    {
        uint256 k = pricesQ96.length;
        if (k == 0) revert EmptyBatch();
        if (k != timestamps.length || k != sigs.length) revert LengthMismatch();
        if (k < MIN_SIGNERS) revert InsufficientSigners();
        if (k > MAX_SIGNERS) revert TooManySigners();
        if (asset == address(0)) revert ZeroAddress();

        uint256[] memory sorted = new uint256[](k);
        address[] memory seenSigners = new address[](k);
        uint64 maxTs = 0;
        uint256 nowTs = block.timestamp;

        for (uint256 i = 0; i < k;) {
            uint64 ts = timestamps[i];
            if (ts + uint64(MAX_AGE) < uint64(nowTs)) revert StalePriceInput();
            if (uint256(ts) > nowTs + FUTURE_SKEW) revert FuturePriceInput();

            bytes32 structHash = keccak256(
                abi.encode(PRICE_TYPEHASH, asset, pricesQ96[i], ts, signerSetEpoch)
            );
            bytes32 digest = _hashTypedDataV4(structHash);
            address signer = ECDSA.recover(digest, sigs[i]);
            if (signer == address(0)) revert InvalidSignature();
            if (!activeSigners[signer]) revert InvalidSignature();

            for (uint256 j = 0; j < i;) {
                if (seenSigners[j] == signer) revert DuplicateSigner();
                unchecked {
                    ++j;
                }
            }
            seenSigners[i] = signer;
            sorted[i] = pricesQ96[i];

            if (ts > maxTs) maxTs = ts;
            unchecked {
                ++i;
            }
        }

        for (uint256 i = 1; i < k;) {
            uint256 key = sorted[i];
            uint256 j = i;
            while (j > 0 && sorted[j - 1] > key) {
                sorted[j] = sorted[j - 1];
                unchecked {
                    --j;
                }
            }
            sorted[j] = key;
            unchecked {
                ++i;
            }
        }

        uint256 median = sorted[k / 2];
        if (k % 2 == 0) {
            uint256 lower = sorted[(k / 2) - 1];
            median = (lower + sorted[k / 2]) / 2;
        }

        prices[asset] = PriceData({priceQ96: median, ts: maxTs});
        emit PricePosted(asset, median, maxTs, uint8(k), uint8(activeSignerCount));
    }

    function getPrice(address asset) external view returns (uint256 priceQ96) {
        PriceData memory p = prices[asset];
        if (p.ts == 0) revert PriceMissing();
        if (block.timestamp - uint256(p.ts) > MAX_AGE) revert PriceStale();
        priceQ96 = p.priceQ96;
    }

    function proposeSignerChange(address signer, bool active) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        uint64 effectiveAt = uint64(block.timestamp + ROTATION_TIMELOCK);
        pendingSignerChanges[signer] = PendingChange({
            effectiveAt: effectiveAt,
            active: active,
            exists: true
        });
        emit SignerChangeProposed(signer, active, uint256(effectiveAt));
    }

    function executeSignerChange(address signer, bool active) external onlyOwner {
        PendingChange memory pending = pendingSignerChanges[signer];
        if (!pending.exists) revert PendingChangeMissing();
        if (pending.active != active) revert PendingChangeMismatch();
        if (block.timestamp < pending.effectiveAt) revert TimelockNotElapsed();

        bool wasActive = activeSigners[signer];
        if (wasActive == active) {
            delete pendingSignerChanges[signer];
            return;
        }

        if (active) {
            if (activeSignerCount + 1 > MAX_SIGNERS) revert TooManySigners();
            activeSigners[signer] = true;
            unchecked {
                ++activeSignerCount;
            }
        } else {
            activeSigners[signer] = false;
            unchecked {
                --activeSignerCount;
            }
        }
        delete pendingSignerChanges[signer];
        uint64 newEpoch;
        unchecked {
            newEpoch = signerSetEpoch + 1;
        }
        signerSetEpoch = newEpoch;
        emit SignerChanged(signer, active);
        emit SignerSetEpochBumped(newEpoch);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}

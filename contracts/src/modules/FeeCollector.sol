// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFeeCollector} from "../interfaces/IFeeCollector.sol";

contract FeeCollector is IFeeCollector, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant override PPM_DENOMINATOR = 1_000_000;
    bytes32 public constant override STREAM_PROTOCOL = keccak256("protocol");
    bytes32 public constant override STREAM_TREASURY = keccak256("treasury");
    bytes32 public constant override STREAM_PAYMASTER_RESERVE = keccak256("paymaster_reserve");

    address public immutable override baseAsset;

    uint256 public override totalAccrued;
    bytes32[] internal _streamIds;

    mapping(bytes32 => uint256) internal _streamIndex;
    mapping(bytes32 => Stream) internal _streams;

    constructor(address baseAsset_, address owner_) Ownable(owner_) {
        if (baseAsset_ == address(0)) revert ZeroAddress();
        baseAsset = baseAsset_;
    }

    function streams(bytes32 streamId)
        external
        view
        override
        returns (address recipient, uint256 sharePpm, uint256 accrued, bool exists)
    {
        Stream storage s = _streams[streamId];
        return (s.recipient, s.sharePpm, s.accrued, s.exists);
    }

    function configureStream(bytes32 streamId, address recipient, uint256 sharePpm) external override onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        Stream storage s = _streams[streamId];
        if (!s.exists) {
            s.exists = true;
            s.recipient = recipient;
            s.sharePpm = sharePpm;
            _streamIds.push(streamId);
            _streamIndex[streamId] = _streamIds.length; // 1-based
        } else {
            s.recipient = recipient;
            s.sharePpm = sharePpm;
        }
        _assertSharesSumToOneMillion();
        emit StreamConfigured(streamId, recipient, sharePpm);
    }

    function configureStreams(
        bytes32[] calldata streamIds_,
        address[] calldata recipients,
        uint256[] calldata sharesPpm
    )
        external
        override
        onlyOwner
    {
        if (streamIds_.length != recipients.length || streamIds_.length != sharesPpm.length) {
            revert LengthMismatch();
        }
        for (uint256 i = 0; i < streamIds_.length; ++i) {
            address recipient = recipients[i];
            if (recipient == address(0)) revert ZeroAddress();
            bytes32 sid = streamIds_[i];
            Stream storage s = _streams[sid];
            if (!s.exists) {
                s.exists = true;
                s.recipient = recipient;
                s.sharePpm = sharesPpm[i];
                _streamIds.push(sid);
                _streamIndex[sid] = _streamIds.length;
            } else {
                s.recipient = recipient;
                s.sharePpm = sharesPpm[i];
            }
            emit StreamConfigured(sid, recipient, sharesPpm[i]);
        }
        _assertSharesSumToOneMillion();
    }

    function removeStream(bytes32 streamId) external override onlyOwner {
        Stream storage s = _streams[streamId];
        if (!s.exists) revert StreamNotFound(streamId);
        if (s.accrued != 0) revert InsufficientAccrued(s.accrued, 0);

        uint256 idx1 = _streamIndex[streamId];
        uint256 lastIdx0 = _streamIds.length - 1;
        if (idx1 - 1 != lastIdx0) {
            bytes32 moved = _streamIds[lastIdx0];
            _streamIds[idx1 - 1] = moved;
            _streamIndex[moved] = idx1;
        }
        _streamIds.pop();
        delete _streamIndex[streamId];
        delete _streams[streamId];

        if (_streamIds.length != 0) {
            _assertSharesSumToOneMillion();
        }
        emit StreamRemoved(streamId);
    }

    function collectFee(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 count = _streamIds.length;
        if (count == 0) revert NoActiveStreams();

        uint256 balBefore = IERC20(baseAsset).balanceOf(address(this));
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(baseAsset).balanceOf(address(this)) - balBefore;

        uint256 distributed = 0;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 sid = _streamIds[i];
            Stream storage s = _streams[sid];
            if (s.sharePpm == 0) continue; // inactive but-stored stream
            uint256 portion = (received * s.sharePpm) / PPM_DENOMINATOR;
            s.accrued += portion;
            distributed += portion;
        }
        uint256 dust = received - distributed;
        if (dust != 0) {
            for (uint256 i = 0; i < count; ++i) {
                bytes32 sid = _streamIds[i];
                Stream storage s = _streams[sid];
                if (s.sharePpm != 0) {
                    s.accrued += dust;
                    break;
                }
            }
        }
        totalAccrued += received;
        emit FeeCollected(msg.sender, received, totalAccrued);
    }

    function withdrawStream(bytes32 streamId) external override nonReentrant {
        Stream storage s = _streams[streamId];
        if (!s.exists) revert StreamNotFound(streamId);
        uint256 amount = s.accrued;
        if (amount == 0) revert InsufficientAccrued(0, 0);
        if (totalAccrued < amount) revert AccruedUnderflow(amount, totalAccrued);
        s.accrued = 0;
        totalAccrued -= amount;
        address to = s.recipient;
        IERC20(baseAsset).safeTransfer(to, amount);
        emit StreamWithdrawn(streamId, to, amount);
    }

    function withdrawTo(bytes32 streamId, address to, uint256 amount) external override nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Stream storage s = _streams[streamId];
        if (!s.exists) revert StreamNotFound(streamId);
        if (msg.sender != s.recipient) revert NotStreamRecipient();
        if (amount > s.accrued) revert InsufficientAccrued(amount, s.accrued);
        if (totalAccrued < amount) revert AccruedUnderflow(amount, totalAccrued);
        s.accrued -= amount;
        totalAccrued -= amount;
        IERC20(baseAsset).safeTransfer(to, amount);
        emit StreamWithdrawn(streamId, to, amount);
    }

    function bridgeToPaymaster(
        address payable target,
        uint256 amount,
        bytes calldata data
    )
        external
        override
        onlyOwner
        nonReentrant
    {
        if (target == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Stream storage s = _streams[STREAM_PAYMASTER_RESERVE];
        if (!s.exists) revert StreamNotFound(STREAM_PAYMASTER_RESERVE);
        if (amount > s.accrued) revert InsufficientAccrued(amount, s.accrued);
        if (totalAccrued < amount) revert AccruedUnderflow(amount, totalAccrued);
        s.accrued -= amount;
        totalAccrued -= amount;
        IERC20(baseAsset).safeTransfer(target, amount);
        emit PaymasterBridged(target, amount, data);
    }

    function _assertSharesSumToOneMillion() internal view {
        uint256 sum = 0;
        uint256 len = _streamIds.length;
        for (uint256 i = 0; i < len; ++i) {
            sum += _streams[_streamIds[i]].sharePpm;
        }
        if (sum != PPM_DENOMINATOR) revert SharesNotOneMillion(sum);
    }
}

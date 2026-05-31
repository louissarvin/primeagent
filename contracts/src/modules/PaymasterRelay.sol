// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {IPaymaster} from "../interfaces/external/IPaymaster.sol";
import {IEntryPoint} from "../interfaces/external/IEntryPoint.sol";
import {IPaymasterRelay} from "../interfaces/IPaymasterRelay.sol";

contract PaymasterRelay is IPaymasterRelay, IPaymaster, Ownable2Step, ReentrancyGuardTransient {
    uint256 public constant override TIMELOCK = 48 hours;
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    bytes32 internal constant _PENDING_MAX_KIND = keccak256("PaymasterRelay.setMaxSponsoredOps");
    bytes32 internal constant _PENDING_CALLERS_KIND = keccak256("PaymasterRelay.setSponsoredCallers");
    bytes32 internal constant _PENDING_PER_CALLER_KIND = keccak256("PaymasterRelay.setMaxSponsoredOpsPerCaller");

    address public immutable override entryPoint;

    address public override guardian;
    uint256 public override maxSponsoredOps;

    mapping(address caller => bool) public override sponsoredCallers;
    mapping(uint256 blockNumber => uint256 count) public override opsSponsoredThisBlock;
    mapping(address caller => uint256 perBlockCap) public override maxSponsoredOpsPerCaller;
    mapping(address caller => mapping(uint256 blockNumber => uint256 count)) public override opsSponsoredByCallerThisBlock;
    mapping(bytes32 payloadHash => uint64 effectiveAt) internal _pending;

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Unauthorized();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert Unauthorized();
        _;
    }

    constructor(address entryPoint_, address owner_, address guardian_, uint256 maxSponsoredOps_) Ownable(owner_) {
        if (entryPoint_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        guardian = guardian_;
        maxSponsoredOps = maxSponsoredOps_;
        emit GuardianChanged(address(0), guardian_);
        emit MaxSponsoredOpsChanged(0, maxSponsoredOps_);
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 /* maxCost */
    )
        external
        override
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (!sponsoredCallers[userOp.sender]) {
            return ("", SIG_VALIDATION_FAILED);
        }
        uint256 spent = opsSponsoredThisBlock[block.number];
        if (spent >= maxSponsoredOps) {
            emit OpsBudgetExceeded(userOp.sender, block.number, maxSponsoredOps);
            return ("", SIG_VALIDATION_FAILED);
        }
        uint256 perCallerCap = maxSponsoredOpsPerCaller[userOp.sender];
        uint256 callerSpent = opsSponsoredByCallerThisBlock[userOp.sender][block.number];
        if (perCallerCap != 0 && callerSpent >= perCallerCap) {
            emit CallerOpsBudgetExceeded(userOp.sender, block.number, perCallerCap);
            return ("", SIG_VALIDATION_FAILED);
        }
        uint256 newCount = spent + 1;
        opsSponsoredThisBlock[block.number] = newCount;
        opsSponsoredByCallerThisBlock[userOp.sender][block.number] = callerSpent + 1;
        emit Sponsored(userOp.sender, userOpHash, block.number, newCount);
        return ("", SIG_VALIDATION_SUCCESS);
    }

    function postOp(
        PostOpMode, /* mode */
        bytes calldata, /* context */
        uint256, /* actualGasCost */
        uint256 /* actualUserOpFeePerGas */
    )
        external
        override
        onlyEntryPoint
    {
        // intentionally empty
    }

    function setGuardian(address newGuardian) external override onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    function proposeSetMaxSponsoredOps(uint256 newMax) external override onlyOwner {
        bytes32 h = keccak256(abi.encode(_PENDING_MAX_KIND, newMax));
        uint64 effectiveAt = uint64(block.timestamp + TIMELOCK);
        _pending[h] = effectiveAt;
        emit MaxSponsoredOpsProposed(newMax, effectiveAt);
    }

    function executeSetMaxSponsoredOps(uint256 newMax) external override onlyOwner {
        bytes32 h = keccak256(abi.encode(_PENDING_MAX_KIND, newMax));
        uint64 effectiveAt = _pending[h];
        if (effectiveAt == 0) revert NoPendingChange();
        if (block.timestamp < effectiveAt) revert TimelockNotElapsed(effectiveAt);
        delete _pending[h];
        emit MaxSponsoredOpsChanged(maxSponsoredOps, newMax);
        maxSponsoredOps = newMax;
    }

    function proposeSetSponsoredCallers(
        address[] calldata callers,
        bool[] calldata active
    )
        external
        override
        onlyOwner
    {
        if (callers.length != active.length) revert LengthMismatch();
        bytes32 h = keccak256(abi.encode(_PENDING_CALLERS_KIND, callers, active));
        uint64 effectiveAt = uint64(block.timestamp + TIMELOCK);
        _pending[h] = effectiveAt;
        emit SponsoredCallersProposed(h, effectiveAt);
    }

    function executeSetSponsoredCallers(
        address[] calldata callers,
        bool[] calldata active
    )
        external
        override
        onlyOwner
    {
        if (callers.length != active.length) revert LengthMismatch();
        bytes32 h = keccak256(abi.encode(_PENDING_CALLERS_KIND, callers, active));
        uint64 effectiveAt = _pending[h];
        if (effectiveAt == 0) revert NoPendingChange();
        if (block.timestamp < effectiveAt) revert TimelockNotElapsed(effectiveAt);
        delete _pending[h];
        for (uint256 i = 0; i < callers.length; ++i) {
            address c = callers[i];
            if (c == address(0)) revert ZeroAddress();
            sponsoredCallers[c] = active[i];
        }
        emit SponsoredCallersChanged(h);
    }

    function proposeSetMaxSponsoredOpsPerCaller(address caller, uint256 newPerBlockCap) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        bytes32 h = keccak256(abi.encode(_PENDING_PER_CALLER_KIND, caller, newPerBlockCap));
        uint64 effectiveAt = uint64(block.timestamp + TIMELOCK);
        _pending[h] = effectiveAt;
        emit MaxSponsoredOpsPerCallerProposed(caller, newPerBlockCap, effectiveAt);
    }

    function executeSetMaxSponsoredOpsPerCaller(address caller, uint256 newPerBlockCap) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        bytes32 h = keccak256(abi.encode(_PENDING_PER_CALLER_KIND, caller, newPerBlockCap));
        uint64 effectiveAt = _pending[h];
        if (effectiveAt == 0) revert NoPendingChange();
        if (block.timestamp < effectiveAt) revert TimelockNotElapsed(effectiveAt);
        delete _pending[h];
        uint256 oldCap = maxSponsoredOpsPerCaller[caller];
        maxSponsoredOpsPerCaller[caller] = newPerBlockCap;
        emit MaxSponsoredOpsPerCallerChanged(caller, oldCap, newPerBlockCap);
    }

    function topUp() external payable override nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        IEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
        emit DepositToppedUp(msg.sender, msg.value);
    }

    function emergencyUnstake() external override onlyGuardian {
        IEntryPoint(entryPoint).unlockStake();
        emit EmergencyUnstaked(msg.sender);
    }

    function withdrawToOwner(address payable to, uint256 amount) external override onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IEntryPoint(entryPoint).withdrawTo(to, amount);
        emit OwnerWithdrawn(to, amount);
    }

    receive() external payable {}
}

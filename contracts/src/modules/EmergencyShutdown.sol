// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPausable} from "../interfaces/external/IPausable.sol";
import {IEmergencyShutdown} from "../interfaces/IEmergencyShutdown.sol";

/// @dev Minimal local interface for the vault liquidation entry-point. Avoids a circular
///      import between `modules/` and `core/`. Mirrors the function added to `AgentVault`
///      that is restricted to the pauser (this coordinator).
interface IAgentVaultLiquidatable {
    function liquidateBaseAsset(address recipient) external returns (uint256 amountSwept);
}

contract EmergencyShutdown is IEmergencyShutdown, Ownable2Step {
    uint256 public constant override TIMELOCK = 48 hours;
    uint256 public constant override MAX_BATCH = 50;
    uint256 public constant override PAUSE_CALL_GAS = 200_000;

    bool public override globalShutdown;
    uint64 public override pendingResumeAt;
    address[] internal _components;

    mapping(address => bool) internal _registered;
    mapping(address => uint256) internal _index1;
    mapping(address registrar => bool) internal _registrars;

    /// @inheritdoc IEmergencyShutdown
    address public override liquidator;

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    function pausableComponents(uint256 index) external view override returns (address) {
        return _components[index];
    }

    function pausableComponentsLength() external view override returns (uint256) {
        return _components.length;
    }

    function registered(address component) external view override returns (bool) {
        return _registered[component];
    }

    function isShutdown() external view override returns (bool) {
        return globalShutdown;
    }

    function isRegistrar(address registrar) external view override returns (bool) {
        return _registrars[registrar];
    }

    function registerComponent(address c) external override {
        if (msg.sender != owner() && !_registrars[msg.sender]) revert NotRegistrar(msg.sender);
        if (c == address(0)) revert ZeroAddress();
        if (_registered[c]) revert AlreadyRegistered(c);
        if (_components.length >= MAX_BATCH) revert BatchTooLarge(_components.length + 1, MAX_BATCH);
        uint256 sz;
        assembly {
            sz := extcodesize(c)
        }
        if (sz == 0) revert NotAContract(c);
        _registered[c] = true;
        _components.push(c);
        _index1[c] = _components.length;
        emit ComponentRegistered(c);
    }

    function setRegistrar(address registrar, bool active) external override onlyOwner {
        if (registrar == address(0)) revert ZeroAddress();
        _registrars[registrar] = active;
        emit RegistrarSet(registrar, active);
    }

    function unregisterComponent(address c) external override onlyOwner {
        if (!_registered[c]) revert NotRegistered(c);
        uint256 idx1 = _index1[c];
        uint256 lastIdx0 = _components.length - 1;
        if (idx1 - 1 != lastIdx0) {
            address moved = _components[lastIdx0];
            _components[idx1 - 1] = moved;
            _index1[moved] = idx1;
        }
        _components.pop();
        delete _index1[c];
        delete _registered[c];
        emit ComponentUnregistered(c);
    }


    function emergencyShutdown(string calldata reason) external override onlyOwner {
        if (globalShutdown) revert AlreadyShutdown();
        globalShutdown = true;
        // Any prior pending-resume is invalidated.
        pendingResumeAt = 0;

        uint256 len = _components.length;
        (uint256 paused, uint256 failures) = _pauseRange(0, len);
        emit ShutdownActivated(reason, paused);
        if (failures != 0) {
            emit ShutdownPartial(paused, failures);
        }
    }

    function emergencyShutdownRange(uint256 from, uint256 to, string calldata reason)
        external
        override
        onlyOwner
    {
        uint256 len = _components.length;
        if (from > to || to > len) revert InvalidRange(from, to);
        if (from == to) revert InvalidRange(from, to);
        if (!globalShutdown) {
            globalShutdown = true;
            pendingResumeAt = 0;
        }
        (uint256 paused, uint256 failures) = _pauseRange(from, to);
        emit ShutdownActivated(reason, paused);
        if (failures != 0) {
            emit ShutdownPartial(paused, failures);
        }
    }

    function _pauseRange(uint256 from, uint256 to) internal returns (uint256 paused, uint256 failures) {
        for (uint256 i = from; i < to; ++i) {
            address c = _components[i];
            (bool ok,) = c.call{gas: PAUSE_CALL_GAS}(abi.encodeCall(IPausable.pause, ()));
            if (ok) {
                ++paused;
            } else {
                ++failures;
            }
        }
    }

    function proposeResume() external override onlyOwner {
        if (!globalShutdown) revert NotShutdown();
        uint64 effectiveAt = uint64(block.timestamp + TIMELOCK);
        pendingResumeAt = effectiveAt;
        emit ResumeProposed(effectiveAt);
    }

    function executeResume() external override onlyOwner {
        if (!globalShutdown) revert NotShutdown();
        uint64 effectiveAt = pendingResumeAt;
        if (effectiveAt == 0) revert NoPendingResume();
        if (block.timestamp < effectiveAt) revert ResumeTimelockNotElapsed(effectiveAt);

        pendingResumeAt = 0;
        globalShutdown = false;

        uint256 resumed = 0;
        uint256 len = _components.length;
        for (uint256 i = 0; i < len; ++i) {
            address c = _components[i];
            (bool ok,) = c.call{gas: PAUSE_CALL_GAS}(abi.encodeCall(IPausable.unpause, ()));
            if (ok) ++resumed;
        }
        emit ResumeExecuted(resumed);
    }

    function cancelResume() external override onlyOwner {
        if (pendingResumeAt == 0) revert NoPendingResume();
        pendingResumeAt = 0;
        emit ResumeCancelled();
    }

    /// @inheritdoc IEmergencyShutdown
    function setLiquidator(address liquidator_, bool active) external override onlyOwner {
        if (liquidator_ == address(0)) revert ZeroAddress();
        // Active assignment overwrites any prior liquidator. Revocation only clears if the
        // current liquidator matches; this prevents an accidental clear by toggling a stale
        // address.
        if (active) {
            liquidator = liquidator_;
        } else if (liquidator == liquidator_) {
            liquidator = address(0);
        }
        emit LiquidatorSet(liquidator_, active);
    }

    /// @inheritdoc IEmergencyShutdown
    /// @dev    Authorisation: only the address stored in `liquidator`. The function does NOT
    ///         pause the vault: per the Tilt invariant, vault withdraw / redeem paths must
    ///         remain available even after liquidation. The seize amount is whatever USDC
    ///         balance the vault holds at call time (see `AgentVault.liquidateBaseAsset`).
    ///         Reentrancy: this function performs exactly one external call (to the vault)
    ///         after a registry read; no state on this coordinator is mutated as a side
    ///         effect, so no `nonReentrant` modifier is required at this layer. The
    ///         downstream `LiquidationExecutor` is the reentrancy boundary for the keeper.
    function liquidate(uint256 tokenId, address vault)
        external
        override
        returns (uint256 amountSwept)
    {
        if (msg.sender != liquidator || liquidator == address(0)) revert NotLiquidator(msg.sender);
        if (vault == address(0)) revert ZeroAddress();
        if (!_registered[vault]) revert VaultNotRegistered(vault);

        amountSwept = IAgentVaultLiquidatable(vault).liquidateBaseAsset(msg.sender);
        emit VaultLiquidated(tokenId, vault, msg.sender, amountSwept);
    }
}

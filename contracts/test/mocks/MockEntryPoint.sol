// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IEntryPoint} from "../../src/interfaces/external/IEntryPoint.sol";

/// @title MockEntryPoint
/// @notice Minimal ERC-4337 v0.7 EntryPoint surface used by `PaymasterRelay` unit tests.
///         Implements the subset of `IStakeManager` (depositTo, balanceOf, addStake,
///         unlockStake, withdrawStake, withdrawTo) needed by the paymaster, plus a
///         single `call` helper to surface a paymaster's `validatePaymasterUserOp` and
///         `postOp` from the EntryPoint's address (matches the `onlyEntryPoint` guard).
contract MockEntryPoint is IEntryPoint {
    struct Deposit {
        uint256 balance;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    mapping(address => Deposit) public deposits;

    function depositTo(address account) external payable override {
        deposits[account].balance += msg.value;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return deposits[account].balance;
    }

    function addStake(uint32 unstakeDelaySec) external payable override {
        Deposit storage d = deposits[msg.sender];
        d.staked = true;
        d.stake += uint112(msg.value);
        d.unstakeDelaySec = unstakeDelaySec;
        d.withdrawTime = 0;
    }

    function unlockStake() external override {
        Deposit storage d = deposits[msg.sender];
        require(d.staked, "not staked");
        d.withdrawTime = uint48(block.timestamp + d.unstakeDelaySec);
    }

    function withdrawStake(address payable withdrawAddress) external override {
        Deposit storage d = deposits[msg.sender];
        require(d.withdrawTime != 0, "must call unlockStake");
        require(block.timestamp >= d.withdrawTime, "stake withdrawal not due");
        uint256 stake = d.stake;
        d.stake = 0;
        d.staked = false;
        d.withdrawTime = 0;
        (bool ok,) = withdrawAddress.call{value: stake}("");
        require(ok, "stake xfer failed");
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external override {
        Deposit storage d = deposits[msg.sender];
        require(d.balance >= withdrawAmount, "insufficient deposit");
        d.balance -= withdrawAmount;
        (bool ok,) = withdrawAddress.call{value: withdrawAmount}("");
        require(ok, "withdraw xfer failed");
    }

    /// @notice Forward a raw call from this mock to `target` (matches the production
    ///         EntryPoint passing through to `paymaster.validatePaymasterUserOp` /
    ///         `paymaster.postOp`).
    function callPaymaster(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // bubble revert
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {}
}

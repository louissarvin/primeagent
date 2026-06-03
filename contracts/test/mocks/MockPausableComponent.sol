// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title MockPausableComponent
/// @notice Test fixture that lets a single trusted controller (the `EmergencyShutdown`
///         contract) call `pause()` and `unpause()`. Uses OpenZeppelin v5 `Pausable`
///         under the hood so behaviour matches AgentVault / Adapter pause semantics.
contract MockPausableComponent is Pausable {
    address public immutable controller;

    bool public alwaysRevert; // when true, pause() and unpause() revert; used to test partial-shutdown counts

    error NotController();

    constructor(address controller_) {
        controller = controller_;
    }

    function setAlwaysRevert(bool v) external {
        alwaysRevert = v;
    }

    function pause() external {
        if (msg.sender != controller) revert NotController();
        if (alwaysRevert) revert("forced revert");
        _pause();
    }

    function unpause() external {
        if (msg.sender != controller) revert NotController();
        if (alwaysRevert) revert("forced revert");
        _unpause();
    }
}

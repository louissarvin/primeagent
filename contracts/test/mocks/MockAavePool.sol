// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAavePool} from "../../src/interfaces/external/IAavePool.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Synchronous Aave V3-style pool mock used by ArbitrumOneAdapter unit tests.
/// @dev    Behaviour:
///         - `supply` pulls `amount` of `asset` from the caller into the pool. No aTokens are
///           minted (the adapter does not read aToken balances in v1).
///         - `withdraw` transfers `amount` of `asset` from the pool to `to`.
///         - `borrow` transfers `amount` of `asset` from the pool to `onBehalfOf`. The pool is
///           pre-funded by tests.
///         - `repay` pulls `min(amount, repayCap[asset])` of `asset` from the caller into the
///           pool when `repayCap[asset] > 0`; otherwise pulls the full `amount`. The returned
///           value is the actually-pulled amount so tests for S-M-4 can simulate Aave's
///           partial-repay behaviour deterministically.
contract MockAavePool is IAavePool {
    using SafeERC20 for IERC20;

    event Supplied(address asset, uint256 amount, address onBehalfOf);
    event Withdrawn(address asset, uint256 amount, address to);
    event Borrowed(address asset, uint256 amount, address onBehalfOf);
    event Repaid(address asset, uint256 amount, address onBehalfOf);

    /// @notice Per-asset cap on a single `repay` call. When zero (default) the mock pulls the
    ///         requested `amount` in full. Tests set this to simulate the on-chain debt being
    ///         smaller than the requested repay (the canonical Aave V3 partial-repay surface).
    mapping(address asset => uint256 cap) public repayCap;

    /// @notice Test helper: set the per-asset cap for the next `repay` call(s).
    function setRepayCap(address asset, uint256 cap) external {
        repayCap[asset] = cap;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(asset, amount, onBehalfOf);
    }

    function withdraw(address asset, uint256 amount, address to) external override returns (uint256) {
        IERC20(asset).safeTransfer(to, amount);
        emit Withdrawn(asset, amount, to);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external override {
        IERC20(asset).safeTransfer(onBehalfOf, amount);
        emit Borrowed(asset, amount, onBehalfOf);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf)
        external
        override
        returns (uint256)
    {
        uint256 cap = repayCap[asset];
        uint256 actual = cap == 0 || cap >= amount ? amount : cap;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), actual);
        emit Repaid(asset, actual, onBehalfOf);
        return actual;
    }
}

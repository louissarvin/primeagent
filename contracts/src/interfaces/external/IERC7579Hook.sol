// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Module} from "./IERC7579Module.sol";

/// @title IERC7579Hook
/// @notice ERC-7579 Hook module surface (moduleType = 4).
/// @dev `preCheck` runs before each call body in an `execute` userOp; `postCheck` runs after.
interface IERC7579Hook is IERC7579Module {
    /// @notice Called before each call body executes inside `Kernel.execute`.
    /// @param msgSender Address that triggered the execution (typically the smart account itself).
    /// @param value ETH value forwarded with the call body.
    /// @param callData Encoded call body (target / value / data per ERC-7579 mode encoding).
    /// @return hookData Opaque data passed through to `postCheck`.
    function preCheck(
        address msgSender,
        uint256 value,
        bytes calldata callData
    )
        external
        returns (bytes memory hookData);

    /// @notice Called after each call body completes.
    function postCheck(bytes calldata hookData) external;
}

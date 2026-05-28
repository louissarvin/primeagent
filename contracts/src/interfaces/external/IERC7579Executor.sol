// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Module} from "./IERC7579Module.sol";

interface IERC7579Executor is IERC7579Module {
    function execute(
        address account,
        address target,
        uint256 value,
        bytes calldata callData
    )
        external
        returns (bytes memory result);
}

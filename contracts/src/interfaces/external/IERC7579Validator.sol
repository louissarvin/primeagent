// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC7579Module} from "./IERC7579Module.sol";

interface IERC7579Validator is IERC7579Module {
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    )
        external
        returns (uint256 validationData);

    function isValidSignatureWithSender(
        address sender,
        bytes32 hash,
        bytes calldata signature
    )
        external
        view
        returns (bytes4);
}

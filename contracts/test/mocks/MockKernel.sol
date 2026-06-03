// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {IERC7579Hook} from "../../src/interfaces/external/IERC7579Hook.sol";
import {IERC7579Validator} from "../../src/interfaces/external/IERC7579Validator.sol";

/// @dev Minimal test double that imitates the ZeroDev Kernel surface needed by Group B's modules:
///        - `installHook(...)` records the hook address (so `msg.sender` on the hook side is this
///          MockKernel; the modules namespace storage by `msg.sender`).
///        - `installValidator(...)` does the same for the validator.
///        - `executeViaHook(target, value, data)` calls `hook.preCheck(...)` with the canonical
///          `(address,uint256,bytes)` call-body encoding, then `hook.postCheck(...)`.
///        - `validateUserOp(...)` forwards a `PackedUserOperation` to the bound validator.
contract MockKernel {
    address public hook;
    address public validator;

    function installHook(address hook_, bytes calldata initData) external {
        hook = hook_;
        IERC7579Hook(hook_).onInstall(initData);
    }

    function uninstallHook(bytes calldata data) external {
        IERC7579Hook(hook).onUninstall(data);
        hook = address(0);
    }

    function installValidator(address validator_, bytes calldata initData) external {
        validator = validator_;
        IERC7579Validator(validator_).onInstall(initData);
    }

    function uninstallValidator(bytes calldata data) external {
        IERC7579Validator(validator).onUninstall(data);
        validator = address(0);
    }

    function executeViaHook(
        address target,
        uint256 value,
        bytes calldata data
    )
        external
        returns (bytes memory hookData)
    {
        bytes memory callBody = abi.encode(target, value, data);
        hookData = IERC7579Hook(hook).preCheck(address(this), value, callBody);
        IERC7579Hook(hook).postCheck(hookData);
    }

    function callPreCheckOnly(
        address target,
        uint256 value,
        bytes calldata data
    )
        external
        returns (bytes memory hookData)
    {
        bytes memory callBody = abi.encode(target, value, data);
        hookData = IERC7579Hook(hook).preCheck(address(this), value, callBody);
    }

    function validateUserOp(
        PackedUserOperation calldata op,
        bytes32 userOpHash
    )
        external
        returns (uint256 validationData)
    {
        validationData = IERC7579Validator(validator).validateUserOp(op, userOpHash);
    }
}

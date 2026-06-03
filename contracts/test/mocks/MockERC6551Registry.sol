// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC6551Registry} from "../../src/interfaces/external/IERC6551Registry.sol";

/// @title MockERC6551Registry
/// @notice Deterministic mock registry. `createAccount` and `account` return the same
///         CREATE2-flavored address derived from the input tuple. The registry does NOT actually
///         deploy any contract; it returns a unique address per tuple and emits the event.
/// @dev Sufficient for Factory unit tests that only care about the address and the event.
contract MockERC6551Registry is IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    )
        external
        returns (address acct)
    {
        acct = _predict(implementation, salt, chainId, tokenContract, tokenId);
        emit ERC6551AccountCreated(acct, implementation, salt, chainId, tokenContract, tokenId);
    }

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    )
        external
        pure
        returns (address acct)
    {
        return _predict(implementation, salt, chainId, tokenContract, tokenId);
    }

    function _predict(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    )
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encode(implementation, salt, chainId, tokenContract, tokenId)))));
    }
}

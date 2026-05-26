// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title IDiamondCut
/// @notice Canonical EIP-2535 DiamondCut interface.
/// @dev Source: https://eips.ethereum.org/EIPS/eip-2535
interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    /// @notice Emitted by the DiamondCut function.
    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);

    /// @notice Add/Replace/Remove any number of functions and optionally execute a function with
    ///         delegatecall.
    /// @param _diamondCut Contains the facet addresses and function selectors.
    /// @param _init Address of contract or facet to delegatecall on (address(0) skips init).
    /// @param _calldata Function call with arguments for the init function.
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external;
}

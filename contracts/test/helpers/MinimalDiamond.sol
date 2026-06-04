// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";

/// @title MinimalDiamond
/// @notice Minimal EIP-2535 diamond used exclusively to exercise the standalone
///         `DiamondCutFacet` and `DiamondLoupeFacet` in unit tests.
/// @dev    The production `PrimeAgentDiamond` implements `diamondCut` and loupe inline (with a
///         48h timelock). The standalone facets cannot be cut into it because the selectors
///         collide. To verify the facets behave canonically per EIP-2535 we deploy this minimal
///         proxy in tests: it routes any unknown selector through `delegatecall` to the facet
///         table in `LibDiamond.diamondStorage()`.
///
///         The constructor takes a single initial cut, exactly mirroring the canonical Mudge
///         reference impl, and the diamond owner is set to `_owner` via `LibDiamond.setContractOwner`.
contract MinimalDiamond {
    error FunctionNotFound(bytes4 selector);

    constructor(address _owner, IDiamondCut.FacetCut[] memory _cut, address _init, bytes memory _calldata) {
        LibDiamond.setContractOwner(_owner);
        LibDiamond.diamondCut(_cut, _init, _calldata);
    }

    /// @dev Routes every unknown selector to the matching facet via `delegatecall`. Mirrors the
    ///      pattern in `PrimeAgentDiamond.fallback`.
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        if (facet == address(0)) revert FunctionNotFound(msg.sig);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}

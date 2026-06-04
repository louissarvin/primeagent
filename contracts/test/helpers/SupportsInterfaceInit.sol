// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";

/// @title SupportsInterfaceInit
/// @notice Init contract used by `MinimalDiamond` to seed the ERC-165 + ERC-2535 interface ids
///         in `LibDiamond.diamondStorage().supportedInterfaces`. Invoked via `delegatecall` from
///         the diamond constructor exactly the way `DiamondInit` is invoked on
///         `PrimeAgentDiamond` in production.
contract SupportsInterfaceInit {
    function init() external {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
    }
}

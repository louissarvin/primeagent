// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IDiamondCut} from "./IDiamondCut.sol";

interface IPrimeAgentDiamond {
    event DiamondCutProposed(bytes32 indexed cutHash, uint64 effectiveAt);
    event DiamondCutExecuted(bytes32 indexed cutHash);
    event DiamondCutCancelled(bytes32 indexed cutHash);
    function CUT_TIMELOCK() external view returns (uint256);
    function proposeDiamondCut(
        IDiamondCut.FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external;
    function executeDiamondCut(
        IDiamondCut.FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external;
    function cancelDiamondCut(bytes32 cutHash) external;
    function pendingCutEffectiveAt(bytes32 cutHash) external view returns (uint64);
    function isCutExecuted(bytes32 cutHash) external view returns (bool);
    function hashCut(
        IDiamondCut.FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external
        pure
        returns (bytes32);
}

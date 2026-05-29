// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IPrimeAgentDiamond} from "../interfaces/IPrimeAgentDiamond.sol";

contract PrimeAgentDiamond is Ownable2Step, IDiamondCut, IDiamondLoupe, IPrimeAgentDiamond {
    error FunctionNotFound(bytes4 selector);
    error CutNotPending();
    error CutTimelockNotElapsed(uint64 effectiveAt);
    error CutAlreadyPending();
    error TimelockBypassNotAvailable();
    error CutAlreadyExecuted();

    uint256 public constant CUT_TIMELOCK = 48 hours;

    mapping(bytes32 cutHash => uint64 effectiveAt) internal _pendingCuts;
    mapping(bytes32 cutHash => bool executed) internal _executedCuts;

    constructor(
        address _owner,
        FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    )
        Ownable(_owner)
    {
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }

    function proposeDiamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external
        onlyOwner
    {
        bytes32 cutHash = _hashCut(_diamondCut, _init, _calldata);
        if (_executedCuts[cutHash]) revert CutAlreadyExecuted();
        if (_pendingCuts[cutHash] != 0) revert CutAlreadyPending();
        uint64 effectiveAt = uint64(block.timestamp + CUT_TIMELOCK);
        _pendingCuts[cutHash] = effectiveAt;
        emit DiamondCutProposed(cutHash, effectiveAt);
    }

    function executeDiamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external
        onlyOwner
    {
        bytes32 cutHash = _hashCut(_diamondCut, _init, _calldata);
        if (_executedCuts[cutHash]) revert CutAlreadyExecuted();
        uint64 effectiveAt = _pendingCuts[cutHash];
        if (effectiveAt == 0) revert CutNotPending();
        if (uint64(block.timestamp) < effectiveAt) revert CutTimelockNotElapsed(effectiveAt);

        delete _pendingCuts[cutHash];
        _executedCuts[cutHash] = true;
        emit DiamondCutExecuted(cutHash);

        FacetCut[] memory cutMem = _copyCutToMemory(_diamondCut);
        bytes memory cdMem = _calldata;
        LibDiamond.diamondCut(cutMem, _init, cdMem);
    }

    function cancelDiamondCut(bytes32 cutHash) external onlyOwner {
        if (_pendingCuts[cutHash] == 0) revert CutNotPending();
        delete _pendingCuts[cutHash];
        emit DiamondCutCancelled(cutHash);
    }

    function pendingCutEffectiveAt(bytes32 cutHash) external view returns (uint64) {
        return _pendingCuts[cutHash];
    }

    function isCutExecuted(bytes32 cutHash) external view returns (bool) {
        return _executedCuts[cutHash];
    }

    function hashCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        external
        pure
        returns (bytes32)
    {
        return _hashCut(_diamondCut, _init, _calldata);
    }

    function diamondCut(FacetCut[] calldata, address, bytes calldata) external view onlyOwner {
        revert TimelockBypassNotAvailable();
    }

    function facets() external view returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 n = ds.facetAddresses.length;
        facets_ = new Facet[](n);
        for (uint256 i; i < n; ++i) {
            address f = ds.facetAddresses[i];
            facets_[i] = Facet({facetAddress: f, functionSelectors: ds.facetFunctionSelectors[f]});
        }
    }

    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory) {
        return LibDiamond.diamondStorage().facetFunctionSelectors[_facet];
    }

    function facetAddresses() external view returns (address[] memory) {
        return LibDiamond.diamondStorage().facetAddresses;
    }

    function facetAddress(bytes4 _functionSelector) external view returns (address) {
        return LibDiamond.diamondStorage().selectorToFacetAndPosition[_functionSelector].facetAddress;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return LibDiamond.diamondStorage().supportedInterfaces[interfaceId];
    }

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

    function _hashCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    )
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(_diamondCut, _init, _calldata));
    }

    function _copyCutToMemory(FacetCut[] calldata src) internal pure returns (FacetCut[] memory dst) {
        dst = new FacetCut[](src.length);
        for (uint256 i; i < src.length; ++i) {
            dst[i] = FacetCut({
                facetAddress: src[i].facetAddress,
                action: src[i].action,
                functionSelectors: src[i].functionSelectors
            });
        }
    }
}

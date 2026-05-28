// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";

library LibDiamond {
    error NotContractOwner(address caller, address owner);
    error IncorrectFacetCutAction(uint8 action);
    error NoSelectorsInFacet();
    error CannotAddSelectorsToZeroAddress();
    error SelectorAlreadyAdded(bytes4 selector);
    error CannotReplaceImmutableFunction(bytes4 selector);
    error CannotReplaceFunctionWithSameFunctionFromSameFacet(bytes4 selector);
    error CannotReplaceFunctionThatDoesNotExist(bytes4 selector);
    error CannotRemoveImmutableFunction(bytes4 selector);
    error CannotRemoveFunctionThatDoesNotExist(bytes4 selector);
    error RemoveFacetAddressMustBeZeroAddress(address facet);
    error InitAddressHasNoCode(address init);
    error InitFunctionReverted(address init, bytes data);
    error NoBytecodeAtAddress(address facet);
    
    bytes32 internal constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");

    struct FacetAddressAndSelectorPosition {
        address facetAddress;
        uint16 selectorPosition;
    }

    struct DiamondStorage {
        mapping(bytes4 => FacetAddressAndSelectorPosition) selectorToFacetAndPosition;
        mapping(address => bytes4[]) facetFunctionSelectors;
        address[] facetAddresses;
        mapping(bytes4 => bool) supportedInterfaces;
        address contractOwner;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DiamondCut(IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata);


    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        address previousOwner = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previousOwner, _newOwner);
    }

    function contractOwner() internal view returns (address contractOwner_) {
        contractOwner_ = diamondStorage().contractOwner;
    }

    function enforceIsContractOwner() internal view {
        if (msg.sender != diamondStorage().contractOwner) {
            revert NotContractOwner(msg.sender, diamondStorage().contractOwner);
        }
    }

    function diamondCut(IDiamondCut.FacetCut[] memory _diamondCut, address _init, bytes memory _calldata) internal {
        for (uint256 facetIndex; facetIndex < _diamondCut.length; facetIndex++) {
            IDiamondCut.FacetCutAction action = _diamondCut[facetIndex].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else {
                revert IncorrectFacetCutAction(uint8(action));
            }
        }
        emit DiamondCut(_diamondCut, _init, _calldata);
        initializeDiamondCut(_init, _calldata);
    }

    function addFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) revert NoSelectorsInFacet();
        if (_facetAddress == address(0)) revert CannotAddSelectorsToZeroAddress();
        DiamondStorage storage ds = diamondStorage();
        uint16 selectorCount = uint16(ds.facetFunctionSelectors[_facetAddress].length);
        if (selectorCount == 0) {
            enforceHasContractCode(_facetAddress);
            ds.facetAddresses.push(_facetAddress);
        }
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (oldFacetAddress != address(0)) revert SelectorAlreadyAdded(selector);
            ds.facetFunctionSelectors[_facetAddress].push(selector);
            ds.selectorToFacetAndPosition[selector] =
                FacetAddressAndSelectorPosition({facetAddress: _facetAddress, selectorPosition: selectorCount});
            selectorCount++;
        }
    }

    function replaceFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) revert NoSelectorsInFacet();
        if (_facetAddress == address(0)) revert CannotAddSelectorsToZeroAddress();
        DiamondStorage storage ds = diamondStorage();
        enforceHasContractCode(_facetAddress);
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (oldFacetAddress == address(this)) revert CannotReplaceImmutableFunction(selector);
            if (oldFacetAddress == _facetAddress) revert CannotReplaceFunctionWithSameFunctionFromSameFacet(selector);
            if (oldFacetAddress == address(0)) revert CannotReplaceFunctionThatDoesNotExist(selector);
            removeFunction(ds, oldFacetAddress, selector);
            uint16 selectorCount = uint16(ds.facetFunctionSelectors[_facetAddress].length);
            if (selectorCount == 0) {
                ds.facetAddresses.push(_facetAddress);
            }
            ds.facetFunctionSelectors[_facetAddress].push(selector);
            ds.selectorToFacetAndPosition[selector] =
                FacetAddressAndSelectorPosition({facetAddress: _facetAddress, selectorPosition: selectorCount});
        }
    }

    function removeFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) revert NoSelectorsInFacet();
        if (_facetAddress != address(0)) revert RemoveFacetAddressMustBeZeroAddress(_facetAddress);
        DiamondStorage storage ds = diamondStorage();
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            removeFunction(ds, oldFacetAddress, selector);
        }
    }

    function removeFunction(DiamondStorage storage ds, address _facetAddress, bytes4 _selector) internal {
        if (_facetAddress == address(0)) revert CannotRemoveFunctionThatDoesNotExist(_selector);
        if (_facetAddress == address(this)) revert CannotRemoveImmutableFunction(_selector);
        uint256 selectorPosition = ds.selectorToFacetAndPosition[_selector].selectorPosition;
        uint256 lastSelectorPosition = ds.facetFunctionSelectors[_facetAddress].length - 1;
        if (selectorPosition != lastSelectorPosition) {
            bytes4 lastSelector = ds.facetFunctionSelectors[_facetAddress][lastSelectorPosition];
            ds.facetFunctionSelectors[_facetAddress][selectorPosition] = lastSelector;
            ds.selectorToFacetAndPosition[lastSelector].selectorPosition = uint16(selectorPosition);
        }
        ds.facetFunctionSelectors[_facetAddress].pop();
        delete ds.selectorToFacetAndPosition[_selector];

        if (lastSelectorPosition == 0) {
            uint256 lastFacetAddressPosition = ds.facetAddresses.length - 1;
            uint256 facetAddressPosition = 0;
            for (uint256 i; i < ds.facetAddresses.length; i++) {
                if (ds.facetAddresses[i] == _facetAddress) {
                    facetAddressPosition = i;
                    break;
                }
            }
            if (facetAddressPosition != lastFacetAddressPosition) {
                ds.facetAddresses[facetAddressPosition] = ds.facetAddresses[lastFacetAddressPosition];
            }
            ds.facetAddresses.pop();
        }
    }

    function initializeDiamondCut(address _init, bytes memory _calldata) internal {
        if (_init == address(0)) return;
        enforceHasContractCode(_init);
        (bool success, bytes memory error) = _init.delegatecall(_calldata);
        if (!success) revert InitFunctionReverted(_init, error);
    }

    function enforceHasContractCode(address _contract) internal view {
        uint256 contractSize;
        assembly {
            contractSize := extcodesize(_contract)
        }
        if (contractSize == 0) revert NoBytecodeAtAddress(_contract);
    }
}

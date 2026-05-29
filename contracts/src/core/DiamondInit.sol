// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IErc7715PolicyAuditFacet} from "../interfaces/IErc7715PolicyAuditFacet.sol";

contract DiamondInit {
    struct AuditStorageMirror {
        mapping(uint256 => bytes) policies; 
        mapping(uint256 => bool) installed; 
        address factory;
        address positionNFT;
    }

    struct InitArgs {
        address auditFactory;
        address auditPositionNFT;
    }

    bytes32 internal constant AUDIT_STORAGE_POSITION = keccak256("primeagent.audit.storage");

    event AuditFacetInitialized(address indexed factory, address indexed positionNFT);

    function init(InitArgs calldata args) external {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IErc7715PolicyAuditFacet).interfaceId] = true;

        if (args.auditFactory != address(0) && args.auditPositionNFT != address(0)) {
            _seedAudit(args.auditFactory, args.auditPositionNFT);
            emit AuditFacetInitialized(args.auditFactory, args.auditPositionNFT);
        }
    }

    function _seedAudit(address factory_, address nft_) internal {
        AuditStorageMirror storage s;
        bytes32 slot = AUDIT_STORAGE_POSITION;
        assembly {
            s.slot := slot
        }
        s.factory = factory_;
        s.positionNFT = nft_;
    }
}

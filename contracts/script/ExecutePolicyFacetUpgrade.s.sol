// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Erc7715PolicyAuditFacet} from "../src/modules/Erc7715PolicyAuditFacet.sol";
import {PrimeAgentDiamond} from "../src/core/PrimeAgentDiamond.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";

/// @title ExecutePolicyFacetUpgrade
/// @notice Sibling to `UpgradePolicyFacet.s.sol`. Re-derives the EXACT same cut payload
///         and calls `executeDiamondCut` after the 48h timelock has elapsed. The cut hash
///         is content-addressed (`keccak256(abi.encode(cuts, init, calldata))`), so any
///         drift between the proposal and the execution payload will revert with
///         `CutNotPending` at the diamond, which is the desired safety property.
///
/// @dev    Required env:
///           - DIAMOND       : the PrimeAgentDiamond address
///           - POLICY_FACET  : the new Erc7715PolicyAuditFacet address printed by the
///                             propose script
///
/// Live execution (after 48h timelock):
///   forge script script/ExecutePolicyFacetUpgrade.s.sol:ExecutePolicyFacetUpgrade \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract ExecutePolicyFacetUpgrade is Script {
    error DiamondAddressZero();
    error FacetAddressZero();

    function run() external {
        address diamondAddr = vm.envAddress("DIAMOND");
        if (diamondAddr == address(0)) revert DiamondAddressZero();
        address facetAddr = vm.envAddress("POLICY_FACET");
        if (facetAddr == address(0)) revert FacetAddressZero();
        PrimeAgentDiamond diamond = PrimeAgentDiamond(payable(diamondAddr));

        console2.log("ExecutePolicyFacetUpgrade");
        console2.log("  diamond", diamondAddr);
        console2.log("  facet", facetAddr);

        bytes4[] memory replaceSel = new bytes4[](2);
        replaceSel[0] = Erc7715PolicyAuditFacet.installPermission.selector;
        replaceSel[1] = Erc7715PolicyAuditFacet.updatePermission.selector;

        bytes4[] memory addSel = new bytes4[](3);
        addSel[0] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        addSel[1] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        addSel[2] = Erc7715PolicyAuditFacet.getPresetHash.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: facetAddr,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSel
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: facetAddr,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSel
        });
        address initAddr = address(0);
        bytes memory initCalldata = bytes("");

        bytes32 cutHash = keccak256(abi.encode(cuts, initAddr, initCalldata));
        uint64 effectiveAt = diamond.pendingCutEffectiveAt(cutHash);
        console2.log("  cutHash");
        console2.logBytes32(cutHash);
        console2.log("  effectiveAt", uint256(effectiveAt));
        console2.log("  block.timestamp", block.timestamp);

        vm.startBroadcast();
        diamond.executeDiamondCut(cuts, initAddr, initCalldata);
        vm.stopBroadcast();

        console2.log("  executed");
    }
}

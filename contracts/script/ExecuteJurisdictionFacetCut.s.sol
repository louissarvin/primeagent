// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {JurisdictionPolicyFacet} from "../src/modules/JurisdictionPolicyFacet.sol";
import {PrimeAgentDiamond} from "../src/core/PrimeAgentDiamond.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";

/// @title ExecuteJurisdictionFacetCut
/// @notice Sibling to `ProposeJurisdictionFacetCut.s.sol`. Re-derives the EXACT same
///         cut payload and calls `executeDiamondCut` after the 48h timelock has
///         elapsed. The cut hash is content-addressed
///         (`keccak256(abi.encode(cuts, init, calldata))`), so any drift between the
///         proposal and the execution payload will revert with `CutNotPending` at the
///         Diamond, which is the desired safety property. The script also refuses to
///         broadcast if the on-chain `effectiveAt` is still in the future.
///
/// @dev    Required env:
///           - DIAMOND              : the PrimeAgentDiamond address
///           - JURISDICTION_FACET   : the new facet address printed by the propose script
///
/// Live execution (after 48h timelock):
///   DIAMOND=0x... JURISDICTION_FACET=0x... \
///     forge script script/ExecuteJurisdictionFacetCut.s.sol:ExecuteJurisdictionFacetCut \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract ExecuteJurisdictionFacetCut is Script {
    error DiamondAddressZero();
    error FacetAddressZero();
    error CutNotProposedOnChain(bytes32 cutHash);
    error CutTimelockNotElapsed(uint64 effectiveAt, uint256 nowTs);

    function run() external {
        address diamondAddr = vm.envAddress("DIAMOND");
        if (diamondAddr == address(0)) revert DiamondAddressZero();
        address facetAddr = vm.envAddress("JURISDICTION_FACET");
        if (facetAddr == address(0)) revert FacetAddressZero();
        PrimeAgentDiamond diamond = PrimeAgentDiamond(payable(diamondAddr));

        console2.log("ExecuteJurisdictionFacetCut");
        console2.log("  diamond", diamondAddr);
        console2.log("  facet", facetAddr);

        bytes4[] memory addSel = _selectors();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
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

        if (effectiveAt == 0) revert CutNotProposedOnChain(cutHash);
        if (uint64(block.timestamp) < effectiveAt) {
            revert CutTimelockNotElapsed(effectiveAt, block.timestamp);
        }

        vm.startBroadcast();
        diamond.executeDiamondCut(cuts, initAddr, initCalldata);
        vm.stopBroadcast();

        console2.log("  executed");
    }

    function _selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = JurisdictionPolicyFacet.pauseForJurisdiction.selector;
        s[1] = JurisdictionPolicyFacet.unpauseForJurisdiction.selector;
        s[2] = JurisdictionPolicyFacet.isPausedForJurisdiction.selector;
        s[3] = JurisdictionPolicyFacet.getPauseVersion.selector;
    }
}

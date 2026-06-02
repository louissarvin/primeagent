// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {JurisdictionPolicyFacet} from "../src/modules/JurisdictionPolicyFacet.sol";
import {PrimeAgentDiamond} from "../src/core/PrimeAgentDiamond.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";

/// @title ProposeJurisdictionFacetCut
/// @notice Feature P ops script. Deploys the new `JurisdictionPolicyFacet` and
///         PROPOSES a 48h-timelocked Diamond cut that ADDs the 4 new selectors:
///           - `pauseForJurisdiction(uint256,bytes2)`
///           - `unpauseForJurisdiction(uint256,bytes2)`
///           - `isPausedForJurisdiction(uint256,bytes2)`
///           - `getPauseVersion(uint256)`
///
/// @dev    Storage layout safety. The facet uses a fresh namespaced storage slot
///         (`keccak256("primeagent.facets.jurisdictionpolicy.v1")`) that does NOT
///         collide with the existing AuditStorage or DiamondStorage slots. The facet
///         only READS from `AuditStorage` (to resolve PositionNFT for ownership
///         checks); it never writes to that slot.
///
/// @dev    The cut payload is content-addressed via
///         `keccak256(abi.encode(cuts, init, calldata))`. The sibling
///         `ExecuteJurisdictionFacetCut.s.sol` script re-derives the EXACT same
///         payload after the 48h timelock. Any drift between propose and execute
///         will revert with `CutNotPending` at the Diamond.
///
///         The script also writes a JSON artefact to
///         `contracts/script/jurisdiction_cut_proposed.json` carrying the facet
///         address, the 4 selectors, the cut hash, and the propose timestamp so
///         the operator (and tests) can verify execution.
///
/// Dry run (no broadcast):
///   DIAMOND=0x0000000000000000000000000000000000001234 \
///     forge script script/ProposeJurisdictionFacetCut.s.sol:ProposeJurisdictionFacetCut \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC
///
/// Live (proposes the cut; executes 48h later via the sibling script):
///   DIAMOND=0x... \
///     forge script script/ProposeJurisdictionFacetCut.s.sol:ProposeJurisdictionFacetCut \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract ProposeJurisdictionFacetCut is Script {
    error DiamondAddressZero();

    function run() external {
        address diamondAddr = vm.envAddress("DIAMOND");
        if (diamondAddr == address(0)) revert DiamondAddressZero();
        PrimeAgentDiamond diamond = PrimeAgentDiamond(payable(diamondAddr));

        console2.log("ProposeJurisdictionFacetCut");
        console2.log("  diamond", diamondAddr);

        vm.startBroadcast();
        JurisdictionPolicyFacet newFacet = new JurisdictionPolicyFacet();
        vm.stopBroadcast();

        console2.log("  new facet (deployed)", address(newFacet));

        bytes4[] memory addSel = _selectors();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSel
        });

        address initAddr = address(0);
        bytes memory initCalldata = bytes("");

        bytes32 cutHash = keccak256(abi.encode(cuts, initAddr, initCalldata));

        console2.log("  cutHash");
        console2.logBytes32(cutHash);

        // Write the artefact BEFORE proposing on-chain. The artefact is purely
        // descriptive (selectors + cut hash + facet address) and is required by the
        // sibling executor script even if the on-chain propose fails (e.g. wrong
        // owner, dummy diamond during simulation, network reorg). The `effectiveAt`
        // field is filled below if the proposal succeeds, otherwise left as 0.
        _writeArtefact(diamondAddr, address(newFacet), addSel, cutHash, 0);

        console2.log("  -- propose --");

        vm.startBroadcast();
        diamond.proposeDiamondCut(cuts, initAddr, initCalldata);
        vm.stopBroadcast();

        uint64 effectiveAt = diamond.pendingCutEffectiveAt(cutHash);
        console2.log("  effectiveAt", uint256(effectiveAt));
        console2.log("  block.timestamp", block.timestamp);

        // Re-write the artefact with the on-chain `effectiveAt` populated.
        _writeArtefact(diamondAddr, address(newFacet), addSel, cutHash, effectiveAt);

        console2.log("  -- to execute after timelock --");
        console2.log("  forge script script/ExecuteJurisdictionFacetCut.s.sol:ExecuteJurisdictionFacetCut \\");
        console2.log("    --sig 'run()' --rpc-url $ARB_SEPOLIA_RPC \\");
        console2.log("    --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow");
        console2.log("  with env: DIAMOND, JURISDICTION_FACET (the address printed above)");
    }

    function _selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = JurisdictionPolicyFacet.pauseForJurisdiction.selector;
        s[1] = JurisdictionPolicyFacet.unpauseForJurisdiction.selector;
        s[2] = JurisdictionPolicyFacet.isPausedForJurisdiction.selector;
        s[3] = JurisdictionPolicyFacet.getPauseVersion.selector;
    }

    function _writeArtefact(
        address diamondAddr,
        address facetAddr,
        bytes4[] memory sel,
        bytes32 cutHash,
        uint64 effectiveAt
    )
        internal
    {
        string memory header = string.concat(
            "{\n",
            '  "diamond": "',
            vm.toString(diamondAddr),
            '",\n  "facet": "',
            vm.toString(facetAddr),
            '",\n'
        );
        string memory selectorBlock = string.concat(
            '  "selectors": [\n    "',
            vm.toString(sel[0]),
            '",\n    "',
            vm.toString(sel[1]),
            '",\n    "',
            vm.toString(sel[2]),
            '",\n    "',
            vm.toString(sel[3]),
            '"\n  ],\n'
        );
        string memory footer = string.concat(
            '  "cutHash": "',
            vm.toString(cutHash),
            '",\n  "effectiveAt": ',
            vm.toString(uint256(effectiveAt)),
            ",\n  \"proposedAt\": ",
            vm.toString(block.timestamp),
            "\n}\n"
        );
        // slither-disable-next-line unsafe-cheatcode
        vm.writeFile("./script/jurisdiction_cut_proposed.json", string.concat(header, selectorBlock, footer));
        console2.log("  artefact -> script/jurisdiction_cut_proposed.json");
    }
}

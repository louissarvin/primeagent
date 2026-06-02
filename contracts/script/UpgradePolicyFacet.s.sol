// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Erc7715PolicyAuditFacet} from "../src/modules/Erc7715PolicyAuditFacet.sol";
import {PrimeAgentDiamond} from "../src/core/PrimeAgentDiamond.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";

/// @title UpgradePolicyFacet
/// @notice Feature C / Option B ops script. Deploys the new `Erc7715PolicyAuditFacet`
///         carrying the `presetHash` storage slot + V2 entry points, and PROPOSES a
///         48h-timelocked Diamond cut that:
///           1. REPLACEs the legacy `installPermission` and `updatePermission` selectors
///              so they bind to the new facet (their calldata struct shape now expects
///              `LegacyPolicy`; the old selectors at the previous facet address would
///              decode as the new `Policy` shape).
///           2. ADDs the new `installPermissionV2`, `updatePermissionV2`, and
///              `getPresetHash` selectors.
///
/// @dev    Storage layout safety. `LibPolicy.Policy` grows one trailing slot (`presetHash`).
///         Solidity assigns a fresh storage slot AFTER all existing slots, so policies
///         installed before the cut continue to read back correctly (their `presetHash`
///         defaults to `bytes32(0)`, which `LibRiskPresets.isCanonicalPresetHash` accepts).
///         The facet's own `AuditStorage` keyspace (`keccak256("primeagent.audit.storage")`)
///         is unchanged.
///
/// @dev    The script writes the proposed cut payload to stdout so the operator can
///         re-broadcast it via `ExecutePolicyFacetUpgrade.s.sol` after the 48h timelock
///         elapses. The DiamondCutFacet's `proposeDiamondCut(...)` is owner-gated and
///         emits `DiamondCutProposed(cutHash, effectiveAt)`.
///
/// Dry run:
///   forge script script/UpgradePolicyFacet.s.sol:UpgradePolicyFacet \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC
///
/// Live (proposes the cut; executes 48h later via the sibling script):
///   forge script script/UpgradePolicyFacet.s.sol:UpgradePolicyFacet \
///     --sig "run()" --rpc-url $ARB_SEPOLIA_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract UpgradePolicyFacet is Script {
    error DiamondAddressZero();

    function run() external {
        address diamondAddr = vm.envAddress("DIAMOND");
        if (diamondAddr == address(0)) revert DiamondAddressZero();
        PrimeAgentDiamond diamond = PrimeAgentDiamond(payable(diamondAddr));

        console2.log("UpgradePolicyFacet");
        console2.log("  diamond", diamondAddr);

        vm.startBroadcast();
        Erc7715PolicyAuditFacet newFacet = new Erc7715PolicyAuditFacet();
        vm.stopBroadcast();

        console2.log("  new facet (deployed)", address(newFacet));

        // REPLACE: legacy selectors now bind to the new facet so their calldata struct
        // shape (`LegacyPolicy`) is decoded correctly.
        bytes4[] memory replaceSel = new bytes4[](2);
        replaceSel[0] = Erc7715PolicyAuditFacet.installPermission.selector;
        replaceSel[1] = Erc7715PolicyAuditFacet.updatePermission.selector;

        // ADD: V2 surface.
        bytes4[] memory addSel = new bytes4[](3);
        addSel[0] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        addSel[1] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        addSel[2] = Erc7715PolicyAuditFacet.getPresetHash.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSel
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSel
        });

        address initAddr = address(0);
        bytes memory initCalldata = bytes("");

        // Compute the cut hash off-chain so the operator can pass it to the executor.
        bytes32 cutHash = keccak256(abi.encode(cuts, initAddr, initCalldata));

        console2.log("  cutHash");
        console2.logBytes32(cutHash);
        console2.log("  -- propose --");

        vm.startBroadcast();
        diamond.proposeDiamondCut(cuts, initAddr, initCalldata);
        vm.stopBroadcast();

        uint64 effectiveAt = diamond.pendingCutEffectiveAt(cutHash);
        console2.log("  effectiveAt", uint256(effectiveAt));
        console2.log("  -- to execute after timelock --");
        console2.log("  forge script script/ExecutePolicyFacetUpgrade.s.sol:ExecutePolicyFacetUpgrade \\");
        console2.log("    --sig 'run()' --rpc-url $ARB_SEPOLIA_RPC \\");
        console2.log("    --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow");
        console2.log("  with env: DIAMOND, POLICY_FACET (the address printed above)");
    }
}

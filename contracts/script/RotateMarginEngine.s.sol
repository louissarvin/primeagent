// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PrimeAgentFactory} from "../src/core/PrimeAgentFactory.sol";
import {PositionNFT} from "../src/core/PositionNFT.sol";
import {AgentVault} from "../src/core/AgentVault.sol";

/// @title RotateMarginEngine
/// @notice Wave A3 ops script. Rotate the `marginEngine` storage slot on every
///         existing AgentVault BeaconProxy so it points at the live Stylus
///         margin engine.
///
/// @dev Background. `PrimeAgentFactory.marginEngine` is `immutable` (see
///      `PrimeAgentFactory.sol:33`) and was passed `address(0)` to the live
///      Arbitrum Sepolia factory. Every BeaconProxy AgentVault therefore has
///      `marginEngine == 0` in its own storage slot (`AgentVault.sol:40`,
///      written in `initialize` at L95). Because the slot is per-proxy,
///      upgrading the beacon impl does NOT touch it. This script rotates the
///      slot on each minted vault by calling `setMarginEngine(newEngine)`,
///      which is gated by `onlyVaultOwner` (`AgentVault.sol:182`) and resolves
///      to `IERC721(positionNFT).ownerOf(tokenId)`. The script's caller
///      (broadcaster) must therefore be the owner of every PositionNFT it
///      rotates; otherwise we revert pre-broadcast with `CallerNotOwner`.
///
/// @dev Newly-minted vaults will continue to inherit the immutable factory
///      `marginEngine`. The script logs a warning when the factory itself is
///      still misconfigured and prints the redeploy command. The script does
///      NOT attempt to redeploy the factory; that is a separate ops step.
///
/// Dry run:
///   forge script script/RotateMarginEngine.s.sol:RotateMarginEngine \
///     --sig "dryRun()" --rpc-url $ARB_SEPOLIA_RPC
///
/// Live:
///   forge script script/RotateMarginEngine.s.sol:RotateMarginEngine \
///     --sig "rotate()" --rpc-url $ARB_SEPOLIA_RPC \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract RotateMarginEngine is Script {
    error TargetEngineZero();
    error FactoryZero();
    error CallerNotOwner(uint256 tokenId, address required, address actual);

    struct Config {
        address marginEngine;
        PrimeAgentFactory factory;
        PositionNFT positionNFT;
    }

    /// @notice Read-only inspection. Logs current vs target engine per vault.
    ///         Never sends a transaction.
    function dryRun() external {
        Config memory cfg = _loadConfig();
        _logHeader(cfg, "dryRun");
        _iterate(cfg, false);
        _maybeLogFactoryWarning(cfg);
    }

    /// @notice Live rotation. Pre-flight checks ownership of every vault that
    ///         needs rotation; reverts before broadcasting if the caller does
    ///         not own one of them, so partial rotations are impossible.
    function rotate() external {
        Config memory cfg = _loadConfig();
        _logHeader(cfg, "rotate");

        // Determine the broadcaster address. `forge script` exposes it via
        // tx.origin when `--private-key` or `--account` is supplied; before
        // any broadcast call, msg.sender is the script contract itself. We
        // use the standard pattern of pulling the private key from env and
        // deriving the address explicitly so the pre-flight checks line up.
        address broadcaster = _broadcaster();

        // Pre-flight: verify ownership for every vault that needs rotation.
        uint256 total = cfg.positionNFT.nextTokenId();
        for (uint256 id; id < total; ++id) {
            (bool exists, address owner, address vault) = _vaultRecord(cfg, id);
            if (!exists || vault == address(0)) continue;
            address current = AgentVault(vault).marginEngine();
            if (current == cfg.marginEngine) continue;
            if (owner != broadcaster) {
                revert CallerNotOwner(id, owner, broadcaster);
            }
        }

        _iterate(cfg, true);
        _maybeLogFactoryWarning(cfg);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.marginEngine = vm.envAddress("MARGIN_ENGINE");
        if (cfg.marginEngine == address(0)) revert TargetEngineZero();
        address factoryAddr = vm.envAddress("FACTORY");
        if (factoryAddr == address(0)) revert FactoryZero();
        cfg.factory = PrimeAgentFactory(factoryAddr);
        cfg.positionNFT = cfg.factory.positionNFT();
    }

    function _broadcaster() internal view returns (address) {
        // Prefer DEPLOYER_PRIVATE_KEY (matches Deploy.s.sol convention). If
        // unset, fall back to tx.origin which is the broadcaster set up by
        // forge when --account or --ledger is used.
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 pk) {
            if (pk != 0) return vm.addr(pk);
        } catch {}
        return tx.origin;
    }

    function _logHeader(Config memory cfg, string memory mode) internal pure {
        console2.log("RotateMarginEngine ", mode);
        console2.log("  factory      ", address(cfg.factory));
        console2.log("  positionNFT  ", address(cfg.positionNFT));
        console2.log("  targetEngine ", cfg.marginEngine);
    }

    function _vaultRecord(
        Config memory cfg,
        uint256 tokenId
    )
        internal
        view
        returns (bool exists, address owner, address vault)
    {
        try cfg.positionNFT.ownerOf(tokenId) returns (address o) {
            owner = o;
            exists = true;
        } catch {
            return (false, address(0), address(0));
        }
        vault = cfg.positionNFT.vaultOf(tokenId);
    }

    function _iterate(Config memory cfg, bool broadcast) internal {
        uint256 total = cfg.positionNFT.nextTokenId();
        if (total == 0) {
            console2.log("  no minted vaults; nothing to do");
            return;
        }

        uint256 updated;
        uint256 skipped;

        for (uint256 id; id < total; ++id) {
            (bool exists, address owner, address vault) = _vaultRecord(cfg, id);
            if (!exists) {
                console2.log("  burned", id);
                continue;
            }
            if (vault == address(0)) {
                console2.log("  no-vault", id);
                continue;
            }

            address current = AgentVault(vault).marginEngine();
            console2.log("  tokenId ", id);
            console2.log("    owner  ", owner);
            console2.log("    vault  ", vault);
            console2.log("    cur    ", current);
            console2.log("    target ", cfg.marginEngine);

            if (current == cfg.marginEngine) {
                console2.log("    skip   already correct");
                ++skipped;
                continue;
            }

            if (broadcast) {
                vm.startBroadcast();
                AgentVault(vault).setMarginEngine(cfg.marginEngine);
                vm.stopBroadcast();
                console2.log("    rotated");
                ++updated;
            } else {
                console2.log("    would rotate");
                ++updated;
            }
        }

        console2.log("  updated", updated);
        console2.log("  skipped", skipped);
    }

    function _maybeLogFactoryWarning(Config memory cfg) internal view {
        address fEngine = cfg.factory.marginEngine();
        if (fEngine == cfg.marginEngine) return;

        console2.log("");
        console2.log("WARN factory.marginEngine is still", fEngine);
        console2.log("WARN newly minted vaults will inherit the stale address");
        console2.log("WARN PrimeAgentFactory.marginEngine is immutable; redeploy is required:");
        console2.log("WARN   forge script script/Deploy.s.sol:Deploy --sig run() \\");
        console2.log("WARN     --rpc-url $ARB_SEPOLIA_RPC \\");
        console2.log("WARN     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow");
        console2.log("WARN   with STYLUS_MARGIN_ENGINE_ADDRESS set and EXISTING_* set for every");
        console2.log("WARN   already-deployed component (PositionNFT, AgentRegistry,");
        console2.log("WARN   AgentVault impl, Diamond, adapters, etc).");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {LibRiskPresets} from "../../src/libraries/LibRiskPresets.sol";

/// @title LibRiskPresetsTest
/// @notice Pins the canonical preset hash registry against the backend's
///         `backend/src/agent/risk/presets.ts`. Drift on either side causes this golden
///         test to fail. To rotate the registry, update both sides in lockstep with a
///         48h timelocked Diamond cut (see `script/UpgradePolicyFacet.s.sol`).
contract LibRiskPresetsTest is Test {
    function test_custom_is_zero() public pure {
        assertEq(LibRiskPresets.PRESET_CUSTOM, bytes32(0), "custom = 0");
    }

    function test_isCanonical_custom() public pure {
        assertTrue(LibRiskPresets.isCanonicalPresetHash(bytes32(0)), "custom accepted");
    }

    function test_isCanonical_all_5() public pure {
        assertTrue(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_CONSERVATIVE), "conservative");
        assertTrue(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_BALANCED), "balanced");
        assertTrue(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_AGGRESSIVE), "aggressive");
        assertTrue(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_MARKET_MAKER), "market-maker");
        assertTrue(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_DELTA_NEUTRAL), "delta-neutral");
    }

    function test_isCanonical_rejects_random_hashes() public pure {
        assertFalse(LibRiskPresets.isCanonicalPresetHash(keccak256("random.value")), "random rejected");
        assertFalse(LibRiskPresets.isCanonicalPresetHash(bytes32(uint256(1))), "non-zero non-canonical rejected");
        assertFalse(LibRiskPresets.isCanonicalPresetHash(bytes32(type(uint256).max)), "max rejected");
    }

    function test_registry_size_and_distinctness() public pure {
        bytes32[5] memory hashes = LibRiskPresets.canonicalHashes();
        // All 5 must be non-zero and pairwise distinct.
        for (uint256 i; i < 5; ++i) {
            assertTrue(hashes[i] != bytes32(0), "non-zero");
            for (uint256 j = i + 1; j < 5; ++j) {
                assertTrue(hashes[i] != hashes[j], "distinct");
            }
        }
    }

    /// @notice Golden hash assertions. Synchronized with backend/src/agent/risk/presets.ts.
    ///         If the backend rotates `presets.ts` canonical JSON, this test, the constants
    ///         in `LibRiskPresets.sol`, and the backend boot assertion must all be updated
    ///         in the same commit.
    function test_golden_hashes_pinned() public pure {
        assertEq(
            LibRiskPresets.PRESET_CONSERVATIVE,
            bytes32(0xaf03b056ed6b288ffb41efacd0466ec096c81fca87415a88c1f477b5e21cbf10),
            "conservative drift"
        );
        assertEq(
            LibRiskPresets.PRESET_BALANCED,
            bytes32(0x0023866c5aa45fcf451794ee0d65c9a946d8b3a76429c9a89cf502a4377a5dd0),
            "balanced drift"
        );
        assertEq(
            LibRiskPresets.PRESET_AGGRESSIVE,
            bytes32(0xeef3286e96d25dde874b810189033c62946a1b6d75dc22ed79d39fbf13bff9a3),
            "aggressive drift"
        );
        assertEq(
            LibRiskPresets.PRESET_MARKET_MAKER,
            bytes32(0x663fe7fa59b298fb81551c78c3a051d917073b367d46d9380abfa75f38d71aa1),
            "market-maker drift"
        );
        assertEq(
            LibRiskPresets.PRESET_DELTA_NEUTRAL,
            bytes32(0xa1913431eb5063f9ba2b20005ca4d43b034c47c579dd16e246f29c244e567bd1),
            "delta-neutral drift"
        );
    }
}

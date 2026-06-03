// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title MockGasBurnerPausable
/// @notice Test fixture exposing a `pause()` / `unpause()` surface that consumes nearly all the
///         forwarded gas via an infinite-loop sentinel. Used by EmergencyShutdown regression
///         tests (audit H-5) to prove the iterator survives a malicious component because the
///         outer caller caps `gas:` at the registered budget.
contract MockGasBurnerPausable {
    bool public paused;

    /// @notice Burns gas in a loop until OOG.
    function pause() external {
        // Burn gas in an unbounded loop. With the H-5 fix, EmergencyShutdown forwards at most
        // PAUSE_CALL_GAS (200_000) into this call. The loop runs out of gas inside that capped
        // sub-frame, the call returns ok = false to the iterator, and the loop continues.
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
            if (i == type(uint256).max) break; // unreachable in practice
        }
        paused = true; // unreachable
    }

    function unpause() external {
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
            if (i == type(uint256).max) break; // unreachable in practice
        }
        paused = false; // unreachable
    }
}

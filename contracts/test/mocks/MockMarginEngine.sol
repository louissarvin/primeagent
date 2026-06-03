// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title MockMarginEngine
/// @notice Test double for the Stylus `margin_engine` contract. Mirrors the external
///         `netCollateralUsdQ96(address)` view that AgentVault.totalAssets() staticcalls.
/// @dev Q96.48 raw values are stored verbatim and returned as-is so tests can drive any value
///      (including the maximum boundary). The mock can also simulate the failure modes the
///      production vault must handle gracefully: outright revert, and short (less than 32 bytes)
///      return data.
contract MockMarginEngine {
    mapping(address vault => uint256 q96) public netCollateralStorage;

    bool public shouldRevert;
    bool public shortReturn;

    function setNetCollateralUsdQ96(address vault, uint256 valueQ96) external {
        netCollateralStorage[vault] = valueQ96;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setShortReturn(bool v) external {
        shortReturn = v;
    }

    /// @notice Matches the Stylus ABI `netCollateralUsdQ96(address)`. Returns the configured
    ///         Q96.48 raw collateral value, or reverts / short-returns when the mock is set up
    ///         to exercise the vault's defensive branches.
    function netCollateralUsdQ96(address vault) external view returns (uint256) {
        if (shouldRevert) {
            revert("MockMarginEngine: forced revert");
        }
        if (shortReturn) {
            // Inline assembly: return only 16 bytes so the caller's `abi.decode(ret, (uint256))`
            // path is short-circuited by the `ret.length < 32` guard.
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, 0)
                return(ptr, 16)
            }
        }
        return netCollateralStorage[vault];
    }
}

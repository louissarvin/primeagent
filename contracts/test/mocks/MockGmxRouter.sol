// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IGmxRouter} from "../../src/interfaces/external/IGmxRouter.sol";

/// @notice Synchronous GMX V2-style router mock used by ArbitrumOneAdapter unit tests.
/// @dev    Simplifications vs real GMX V2:
///         - No keeper/callback flow; open and close resolve in the same transaction.
///         - PnL is set by the test via `setPnl(positionKey, pnlSigned, returnedAmount)` BEFORE
///           the `createDecreasePosition` call. The router transfers `returnedAmount` of the
///           collateral token back to `account` (which is the adapter).
contract MockGmxRouter is IGmxRouter {
    using SafeERC20 for IERC20;

    struct Position {
        address account;
        address collateralToken;
        uint256 collateralAmount;
        uint256 sizeUsdQ96;
        bool isLong;
        bool exists;
    }

    mapping(bytes32 => Position) public positionsOf;
    mapping(bytes32 => int256) public pnlOf;
    mapping(bytes32 => uint256) public returnedAmountOf;
    uint256 public nextKey;

    event PositionOpened(bytes32 indexed key, address account, uint256 sizeUsdQ96, bool isLong);
    event PositionClosed(bytes32 indexed key, int256 realizedPnl);

    function createIncreasePosition(
        address indexToken,
        address collateralToken,
        uint256 sizeUsdQ96,
        bool isLong,
        uint256 collateralAmount,
        uint256, // acceptablePriceQ96
        address account
    )
        external
        override
        returns (bytes32 positionKey)
    {
        IERC20(collateralToken).safeTransferFrom(account, address(this), collateralAmount);
        unchecked {
            nextKey++;
        }
        positionKey = keccak256(abi.encodePacked(nextKey, account, indexToken, sizeUsdQ96, isLong));
        positionsOf[positionKey] = Position({
            account: account,
            collateralToken: collateralToken,
            collateralAmount: collateralAmount,
            sizeUsdQ96: sizeUsdQ96,
            isLong: isLong,
            exists: true
        });
        emit PositionOpened(positionKey, account, sizeUsdQ96, isLong);
    }

    function createDecreasePosition(
        bytes32 positionKey,
        uint256, // acceptablePriceQ96
        address account
    )
        external
        override
        returns (int256 realizedPnl)
    {
        Position memory p = positionsOf[positionKey];
        require(p.exists, "MockGmxRouter: NO_POSITION");
        require(p.account == account, "MockGmxRouter: WRONG_ACCOUNT");
        realizedPnl = pnlOf[positionKey];
        uint256 toReturn = returnedAmountOf[positionKey];
        if (toReturn == 0) {
            // Default: return the original collateral.
            toReturn = p.collateralAmount;
        }
        delete positionsOf[positionKey];
        IERC20(p.collateralToken).safeTransfer(account, toReturn);
        emit PositionClosed(positionKey, realizedPnl);
    }

    // --- Test helpers ---
    function setPnl(bytes32 positionKey, int256 pnl, uint256 returnedAmount) external {
        pnlOf[positionKey] = pnl;
        returnedAmountOf[positionKey] = returnedAmount;
    }
}

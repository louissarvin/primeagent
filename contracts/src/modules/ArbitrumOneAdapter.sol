// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAgentVault} from "../interfaces/IAgentVault.sol";
import {IArbitrumOneAdapter} from "../interfaces/IArbitrumOneAdapter.sol";
import {IAavePool} from "../interfaces/external/IAavePool.sol";
import {IGmxRouter} from "../interfaces/external/IGmxRouter.sol";

interface IPositionNFTView {
    function vaultOf(uint256 tokenId) external view returns (address);
}

contract ArbitrumOneAdapter is IArbitrumOneAdapter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error UnknownVault();
    error ZeroAddress();
    error ZeroAmount();
    error GmxError();
    error AaveError();

    address public immutable positionNFT;
    address public immutable gmxRouter;
    address public immutable aavePool;
    address public immutable priceOracle;

    constructor(address positionNFT_, address gmxRouter_, address aavePool_, address priceOracle_) {
        if (positionNFT_ == address(0) || gmxRouter_ == address(0) || aavePool_ == address(0)) revert ZeroAddress();
        positionNFT = positionNFT_;
        gmxRouter = gmxRouter_;
        aavePool = aavePool_;
        priceOracle = priceOracle_;
    }

    function openPerp(
        uint256 tokenId,
        address indexToken,
        uint256 sizeUsdQ96,
        bool isLong,
        uint256 collateralUsdcAmount,
        uint256 acceptablePriceQ96
    )
        external
        nonReentrant
        returns (bytes32 positionKey)
    {
        if (indexToken == address(0)) revert ZeroAddress();
        if (collateralUsdcAmount == 0 || sizeUsdQ96 == 0) revert ZeroAmount();
        address vault = _resolveVault(tokenId);
        address collateralToken = _vaultAsset(vault);

        IAgentVault(vault).pullSideBalance(collateralToken, collateralUsdcAmount, address(this));
        IERC20(collateralToken).forceApprove(gmxRouter, collateralUsdcAmount);
        try IGmxRouter(gmxRouter).createIncreasePosition(
            indexToken, collateralToken, sizeUsdQ96, isLong, collateralUsdcAmount, acceptablePriceQ96, address(this)
        ) returns (bytes32 key) {
            positionKey = key;
        } catch {
            revert GmxError();
        }

        emit PerpOpened(tokenId, positionKey, indexToken, isLong, sizeUsdQ96, collateralUsdcAmount);
    }

    function closePerp(
        uint256 tokenId,
        bytes32 positionKey,
        uint256 acceptablePriceQ96
    )
        external
        nonReentrant
        returns (int256 realizedPnl)
    {
        address vault = _resolveVault(tokenId);
        address collateralToken = _vaultAsset(vault);

        uint256 balanceBefore = IERC20(collateralToken).balanceOf(address(this));
        try IGmxRouter(gmxRouter).createDecreasePosition(positionKey, acceptablePriceQ96, address(this))
        returns (int256 pnl) {
            realizedPnl = pnl;
        } catch {
            revert GmxError();
        }
        uint256 received = IERC20(collateralToken).balanceOf(address(this)) - balanceBefore;

        if (received > 0) {
            IERC20(collateralToken).forceApprove(vault, received);
            IAgentVault(vault).pushSideBalance(collateralToken, received);
        }
        emit PerpClosed(tokenId, positionKey, realizedPnl);
    }

    function borrow(uint256 tokenId, address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        address vault = _resolveVault(tokenId);

        try IAavePool(aavePool).borrow(asset, amount, 2, 0, address(this)) {}
        catch {
            revert AaveError();
        }
        IERC20(asset).forceApprove(vault, amount);
        IAgentVault(vault).pushSideBalance(asset, amount);
        emit Borrowed(tokenId, asset, amount);
    }

    function repay(uint256 tokenId, address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        address vault = _resolveVault(tokenId);

        IAgentVault(vault).pullSideBalance(asset, amount, address(this));
        IERC20(asset).forceApprove(aavePool, amount);
        uint256 actualRepaid = 0;
        try IAavePool(aavePool).repay(asset, amount, 2, address(this)) returns (uint256 repaid) {
            actualRepaid = repaid;
        } catch {
            revert AaveError();
        }

        IERC20(asset).forceApprove(aavePool, 0);
        if (actualRepaid < amount) {
            uint256 residual;
            unchecked {
                residual = amount - actualRepaid;
            }
            IERC20(asset).forceApprove(vault, residual);
            IAgentVault(vault).pushSideBalance(asset, residual);
            emit RepayResidualPushed(tokenId, asset, residual);
        }
        emit Repaid(tokenId, asset, actualRepaid);
    }

    function supply(uint256 tokenId, address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        address vault = _resolveVault(tokenId);

        IAgentVault(vault).pullSideBalance(asset, amount, address(this));
        IERC20(asset).forceApprove(aavePool, amount);
        try IAavePool(aavePool).supply(asset, amount, address(this), 0) {}
        catch {
            revert AaveError();
        }
        emit Supplied(tokenId, asset, amount);
    }

    function withdraw(uint256 tokenId, address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        address vault = _resolveVault(tokenId);

        uint256 received = 0;
        try IAavePool(aavePool).withdraw(asset, amount, address(this)) returns (uint256 r) {
            received = r;
        } catch {
            revert AaveError();
        }
        if (received > 0) {
            IERC20(asset).forceApprove(vault, received);
            IAgentVault(vault).pushSideBalance(asset, received);
        }
        emit Withdrawn(tokenId, asset, received);
    }

    function _resolveVault(uint256 tokenId) internal view returns (address vault) {
        vault = IPositionNFTView(positionNFT).vaultOf(tokenId);
        if (vault == address(0)) revert UnknownVault();
    }

    function _vaultAsset(address vault) internal view returns (address) {
        (bool ok, bytes memory ret) = vault.staticcall(abi.encodeWithSignature("asset()"));
        if (!ok || ret.length < 32) revert UnknownVault();
        return abi.decode(ret, (address));
    }
}

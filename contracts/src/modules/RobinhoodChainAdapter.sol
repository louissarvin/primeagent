// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAgentVault} from "../interfaces/IAgentVault.sol";
import {IRobinhoodChainAdapter} from "../interfaces/IRobinhoodChainAdapter.sol";
import {IV2Router} from "../interfaces/IV2Router.sol";
import {IV3Pool, IV3SwapCallback} from "../interfaces/IV3Pool.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

interface IPositionNFTView {
    function vaultOf(uint256 tokenId) external view returns (address);
}

contract RobinhoodChainAdapter is IRobinhoodChainAdapter, IV3SwapCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error UnknownVault();
    error RouteUnsupported();
    error SlippageExceeded();
    error ZeroAddress();
    error ZeroAmount();
    error NotPool();

    uint8 public constant VENUE_V2 = 0;
    uint8 public constant VENUE_V3 = 1;
    bytes32 private constant _T_SLOT_PAYER_TOKEN = keccak256("primeagent.rhadapter.tslot.payerToken");
    bytes32 private constant _T_SLOT_PAYER_AMOUNT = keccak256("primeagent.rhadapter.tslot.payerAmount");

    address public immutable positionNFT;
    address public immutable v2Router;
    address public immutable v3Pool;
    address public immutable priceOracle;

    constructor(address positionNFT_, address v2Router_, address v3Pool_, address priceOracle_) {
        if (positionNFT_ == address(0) || v2Router_ == address(0) || v3Pool_ == address(0)) revert ZeroAddress();
        positionNFT = positionNFT_;
        v2Router = v2Router_;
        v3Pool = v3Pool_;
        priceOracle = priceOracle_;
    }

    function swap(
        uint256 tokenId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata routeData
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();

        address vault = IPositionNFTView(positionNFT).vaultOf(tokenId);
        if (vault == address(0)) revert UnknownVault();

        IAgentVault(vault).pullSideBalance(tokenIn, amountIn, address(this));

        uint8 venue = _decodeVenue(routeData);
        if (venue == VENUE_V2) {
            amountOut = _swapV2(tokenIn, tokenOut, amountIn, minAmountOut);
        } else if (venue == VENUE_V3) {
            amountOut = _swapV3(tokenIn, tokenOut, amountIn, minAmountOut, routeData);
        } else {
            revert RouteUnsupported();
        }
        if (amountOut < minAmountOut) revert SlippageExceeded();

        IERC20(tokenOut).forceApprove(vault, amountOut);
        IAgentVault(vault).pushSideBalance(tokenOut, amountOut);

        emit SwapExecuted(tokenId, tokenIn, tokenOut, amountIn, amountOut, venue);
    }

    function quote(
        uint256 tokenId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes calldata routeData
    )
        external
        view
        returns (uint256 amountOut)
    {
        address vault = IPositionNFTView(positionNFT).vaultOf(tokenId);
        if (vault == address(0)) revert UnknownVault();

        uint8 venue = _decodeVenue(routeData);
        if (venue == VENUE_V2) {
            amountOut = IV2Router(v2Router).quote(tokenIn, tokenOut, amountIn);
        } else if (venue == VENUE_V3) {
            uint256 liq = uint256(IV3Pool(v3Pool).liquidity());
            if (liq == 0) return 0;
            uint256 amountInWithFee = amountIn * 997;
            amountOut = (amountInWithFee * liq) / (liq * 1_000 + amountInWithFee);
        } else {
            revert RouteUnsupported();
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != v3Pool) revert NotPool();
        address payerToken;
        uint256 expectedAmount;
        bytes32 tokenSlot = _T_SLOT_PAYER_TOKEN;
        bytes32 amountSlot = _T_SLOT_PAYER_AMOUNT;
        assembly {
            payerToken := tload(tokenSlot)
            expectedAmount := tload(amountSlot)
        }
        uint256 owed;
        if (amount0Delta > 0) {
            owed = uint256(amount0Delta);
        } else if (amount1Delta > 0) {
            owed = uint256(amount1Delta);
        }
        if (owed != expectedAmount) revert SlippageExceeded();
        IERC20(payerToken).safeTransfer(msg.sender, owed);
    }

    function _decodeVenue(bytes calldata routeData) internal pure returns (uint8 venue) {
        if (routeData.length == 0) revert RouteUnsupported();
        venue = uint8(routeData[0]);
    }

    function _swapV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    )
        internal
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).forceApprove(v2Router, amountIn);
        amountOut = IV2Router(v2Router).swapExactIn(tokenIn, tokenOut, amountIn, minAmountOut, address(this));
    }

    function _swapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata routeData
    )
        internal
        returns (uint256 amountOut)
    {
        if (routeData.length < 1 + 20) revert RouteUnsupported();
        uint160 sqrtPriceLimitX96;
        bytes calldata tail = routeData[1:];
        if (tail.length < 32) revert RouteUnsupported();
        sqrtPriceLimitX96 = uint160(uint256(bytes32(tail[0:32])));

        address t0 = IV3Pool(v3Pool).token0();
        address t1 = IV3Pool(v3Pool).token1();
        bool zeroForOne;
        if (tokenIn == t0 && tokenOut == t1) {
            zeroForOne = true;
        } else if (tokenIn == t1 && tokenOut == t0) {
            zeroForOne = false;
        } else {
            revert RouteUnsupported();
        }

        bytes32 tokenSlot = _T_SLOT_PAYER_TOKEN;
        bytes32 amountSlot = _T_SLOT_PAYER_AMOUNT;
        assembly {
            tstore(tokenSlot, tokenIn)
            tstore(amountSlot, amountIn)
        }
        (int256 amount0, int256 amount1) = IV3Pool(v3Pool).swap(
            address(this), zeroForOne, int256(amountIn), sqrtPriceLimitX96, ""
        );

        amountOut = zeroForOne ? uint256(-amount1) : uint256(-amount0);
        if (amountOut < minAmountOut) revert SlippageExceeded();
    }
}

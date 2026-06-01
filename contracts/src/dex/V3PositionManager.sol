// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IV3MintCallback} from "../interfaces/IV3Pool.sol";
import {IV3PositionManager} from "../interfaces/IV3PositionManager.sol";
import {V3Pool} from "./V3Pool.sol";

contract V3PositionManager is ERC721, IV3PositionManager, IV3MintCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error PoolMismatch();
    error NotOwnerOrApproved();
    error NotPool();
    error InvalidAmount();
    error ZeroLiquidity();
    error PositionNotEmpty();
    error CollectMismatch();

    struct PositionData {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 tokensOwed0;
        uint256 tokensOwed1;
    }

    V3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public nextTokenId;
    address private _pendingPayer;

    mapping(uint256 tokenId => PositionData) public positionsOf;

    constructor(address pool_) ERC721("PrimeAgent V3 Positions", "PA-V3-POS") {
        if (pool_ == address(0)) revert InvalidAmount();
        pool = V3Pool(pool_);
        token0 = pool.token0();
        token1 = pool.token1();
        fee = pool.fee();
    }

    function mint(MintParams calldata p) external nonReentrant returns (uint256 tokenId, uint128 liquidity) {
        if (p.token0 != token0 || p.token1 != token1 || p.fee != fee) revert PoolMismatch();
        if (p.recipient == address(0)) revert InvalidAmount();
        uint256 minDesired = p.amount0Desired < p.amount1Desired ? p.amount0Desired : p.amount1Desired;
        if (minDesired == 0 || minDesired > type(uint128).max) revert InvalidAmount();
        liquidity = uint128(minDesired);

        unchecked {
            tokenId = ++nextTokenId;
        }

        positionsOf[tokenId] = PositionData({
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0
        });

        _pendingPayer = msg.sender;
        (uint256 amount0, uint256 amount1) =
            pool.mint(address(this), p.tickLower, p.tickUpper, liquidity, abi.encode(msg.sender));
        _pendingPayer = address(0);

        _safeMint(p.recipient, tokenId);
        emit PositionMinted(tokenId, p.recipient, p.tickLower, p.tickUpper, liquidity, amount0, amount1);
    }

    function decreaseLiquidity(
        uint256 tokenId,
        uint128 liquidityDelta
    )
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        _requireOwnerOrApproved(tokenId);
        PositionData storage position = positionsOf[tokenId];
        if (liquidityDelta == 0 || position.liquidity < liquidityDelta) revert ZeroLiquidity();

        (amount0, amount1) = pool.burn(position.tickLower, position.tickUpper, liquidityDelta);

        unchecked {
            position.liquidity -= liquidityDelta;
        }
        position.tokensOwed0 += amount0;
        position.tokensOwed1 += amount1;

        (uint128 collected0, uint128 collected1) = pool.collect(
            address(this), position.tickLower, position.tickUpper, _toU128(amount0), _toU128(amount1)
        );
        if (uint256(collected0) != amount0 || uint256(collected1) != amount1) revert CollectMismatch();

        emit LiquidityDecreased(tokenId, liquidityDelta, amount0, amount1);
    }

    function collect(uint256 tokenId, address recipient) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        _requireOwnerOrApproved(tokenId);
        if (recipient == address(0)) revert InvalidAmount();
        PositionData storage position = positionsOf[tokenId];
        amount0 = position.tokensOwed0;
        amount1 = position.tokensOwed1;
        position.tokensOwed0 = 0;
        position.tokensOwed1 = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(recipient, amount1);
        emit Collected(tokenId, recipient, amount0, amount1);
    }

    function burn(uint256 tokenId) external nonReentrant {
        _requireOwnerOrApproved(tokenId);
        PositionData storage position = positionsOf[tokenId];
        if (position.liquidity != 0 || position.tokensOwed0 != 0 || position.tokensOwed1 != 0) {
            revert PositionNotEmpty();
        }
        delete positionsOf[tokenId];
        _burn(tokenId);
        emit PositionBurned(tokenId);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        if (msg.sender != address(pool)) revert NotPool();
        address payer = abi.decode(data, (address));
        if (payer == address(0) || payer != _pendingPayer) revert NotPool();
        if (amount0Owed > 0) IERC20(token0).safeTransferFrom(payer, address(pool), amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransferFrom(payer, address(pool), amount1Owed);
    }

    function _requireOwnerOrApproved(uint256 tokenId) internal view {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert NotOwnerOrApproved();
        if (
            msg.sender != owner && getApproved(tokenId) != msg.sender && !isApprovedForAll(owner, msg.sender)
        ) revert NotOwnerOrApproved();
    }

    function _toU128(uint256 v) internal pure returns (uint128) {
        if (v > type(uint128).max) revert InvalidAmount();
        return uint128(v);
    }
}

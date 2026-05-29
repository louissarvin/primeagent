// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC4626Upgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

contract AgentVault is
    Initializable,
    ERC4626Upgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error NotAdapter();
    error NotOwner();
    error NotPauser();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientSideBalance();
    error TooManySideAssets();
    error CannotPullBaseAsset();
    error NotPauserForLiquidation();
    error MarkToMarketSelectorDrift(bytes4 expected, bytes4 actual);

    uint256 public constant MAX_SIDE_ASSETS = 30;
    uint256 internal constant NET_COLLATERAL_GAS = 300_000;
    bytes4 internal constant NET_COLLATERAL_USD_Q96_SELECTOR =
        bytes4(keccak256("netCollateralUsdQ96(address)"));

    /// @notice Stylus `margin_engine.mark_to_market_basket(assets, balances, prices)` selector.
    /// @dev    Auto-generated camelCase selector per Stylus ABI rules (see Feature E,
    ///         Implementation Plan section 2.E). Function signature:
    ///         `markToMarketBasket(address[],uint256[],uint256[]) returns (int256)`.
    ///         The middle arg is unsigned because side balances on the vault are always
    ///         positive (push requires > 0, pull reverts on underflow); the return value
    ///         is `int256` because the engine can net to a negative MTM across a mixed
    ///         basket. The compile-time assert in the constructor pins the selector to
    ///         the Stylus crate's published `0x5e89fd56` (see stylus-build-notes.md).
    bytes4 internal constant MARK_TO_MARKET_BASKET_SELECTOR =
        bytes4(keccak256("markToMarketBasket(address[],uint256[],uint256[])"));

    /// @notice Selector for `PriceOracle.getPrice(address asset) view returns (uint256)`.
    /// @dev    Cached as a constant so the basket-mode read path does not pay the keccak256
    ///         per call. Reverts (e.g. stale / missing) cause the basket-mode `totalAssets()`
    ///         to fall back to the base-balance-only value, matching the existing engine
    ///         revert-fallback behaviour for the stateful path.
    bytes4 internal constant GET_PRICE_SELECTOR = bytes4(keccak256("getPrice(address)"));

    uint256 public tokenId;
    address public positionNFT;
    address public marginEngine;
    address public adapter;
    address public pauser;
    address[] public sideAssets;

    mapping(address adapter => bool) public isAdapter;
    mapping(address asset => uint256 amount) public sideBalance;
    mapping(address asset => bool tracked) public isSideAsset;

    /// @notice When true, `totalAssets()` calls the stateless basket entrypoint on the
    ///         margin engine instead of the stateful `netCollateralUsdQ96(vault)` path.
    /// @dev    Feature E, Implementation Plan section 2.E. Default `false` so existing
    ///         vaults keep their historical accounting path; new vaults can opt in via
    ///         `setUseBasketMarkToMarket(true)` after they have a price oracle wired
    ///         through the margin engine. Gated to the NFT owner.
    bool public useBasketMarkToMarket;

    /// @notice Optional PriceOracle used when `useBasketMarkToMarket == true`.
    /// @dev    Owner-set so a vault can opt out of basket mode without touching the
    ///         margin engine. If unset while basket mode is active, the read path falls
    ///         back to the base-balance-only total (the staticcall to a zero address is
    ///         short-circuited).
    address public priceOracle;

    event SideBalancePushed(address indexed token, address indexed from, uint256 amount);
    event SideBalancePulled(address indexed token, address indexed to, uint256 amount);
    event MarginEngineSet(address indexed oldEngine, address indexed newEngine);
    event AdapterSet(address indexed adapter, bool active);
    event PauserSet(address indexed oldPauser, address indexed newPauser);
    event Paused();
    event Unpaused();
    event BaseAssetLiquidated(address indexed recipient, uint256 amount);
    /// @notice Emitted when the basket mark-to-market read path is toggled.
    event MarginEngineModeChanged(bool useBasketMarkToMarket);
    /// @notice Emitted when the optional PriceOracle for basket mode is rotated.
    event PriceOracleSet(address indexed oldOracle, address indexed newOracle);

    modifier onlyAdapter() {
        if (msg.sender != adapter && !isAdapter[msg.sender]) revert NotAdapter();
        _;
    }

    modifier onlyVaultOwner() {
        if (msg.sender != _vaultOwner()) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
        // Pin the Stylus basket entrypoint selector at deploy time. The Stylus crate's
        // published selector is `0x5e89fd56` (see memory/stylus-build-notes.md). If the
        // signature string above is ever rewritten and drifts from the engine's compiled
        // ABI, this revert kills deploys before any vault can silently fall through to
        // the base-balance-only path.
        if (MARK_TO_MARKET_BASKET_SELECTOR != bytes4(0x5e89fd56)) {
            revert MarkToMarketSelectorDrift(bytes4(0x5e89fd56), MARK_TO_MARKET_BASKET_SELECTOR);
        }
    }

    function initialize(
        address baseAsset,
        address positionNFT_,
        uint256 tokenId_,
        address marginEngine_,
        address adapter_,
        address[] calldata initialAdapters,
        address initialPauser,
        string calldata vaultName,
        string calldata vaultSymbol
    )
        external
        initializer
    {
        if (baseAsset == address(0) || positionNFT_ == address(0)) {
            revert ZeroAddress();
        }
        __ERC20_init(vaultName, vaultSymbol);
        __ERC4626_init(IERC20(baseAsset));
        __Pausable_init();

        positionNFT = positionNFT_;
        tokenId = tokenId_;
        marginEngine = marginEngine_;
        adapter = adapter_;

        uint256 len = initialAdapters.length;
        for (uint256 i; i < len; ++i) {
            address a = initialAdapters[i];
            if (a == address(0)) continue;
            isAdapter[a] = true;
            emit AdapterSet(a, true);
        }

        if (initialPauser != address(0)) {
            pauser = initialPauser;
            emit PauserSet(address(0), initialPauser);
        }
    }

    function pushSideBalance(address token, uint256 amount) external onlyAdapter nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == asset()) revert CannotPullBaseAsset();

        if (!isSideAsset[token]) {
            if (sideAssets.length >= MAX_SIDE_ASSETS) revert TooManySideAssets();
            sideAssets.push(token);
            isSideAsset[token] = true;
        }
        sideBalance[token] += amount;
        emit SideBalancePushed(token, msg.sender, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function pullSideBalance(
        address token,
        uint256 amount,
        address to
    )
        external
        onlyAdapter
        nonReentrant
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == asset()) revert CannotPullBaseAsset();
        uint256 current = sideBalance[token];
        if (amount > current) revert InsufficientSideBalance();

        unchecked {
            sideBalance[token] = current - amount;
        }
        emit SideBalancePulled(token, to, amount);

        IERC20(token).safeTransfer(to, amount);
    }

    function liquidateBaseAsset(address recipient)
        external
        nonReentrant
        returns (uint256 amountSwept)
    {
        if (msg.sender != pauser) revert NotPauserForLiquidation();
        if (recipient == address(0)) revert ZeroAddress();

        address base = asset();
        amountSwept = IERC20(base).balanceOf(address(this));
        if (amountSwept == 0) {
            emit BaseAssetLiquidated(recipient, 0);
            return 0;
        }

        emit BaseAssetLiquidated(recipient, amountSwept);
        IERC20(base).safeTransfer(recipient, amountSwept);
    }

    function setAdapter(address adapter_, bool active_) external {
        if (msg.sender != _vaultOwner()) revert NotOwner();
        if (adapter_ == address(0)) revert ZeroAddress();
        isAdapter[adapter_] = active_;
        emit AdapterSet(adapter_, active_);
    }

    function setPauser(address newPauser) external onlyVaultOwner {
        emit PauserSet(pauser, newPauser);
        pauser = newPauser;
    }

    function setMarginEngine(address newEngine) external onlyVaultOwner {
        emit MarginEngineSet(marginEngine, newEngine);
        marginEngine = newEngine;
    }

    /// @notice Toggle the basket mark-to-market accounting path for `totalAssets()`.
    /// @dev    Feature E. Gated to the NFT owner. The flag is per-vault so the migration
    ///         can roll forward one vault at a time without touching the global beacon
    ///         implementation. When set to `true`, `totalAssets()` calls
    ///         `markToMarketBasket(assets, balances, prices)` on the margin engine with
    ///         the live snapshot. When `false`, the legacy stateful path is used.
    /// @param  enabled `true` to switch to the basket path, `false` to fall back to legacy.
    function setUseBasketMarkToMarket(bool enabled) external onlyVaultOwner {
        useBasketMarkToMarket = enabled;
        emit MarginEngineModeChanged(enabled);
    }

    /// @notice Set or rotate the PriceOracle used by the basket read path.
    /// @dev    Setting to `address(0)` disables basket-mode price discovery; the vault
    ///         will fall back to the base-balance-only total instead of querying a missing
    ///         oracle. Gated to the NFT owner.
    /// @param  newOracle Address of the canonical PriceOracle (see `periphery/PriceOracle.sol`).
    function setPriceOracle(address newOracle) external onlyVaultOwner {
        emit PriceOracleSet(priceOracle, newOracle);
        priceOracle = newOracle;
    }

    function pause() external {
        if (msg.sender != _vaultOwner() && msg.sender != pauser) revert NotPauser();
        _pause();
        emit Paused();
    }

    function unpause() external {
        if (msg.sender != _vaultOwner() && msg.sender != pauser) revert NotPauser();
        _unpause();
        emit Unpaused();
    }

    function totalAssets() public view override returns (uint256) {
        uint256 baseBalance = IERC20(asset()).balanceOf(address(this));

        address engine = marginEngine;
        if (engine == address(0)) {
            return baseBalance;
        }

        uint256 sz;
        assembly {
            sz := extcodesize(engine)
        }
        if (sz == 0) {
            return baseBalance;
        }

        if (useBasketMarkToMarket) {
            return _basketTotalAssets(engine, baseBalance);
        }

        (bool ok, bytes memory ret) = engine.staticcall{gas: NET_COLLATERAL_GAS}(
            abi.encodeWithSelector(NET_COLLATERAL_USD_Q96_SELECTOR, address(this))
        );
        if (!ok || ret.length < 32) {
            return baseBalance;
        }

        uint256 netCollateralUsdQ96 = abi.decode(ret, (uint256));
        uint256 netCollateralUsd = netCollateralUsdQ96 >> 48;
        return netCollateralUsd + baseBalance;
    }

    /// @dev Basket-mode `totalAssets()` helper. Snapshots the side-assets array, fetches a
    ///      live price for each via the configured PriceOracle, and asks the margin engine
    ///      to mark-to-market the basket in one stateless call. Returns `baseBalance` on
    ///      any defensive failure path (missing oracle, oracle revert, engine revert, or
    ///      negative engine return) so deposits / withdrawals never brick on a transient
    ///      pricing problem.
    function _basketTotalAssets(address engine, uint256 baseBalance) internal view returns (uint256) {
        address oracle = priceOracle;
        if (oracle == address(0)) return baseBalance;
        uint256 oracleSz;
        assembly {
            oracleSz := extcodesize(oracle)
        }
        if (oracleSz == 0) return baseBalance;

        uint256 n = sideAssets.length;
        // Build snapshot arrays. Empty basket short-circuits to the base balance because
        // the engine has nothing to mark and we should not pay the staticcall.
        if (n == 0) return baseBalance;

        address[] memory assets = new address[](n);
        uint256[] memory balances = new uint256[](n);
        uint256[] memory pricesQ96 = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            address a = sideAssets[i];
            assets[i] = a;
            // Side balances are always positive on the vault (`pushSideBalance` requires
            // > 0, `pull` reverts on insufficient), so we pass them as `uint256` directly.
            // The engine returns a SIGNED int256 NAV because the cross-asset basket can
            // net to negative even if every leg is unsigned; the sign lives in the result,
            // not the inputs.
            balances[i] = sideBalance[a];

            (bool pOk, bytes memory pRet) =
                oracle.staticcall{gas: 50_000}(abi.encodeWithSelector(GET_PRICE_SELECTOR, a));
            if (!pOk || pRet.length < 32) return baseBalance;
            pricesQ96[i] = abi.decode(pRet, (uint256));
        }

        (bool eOk, bytes memory eRet) = engine.staticcall{gas: NET_COLLATERAL_GAS}(
            abi.encodeWithSelector(MARK_TO_MARKET_BASKET_SELECTOR, assets, balances, pricesQ96)
        );
        if (!eOk || eRet.length < 32) return baseBalance;

        int256 nav = abi.decode(eRet, (int256));
        // Negative NAV from the engine cannot reduce the vault below its ERC-4626 base
        // balance (totalAssets() returns uint256). Treat negative as zero contribution and
        // log the loss off-chain via the engine's own events.
        if (nav <= 0) return baseBalance;

        // Engine returns Q96.48 (consistent with the stateful path); truncate to integer USD.
        uint256 navUsd = uint256(nav) >> 48;
        return navUsd + baseBalance;
    }

    function totalBaseAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function deposit(
        uint256 assets,
        address receiver
    )
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    )
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner);
    }

    function sideAssetsLength() external view returns (uint256) {
        return sideAssets.length;
    }

    function _vaultOwner() internal view returns (address) {
        return IERC721(positionNFT).ownerOf(tokenId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @dev Mock stateless margin engine that returns a configurable int256 NAV in Q96.48 from
///      its `markToMarketBasket(address[],uint256[],uint256[])` method. Also records the
///      args for assertion. The selector is camelCase per Stylus ABI rules.
contract MockBasketEngine {
    int256 public navQ96;
    bool public shouldRevert;

    address[] public lastAssets;
    uint256[] public lastBalances;
    uint256[] public lastPrices;
    uint256 public callCount;

    function setNav(int256 v) external {
        navQ96 = v;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function markToMarketBasket(address[] calldata assets, uint256[] calldata balances, uint256[] calldata prices)
        external
        returns (int256)
    {
        // Even though the production engine is view, Solidity allows a non-view mock for
        // assertion bookkeeping; the staticcall in AgentVault would revert here. We treat
        // the call as view by ONLY emitting a log and recording via storage when the test
        // explicitly wants to capture; tests that exercise the staticcall path use a
        // sibling pure-view helper instead.
        callCount++;
        delete lastAssets;
        delete lastBalances;
        delete lastPrices;
        for (uint256 i; i < assets.length; ++i) lastAssets.push(assets[i]);
        for (uint256 i; i < balances.length; ++i) lastBalances.push(balances[i]);
        for (uint256 i; i < prices.length; ++i) lastPrices.push(prices[i]);
        if (shouldRevert) revert("mock basket revert");
        return navQ96;
    }
}

/// @dev Pure-view mock used by AgentVault.totalAssets()'s staticcall. Returns a configured
///      Q96.48 value; reverts when configured to.
contract MockBasketEngineView {
    int256 public navQ96;
    bool public shouldRevert;
    bool public shortReturn;

    function setNav(int256 v) external {
        navQ96 = v;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setShortReturn(bool v) external {
        shortReturn = v;
    }

    function markToMarketBasket(address[] calldata, uint256[] calldata, uint256[] calldata)
        external
        view
        returns (int256)
    {
        if (shouldRevert) revert("mock basket revert");
        if (shortReturn) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, 0)
                return(ptr, 16)
            }
        }
        return navQ96;
    }
}

/// @dev Pure-view price oracle mock. Returns a configured price per asset.
contract MockPriceOracle {
    mapping(address => uint256) public _price;
    mapping(address => bool) public _shouldRevert;

    function setPrice(address asset, uint256 p) external {
        _price[asset] = p;
    }

    function setShouldRevert(address asset, bool v) external {
        _shouldRevert[asset] = v;
    }

    function getPrice(address asset) external view returns (uint256) {
        if (_shouldRevert[asset]) revert("mock oracle revert");
        return _price[asset];
    }
}

contract AgentVaultBasketReaderTest is Test {
    AgentVault internal vault;
    PositionNFT internal nft;
    MockERC20 internal usdc;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    MockBasketEngineView internal engine;
    MockPriceOracle internal oracle;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal adapter = makeAddr("adapter");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    uint256 internal tokenId;

    function setUp() public {
        AgentVault impl = new AgentVault();
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), owner);

        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);
        amzn = new MockERC20("AMZN", "AMZN", 18);

        vm.prank(factory);
        tokenId = nft.mintTo(alice, address(0xdead));

        engine = new MockBasketEngineView();
        oracle = new MockPriceOracle();

        address[] memory emptyAdapters = new address[](0);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(engine),
                adapter,
                emptyAdapters,
                address(0),
                "V",
                "V"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));
    }

    function _seedSideBalances() internal {
        // Push 50 TSLA and 100 AMZN as side balances.
        tsla.mint(adapter, 50e18);
        amzn.mint(adapter, 100e18);
        vm.startPrank(adapter);
        tsla.approve(address(vault), 50e18);
        amzn.approve(address(vault), 100e18);
        vault.pushSideBalance(address(tsla), 50e18);
        vault.pushSideBalance(address(amzn), 100e18);
        vm.stopPrank();
    }

    function _depositAs(address user, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        vm.stopPrank();
    }

    // ---- Flag setters ----

    function test_default_useBasketMarkToMarket_is_false() public view {
        assertFalse(vault.useBasketMarkToMarket(), "default false");
    }

    function test_setUseBasketMarkToMarket_only_vault_owner() public {
        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        vault.setUseBasketMarkToMarket(true);

        vm.expectEmit(false, false, false, true, address(vault));
        emit AgentVault.MarginEngineModeChanged(true);
        vm.prank(alice);
        vault.setUseBasketMarkToMarket(true);
        assertTrue(vault.useBasketMarkToMarket(), "set true");
    }

    function test_setPriceOracle_only_vault_owner() public {
        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        vault.setPriceOracle(address(oracle));

        vm.expectEmit(true, true, false, false, address(vault));
        emit AgentVault.PriceOracleSet(address(0), address(oracle));
        vm.prank(alice);
        vault.setPriceOracle(address(oracle));
        assertEq(vault.priceOracle(), address(oracle), "oracle set");
    }

    // ---- totalAssets(): basket-mode happy path ----

    function test_basket_totalAssets_returns_engine_nav_plus_base() public {
        _depositAs(alice, 1_000e6);
        _seedSideBalances();

        // Configure: TSLA price 1.0 Q96, AMZN price 2.0 Q96 (arbitrary). NAV = 200 USD Q96.48.
        oracle.setPrice(address(tsla), 1 << 96);
        oracle.setPrice(address(amzn), 2 << 96);
        engine.setNav(int256(uint256(200) << 48));

        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        // Base balance is 1_000e6 USDC; engine returns 200 USD (integer USD after Q48 shift).
        assertEq(vault.totalAssets(), 1_000e6 + 200, "base + nav");
    }

    function test_basket_totalAssets_negative_nav_returns_base_only() public {
        _depositAs(alice, 500e6);
        _seedSideBalances();

        oracle.setPrice(address(tsla), 1 << 96);
        oracle.setPrice(address(amzn), 1 << 96);
        engine.setNav(-int256(uint256(100) << 48));

        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        // Negative NAV is clamped to zero contribution; totalAssets() never goes below base.
        assertEq(vault.totalAssets(), 500e6, "negative clamps");
    }

    // ---- Defensive fallbacks ----

    function test_basket_totalAssets_falls_back_when_oracle_unset() public {
        _depositAs(alice, 250e6);
        _seedSideBalances();

        vm.prank(alice);
        vault.setUseBasketMarkToMarket(true);
        // No oracle wired.
        assertEq(vault.totalAssets(), 250e6, "oracle missing -> base");
    }

    function test_basket_totalAssets_falls_back_when_oracle_reverts() public {
        _depositAs(alice, 333e6);
        _seedSideBalances();

        oracle.setPrice(address(tsla), 1 << 96);
        oracle.setPrice(address(amzn), 1 << 96);
        oracle.setShouldRevert(address(tsla), true);
        engine.setNav(int256(uint256(123) << 48));

        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        // First oracle read reverts -> fall back.
        assertEq(vault.totalAssets(), 333e6, "oracle revert -> base");
    }

    function test_basket_totalAssets_falls_back_when_engine_reverts() public {
        _depositAs(alice, 777e6);
        _seedSideBalances();

        oracle.setPrice(address(tsla), 1 << 96);
        oracle.setPrice(address(amzn), 1 << 96);
        engine.setShouldRevert(true);

        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        assertEq(vault.totalAssets(), 777e6, "engine revert -> base");
    }

    function test_basket_totalAssets_falls_back_on_short_return() public {
        _depositAs(alice, 111e6);
        _seedSideBalances();

        oracle.setPrice(address(tsla), 1 << 96);
        oracle.setPrice(address(amzn), 1 << 96);
        engine.setShortReturn(true);

        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        assertEq(vault.totalAssets(), 111e6, "short return -> base");
    }

    function test_basket_totalAssets_empty_basket_returns_base() public {
        _depositAs(alice, 999e6);

        // No side assets pushed; flag on; oracle wired; engine would return nonzero if asked.
        engine.setNav(int256(uint256(999_999) << 48));
        oracle.setPrice(address(tsla), 1 << 96);
        vm.startPrank(alice);
        vault.setPriceOracle(address(oracle));
        vault.setUseBasketMarkToMarket(true);
        vm.stopPrank();

        // Empty basket short-circuits to base balance (engine never called).
        assertEq(vault.totalAssets(), 999e6, "empty basket = base only");
    }

    // ---- Flag off keeps the legacy stateful path verbatim ----

    function test_legacy_path_unchanged_when_flag_off() public {
        _depositAs(alice, 500e6);
        _seedSideBalances();

        // Engine in this test returns the BASKET nav from the view variant only; the
        // staticcall to `netCollateralUsdQ96(address)` will short-return / 0 because
        // the mock does not implement that selector. The vault falls back to base.
        assertFalse(vault.useBasketMarkToMarket(), "flag off");
        assertEq(vault.totalAssets(), 500e6, "legacy path falls back to base on unimpl");
    }
}

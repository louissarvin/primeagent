// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockMarginEngine} from "../mocks/MockMarginEngine.sol";

contract AgentVaultTest is Test {
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    PositionNFT internal nft;

    MockERC20 internal usdc;
    MockERC20 internal tsla;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal adapter = makeAddr("adapter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    uint256 internal tokenId;

    function setUp() public {
        // Deploy implementation + beacon.
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        // Deploy NFT and set factory to this test.
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // Tokens.
        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);

        // The factory mints the NFT to alice and deploys the vault clone, in order.
        vm.prank(factory);
        tokenId = nft.mintTo(alice, address(0xdead));

        // Deploy the per-NFT BeaconProxy. We then re-point the NFT mapping to it.
        address[] memory emptyAdapters = new address[](0);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(0),
                adapter,
                emptyAdapters,
                address(0),
                "PrimeVault",
                "pVAULT"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));

        // Sanity: vault is initialized.
        assertEq(vault.asset(), address(usdc), "asset");
        assertEq(vault.positionNFT(), address(nft), "positionNFT");
        assertEq(vault.tokenId(), tokenId, "tokenId");
        assertEq(vault.adapter(), adapter, "adapter");
    }

    // ---- Initializer ----
    function test_initialize_only_once() public {
        address[] memory emptyAdapters = new address[](0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(
            address(usdc), address(nft), tokenId, address(0), adapter, emptyAdapters, address(0), "X", "X"
        );
    }

    function test_implementation_cannot_be_initialized() public {
        address[] memory emptyAdapters = new address[](0);
        // The implementation contract has _disableInitializers() in its constructor.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImpl.initialize(
            address(usdc), address(nft), tokenId, address(0), adapter, emptyAdapters, address(0), "X", "X"
        );
    }

    // ---- pushSideBalance / pullSideBalance ----
    function test_pushSideBalance_only_adapter() public {
        tsla.mint(mallory, 100e18);
        vm.startPrank(mallory);
        tsla.approve(address(vault), 100e18);
        vm.expectRevert(AgentVault.NotAdapter.selector);
        vault.pushSideBalance(address(tsla), 100e18);
        vm.stopPrank();
    }

    function test_pushSideBalance_credits_and_pulls_in_tokens() public {
        uint256 amount = 50e18;
        tsla.mint(adapter, amount);
        vm.startPrank(adapter);
        tsla.approve(address(vault), amount);
        vault.pushSideBalance(address(tsla), amount);
        vm.stopPrank();

        assertEq(vault.sideBalance(address(tsla)), amount, "sideBalance");
        assertEq(tsla.balanceOf(address(vault)), amount, "vault token bal");
        assertEq(vault.sideAssetsLength(), 1, "side assets length");
        assertEq(vault.sideAssets(0), address(tsla), "side assets[0]");
        assertTrue(vault.isSideAsset(address(tsla)), "isSideAsset");
    }

    function test_pullSideBalance_decrements() public {
        uint256 amount = 50e18;
        tsla.mint(adapter, amount);
        vm.startPrank(adapter);
        tsla.approve(address(vault), amount);
        vault.pushSideBalance(address(tsla), amount);

        vault.pullSideBalance(address(tsla), 30e18, bob);
        vm.stopPrank();

        assertEq(vault.sideBalance(address(tsla)), 20e18, "remaining");
        assertEq(tsla.balanceOf(bob), 30e18, "bob received");
    }

    function test_pullSideBalance_reverts_on_insufficient() public {
        vm.expectRevert(AgentVault.InsufficientSideBalance.selector);
        vm.prank(adapter);
        vault.pullSideBalance(address(tsla), 1, bob);
    }

    /// @notice Regression test for audit C-1. An authorised adapter MUST NOT be able to drain the
    ///         vault's ERC-4626 base asset (USDC) via `pullSideBalance`; doing so would silently
    ///         devalue every outstanding share because `totalAssets()` returns `balanceOf(this)`.
    function test_pullSideBalance_cannot_drain_base_asset() public {
        // Alice deposits 1000 USDC into the vault. The vault now holds the base asset.
        uint256 deposited = 1_000e6;
        _depositAs(alice, deposited);
        assertEq(vault.totalAssets(), deposited, "base assets present");

        // A compromised authorised adapter attempts to extract the USDC via pullSideBalance.
        vm.prank(adapter);
        vm.expectRevert(AgentVault.CannotPullBaseAsset.selector);
        vault.pullSideBalance(address(usdc), deposited, mallory);

        // Vault still holds the deposit; total assets are intact.
        assertEq(vault.totalAssets(), deposited, "base assets preserved");
        assertEq(usdc.balanceOf(mallory), 0, "attacker received nothing");
    }

    /// @notice Regression test for audit C-1 (symmetric pushSideBalance reject of base asset).
    ///         The push path already rejected the base asset before the fix; we lock the new
    ///         error name in so future refactors cannot drift the error type.
    function test_pushSideBalance_cannot_credit_base_asset() public {
        usdc.mint(adapter, 100e6);
        vm.startPrank(adapter);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert(AgentVault.CannotPullBaseAsset.selector);
        vault.pushSideBalance(address(usdc), 100e6);
        vm.stopPrank();
    }

    // ---- ERC-4626 deposit/withdraw ----
    function _depositAs(address user, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        vm.stopPrank();
    }

    function test_totalBaseAssets_matches_balance() public {
        _depositAs(alice, 1_000e6);
        assertEq(vault.totalBaseAssets(), 1_000e6, "base assets");
        assertEq(vault.totalAssets(), 1_000e6, "total assets (wave 2 ignores side)");
    }

    function test_deposit_then_redeem_roundtrip() public {
        uint256 amt = 1_000e6;
        uint256 shares = _depositAs(alice, amt);

        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        // OZ ERC4626 virtual-share offset rounds down by 1 wei on first redemption from a single
        // depositor; we tolerate this off-by-one because totalAssets() + 1 in the conversion math.
        assertApproxEqAbs(assets, amt, 2, "redeem roundtrip");
    }

    // ---- Pausable: deposit paused, withdraw never paused ----
    function test_deposit_paused() public {
        // Owner of NFT is alice; she pauses.
        vm.prank(alice);
        vault.pause();

        // mint + approve, expect revert on deposit.
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert();
        vault.deposit(100e6, alice);
        vm.stopPrank();
    }

    function test_withdraw_never_paused() public {
        // Deposit then pause then withdraw must still work.
        uint256 amt = 1_000e6;
        _depositAs(alice, amt);

        vm.prank(alice);
        vault.pause();
        assertTrue(vault.paused(), "paused");

        vm.prank(alice);
        uint256 shares = vault.withdraw(500e6, alice, alice);
        assertGt(shares, 0, "withdraw consumed shares");
        assertApproxEqAbs(usdc.balanceOf(alice), 500e6, 2, "alice usdc back");
    }

    function test_redeem_never_paused() public {
        uint256 amt = 1_000e6;
        uint256 shares = _depositAs(alice, amt);

        vm.prank(alice);
        vault.pause();
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(assets, amt, 2, "redeem under pause");
    }

    // ---- setMarginEngine ----
    function test_setMarginEngine_only_owner_of_nft() public {
        address newEngine = makeAddr("newEngine");

        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        vault.setMarginEngine(newEngine);

        vm.prank(alice);
        vault.setMarginEngine(newEngine);
        assertEq(vault.marginEngine(), newEngine, "engine set");
    }

    function test_pause_only_owner_of_nft() public {
        vm.expectRevert(AgentVault.NotPauser.selector);
        vm.prank(mallory);
        vault.pause();
    }

    // ---- setAdapter (Wave 3 multi-adapter set) ----
    function test_setAdapter_only_owner_of_nft() public {
        address newAdapter = makeAddr("newAdapter");

        // Non-owner cannot toggle.
        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        vault.setAdapter(newAdapter, true);

        // Owner of the NFT (alice) succeeds.
        vm.expectEmit(true, false, false, true, address(vault));
        emit AgentVault.AdapterSet(newAdapter, true);
        vm.prank(alice);
        vault.setAdapter(newAdapter, true);
        assertTrue(vault.isAdapter(newAdapter), "isAdapter true");
    }

    function test_setAdapter_grants_push_pull_access() public {
        address newAdapter = makeAddr("newAdapter");

        // Before grant: newAdapter is unauthorized.
        tsla.mint(newAdapter, 100e18);
        vm.startPrank(newAdapter);
        tsla.approve(address(vault), 100e18);
        vm.expectRevert(AgentVault.NotAdapter.selector);
        vault.pushSideBalance(address(tsla), 50e18);
        vm.stopPrank();

        // Grant authorization.
        vm.prank(alice);
        vault.setAdapter(newAdapter, true);

        // Push works.
        vm.startPrank(newAdapter);
        vault.pushSideBalance(address(tsla), 50e18);
        assertEq(vault.sideBalance(address(tsla)), 50e18, "side balance after push");

        // Pull works.
        vault.pullSideBalance(address(tsla), 20e18, bob);
        assertEq(vault.sideBalance(address(tsla)), 30e18, "side balance after pull");
        assertEq(tsla.balanceOf(bob), 20e18, "bob received");
        vm.stopPrank();

        // Revoke authorization.
        vm.prank(alice);
        vault.setAdapter(newAdapter, false);
        assertFalse(vault.isAdapter(newAdapter), "isAdapter false after revoke");

        // After revoke: push and pull both revert.
        vm.startPrank(newAdapter);
        tsla.approve(address(vault), 10e18);
        vm.expectRevert(AgentVault.NotAdapter.selector);
        vault.pushSideBalance(address(tsla), 10e18);
        vm.expectRevert(AgentVault.NotAdapter.selector);
        vault.pullSideBalance(address(tsla), 1e18, bob);
        vm.stopPrank();
    }

    function test_legacy_adapter_still_works() public {
        // The constructor-set adapter retains push/pull access without being added via setAdapter.
        assertFalse(vault.isAdapter(adapter), "legacy adapter is not in the multi-set");

        uint256 amount = 40e18;
        tsla.mint(adapter, amount);
        vm.startPrank(adapter);
        tsla.approve(address(vault), amount);
        vault.pushSideBalance(address(tsla), amount);
        assertEq(vault.sideBalance(address(tsla)), amount, "legacy push works");

        vault.pullSideBalance(address(tsla), 10e18, bob);
        assertEq(vault.sideBalance(address(tsla)), amount - 10e18, "legacy pull works");
        assertEq(tsla.balanceOf(bob), 10e18, "bob received via legacy adapter");
        vm.stopPrank();
    }

    // ---- Task 1: totalAssets() with Stylus margin_engine staticcall ----

    /// @notice Without a wired margin engine, `totalAssets()` returns only the base balance.
    function test_totalAssets_with_marginEngine_zero_returns_base_balance() public {
        // No engine wired (setUp passes address(0)).
        assertEq(vault.marginEngine(), address(0), "engine unset");
        _depositAs(alice, 1_000e6);
        assertEq(vault.totalAssets(), 1_000e6, "base only");
    }

    /// @notice With a wired engine returning a non-zero Q96.48 value, `totalAssets()` adds the
    ///         integer-USD net to the base balance.
    function test_totalAssets_with_marginEngine_wired_uses_staticcall_result() public {
        MockMarginEngine engine = new MockMarginEngine();
        // Set 100 USD net collateral (raw Q96.48 = 100 << 48).
        engine.setNetCollateralUsdQ96(address(vault), uint256(100) << 48);

        vm.prank(alice);
        vault.setMarginEngine(address(engine));

        _depositAs(alice, 1_000e6);
        // Base = 1_000_000_000 (1000 USDC at 6dp) + integer USD 100 = 1_000_000_100.
        assertEq(vault.totalAssets(), 1_000e6 + 100, "engine net added");
    }

    /// @notice When the engine reverts, `totalAssets()` falls back to the base balance instead
    ///         of bricking share-price reads or withdrawals.
    function test_totalAssets_with_marginEngine_revert_falls_back_to_base_balance() public {
        MockMarginEngine engine = new MockMarginEngine();
        engine.setShouldRevert(true);

        vm.prank(alice);
        vault.setMarginEngine(address(engine));

        _depositAs(alice, 500e6);
        // Engine reverts -> falls back to base.
        assertEq(vault.totalAssets(), 500e6, "fallback on revert");
    }

    /// @notice With a wired engine returning zero, `totalAssets()` returns just the base balance.
    function test_totalAssets_with_marginEngine_zero_q96_returns_just_base() public {
        MockMarginEngine engine = new MockMarginEngine();
        // Default: zero net collateral.

        vm.prank(alice);
        vault.setMarginEngine(address(engine));

        _depositAs(alice, 2_500e6);
        assertEq(vault.totalAssets(), 2_500e6, "zero net + base");
    }

    /// @notice An engine that returns less than 32 bytes is rejected by the staticcall guard and
    ///         the vault falls back to the base balance.
    function test_totalAssets_with_marginEngine_short_return_falls_back_to_base() public {
        MockMarginEngine engine = new MockMarginEngine();
        engine.setShortReturn(true);

        vm.prank(alice);
        vault.setMarginEngine(address(engine));

        _depositAs(alice, 750e6);
        assertEq(vault.totalAssets(), 750e6, "short-return falls back to base");
    }

    /// @notice An engine address pointing at an EOA (no code) is short-circuited via the
    ///         extcodesize check; `totalAssets()` returns the base balance.
    function test_totalAssets_with_marginEngine_eoa_falls_back_to_base() public {
        address eoaEngine = makeAddr("noCodeEngine");
        vm.prank(alice);
        vault.setMarginEngine(eoaEngine);

        _depositAs(alice, 333e6);
        assertEq(vault.totalAssets(), 333e6, "EOA engine falls back to base");
    }

    // ---- Task 2: delegated pauser ----

    /// @notice `setPauser` is gated on the NFT owner; non-owner callers revert with `NotOwner`.
    function test_setPauser_only_owner_of_nft() public {
        address candidate = makeAddr("pauserCandidate");

        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        vault.setPauser(candidate);

        vm.expectEmit(true, true, false, false, address(vault));
        emit AgentVault.PauserSet(address(0), candidate);
        vm.prank(alice);
        vault.setPauser(candidate);
        assertEq(vault.pauser(), candidate, "pauser set");
    }

    /// @notice The delegated pauser can call `pause()` even though it does not own the NFT.
    function test_pauser_can_pause_without_being_NFT_owner() public {
        address delegate = makeAddr("delegatePauser");
        vm.prank(alice);
        vault.setPauser(delegate);

        assertTrue(nft.ownerOf(tokenId) != delegate, "delegate is not the NFT owner");

        vm.prank(delegate);
        vault.pause();
        assertTrue(vault.paused(), "vault paused by delegate");
    }

    /// @notice The delegated pauser can also call `unpause()`.
    function test_pauser_can_unpause() public {
        address delegate = makeAddr("delegatePauser");
        vm.prank(alice);
        vault.setPauser(delegate);

        vm.prank(delegate);
        vault.pause();
        assertTrue(vault.paused(), "paused");

        vm.prank(delegate);
        vault.unpause();
        assertFalse(vault.paused(), "unpaused by delegate");
    }

    /// @notice The NFT owner can still pause/unpause when a delegated pauser is configured.
    function test_NFT_owner_can_still_pause_when_pauser_set() public {
        address delegate = makeAddr("delegatePauser");
        vm.prank(alice);
        vault.setPauser(delegate);

        vm.prank(alice);
        vault.pause();
        assertTrue(vault.paused(), "owner paused");

        vm.prank(alice);
        vault.unpause();
        assertFalse(vault.paused(), "owner unpaused");
    }

    /// @notice A random address that is neither the NFT owner nor the delegated pauser is
    ///         rejected with `NotPauser`.
    function test_random_address_cannot_pause() public {
        address delegate = makeAddr("delegatePauser");
        vm.prank(alice);
        vault.setPauser(delegate);

        address randomGuy = makeAddr("randomGuy");
        vm.expectRevert(AgentVault.NotPauser.selector);
        vm.prank(randomGuy);
        vault.pause();
    }

    /// @notice The factory wires `initialPauser` at deploy time so the coordinator can pause
    ///         without any post-deploy tx. Locked in via a direct re-initialize on a fresh proxy.
    function test_initialize_wires_initialPauser_slot() public {
        // Mint a second NFT id so we can spin up a fresh vault with non-zero initialPauser.
        vm.prank(factory);
        uint256 newTokenId = nft.mintTo(alice, address(0xdead));

        address initialPauser = makeAddr("initialPauser");
        address extraAdapter = makeAddr("extraAdapter");
        address[] memory initialAdapters = new address[](1);
        initialAdapters[0] = extraAdapter;

        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                newTokenId,
                address(0),
                address(0), // no legacy adapter
                initialAdapters,
                initialPauser,
                "V",
                "V"
            )
        );
        AgentVault freshVault = AgentVault(address(new BeaconProxy(address(beacon), initData)));

        assertEq(freshVault.pauser(), initialPauser, "initial pauser set at init");
        assertTrue(freshVault.isAdapter(extraAdapter), "initial adapter pre-authorised");

        // Re-point NFT mapping by minting again with the real vault.
        vm.prank(factory);
        nft.mintTo(alice, address(freshVault));
    }

    // ---- Fuzz roundtrip ----
    function testFuzz_deposit_then_withdraw_roundtrip(uint96 amount) public {
        amount = uint96(bound(uint256(amount), 1, 1_000_000_000e6));
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, alice);
        // OZ vault virtual-offset can produce shares = 0 only when amount is 0; we lower-bounded.
        assertGt(shares, 0, "shares minted");
        uint256 assets = vault.redeem(shares, alice, alice);
        vm.stopPrank();
        // Roundtrip is lossless to within 1 wei due to virtual offset rounding.
        assertApproxEqAbs(assets, amount, 1, "lossy roundtrip");
    }
}

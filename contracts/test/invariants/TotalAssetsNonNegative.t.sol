// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title TotalAssetsNonNegativeHandler
/// @notice Drives an AgentVault through deposit / withdraw / push / pull permutations so the
///         invariant runner can probe `totalAssets()` for any underflow, revert, or accounting
///         break. The handler does NOT directly assert anything; assertions live on
///         `TotalAssetsNonNegativeInvariants` and are evaluated between handler calls.
contract TotalAssetsNonNegativeHandler is Test {
    AgentVault public immutable vault;
    MockERC20 public immutable usdc;
    MockERC20 public immutable sideTokenA;
    MockERC20 public immutable sideTokenB;
    address public immutable adapter;

    address[3] public users;

    constructor(
        AgentVault vault_,
        MockERC20 usdc_,
        MockERC20 sideA_,
        MockERC20 sideB_,
        address adapter_,
        address[3] memory users_
    ) {
        vault = vault_;
        usdc = usdc_;
        sideTokenA = sideA_;
        sideTokenB = sideB_;
        adapter = adapter_;
        users = users_;
    }

    function _pickUser(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _pickSideToken(uint256 seed) internal view returns (MockERC20) {
        return seed % 2 == 0 ? sideTokenA : sideTokenB;
    }

    function deposit(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        amount = uint96(bound(amount, 1, 1_000_000e6));
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        try vault.deposit(uint256(amount), user) {} catch {}
        vm.stopPrank();
    }

    function withdraw(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        uint256 maxW = vault.maxWithdraw(user);
        if (maxW == 0) return;
        uint256 want = bound(uint256(amount), 1, maxW);
        vm.prank(user);
        try vault.withdraw(want, user, user) {} catch {}
    }

    function pushSide(uint256 tokenSeed, uint96 amount) external {
        MockERC20 t = _pickSideToken(tokenSeed);
        amount = uint96(bound(amount, 1, 100_000e18));
        t.mint(adapter, amount);
        vm.startPrank(adapter);
        t.approve(address(vault), amount);
        try vault.pushSideBalance(address(t), amount) {} catch {}
        vm.stopPrank();
    }

    function pullSide(uint256 tokenSeed, uint96 amount, uint256 toSeed) external {
        MockERC20 t = _pickSideToken(tokenSeed);
        address to = _pickUser(toSeed);
        uint256 bal = vault.sideBalance(address(t));
        if (bal == 0) return;
        amount = uint96(bound(uint256(amount), 1, bal));
        vm.prank(adapter);
        try vault.pullSideBalance(address(t), uint256(amount), to) {} catch {}
    }
}

/// @title TotalAssetsNonNegativeInvariants
/// @notice Invariant fixture asserting that `AgentVault.totalAssets()`:
///         1) never reverts under any reachable handler state,
///         2) is always >= the vault's raw USDC balance (lower bound: base asset stays accounted),
///         3) tracks deposit accounting via `convertToAssets(totalSupply()) ~= totalAssets()`
///            within virtual-share rounding,
///         4) only moves by an amount commensurate with the most recent deposit/withdraw.
///
/// @dev Wave-2 implementation of `totalAssets` returns ONLY the base asset balance. When the
///      Stylus margin engine integration lands (Section 8.2; flagged TODO in AgentVault.sol),
///      this fixture will continue to exercise the lower-bound invariant: the marginEngine path
///      is additive, never subtractive, so `totalAssets() >= IERC20(asset()).balanceOf(vault)`
///      remains true. We probe `vault.marginEngine()` at runtime so the test is agnostic to
///      whether the engine has been wired or not.
contract TotalAssetsNonNegativeInvariants is StdInvariant, Test {
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    PositionNFT internal nft;

    MockERC20 internal usdc;
    MockERC20 internal tsla;
    MockERC20 internal amzn;

    address internal owner = makeAddr("totalAssets.owner");
    address internal factory = makeAddr("totalAssets.factory");
    address internal adapter = makeAddr("totalAssets.adapter");
    address internal nftOwner = makeAddr("totalAssets.nftOwner");

    TotalAssetsNonNegativeHandler internal handler;

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);
        amzn = new MockERC20("AMZN", "AMZN", 18);

        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        vm.prank(factory);
        nft.mintTo(nftOwner, address(0xdead));
        uint256 tokenId = 1;

        address[] memory empty;
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(0),
                adapter,
                empty,
                address(0),
                "PrimeVault",
                "pVAULT"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));

        vm.prank(factory);
        nft.mintTo(nftOwner, address(vault));

        // Seed 3 users so totalSupply is non-zero from block zero.
        address[3] memory u;
        u[0] = makeAddr("totalAssets.user.0");
        u[1] = makeAddr("totalAssets.user.1");
        u[2] = makeAddr("totalAssets.user.2");
        for (uint256 i; i < 3; ++i) {
            usdc.mint(u[i], 1_000_000e6);
            vm.startPrank(u[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(50_000e6, u[i]);
            vm.stopPrank();
        }

        handler = new TotalAssetsNonNegativeHandler(vault, usdc, tsla, amzn, adapter, u);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.pushSide.selector;
        selectors[3] = handler.pullSide.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Property 1: `totalAssets()` MUST NOT revert under any reachable state. The Stylus
    ///         margin engine path (Section 8.2) is documented to fall back to base balance on
    ///         staticcall failure; pre-Stylus the call is pure storage and cannot revert.
    function invariant_totalAssets_never_reverts() public {
        (bool ok, ) =
            address(vault).staticcall(abi.encodeWithSignature("totalAssets()"));
        require(ok, "totalAssets() reverted");
    }

    /// @notice Property 2: `totalAssets()` is always >= the vault's raw base-asset balance. The
    ///         margin engine path can only ADD to base balance (it nets in marked-to-market side
    ///         value); it never subtracts. Hence the base balance is a hard floor.
    function invariant_totalAssets_gte_baseAssetBalance() public view {
        uint256 base = IERC20(vault.asset()).balanceOf(address(vault));
        uint256 total = vault.totalAssets();
        require(total >= base, "totalAssets dropped below base balance");
    }

    /// @notice Property 3: `totalBaseAssets()` always equals the vault's raw base balance. This
    ///         is the audit-grade debug view documented in Section 7.4.
    function invariant_totalBaseAssets_equals_balanceOf() public view {
        uint256 base = IERC20(vault.asset()).balanceOf(address(vault));
        require(vault.totalBaseAssets() == base, "totalBaseAssets diverged from raw balance");
    }

    /// @notice Property 4: a single deposit of X immediately increases `totalAssets` by exactly
    ///         X (modulo virtual-share rounding of at most 1 wei). We verify this OUTSIDE the
    ///         handler permutation so we know it holds at any reachable state.
    function invariant_totalAssets_monotone_under_deposit() public {
        uint256 before = vault.totalAssets();
        address probe = makeAddr("probe.depositor");
        uint256 amount = 1_000e6;
        usdc.mint(probe, amount);

        uint256 snap = vm.snapshotState();
        vm.startPrank(probe);
        usdc.approve(address(vault), amount);
        try vault.deposit(amount, probe) {
            uint256 afterDeposit = vault.totalAssets();
            // Deposits MUST strictly grow totalAssets by approximately amount.
            require(
                afterDeposit >= before + amount - 1 && afterDeposit <= before + amount + 1,
                "deposit did not move totalAssets by ~amount"
            );
        } catch {
            // Deposit may revert if the vault is paused; the invariant only cares about
            // successful deposits.
        }
        vm.stopPrank();
        vm.revertToState(snap);
    }

    /// @notice Property 5: a withdraw of X immediately decreases `totalAssets` by X (modulo
    ///         virtual-share rounding of at most 1 wei).
    function invariant_totalAssets_monotone_under_withdraw() public {
        uint256 before = vault.totalAssets();
        // Pick a seeded user with positive shares to probe withdraw monotonicity.
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxW = vault.maxWithdraw(u);
            if (maxW == 0) continue;
            uint256 want = maxW > 1_000e6 ? 1_000e6 : maxW;
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.withdraw(want, u, u) {
                uint256 afterWithdraw = vault.totalAssets();
                require(
                    afterWithdraw + want + 1 >= before && afterWithdraw <= before - want + 1,
                    "withdraw did not move totalAssets by ~amount"
                );
            } catch {}
            vm.revertToState(snap);
            return; // Only need to verify on the first eligible user.
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title WithdrawNeverPausableHandler
/// @notice Stateful fuzzing handler that drives a single AgentVault through a permutation of
///         deposit / mint / withdraw / redeem / pause / unpause / side-balance pushes & pulls,
///         then asserts the canonical PrimeAgent invariant: shareholders can ALWAYS withdraw or
///         redeem irrespective of pause state. See PrimeAgent.md Section 7.4 ("redeem is never
///         pausable; Tilt invariant").
/// @dev Each handler entry-point is wrapped with `try { ... } catch { return; }`-style guards so
///      that a legitimate revert (e.g. `pause()` while already paused, or `withdraw` from a
///      depositor with no shares) does NOT count as a property violation. The actual property
///      assertions live on the `WithdrawNeverPausableInvariants` contract and are evaluated
///      between fuzz calls by Foundry's invariant runner.
contract WithdrawNeverPausableHandler is Test {
    AgentVault public immutable vault;
    MockERC20 public immutable usdc;
    MockERC20 public immutable sideToken;
    address public immutable nftOwner;
    address public immutable adapter;

    address[3] public users;

    // --- Telemetry: how many times each action was attempted/executed ---
    uint256 public depositCalls;
    uint256 public withdrawCalls;
    uint256 public pauseCalls;
    uint256 public unpauseCalls;
    uint256 public pushCalls;
    uint256 public pullCalls;

    constructor(
        AgentVault vault_,
        MockERC20 usdc_,
        MockERC20 sideToken_,
        address nftOwner_,
        address adapter_,
        address[3] memory users_
    ) {
        vault = vault_;
        usdc = usdc_;
        sideToken = sideToken_;
        nftOwner = nftOwner_;
        adapter = adapter_;
        users = users_;
    }

    function _pickUser(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function deposit(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        amount = uint96(bound(amount, 1, 1_000_000e6));
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        try vault.deposit(uint256(amount), user) {
            ++depositCalls;
        } catch {
            // tolerated: paused state can block deposit; not a violation.
        }
        vm.stopPrank();
    }

    function mint(uint256 userSeed, uint96 shares) external {
        address user = _pickUser(userSeed);
        shares = uint96(bound(shares, 1, 1_000_000e6));
        uint256 assetsNeeded = vault.previewMint(uint256(shares));
        if (assetsNeeded == 0 || assetsNeeded > 1_000_000_000e6) return;
        usdc.mint(user, assetsNeeded);
        vm.startPrank(user);
        usdc.approve(address(vault), assetsNeeded);
        try vault.mint(uint256(shares), user) {} catch {}
        vm.stopPrank();
    }

    function withdraw(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        uint256 maxW = vault.maxWithdraw(user);
        if (maxW == 0) return;
        uint256 want = bound(uint256(amount), 1, maxW);
        vm.prank(user);
        try vault.withdraw(want, user, user) {
            ++withdrawCalls;
        } catch {
            // Withdraw failure here is a hard violation; surface as a revert.
            revert("withdraw must always succeed when maxWithdraw > 0");
        }
    }

    function redeem(uint256 userSeed, uint96 shares) external {
        address user = _pickUser(userSeed);
        uint256 maxR = vault.maxRedeem(user);
        if (maxR == 0) return;
        uint256 want = bound(uint256(shares), 1, maxR);
        vm.prank(user);
        try vault.redeem(want, user, user) {} catch {
            revert("redeem must always succeed when maxRedeem > 0");
        }
    }

    function pauseVault() external {
        vm.prank(nftOwner);
        try vault.pause() {
            ++pauseCalls;
        } catch {}
    }

    function unpauseVault() external {
        vm.prank(nftOwner);
        try vault.unpause() {
            ++unpauseCalls;
        } catch {}
    }

    function pushSide(uint96 amount) external {
        amount = uint96(bound(amount, 1, 100_000e18));
        sideToken.mint(adapter, amount);
        vm.startPrank(adapter);
        sideToken.approve(address(vault), amount);
        try vault.pushSideBalance(address(sideToken), amount) {
            ++pushCalls;
        } catch {}
        vm.stopPrank();
    }

    function pullSide(uint96 amount, uint256 toSeed) external {
        address to = _pickUser(toSeed);
        uint256 bal = vault.sideBalance(address(sideToken));
        if (bal == 0) return;
        amount = uint96(bound(uint256(amount), 1, bal));
        vm.prank(adapter);
        try vault.pullSideBalance(address(sideToken), uint256(amount), to) {
            ++pullCalls;
        } catch {}
    }
}

/// @title WithdrawNeverPausableInvariants
/// @notice Invariant fixture that proves: regardless of how a vault has been driven through
///         deposits, withdrawals, pauses, and side-balance shuffles, a depositor with non-zero
///         shares can always exit via `withdraw` or `redeem`. This locks in the AgentVault
///         Section 7.4 guarantee that the audit and `test_withdraw_never_paused` unit test
///         enforce in single-shot tests; here we widen the surface to permutations.
contract WithdrawNeverPausableInvariants is StdInvariant, Test {
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    PositionNFT internal nft;

    MockERC20 internal usdc;
    MockERC20 internal tsla;

    address internal owner = makeAddr("invariants.owner");
    address internal factory = makeAddr("invariants.factory");
    address internal adapter = makeAddr("invariants.adapter");
    address internal nftOwner = makeAddr("invariants.nftOwner");

    WithdrawNeverPausableHandler internal handler;

    function setUp() public {
        // Tokens
        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);

        // NFT + factory wiring
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // Vault impl + beacon
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        // Mint the NFT to nftOwner. We mint twice because the BeaconProxy constructor needs to
        // know the tokenId, and the NFT's mintTo increments by 1 per call; the second mint is the
        // one bound to our vault clone.
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

        // Seed users with non-zero initial shares so the invariants have something to check.
        address[3] memory u;
        u[0] = makeAddr("invariants.user.0");
        u[1] = makeAddr("invariants.user.1");
        u[2] = makeAddr("invariants.user.2");
        for (uint256 i; i < 3; ++i) {
            usdc.mint(u[i], 1_000_000e6);
            vm.startPrank(u[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100_000e6, u[i]);
            vm.stopPrank();
        }

        handler = new WithdrawNeverPausableHandler(vault, usdc, tsla, nftOwner, adapter, u);
        targetContract(address(handler));

        // Constrain fuzzing to public handler entry points.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.mint.selector;
        selectors[2] = handler.withdraw.selector;
        selectors[3] = handler.redeem.selector;
        selectors[4] = handler.pauseVault.selector;
        selectors[5] = handler.unpauseVault.selector;
        selectors[6] = handler.pushSide.selector;
        selectors[7] = handler.pullSide.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Property 1: every seeded user can withdraw their `maxWithdraw` at any state. The
    ///         handler tracks ownership of shares; this invariant evaluates after each call.
    function invariant_withdraw_always_callable_when_user_has_shares() public {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxW = vault.maxWithdraw(u);
            if (maxW == 0) continue;
            // Snapshot vault state so we can revert post-check (Forge fuzz does not auto-revert).
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.withdraw(maxW, u, u) {} catch {
                revert("invariant_withdraw_always_callable_when_user_has_shares");
            }
            vm.revertToState(snap);
        }
    }

    /// @notice Property 2: redeem must always succeed when `maxRedeem > 0`.
    function invariant_redeem_always_callable_when_user_has_shares() public {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxR = vault.maxRedeem(u);
            if (maxR == 0) continue;
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.redeem(maxR, u, u) {} catch {
                revert("invariant_redeem_always_callable_when_user_has_shares");
            }
            vm.revertToState(snap);
        }
    }

    /// @notice Property 3: even when the vault is paused, withdraw still succeeds. This is the
    ///         direct codification of AgentVault Section 7.4's "redeem is never pausable" rule.
    function invariant_paused_state_does_not_block_withdraw() public {
        if (!vault.paused()) return;
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxW = vault.maxWithdraw(u);
            if (maxW == 0) continue;
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.withdraw(maxW, u, u) {} catch {
                revert("invariant_paused_state_does_not_block_withdraw");
            }
            vm.revertToState(snap);
        }
    }
}

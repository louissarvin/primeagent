// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {JurisdictionPolicyFacet} from "../../src/modules/JurisdictionPolicyFacet.sol";
import {IJurisdictionPolicyFacet} from "../../src/interfaces/IJurisdictionPolicyFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title JurisdictionPauseHandler
/// @notice Stateful fuzzing handler. Drives an `AgentVault` through deposits and a
///         `JurisdictionPolicyFacet` through pause/unpause calls on a permuted set of
///         ISO codes. The invariant fixture asserts that NO combination of
///         jurisdiction pauses ever blocks `withdraw` or `redeem` for shareholders.
contract JurisdictionPauseHandler is Test {
    AgentVault public immutable vault;
    MockERC20 public immutable usdc;
    PositionNFT public immutable nft;
    IJurisdictionPolicyFacet public immutable jurisdictionFacet;
    uint256 public immutable tokenId;
    address public immutable tokenOwner;

    address[3] public users;

    // Cycle through 8 candidate ISO codes; deterministic and exhaustive enough that
    // any single code can be paused / unpaused multiple times during a single run.
    bytes2[8] internal isos = [
        bytes2("GB"),
        bytes2("US"),
        bytes2("DE"),
        bytes2("FR"),
        bytes2("IE"),
        bytes2("JP"),
        bytes2("SG"),
        bytes2("CA")
    ];

    uint256 public pauseCalls;
    uint256 public unpauseCalls;

    constructor(
        AgentVault vault_,
        MockERC20 usdc_,
        PositionNFT nft_,
        IJurisdictionPolicyFacet jurisdictionFacet_,
        uint256 tokenId_,
        address tokenOwner_,
        address[3] memory users_
    ) {
        vault = vault_;
        usdc = usdc_;
        nft = nft_;
        jurisdictionFacet = jurisdictionFacet_;
        tokenId = tokenId_;
        tokenOwner = tokenOwner_;
        users = users_;
    }

    function _pickUser(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _pickIso(uint256 seed) internal view returns (bytes2) {
        return isos[seed % isos.length];
    }

    function deposit(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        amount = uint96(bound(uint256(amount), 1, 1_000_000e6));
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        try vault.deposit(uint256(amount), user) {} catch {}
        vm.stopPrank();
    }

    function pauseJurisdiction(uint256 isoSeed) external {
        bytes2 iso = _pickIso(isoSeed);
        vm.prank(tokenOwner);
        try jurisdictionFacet.pauseForJurisdiction(tokenId, iso) {
            ++pauseCalls;
        } catch {
            // tolerated: pausing an already-paused ISO is a legitimate revert.
        }
    }

    function unpauseJurisdiction(uint256 isoSeed) external {
        bytes2 iso = _pickIso(isoSeed);
        vm.prank(tokenOwner);
        try jurisdictionFacet.unpauseForJurisdiction(tokenId, iso) {
            ++unpauseCalls;
        } catch {
            // tolerated: unpausing a non-paused ISO is a legitimate revert.
        }
    }

    function withdraw(uint256 userSeed, uint96 amount) external {
        address user = _pickUser(userSeed);
        uint256 maxW = vault.maxWithdraw(user);
        if (maxW == 0) return;
        uint256 want = bound(uint256(amount), 1, maxW);
        vm.prank(user);
        try vault.withdraw(want, user, user) {}
        catch {
            revert("withdraw must succeed regardless of jurisdiction pause");
        }
    }

    function redeem(uint256 userSeed, uint96 shares) external {
        address user = _pickUser(userSeed);
        uint256 maxR = vault.maxRedeem(user);
        if (maxR == 0) return;
        uint256 want = bound(uint256(shares), 1, maxR);
        vm.prank(user);
        try vault.redeem(want, user, user) {}
        catch {
            revert("redeem must succeed regardless of jurisdiction pause");
        }
    }
}

/// @title WithdrawNeverPausedByJurisdictionInvariants
/// @notice Locks in the Tilt invariant: jurisdiction pauses (Feature P) never block
///         `AgentVault.withdraw` or `AgentVault.redeem`. The handler drives both a
///         real `AgentVault` and a real `JurisdictionPolicyFacet`-equipped Diamond
///         through permutations of deposits, withdraws, and jurisdiction toggles;
///         the invariants below assert exit paths remain open after every step.
contract WithdrawNeverPausedByJurisdictionInvariants is StdInvariant, Test {
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    PositionNFT internal nft;

    PrimeAgentDiamond internal diamond;
    JurisdictionPolicyFacet internal jurFacet;
    DiamondInit internal initContract;

    MockERC20 internal usdc;

    address internal owner = makeAddr("inv.owner");
    address internal factory = makeAddr("inv.factory");
    address internal adapter = makeAddr("inv.adapter");
    address internal nftOwner = makeAddr("inv.nftOwner");

    JurisdictionPauseHandler internal handler;

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        MockERC20 sideToken = new MockERC20("TSLA", "TSLA", 18);
        sideToken; // silence unused

        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // Diamond hosting the JurisdictionPolicyFacet. The PositionNFT address is
        // seeded into AuditStorage so the facet's ownerOf lookup works.
        jurFacet = new JurisdictionPolicyFacet();
        initContract = new DiamondInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(jurFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _jurSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        // Vault impl + beacon.
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        // First mint is throw-away to align ids with the post-vault mint.
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

        // Seed users with initial deposits.
        address[3] memory u;
        u[0] = makeAddr("inv.user.0");
        u[1] = makeAddr("inv.user.1");
        u[2] = makeAddr("inv.user.2");
        for (uint256 i; i < 3; ++i) {
            usdc.mint(u[i], 1_000_000e6);
            vm.startPrank(u[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100_000e6, u[i]);
            vm.stopPrank();
        }

        handler = new JurisdictionPauseHandler(
            vault,
            usdc,
            nft,
            IJurisdictionPolicyFacet(address(diamond)),
            tokenId,
            nftOwner,
            u
        );
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.redeem.selector;
        selectors[3] = handler.pauseJurisdiction.selector;
        selectors[4] = handler.unpauseJurisdiction.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _jurSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = JurisdictionPolicyFacet.pauseForJurisdiction.selector;
        s[1] = JurisdictionPolicyFacet.unpauseForJurisdiction.selector;
        s[2] = JurisdictionPolicyFacet.isPausedForJurisdiction.selector;
        s[3] = JurisdictionPolicyFacet.getPauseVersion.selector;
    }

    /// @notice Property: every shareholder can withdraw their `maxWithdraw` regardless
    ///         of how many jurisdictions have been paused / unpaused. Snapshots state
    ///         before each probe so the invariant fixture does not leak side-effects.
    function invariant_withdraw_unaffected_by_jurisdiction_pause() public {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxW = vault.maxWithdraw(u);
            if (maxW == 0) continue;
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.withdraw(maxW, u, u) {}
            catch {
                revert("invariant_withdraw_unaffected_by_jurisdiction_pause");
            }
            vm.revertToState(snap);
        }
    }

    /// @notice Property: every shareholder can redeem their `maxRedeem` regardless of
    ///         jurisdiction pause state.
    function invariant_redeem_unaffected_by_jurisdiction_pause() public {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            uint256 maxR = vault.maxRedeem(u);
            if (maxR == 0) continue;
            uint256 snap = vm.snapshotState();
            vm.prank(u);
            try vault.redeem(maxR, u, u) {}
            catch {
                revert("invariant_redeem_unaffected_by_jurisdiction_pause");
            }
            vm.revertToState(snap);
        }
    }
}

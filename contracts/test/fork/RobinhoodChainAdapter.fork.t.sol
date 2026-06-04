// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {V2Router} from "../../src/dex/V2Router.sol";
import {V3Pool} from "../../src/dex/V3Pool.sol";
import {V3PositionManager} from "../../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../../src/interfaces/IV3PositionManager.sol";
import {RobinhoodChainAdapter} from "../../src/modules/RobinhoodChainAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title RobinhoodChainAdapterForkTest
/// @notice Fork tests for `RobinhoodChainAdapter` running against the Robinhood Chain testnet
///         (chain 46630). Per PrimeAgent.md Section 7.9, the V2Router / V3Pool / V3PositionManager
///         on RH Chain are team-deployed; Wave 3 does NOT yet deploy them to the live network, so
///         this fork test deploys the DEX freshly on the fork and exercises swap roundtrips
///         end-to-end against the in-fork state.
/// @dev The test skips cleanly when `RH_CHAIN_RPC_URL` is empty (the CI default).
///      Run locally:
///         `RH_CHAIN_RPC_URL=... forge test --match-path test/fork/RobinhoodChainAdapter.fork.t.sol -vv`
contract RobinhoodChainAdapterForkTest is Test, IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // --- Test EOAs ---
    address internal owner = makeAddr("fork.rh.owner");
    address internal factory = makeAddr("fork.rh.factory");
    address internal alice = makeAddr("fork.rh.alice");
    address internal kernel = makeAddr("fork.rh.kernel");

    // --- Production stack (forked-chain deploy) ---
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    PositionNFT internal nft;

    V2Router internal v2;
    V3Pool internal v3;
    V3PositionManager internal posMgr;
    RobinhoodChainAdapter internal adapter;

    MockERC20 internal usdc;
    MockERC20 internal tsla;
    MockERC20 internal amzn;

    uint256 internal tokenId;

    // Q96 sqrt price for 1:1 pool initialization.
    uint160 internal constant START_SQRT = 79_228_162_514_264_337_593_543_950_336;

    modifier onFork() {
        string memory rpc = vm.envOr("RH_CHAIN_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "RH_CHAIN_RPC_URL not set; skipping fork test");
            return;
        }
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("RH_CHAIN_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // Skip-setup: no fork URL configured.
        vm.createSelectFork(rpc);
        require(block.chainid == 46630, "fork must select Robinhood Chain testnet");

        // ----- Tokens (deployed fresh on the fork) -----
        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);
        amzn = new MockERC20("AMZN", "AMZN", 18);

        // ----- NFT + factory wiring -----
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // ----- Vault impl + beacon -----
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        // Mint NFT #0 (placeholder vault) and #1 (real vault).
        vm.prank(factory);
        nft.mintTo(alice, address(0xdead));
        tokenId = 1;

        address[] memory empty;
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(0),
                address(0),
                empty,
                address(0),
                "PrimeAgent Vault",
                "pVAULT"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));

        vm.prank(factory);
        nft.mintTo(alice, address(vault));

        // ----- DEX: V2 + V3 + position manager, freshly deployed on the fork -----
        v2 = new V2Router();
        (address t0, address t1) =
            address(tsla) < address(amzn) ? (address(tsla), address(amzn)) : (address(amzn), address(tsla));
        v3 = new V3Pool(t0, t1, 3_000);
        v3.initialize(START_SQRT);
        posMgr = new V3PositionManager(address(v3));

        // ----- Adapter -----
        adapter = new RobinhoodChainAdapter(address(nft), address(v2), address(v3), address(0));

        // Authorize adapter on the vault.
        vm.prank(alice);
        vault.setAdapter(address(adapter), true);

        // ----- Seed V2 pool with deep liquidity -----
        tsla.mint(address(this), 10_000e18);
        amzn.mint(address(this), 10_000e18);
        v2.createPool(address(tsla), address(amzn));
        tsla.approve(address(v2), type(uint256).max);
        amzn.approve(address(v2), type(uint256).max);
        v2.addLiquidity(address(tsla), address(amzn), 10_000e18, 10_000e18);

        // ----- Seed V3 pool via the position manager -----
        tsla.mint(address(this), 10_000);
        amzn.mint(address(this), 10_000);
        tsla.approve(address(posMgr), type(uint256).max);
        amzn.approve(address(posMgr), type(uint256).max);
        IV3PositionManager.MintParams memory mp = IV3PositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: 3_000,
            tickLower: -1_000,
            tickUpper: 1_000,
            amount0Desired: 10_000,
            amount1Desired: 10_000,
            recipient: address(this)
        });
        posMgr.mint(mp);
    }

    // ----- Test helpers -----
    function _routeV2() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0));
    }

    function _routeV3(uint160 priceLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), bytes32(uint256(priceLimit)));
    }

    function _pushSideToVault(MockERC20 token, uint256 amount) internal {
        // Use the legacy adapter slot (`address(0)`) is empty in this test; instead we route the
        // push via the authorized adapter we just wired. The adapter contract isn't a normal EOA
        // we can prank-from cheaply; so we add a per-test transient legacy-adapter alias by
        // pranking from the adapter address. The adapter has no balanceOf signal so we mint
        // first then prank-approve.
        token.mint(address(adapter), amount);
        vm.startPrank(address(adapter));
        token.approve(address(vault), amount);
        vault.pushSideBalance(address(token), amount);
        vm.stopPrank();
    }

    // ----- Tests -----

    /// @notice Confirms the V2 swap path works end-to-end on the Robinhood Chain fork. We pre-seed
    ///         the vault with TSLA as a side balance, then call the adapter to swap to AMZN.
    function test_swap_via_v2_route_on_rh_chain_fork() public onFork {
        uint256 amountIn = 10e18;
        _pushSideToVault(tsla, amountIn);

        vm.prank(kernel);
        uint256 out = adapter.swap(tokenId, address(tsla), address(amzn), amountIn, 0, _routeV2());
        assertGt(out, 0, "V2 swap produced output");
        assertEq(vault.sideBalance(address(amzn)), out, "vault AMZN side balance credited");
    }

    /// @notice Confirms the V3 swap path works end-to-end on the Robinhood Chain fork. Uses
    ///         small amounts to stay within the V3 single-tick approximation.
    function test_swap_via_v3_route_on_rh_chain_fork() public onFork {
        uint256 amountIn = 1_000;
        _pushSideToVault(tsla, amountIn);

        bool zeroForOne = address(tsla) < address(amzn);
        uint160 limit = zeroForOne ? uint160(4_295_128_740) : type(uint160).max - 1;
        vm.prank(kernel);
        uint256 out = adapter.swap(tokenId, address(tsla), address(amzn), amountIn, 0, _routeV3(limit));
        assertGt(out, 0, "V3 swap produced output");
    }

    /// @notice Confirms the adapter cleanly rejects an unsupported route discriminator on the
    ///         fork (mirrors the unit-test guarantee).
    function test_swap_fails_gracefully_when_route_unsupported() public onFork {
        uint256 amountIn = 10e18;
        _pushSideToVault(tsla, amountIn);

        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.RouteUnsupported.selector);
        adapter.swap(tokenId, address(tsla), address(amzn), amountIn, 0, abi.encodePacked(uint8(99)));
    }
}

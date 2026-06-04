// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {V2Router} from "../../src/dex/V2Router.sol";
import {V3Pool} from "../../src/dex/V3Pool.sol";
import {V3PositionManager} from "../../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../../src/interfaces/IV3PositionManager.sol";
import {RobinhoodChainAdapter} from "../../src/modules/RobinhoodChainAdapter.sol";
import {IRobinhoodChainAdapter} from "../../src/interfaces/IRobinhoodChainAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract RobinhoodChainAdapterTest is Test, IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

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
    MockERC20 internal aapl;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal kernel = makeAddr("kernel");

    uint256 internal tokenId;

    uint160 internal constant START_SQRT = 79_228_162_514_264_337_593_543_950_336;

    function setUp() public {
        // Vault infra.
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);
        nft = new PositionNFT("PrimeAgent", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        usdc = new MockERC20("USDC", "USDC", 6);
        tsla = new MockERC20("TSLA", "TSLA", 18);
        aapl = new MockERC20("AAPL", "AAPL", 18);

        // Mint the NFT to alice.
        vm.prank(factory);
        tokenId = nft.mintTo(alice, address(0xdead));

        // Deploy vault clone.
        address[] memory emptyAdapters = new address[](0);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(0),
                address(0xbeef),
                emptyAdapters,
                address(0),
                "Vault",
                "V"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));
        // Re-point the NFT mapping (the mint set vaultOf = address(0xdead); rewrite for tests).
        // We can't directly modify NFT mapping, so we redeploy with the correct vault address.
        // Easier path: prank the factory to mintTo with the right vault.
        vm.prank(factory);
        tokenId = nft.mintTo(alice, address(vault));

        // Re-init the vault with the correct tokenId. Actually the vault was already initialized
        // with the previous tokenId. Easier approach: re-deploy vault with new tokenId.
        initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(0),
                address(0xbeef),
                emptyAdapters,
                address(0),
                "Vault",
                "V"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));
        // And mint AGAIN so the mapping is right.
        vm.prank(factory);
        tokenId = nft.mintTo(alice, address(vault));

        // DEX setup. V3 needs sorted (token0 < token1).
        v2 = new V2Router();
        (address t0, address t1) =
            address(tsla) < address(aapl) ? (address(tsla), address(aapl)) : (address(aapl), address(tsla));
        v3 = new V3Pool(t0, t1, 3_000);
        v3.initialize(START_SQRT);
        posMgr = new V3PositionManager(address(v3));

        adapter = new RobinhoodChainAdapter(address(nft), address(v2), address(v3), address(0));

        // Authorize the adapter on the vault.
        vm.prank(alice);
        vault.setAdapter(address(adapter), true);

        // Seed V2 pool with TSLA and AAPL reserves.
        tsla.mint(address(this), 10_000e18);
        aapl.mint(address(this), 10_000e18);
        v2.createPool(address(tsla), address(aapl));
        tsla.approve(address(v2), type(uint256).max);
        aapl.approve(address(v2), type(uint256).max);
        v2.addLiquidity(address(tsla), address(aapl), 10_000e18, 10_000e18);

        // Seed V3 pool via the PositionManager.
        tsla.mint(address(this), 10_000);
        aapl.mint(address(this), 10_000);
        tsla.approve(address(posMgr), type(uint256).max);
        aapl.approve(address(posMgr), type(uint256).max);
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

        // Pre-fund the vault with TSLA side-balance for the swap.
        tsla.mint(address(0xbeef), 100e18);
        vm.startPrank(address(0xbeef));
        tsla.approve(address(vault), 100e18);
        vault.pushSideBalance(address(tsla), 100e18);
        vm.stopPrank();
    }

    function _routeV2() internal pure returns (bytes memory) {
        // Just need a leading 0x00 byte.
        return abi.encodePacked(uint8(0));
    }

    function _routeV3(uint160 priceLimit) internal pure returns (bytes memory) {
        // Leading 0x01 byte then 32-byte uint with the sqrtPriceLimitX96.
        return abi.encodePacked(uint8(1), bytes32(uint256(priceLimit)));
    }

    function test_swap_v2_happy_path() public {
        uint256 amountIn = 10e18;
        vm.prank(kernel);
        uint256 out = adapter.swap(tokenId, address(tsla), address(aapl), amountIn, 0, _routeV2());
        assertGt(out, 0, "got output");
        assertEq(vault.sideBalance(address(aapl)), out, "vault credited");
    }

    function test_swap_v3_happy_path() public {
        // V3 pool has only 10k liquidity; swap a small amount to stay in-range. Static-analysis
        // S-M-1 mandated `V3Pool.MIN_SWAP_AMOUNT = 1_000`, so we use exactly the floor.
        uint256 amountIn = 1_000;
        // Pre-fund the vault with TSLA at small scale.
        tsla.mint(address(0xbeef), 1_000);
        vm.startPrank(address(0xbeef));
        tsla.approve(address(vault), 1_000);
        vault.pushSideBalance(address(tsla), 1_000);
        vm.stopPrank();
        // sqrtPriceLimit must not block the swap; use a wide bound.
        bool zeroForOne = address(tsla) < address(aapl);
        uint160 limit = zeroForOne ? uint160(4_295_128_739) : type(uint160).max - 1;
        vm.prank(kernel);
        uint256 out = adapter.swap(tokenId, address(tsla), address(aapl), amountIn, 0, _routeV3(limit));
        assertGt(out, 0);
    }

    function test_quote_v2_matches_swap() public {
        uint256 amountIn = 10e18;
        uint256 quoted = adapter.quote(tokenId, address(tsla), address(aapl), amountIn, _routeV2());
        vm.prank(kernel);
        uint256 actual = adapter.swap(tokenId, address(tsla), address(aapl), amountIn, 0, _routeV2());
        assertEq(quoted, actual);
    }

    function test_swap_revert_unknown_vault() public {
        // tokenId 999 does not exist => vaultOf returns address(0).
        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.UnknownVault.selector);
        adapter.swap(999, address(tsla), address(aapl), 1, 0, _routeV2());
    }

    function test_swap_revert_route_unsupported() public {
        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.RouteUnsupported.selector);
        adapter.swap(tokenId, address(tsla), address(aapl), 1e18, 0, abi.encodePacked(uint8(99)));
    }

    function test_swap_revert_slippage() public {
        uint256 amountIn = 10e18;
        // V2Router raises its own InsufficientOutput before the adapter's SlippageExceeded check
        // when the router-level min is enforced. Use the V2Router error.
        vm.prank(kernel);
        vm.expectRevert(V2Router.InsufficientOutput.selector);
        adapter.swap(tokenId, address(tsla), address(aapl), amountIn, 1_000_000e18, _routeV2());
    }

    function test_swap_revert_when_adapter_not_authorized() public {
        vm.prank(alice);
        vault.setAdapter(address(adapter), false);
        vm.prank(kernel);
        vm.expectRevert(AgentVault.NotAdapter.selector);
        adapter.swap(tokenId, address(tsla), address(aapl), 1e18, 0, _routeV2());
    }

    function test_swap_revert_zero_amount() public {
        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.ZeroAmount.selector);
        adapter.swap(tokenId, address(tsla), address(aapl), 0, 0, _routeV2());
    }

    function test_swap_revert_zero_token() public {
        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.ZeroAddress.selector);
        adapter.swap(tokenId, address(0), address(aapl), 1, 0, _routeV2());
    }

    function test_swap_emits_event() public {
        uint256 amountIn = 10e18;
        uint256 expected = adapter.quote(tokenId, address(tsla), address(aapl), amountIn, _routeV2());
        vm.expectEmit(true, true, true, true, address(adapter));
        emit IRobinhoodChainAdapter.SwapExecuted(tokenId, address(tsla), address(aapl), amountIn, expected, 0);
        vm.prank(kernel);
        adapter.swap(tokenId, address(tsla), address(aapl), amountIn, 0, _routeV2());
    }

    function test_swap_v3_revert_token_mismatch() public {
        // tokenIn is unrelated to the V3 pool. The adapter pulls from the vault first; if the
        // side balance doesn't exist, the vault reverts. If we pre-fund the side balance to
        // make the pull succeed, the V3 routing then reverts with RouteUnsupported.
        MockERC20 random = new MockERC20("R", "R", 18);
        random.mint(address(0xbeef), 1);
        vm.startPrank(address(0xbeef));
        random.approve(address(vault), 1);
        vault.pushSideBalance(address(random), 1);
        vm.stopPrank();
        vm.prank(kernel);
        vm.expectRevert(RobinhoodChainAdapter.RouteUnsupported.selector);
        adapter.swap(tokenId, address(random), address(aapl), 1, 0, _routeV3(type(uint160).max - 1));
    }
}

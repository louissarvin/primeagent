// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/*//////////////////////////////////////////////////////////////
                            USAGE
//////////////////////////////////////////////////////////////*/
//
// Local broadcast (anvil / Robinhood Chain testnet RPC):
//   forge script script/SeedLiquidity.s.sol --rpc-url <rpc> --broadcast
//
// Optional env vars:
//   DEPLOYER_PRIVATE_KEY            uint256   broadcaster pk (required unless --account)
//   USDC_ADDRESS                    address   optional; deploy fresh USDC mock if unset
//   V2_ROUTER                       address   optional; deploy fresh V2Router if unset
//   V3_POSITION_MANAGER             address   optional; if set, V3 pools/managers are skipped
//   LIQUIDITY_USDC_PER_POOL         uint256   optional; defaults to 100_000 * 1e6 ($100k notional)
//
// The script deploys (or reuses) USDC + the 5 stock mocks, creates a V2 pair + V3 pool per
// stock, and seeds each pool with $100k of notional both sides at the stock's prevailing price.
// It also dumps every address in a structured `LOG: ...` block so an off-chain harness can
// scrape the run output.

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {V2Router} from "../src/dex/V2Router.sol";
import {V3Pool} from "../src/dex/V3Pool.sol";
import {V3PositionManager} from "../src/dex/V3PositionManager.sol";
import {IV3PositionManager} from "../src/interfaces/IV3PositionManager.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @title SeedLiquidity
/// @notice One-shot bootstrap script that stands up the demo's tokenised equities and seeds the
///         in-house V2 + V3 forks with enough liquidity to demo TSLA / AMZN / PLTR / NFLX / AMD
///         trades against USDC. Pitch reference: PrimeAgent.md sections 14-15.
///
/// @dev Per-asset pricing (USD spot, as of 2026 pitch deck):
///         TSLA = $275, AMZN = $185, PLTR = $28, NFLX = $720, AMD = $165.
///       Per-pool notional = $100,000 each side, so:
///         TSLA pool = 363.636... TSLA + 100_000 USDC.
///         AMZN pool = 540.540... AMZN + 100_000 USDC.
///         PLTR pool = 3_571.428... PLTR + 100_000 USDC.
///         NFLX pool = 138.888... NFLX + 100_000 USDC.
///         AMD  pool = 606.060... AMD  + 100_000 USDC.
///       All stock mocks use 18 decimals (project convention). USDC uses 6 decimals to match
///       the real asset.
///
/// @dev V2 + V3 forks: see `src/dex/V2Router.sol`, `src/dex/V3Pool.sol`. The V3 pool is a
///       SIMPLIFIED constant-product fork that locks the fee tier to 0.3% (3000) and treats
///       `liquidity` as a 1:1 token0/token1 contribution at init, so we seed it via the
///       PositionManager `mint` path with equal desired amounts on both sides.
contract SeedLiquidity is Script {
    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice $100k notional per pool side (default).
    uint256 internal constant DEFAULT_LIQUIDITY_USDC = 100_000 * 1e6;

    /// @notice Stock decimals (project convention; matches `test/mocks/MockERC20.sol`).
    uint8 internal constant STOCK_DECIMALS = 18;

    /// @notice USDC decimals (matches the real asset).
    uint8 internal constant USDC_DECIMALS = 6;

    /// @notice V3 pool fee tier (locked to 0.3% in `V3Pool.sol`).
    uint24 internal constant V3_FEE = 3_000;

    /// @notice Sqrt(1) << 96 — initial V3 sqrt price for a 1:1 ratio. The V3 fork's pricing
    ///         is internal and self-corrects on `mint`; this is only used at `initialize`.
    uint160 internal constant V3_SQRT_PRICE_1 = uint160(1 << 96);

    /// @notice Full-range ticks for the V3 fork. The fork doesn't actually use ticks for
    ///         math (constant-product simplified path), but the position manager records them.
    int24 internal constant FULL_RANGE_LOWER = -887_220;
    int24 internal constant FULL_RANGE_UPPER = 887_220;

    /*//////////////////////////////////////////////////////////////
                              TYPES
    //////////////////////////////////////////////////////////////*/

    struct Stock {
        string name;
        string symbol;
        uint256 priceUsd; // integer USD (e.g. 275 for TSLA)
        address token;
        bytes32 v2PairKey;
        address v3Pool;
        address v3PositionManager;
        uint256 stockSeedAmount; // amount of stock tokens (18 dec) at $100k notional
    }

    /*//////////////////////////////////////////////////////////////
                              ENTRYPOINT
    //////////////////////////////////////////////////////////////*/

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 liquidityUsdc = vm.envOr("LIQUIDITY_USDC_PER_POOL", DEFAULT_LIQUIDITY_USDC);

        console2.log("==== SeedLiquidity ====");
        console2.log("Chain ID :", block.chainid);
        console2.log("Deployer :", deployer);
        console2.log("USDC per pool :", liquidityUsdc);

        vm.startBroadcast(pk);

        // 1. Quote asset (USDC, 6 decimals).
        address usdc = _deployOrReuseUsdc();

        // 2. V2Router (singleton fork instance).
        V2Router v2 = V2Router(_deployOrReuseV2Router());

        // 3. Stock mocks + per-asset pools.
        // We pass the broadcast EOA explicitly because foundry's script simulation reports a
        // synthetic `msg.sender` (`DefaultSender`) inside the script body that does not match the
        // address that signs the broadcasted transactions on chain. Using `vm.addr(pk)` keeps
        // the simulated state aligned with the real chain.
        Stock[5] memory stocks = _buildStockTable(liquidityUsdc);
        for (uint256 i; i < stocks.length; ++i) {
            _seedSingleStock(stocks[i], usdc, v2, liquidityUsdc, deployer);
        }

        vm.stopBroadcast();

        // 4. Structured log block for off-chain pickup.
        _printSummary(usdc, address(v2), stocks);
    }

    /*//////////////////////////////////////////////////////////////
                          STOCK TABLE BUILD
    //////////////////////////////////////////////////////////////*/

    function _buildStockTable(uint256 liquidityUsdc) internal pure returns (Stock[5] memory s) {
        s[0] = Stock({
            name: "Tesla",
            symbol: "TSLA",
            priceUsd: 275,
            token: address(0),
            v2PairKey: bytes32(0),
            v3Pool: address(0),
            v3PositionManager: address(0),
            stockSeedAmount: _stockSeedFor(liquidityUsdc, 275)
        });
        s[1] = Stock({
            name: "Amazon",
            symbol: "AMZN",
            priceUsd: 185,
            token: address(0),
            v2PairKey: bytes32(0),
            v3Pool: address(0),
            v3PositionManager: address(0),
            stockSeedAmount: _stockSeedFor(liquidityUsdc, 185)
        });
        s[2] = Stock({
            name: "Palantir",
            symbol: "PLTR",
            priceUsd: 28,
            token: address(0),
            v2PairKey: bytes32(0),
            v3Pool: address(0),
            v3PositionManager: address(0),
            stockSeedAmount: _stockSeedFor(liquidityUsdc, 28)
        });
        s[3] = Stock({
            name: "Netflix",
            symbol: "NFLX",
            priceUsd: 720,
            token: address(0),
            v2PairKey: bytes32(0),
            v3Pool: address(0),
            v3PositionManager: address(0),
            stockSeedAmount: _stockSeedFor(liquidityUsdc, 720)
        });
        s[4] = Stock({
            name: "AMD",
            symbol: "AMD",
            priceUsd: 165,
            token: address(0),
            v2PairKey: bytes32(0),
            v3Pool: address(0),
            v3PositionManager: address(0),
            stockSeedAmount: _stockSeedFor(liquidityUsdc, 165)
        });
    }

    /// @dev Converts a USDC notional (6 decimals) at a given USD spot to the matching stock
    ///      amount in 18 decimals: stockAmt = (usdcNotional * 10^18) / (price * 10^6).
    ///      Rounded DOWN. We multiply before dividing per project math rule. The price oracle
    ///      consequence is documented; rounding favors the protocol (less stock dispensed).
    function _stockSeedFor(uint256 usdcNotional, uint256 priceUsd) internal pure returns (uint256) {
        // (usdcNotional / 10^6) USD / priceUsd USD-per-share * 10^18 wei per share.
        // Rearranged: usdcNotional * 10^(18 - 6) / priceUsd = usdcNotional * 1e12 / priceUsd.
        return Math.mulDiv(usdcNotional, 1e12, priceUsd);
    }

    /*//////////////////////////////////////////////////////////////
                          PER-STOCK SEEDING
    //////////////////////////////////////////////////////////////*/

    function _seedSingleStock(
        Stock memory stock,
        address usdc,
        V2Router v2,
        uint256 liquidityUsdc,
        address provider
    )
        internal
    {

        // Deploy stock mock + mint enough for V2 + V3 seeding (2x stockSeedAmount).
        MockERC20 token = new MockERC20(stock.name, stock.symbol, STOCK_DECIMALS);
        stock.token = address(token);
        token.mint(provider, stock.stockSeedAmount * 2);

        // Mint matching USDC (also 2x for V2 + V3 seeding).
        MockERC20(usdc).mint(provider, liquidityUsdc * 2);

        // ---- V2: create pair, add liquidity ----
        // Note: `addLiquidity` pulls tokens from `msg.sender` via safeTransferFrom, so the
        // approve + add must run as the provider (already the broadcast EOA inside the script).
        // We use `approve` directly (not SafeERC20.safeIncreaseAllowance) because the latter
        // reads `allowance(address(this), spender)` and foundry refuses to expose the script's
        // address. `MockERC20` is a vanilla OZ ERC20 so the boolean approve return is honoured.
        stock.v2PairKey = v2.createPool(usdc, address(token));
        IERC20(usdc).approve(address(v2), liquidityUsdc);
        IERC20(address(token)).approve(address(v2), stock.stockSeedAmount);
        v2.addLiquidity(usdc, address(token), liquidityUsdc, stock.stockSeedAmount);

        // ---- V3: deploy a dedicated pool + position manager per pair ----
        // V3Pool enforces token0 < token1 in its constructor. Sort here.
        (address t0, address t1) = usdc < address(token) ? (usdc, address(token)) : (address(token), usdc);
        V3Pool pool = new V3Pool(t0, t1, V3_FEE);
        V3PositionManager manager = new V3PositionManager(address(pool));

        pool.initialize(V3_SQRT_PRICE_1);

        // The V3 fork uses `liquidity = min(amount0Desired, amount1Desired)` and applies that
        // as the actual contribution on BOTH sides (constant-product simplified path). Equal
        // desired amounts produce a clean min-bound liquidity figure. We pick the smaller of
        // (liquidityUsdc, stockSeedAmount) and use it for both, so the fork's per-side equality
        // assumption holds without leftover dust.
        uint256 v3Amount = liquidityUsdc < stock.stockSeedAmount ? liquidityUsdc : stock.stockSeedAmount;

        IERC20(t0).approve(address(manager), v3Amount);
        IERC20(t1).approve(address(manager), v3Amount);

        manager.mint(
            IV3PositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: V3_FEE,
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                amount0Desired: v3Amount,
                amount1Desired: v3Amount,
                recipient: provider
            })
        );

        stock.v3Pool = address(pool);
        stock.v3PositionManager = address(manager);

        console2.log("Seeded", stock.symbol);
        console2.log("  token             :", address(token));
        console2.log("  stock seed (1e18) :", stock.stockSeedAmount);
        console2.log("  v2 pairKey log    :");
        console2.logBytes32(stock.v2PairKey);
        console2.log("  v3 pool           :", address(pool));
        console2.log("  v3 positionMgr    :", address(manager));
    }

    /*//////////////////////////////////////////////////////////////
                          DEPLOY-OR-REUSE
    //////////////////////////////////////////////////////////////*/

    function _deployOrReuseUsdc() internal returns (address) {
        address existing = vm.envOr("USDC_ADDRESS", address(0));
        if (existing != address(0)) {
            console2.log("Reusing USDC at", existing);
            return existing;
        }
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", USDC_DECIMALS);
        console2.log("Deployed USDC mock", address(usdc));
        return address(usdc);
    }

    function _deployOrReuseV2Router() internal returns (address) {
        address existing = vm.envOr("V2_ROUTER", address(0));
        if (existing != address(0)) {
            console2.log("Reusing V2Router at", existing);
            return existing;
        }
        V2Router r = new V2Router();
        console2.log("Deployed V2Router", address(r));
        return address(r);
    }

    /*//////////////////////////////////////////////////////////////
                              SUMMARY
    //////////////////////////////////////////////////////////////*/

    function _printSummary(address usdc, address v2, Stock[5] memory stocks) internal pure {
        console2.log("");
        console2.log("==== SeedLiquidity Summary ====");
        console2.log("USDC      :", usdc);
        console2.log("V2Router  :", v2);
        console2.log("--- Per stock ---");
        for (uint256 i; i < stocks.length; ++i) {
            console2.log(stocks[i].symbol, "token:", stocks[i].token);
            console2.log("  v3 pool       :", stocks[i].v3Pool);
            console2.log("  v3 positionMgr:", stocks[i].v3PositionManager);
            console2.log("  price USD     :", stocks[i].priceUsd);
            console2.log("  stock seeded  :", stocks[i].stockSeedAmount);
        }
        console2.log("");
        console2.log("(All V2 pairs share the singleton V2Router above; pairKey can be recomputed");
        console2.log(" via V2Router.pairKeyOf(usdc, stockToken).)");
    }
}

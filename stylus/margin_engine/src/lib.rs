// PrimeAgent margin_engine: cross-domain mark-to-market and net-exposure.
// Source of truth: PrimeAgent.md Section 8.3 (Wave 2F).
//
// Architecture (Wave 2F scope):
//   - Per-vault, per-asset collateral balances in Q96.48.
//   - Per-asset margin requirement / liquidation threshold in basis points.
//   - PriceOracle and MCP attestor are configured at init time.
//   - Cross-domain math combines on-chain and attested off-chain margin.
//
// Wave 3 will tighten access control (only the PositionNFT-bound vault may push
// or pull collateral); Wave 2F intentionally accepts any caller for `push_*`
// and `pull_*` so that integration tests can drive the engine directly.
//
// Pins (workspace): stylus-sdk 0.10.7, alloy-primitives 1.6.0,
// alloy-sol-types 1.6.0, Rust 1.91.0.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
#![cfg_attr(not(any(feature = "export-abi", test)), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use alloy_primitives::{Address, I256, U256};
use alloy_sol_types::sol;
// `Call` is re-exported through the prelude via `stylus_core::calls::Call`.
use stylus_sdk::{call::static_call, prelude::*};

use quic_arithmetic::{Q96, Q96_ONE};

pub mod basket;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

sol_storage! {
    #[entrypoint]
    pub struct MarginEngine {
        /// Per-vault, per-asset collateral balance, stored as Q96.48 raw.
        mapping(address => mapping(address => uint256)) collateral_balance;

        /// Per-vault enumeration of assets that have non-zero collateral.
        /// We append on first deposit; we do NOT remove on withdrawal because
        /// Solidity-style mappings do not support removal without an extra
        /// "present" mapping. Idempotent reads gate the actual sum.
        mapping(address => address[]) vault_assets;

        /// O(1) presence lookup: `vault_assets_present[vault][asset] == true`
        /// if `asset` has been registered in `vault_assets[vault]`.
        mapping(address => mapping(address => bool)) vault_assets_present;

        /// Per-vault, per-asset open notional (Q96.48). Used to compute the
        /// margin requirement: `notional * margin_bps / 10_000`.
        mapping(address => mapping(address => uint256)) position_notional;

        /// Per-asset initial-margin requirement, in basis points (e.g. 2_500 = 25%).
        mapping(address => uint256) margin_requirement_bps;

        /// Per-asset liquidation threshold, in basis points (e.g. 1_500 = 15%).
        mapping(address => uint256) liquidation_threshold_bps;

        /// The Wave 2E PriceOracle contract (Solidity).
        address price_oracle;

        /// The RobinhoodMcpAttestor (off-chain notional attestation source).
        address attestor;

        /// Contract owner: set at `init`, gates parameter-setting methods.
        address owner;

        /// Initialization guard. `init` may run only when this is zero.
        bool initialized;
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

sol! {
    /// Emitted when collateral is pushed into a vault's bucket.
    event CollateralPushed(address indexed vault, address indexed asset, uint256 amount_q96);

    /// Emitted when collateral is pulled from a vault's bucket.
    event CollateralPulled(address indexed vault, address indexed asset, uint256 amount_q96);

    /// Emitted when an admin updates margin / liquidation parameters for an asset.
    event MarginParamsUpdated(
        address indexed asset,
        uint256 initial_bps,
        uint256 liq_bps
    );

    /// Emitted when an admin sets the open-position notional for a vault on an asset.
    event PositionNotionalUpdated(
        address indexed vault,
        address indexed asset,
        uint256 notional_q96
    );
}

// ---------------------------------------------------------------------------
// Errors (encoded as &'static [u8] for Vec<u8> return type)
// ---------------------------------------------------------------------------

const ERR_UNAUTHORIZED: &[u8] = b"margin_engine: unauthorized";
const ERR_ALREADY_INITIALIZED: &[u8] = b"margin_engine: already initialized";
const ERR_NOT_INITIALIZED: &[u8] = b"margin_engine: not initialized";
const ERR_PRICE_ORACLE_FAILED: &[u8] = b"margin_engine: price oracle failed";
const ERR_INSUFFICIENT_COLLATERAL: &[u8] = b"margin_engine: insufficient collateral";
const ERR_INVALID_PARAMS: &[u8] = b"margin_engine: invalid params";
const ERR_OVERFLOW: &[u8] = b"margin_engine: arithmetic overflow";

// ---------------------------------------------------------------------------
// External ABI for PriceOracle.getPrice(address) -> uint256 (Q96.48)
//
// The Solidity PriceOracle exposes `getPrice(address asset) external view
// returns (uint256)` (see Wave 2E `contracts/oracle/PriceOracle.sol`). The
// selector below is keccak256("getPrice(address)")[:4] = 0x41976e09.
// ---------------------------------------------------------------------------

const PRICE_ORACLE_GET_PRICE_SELECTOR: [u8; 4] = [0x41, 0x97, 0x6e, 0x09];

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

#[public]
impl MarginEngine {
    /// One-time initializer: sets the price oracle, attestor, and owner.
    ///
    /// Sender becomes the owner. Reverts if already initialized.
    pub fn init(&mut self, price_oracle: Address, attestor: Address) -> Result<(), Vec<u8>> {
        if self.initialized.get() {
            return Err(ERR_ALREADY_INITIALIZED.to_vec());
        }
        if price_oracle == Address::ZERO || attestor == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        self.price_oracle.set(price_oracle);
        self.attestor.set(attestor);
        self.owner.set(self.vm().msg_sender());
        self.initialized.set(true);
        Ok(())
    }

    /// Returns the address of the configured PriceOracle.
    pub fn price_oracle(&self) -> Address {
        self.price_oracle.get()
    }

    /// Returns the address of the configured MCP attestor.
    pub fn attestor(&self) -> Address {
        self.attestor.get()
    }

    /// Returns the owner address.
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Update per-asset margin parameters. Only callable by owner.
    pub fn set_margin_params(
        &mut self,
        asset: Address,
        initial_bps: U256,
        liq_bps: U256,
    ) -> Result<(), Vec<u8>> {
        self.only_owner()?;
        if asset == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        // Liquidation threshold must be strictly below the initial requirement,
        // and both must be bounded by 100% (10_000 bps).
        let cap = U256::from(10_000u32);
        if initial_bps > cap || liq_bps > cap || liq_bps >= initial_bps {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        self.margin_requirement_bps.setter(asset).set(initial_bps);
        self.liquidation_threshold_bps.setter(asset).set(liq_bps);
        log(
            self.vm(),
            MarginParamsUpdated {
                asset,
                initial_bps,
                liq_bps,
            },
        );
        Ok(())
    }

    /// Returns the per-asset initial margin requirement in basis points.
    pub fn margin_requirement_bps(&self, asset: Address) -> U256 {
        self.margin_requirement_bps.get(asset)
    }

    /// Returns the per-asset liquidation threshold in basis points.
    pub fn liquidation_threshold_bps(&self, asset: Address) -> U256 {
        self.liquidation_threshold_bps.get(asset)
    }

    /// Returns the raw Q96.48 collateral balance held by `vault` in `asset`.
    pub fn collateral_balance(&self, vault: Address, asset: Address) -> U256 {
        self.collateral_balance.getter(vault).get(asset)
    }

    /// Returns the raw Q96.48 open notional for `vault` in `asset`.
    pub fn position_notional(&self, vault: Address, asset: Address) -> U256 {
        self.position_notional.getter(vault).get(asset)
    }

    /// Push collateral into `vault`'s bucket for `asset`. Amount is Q96.48 raw.
    ///
    /// Wave 2F accepts any caller (vault-only enforcement lands in Wave 3 once
    /// PositionNFT.vaultOf is wired in).
    pub fn push_collateral(
        &mut self,
        vault: Address,
        asset: Address,
        amount_q96: U256,
    ) -> Result<(), Vec<u8>> {
        self.require_init()?;
        self.only_vault(vault)?;
        if vault == Address::ZERO || asset == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        // Update balance with overflow check.
        let prev = self.collateral_balance.getter(vault).get(asset);
        let next = prev
            .checked_add(amount_q96)
            .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
        self.collateral_balance
            .setter(vault)
            .setter(asset)
            .set(next);

        // Register asset in the vault's asset list if not already present.
        if !self.vault_assets_present.getter(vault).get(asset) {
            self.vault_assets_present
                .setter(vault)
                .setter(asset)
                .set(true);
            self.vault_assets.setter(vault).push(asset);
        }

        log(
            self.vm(),
            CollateralPushed {
                vault,
                asset,
                amount_q96,
            },
        );
        Ok(())
    }

    /// Pull collateral out of `vault`'s bucket for `asset`. Amount is Q96.48 raw.
    pub fn pull_collateral(
        &mut self,
        vault: Address,
        asset: Address,
        amount_q96: U256,
    ) -> Result<(), Vec<u8>> {
        self.require_init()?;
        self.only_vault(vault)?;
        if vault == Address::ZERO || asset == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        let prev = self.collateral_balance.getter(vault).get(asset);
        if prev < amount_q96 {
            return Err(ERR_INSUFFICIENT_COLLATERAL.to_vec());
        }
        let next = prev - amount_q96;
        self.collateral_balance
            .setter(vault)
            .setter(asset)
            .set(next);

        log(
            self.vm(),
            CollateralPulled {
                vault,
                asset,
                amount_q96,
            },
        );
        Ok(())
    }

    /// Set or update the open-position notional for `vault` in `asset` (Q96.48 raw).
    ///
    /// In Wave 3 this becomes "delta-add"; for Wave 2F we expose a setter so
    /// tests can seed positions deterministically. Vault-only.
    pub fn set_position_notional(
        &mut self,
        vault: Address,
        asset: Address,
        notional_q96: U256,
    ) -> Result<(), Vec<u8>> {
        self.require_init()?;
        self.only_vault(vault)?;
        if vault == Address::ZERO || asset == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        self.position_notional
            .setter(vault)
            .setter(asset)
            .set(notional_q96);

        // Ensure asset is registered for iteration.
        if !self.vault_assets_present.getter(vault).get(asset) {
            self.vault_assets_present
                .setter(vault)
                .setter(asset)
                .set(true);
            self.vault_assets.setter(vault).push(asset);
        }
        log(
            self.vm(),
            PositionNotionalUpdated {
                vault,
                asset,
                notional_q96,
            },
        );
        Ok(())
    }

    /// Returns the total USD value of `vault`'s collateral as a Q96.48 number.
    ///
    /// Iterates the vault's registered assets, reads each price from the
    /// PriceOracle (Q96.48), and accumulates `balance * price / 2^48`.
    ///
    /// `view`: this method does not mutate state. It still requires `&mut self`
    /// in stylus 0.10.7 because `static_call` carries a mutating-context generic
    /// when used from a `#[public]` method.
    pub fn net_collateral_usd_q96(&mut self, vault: Address) -> Result<U256, Vec<u8>> {
        self.require_init()?;
        let len = self.vault_assets.getter(vault).len();
        let mut total = Q96::ZERO;
        for i in 0..len {
            let asset = self
                .vault_assets
                .getter(vault)
                .get(i)
                .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
            let raw_bal = self.collateral_balance.getter(vault).get(asset);
            if raw_bal.is_zero() {
                continue;
            }
            let bal = Q96::from_q96_raw(raw_bal);
            let price_raw = self.read_price_q96(asset)?;
            let price = Q96::from_q96_raw(price_raw);
            let line = bal.checked_mul(price).map_err(|_| ERR_OVERFLOW.to_vec())?;
            total = total.checked_add(line).map_err(|_| ERR_OVERFLOW.to_vec())?;
        }
        Ok(total.raw)
    }

    /// Returns the total margin currently used by `vault` as a Q96.48 USD value.
    ///
    /// Pure function over storage; does not call the oracle. The formula is
    /// `sum_i (notional_i * margin_bps_i / 10_000)`.
    pub fn margin_used_usd_q96(&self, vault: Address) -> Result<U256, Vec<u8>> {
        let len = self.vault_assets.getter(vault).len();
        let mut total = Q96::ZERO;
        let bps_div = U256::from(10_000u32);
        for i in 0..len {
            let asset = self
                .vault_assets
                .getter(vault)
                .get(i)
                .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
            let raw_notional = self.position_notional.getter(vault).get(asset);
            if raw_notional.is_zero() {
                continue;
            }
            let bps = self.margin_requirement_bps.get(asset);
            // line = notional * bps / 10_000, computed in U256 over the raw Q96.48.
            let scaled = raw_notional
                .checked_mul(bps)
                .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
            let line_raw = scaled / bps_div;
            total = total
                .checked_add(Q96::from_q96_raw(line_raw))
                .map_err(|_| ERR_OVERFLOW.to_vec())?;
        }
        Ok(total.raw)
    }

    /// Returns true when the vault is below its liquidation threshold.
    ///
    /// Definition: collateral USD divided by total notional, in basis points,
    /// is strictly less than the asset's `liquidation_threshold_bps`. For a
    /// multi-asset vault we use the maximum threshold across held assets as
    /// the conservative bound. If the vault has no notional, returns `false`.
    pub fn liquidation_check(&mut self, vault: Address) -> Result<bool, Vec<u8>> {
        self.require_init()?;
        let collateral_raw = self.net_collateral_usd_q96(vault)?;

        let len = self.vault_assets.getter(vault).len();
        let mut total_notional = Q96::ZERO;
        let mut max_liq_bps = U256::ZERO;

        for i in 0..len {
            let asset = self
                .vault_assets
                .getter(vault)
                .get(i)
                .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
            let raw_notional = self.position_notional.getter(vault).get(asset);
            if raw_notional.is_zero() {
                continue;
            }
            total_notional = total_notional
                .checked_add(Q96::from_q96_raw(raw_notional))
                .map_err(|_| ERR_OVERFLOW.to_vec())?;
            let liq = self.liquidation_threshold_bps.get(asset);
            if liq > max_liq_bps {
                max_liq_bps = liq;
            }
        }

        if total_notional.raw.is_zero() {
            return Ok(false);
        }

        // threshold = total_notional * max_liq_bps / 10_000
        let threshold_raw = total_notional
            .raw
            .checked_mul(max_liq_bps)
            .ok_or_else(|| ERR_OVERFLOW.to_vec())?
            / U256::from(10_000u32);

        Ok(collateral_raw < threshold_raw)
    }

    /// Stateless basket mark-to-market.
    ///
    /// Computes `Sigma balances_i * prices_i` over a caller-supplied basket of
    /// `(asset, balance, price)` tuples in Q96.48, returning a signed
    /// `I256` Q96.48 sum. Does NOT read storage, does NOT call the oracle.
    ///
    /// This is the Feature E entrypoint (see IMPLEMENTATION_PLAN.md section
    /// 2.E). It is additive: existing callers of `net_collateral_usd_q96`
    /// remain on the stateful path until they opt-in to the basket reader.
    ///
    /// Solidity ABI signature: `markToMarketBasket(address[],uint256[],uint256[])`
    /// Function selector (keccak256 first 4 bytes): `0x5e89fd56`.
    ///
    /// Computed via:
    /// `cast sig "markToMarketBasket(address[],uint256[],uint256[])"`
    ///
    /// Validation:
    ///   - `assets`, `balances`, `prices` must all have the same length.
    ///   - Length must be in `0..=basket::MAX_BASKET_LEN` (30).
    ///   - No element of `assets` may be `Address::ZERO`.
    ///
    /// Error handling:
    ///   - Validation failures return `I256::MIN` rather than reverting, so a
    ///     downstream `AgentVault.totalAssets()` call (ERC-4626 share pricing)
    ///     never reverts due to a malformed feed.
    ///   - Arithmetic overflow saturates to `I256::MAX` (see `basket.rs`).
    pub fn mark_to_market_basket(
        &self,
        assets: Vec<Address>,
        balances: Vec<U256>,
        prices: Vec<U256>,
    ) -> I256 {
        basket::compute_basket_value_vec(assets, balances, prices)
    }

    /// Combines on-chain and attested off-chain margin into a single Q96.48
    /// "free margin" number. Spec's flagship formula (Section 8.3):
    ///
    /// `cross = (on_collat + off_collat) - max(on_margin, off_margin)`
    ///
    /// `off_chain_notional_q96` is the off-chain open notional (attested via
    /// MCP). The off-chain margin requirement is computed against the largest
    /// margin bps across the vault's assets, which is conservative.
    ///
    /// Saturates to zero rather than reverting when the requirement exceeds
    /// the combined collateral, so the call can be used inside a view fallback.
    pub fn cross_domain_net_usd_q96(
        &mut self,
        vault: Address,
        off_chain_notional_q96: U256,
        off_chain_collateral_q96: U256,
    ) -> Result<U256, Vec<u8>> {
        self.require_init()?;

        let on_collat_raw = self.net_collateral_usd_q96(vault)?;
        let on_margin_raw = self.margin_used_usd_q96(vault)?;

        let on_collat = Q96::from_q96_raw(on_collat_raw);
        let off_collat = Q96::from_q96_raw(off_chain_collateral_q96);
        let on_margin = Q96::from_q96_raw(on_margin_raw);

        // Compute off-chain margin using the highest configured initial bps
        // across the assets the vault holds. This is intentionally conservative
        // and avoids requiring per-asset off-chain notionals from the caller.
        let max_bps = self.max_margin_bps(vault)?;
        let off_margin_raw = off_chain_notional_q96
            .checked_mul(max_bps)
            .ok_or_else(|| ERR_OVERFLOW.to_vec())?
            / U256::from(10_000u32);
        let off_margin = Q96::from_q96_raw(off_margin_raw);

        let total_collat = on_collat
            .checked_add(off_collat)
            .map_err(|_| ERR_OVERFLOW.to_vec())?;
        let worst_margin = on_margin.max(off_margin);
        let net = total_collat.saturating_sub(worst_margin);
        Ok(net.raw)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (kept out of the public ABI)
// ---------------------------------------------------------------------------

impl MarginEngine {
    fn require_init(&self) -> Result<(), Vec<u8>> {
        if !self.initialized.get() {
            return Err(ERR_NOT_INITIALIZED.to_vec());
        }
        Ok(())
    }

    fn only_owner(&self) -> Result<(), Vec<u8>> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(ERR_UNAUTHORIZED.to_vec());
        }
        Ok(())
    }

    /// Vault-only gate (Wave 2F: any caller permitted, see crate-level comment).
    fn only_vault(&self, _vault: Address) -> Result<(), Vec<u8>> {
        // Wave 3 will compare msg_sender against PositionNFT.vaultOf(vault).
        Ok(())
    }

    /// Static-call the PriceOracle for the Q96.48 price of `asset`.
    fn read_price_q96(&mut self, asset: Address) -> Result<U256, Vec<u8>> {
        let oracle = self.price_oracle.get();
        if oracle == Address::ZERO {
            return Err(ERR_PRICE_ORACLE_FAILED.to_vec());
        }
        // calldata = selector || abi.encode(asset)
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&PRICE_ORACLE_GET_PRICE_SELECTOR);
        // address is 20 bytes right-padded to 32 in ABI encoding.
        let mut addr_word = [0u8; 32];
        addr_word[12..].copy_from_slice(asset.as_slice());
        calldata.extend_from_slice(&addr_word);

        let returned = static_call(self.vm(), Call::new(), oracle, &calldata)
            .map_err(|_| ERR_PRICE_ORACLE_FAILED.to_vec())?;
        if returned.len() < 32 {
            return Err(ERR_PRICE_ORACLE_FAILED.to_vec());
        }
        // ABI-decode a single uint256 from the first 32 bytes.
        Ok(U256::from_be_slice(&returned[..32]))
    }

    /// Highest `margin_requirement_bps` across the vault's registered assets.
    /// Returns the asset-zero default of `0` when the vault holds nothing.
    fn max_margin_bps(&self, vault: Address) -> Result<U256, Vec<u8>> {
        let len = self.vault_assets.getter(vault).len();
        let mut max = U256::ZERO;
        for i in 0..len {
            let asset = self
                .vault_assets
                .getter(vault)
                .get(i)
                .ok_or_else(|| ERR_OVERFLOW.to_vec())?;
            let bps = self.margin_requirement_bps.get(asset);
            if bps > max {
                max = bps;
            }
        }
        Ok(max)
    }
}

/// Q96.48 marker constant re-exported so callers can construct prices in tests.
pub const Q96_ONE_RAW: U256 = Q96_ONE;

/// Helper that emits a Solidity event via the VM log API.
fn log<E: alloy_sol_types::SolEvent>(vm: &stylus_sdk::host::VM, event: E) {
    vm.log(event);
}

#[cfg(test)]
mod tests;

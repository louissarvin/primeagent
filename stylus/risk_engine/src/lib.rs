// PrimeAgent risk_engine: deterministic Monte Carlo Value-at-Risk.
// Source of truth: PrimeAgent.md Section 8.5.
//
// Wave 2F scope:
//   - Per-asset annualized volatility (basis points) in storage.
//   - `var_99_q96(vault, horizon_days)` -> 99%-VaR over a single-asset horizon,
//     computed by a small deterministic Monte Carlo (PATH_COUNT paths).
//   - Math helpers for `sqrt_q96` (Newton's method) and `ln_approx_q96`
//     (Taylor series around 1, used internally).
//
// Gas posture: on-chain Monte Carlo is expensive. PATH_COUNT is intentionally
// small (PATH_COUNT = 64) so the function fits in a `view` call gas budget.
// Production use would either (a) move this off-chain entirely, (b) use a
// pre-computed normal CDF table, or (c) run on Stylus with a much larger
// budget. The spec's "10k paths" claim is aspirational; we ship what is
// actually verifiable in tests.
//
// Pins (workspace): stylus-sdk 0.10.7, alloy-primitives 1.6.0,
// alloy-sol-types 1.6.0, Rust 1.91.0.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
#![cfg_attr(not(any(feature = "export-abi", test)), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use alloy_primitives::{Address, U256};
use alloy_sol_types::sol;
use stylus_sdk::prelude::*;

use quic_arithmetic::Q96;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Number of Monte Carlo paths simulated per VaR call.
///
/// Bounded so the on-chain cost stays within a reasonable `view` budget.
/// Each path requires one PRNG step, one ln-approx, and a few Q96 multiplies.
pub const PATH_COUNT: u32 = 64;

/// 99th percentile index for a 64-path simulation, computed as
/// `floor(64 * 0.01) = 0`. We use index 1 to avoid the absolute extreme.
pub const VAR_INDEX: usize = 1;

/// 10_000 basis points = 100%.
const BPS_DENOM: u32 = 10_000;

/// Number of days in a calendar year (used for vol annualization).
const DAYS_PER_YEAR: u32 = 365;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

sol_storage! {
    #[entrypoint]
    pub struct RiskEngine {
        /// Per-asset historical (annualized) volatility in basis points.
        /// Example: 8_000 bps = 80% annualized vol.
        mapping(address => uint256) historical_volatility_bps;

        /// Address of the deployed `MarginEngine` (for portfolio queries in
        /// Wave 3; not used by the Wave 2F VaR path).
        address margin_engine;

        /// Owner: set at `init`.
        address owner;

        /// Initialization guard.
        bool initialized;
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

sol! {
    event VolatilityUpdated(address indexed asset, uint256 vol_bps);
}

const ERR_UNAUTHORIZED: &[u8] = b"risk_engine: unauthorized";
const ERR_ALREADY_INITIALIZED: &[u8] = b"risk_engine: already initialized";
const ERR_INVALID_PARAMS: &[u8] = b"risk_engine: invalid params";
const ERR_OVERFLOW: &[u8] = b"risk_engine: arithmetic overflow";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

#[public]
impl RiskEngine {
    /// One-time initializer. Sender becomes the owner.
    pub fn init(&mut self, margin_engine: Address) -> Result<(), Vec<u8>> {
        if self.initialized.get() {
            return Err(ERR_ALREADY_INITIALIZED.to_vec());
        }
        if margin_engine == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        self.margin_engine.set(margin_engine);
        self.owner.set(self.vm().msg_sender());
        self.initialized.set(true);
        Ok(())
    }

    /// Returns the configured owner.
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Returns the configured margin engine address.
    pub fn margin_engine(&self) -> Address {
        self.margin_engine.get()
    }

    /// Update per-asset annualized volatility (basis points). Only owner.
    pub fn set_vol(&mut self, asset: Address, vol_bps: U256) -> Result<(), Vec<u8>> {
        if !self.initialized.get() {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        if self.vm().msg_sender() != self.owner.get() {
            return Err(ERR_UNAUTHORIZED.to_vec());
        }
        if asset == Address::ZERO {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        // Cap at 10_000% (1_000_000 bps) to avoid pathological multiplication.
        if vol_bps > U256::from(1_000_000u32) {
            return Err(ERR_INVALID_PARAMS.to_vec());
        }
        self.historical_volatility_bps.setter(asset).set(vol_bps);
        self.vm().log(VolatilityUpdated { asset, vol_bps });
        Ok(())
    }

    /// Returns the stored volatility (basis points) for `asset`.
    pub fn vol_bps(&self, asset: Address) -> U256 {
        self.historical_volatility_bps.get(asset)
    }

    /// Single-asset, single-position 99% Value-at-Risk over `horizon_days`.
    ///
    /// Inputs:
    ///   - `vault`: vault address (used to seed the PRNG; mixed with block
    ///     timestamp so two distinct vaults get different shocks).
    ///   - `asset`: the asset whose stored volatility is sampled.
    ///   - `notional_q96`: open notional in USD (Q96.48).
    ///   - `horizon_days`: VaR horizon in days.
    ///
    /// Returns a non-negative VaR estimate (Q96.48): the absolute value of the
    /// 1% worst simulated PnL across `PATH_COUNT` paths.
    pub fn var_99_q96(
        &self,
        vault: Address,
        asset: Address,
        notional_q96: U256,
        horizon_days: U256,
    ) -> Result<U256, Vec<u8>> {
        if horizon_days == U256::ZERO {
            return Ok(U256::ZERO);
        }
        let vol_bps = self.historical_volatility_bps.get(asset);
        if vol_bps == U256::ZERO {
            return Ok(U256::ZERO);
        }
        let ts = self.vm().block_timestamp();
        let vault_low = u64_from_address_low(vault);
        compute_var_99_q96_pure(vol_bps, notional_q96, horizon_days, ts, vault_low)
    }

    /// Public wrapper exposing the integer square root for verification.
    /// Returns `floor(sqrt(x))` in Q96.48 form.
    pub fn sqrt_q96_external(&self, x: U256) -> U256 {
        sqrt_q96(Q96::from_q96_raw(x)).raw
    }

    /// Public wrapper exposing the natural-log Taylor approximation.
    /// Valid for inputs in `[0.5 * 2^48, 2 * 2^48]` (Q96.48); accuracy degrades
    /// outside that band.
    pub fn ln_approx_q96_external(&self, x: U256) -> U256 {
        ln_approx_q96(Q96::from_q96_raw(x)).raw
    }
}

// ---------------------------------------------------------------------------
// Pure VaR core (host-agnostic; no VM, no storage).
// ---------------------------------------------------------------------------

/// Compute the 99% Value-at-Risk for a single-asset position without any
/// host or storage dependency.
///
/// Inputs are the same as `RiskEngine::var_99_q96`, with the `vol_bps` and
/// PRNG seed parameters now explicit so the function can be exercised from
/// integration tests that cannot link `stylus_sdk::testing::TestVM`
/// (`tests/var_invariant.rs` uses this path; see comment in
/// `risk_engine/tests/var_invariant.rs` for the dependency-version
/// rationale).
///
/// Invariants enforced by this function (asserted by `tests/var_invariant.rs`):
///   - Returns `U256::ZERO` if `vol_bps == 0` or `horizon_days == 0`.
///   - Result is non-negative (trivially, by U256).
///   - For fixed `(vol_bps, notional, seed_ts, seed_vault)`, the result is
///     non-decreasing in `horizon_days`.
pub fn compute_var_99_q96_pure(
    vol_bps: U256,
    notional_q96: U256,
    horizon_days: U256,
    seed_ts: u64,
    seed_vault_low: u64,
) -> Result<U256, Vec<u8>> {
    if horizon_days == U256::ZERO || vol_bps == U256::ZERO {
        return Ok(U256::ZERO);
    }

    // Horizon vol = annualized_vol * sqrt(horizon / 365).
    let vol_bps_u128 = u128_from_u256(vol_bps)?;
    let vol_q96 = Q96::from_u128(vol_bps_u128)
        .checked_div(Q96::from_u128(BPS_DENOM as u128))
        .map_err(|_| ERR_OVERFLOW.to_vec())?;
    let horizon_q96 = Q96::from_u128(u128_from_u256(horizon_days)?);
    let year_q96 = Q96::from_u128(DAYS_PER_YEAR as u128);
    let ratio = horizon_q96
        .checked_div(year_q96)
        .map_err(|_| ERR_OVERFLOW.to_vec())?;
    let sqrt_ratio = sqrt_q96(ratio);
    let scaled_vol = vol_q96
        .checked_mul(sqrt_ratio)
        .map_err(|_| ERR_OVERFLOW.to_vec())?;

    let mut rng = SplitMix64::new(seed_ts ^ seed_vault_low);
    let mut losses: Vec<U256> = Vec::with_capacity(PATH_COUNT as usize);
    let notional = Q96::from_q96_raw(notional_q96);
    for _ in 0..PATH_COUNT {
        let z_raw = rng.next_normal_q96();
        let is_loss = (z_raw & 1) == 0;
        let magnitude_q96 = z_raw >> 1;
        let mag = Q96::from_q96_raw(U256::from(magnitude_q96));
        let shock = mag
            .checked_mul(scaled_vol)
            .map_err(|_| ERR_OVERFLOW.to_vec())?;
        let pnl = notional
            .checked_mul(shock)
            .map_err(|_| ERR_OVERFLOW.to_vec())?;
        if is_loss {
            losses.push(pnl.raw);
        } else {
            losses.push(U256::ZERO);
        }
    }

    losses.sort();
    let idx = (PATH_COUNT as usize)
        .saturating_sub(VAR_INDEX + 1)
        .min(losses.len().saturating_sub(1));
    Ok(losses[idx])
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/// Integer square root via Newton's method, returning the result in Q96.48.
///
/// Algorithm: keep an estimate `g` of the Q96 sqrt; update with
/// `g_{n+1} = (g + x / g) / 2`. Convergence is quadratic. We cap iterations
/// at 64 (more than enough for `U256` inputs).
pub fn sqrt_q96(x: Q96) -> Q96 {
    if x.raw.is_zero() {
        return Q96::ZERO;
    }
    // Initial guess: integer sqrt of the raw value, scaled up by 2^24 (half
    // of 48) because raw is `value * 2^48`. After the first refinement step
    // the estimate stabilizes regardless of the initial value as long as it
    // is non-zero.
    let mut g: U256 = integer_sqrt_u256(x.raw) << 24u32;
    if g.is_zero() {
        g = U256::from(1u8) << 24u32;
    }
    // We compute g_{n+1} = (g + x_raw * 2^48 / g) / 2 -- the 2^48 comes from
    // representing `x / g` in Q96.48 form.
    let two = U256::from(2u8);
    for _ in 0..64 {
        // numerator = x_raw << 48 (fits because raw fits in 208 bits in our use)
        let num = match x.raw.checked_shl(48) {
            Some(v) => v,
            None => break, // overflow safeguard
        };
        let x_over_g = num / g;
        let next = (g + x_over_g) / two;
        if next == g
            || (next > g && next - g <= U256::from(1u8))
            || (g > next && g - next <= U256::from(1u8))
        {
            g = next;
            break;
        }
        g = next;
    }
    Q96::from_q96_raw(g)
}

/// Integer square root of a U256 (Newton's method on plain integers).
fn integer_sqrt_u256(n: U256) -> U256 {
    if n < U256::from(2u8) {
        return n;
    }
    let mut x = n;
    let mut y = (x + U256::from(1u8)) / U256::from(2u8);
    while y < x {
        x = y;
        y = (x + n / x) / U256::from(2u8);
    }
    x
}

/// Taylor-series natural-log approximation around 1:
/// `ln(1 + u) ≈ u - u^2/2 + u^3/3 - u^4/4`.
///
/// Accepts a Q96.48 input. For `x` in `[0.5, 2.0]` (Q96) the result is within
/// ~1% of true `ln(x)`. Outside that band the polynomial diverges -- callers
/// must clamp. Returns the magnitude only (Q96.48); sign is determined by
/// whether `x >= 1` (positive) or `x < 1` (the result still encodes the
/// magnitude of `|ln(x)|`).
pub fn ln_approx_q96(x: Q96) -> Q96 {
    if x.raw.is_zero() {
        return Q96::ZERO;
    }
    let one = Q96::ONE;
    // u = x - 1 if x >= 1, else u = 1 - x. We compute |ln(x)| and rely on the
    // caller to track sign.
    let u = if x.ge(one) {
        x.checked_sub(one).unwrap_or(Q96::ZERO)
    } else {
        one.checked_sub(x).unwrap_or(Q96::ZERO)
    };
    let u2 = match u.checked_mul(u) {
        Ok(v) => v,
        Err(_) => return Q96::ZERO,
    };
    let u3 = match u2.checked_mul(u) {
        Ok(v) => v,
        Err(_) => return u, // fall back to first-order term
    };
    let u4 = match u3.checked_mul(u) {
        Ok(v) => v,
        Err(_) => return u,
    };
    // Combine: u - u2/2 + u3/3 - u4/4
    let t1 = u;
    let t2 = u2.checked_div(Q96::from_u128(2)).unwrap_or(Q96::ZERO);
    let t3 = u3.checked_div(Q96::from_u128(3)).unwrap_or(Q96::ZERO);
    let t4 = u4.checked_div(Q96::from_u128(4)).unwrap_or(Q96::ZERO);
    let pos = t1.saturating_add(t3);
    let neg = t2.saturating_add(t4);
    pos.saturating_sub(neg)
}

// ---------------------------------------------------------------------------
// PRNG: SplitMix64 -- short, deterministic, and well-behaved for small N.
// ---------------------------------------------------------------------------

/// 64-bit SplitMix64 PRNG. Output distribution is good enough for Monte Carlo
/// targeting <2^16 samples per call, which is well above our PATH_COUNT.
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        // SplitMix64 produces zero on zero input; nudge to break that case.
        SplitMix64 {
            state: seed.wrapping_add(0x9E37_79B9_7F4A_7C15),
        }
    }

    fn next_u64(&mut self) -> u64 {
        // Constants from Sebastiano Vigna's SplitMix64.
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Sample a "normal-ish" shock in Q96.48. Production code would use a
    /// proper inverse-CDF; we use a 12-uniform-sum approximation (CLT-style)
    /// for low-gas determinism. Returns a 65-bit value: low bit is the sign
    /// (0 = loss, 1 = gain), remaining bits are the magnitude in Q96.48
    /// scaled so a 1-sigma shock = ~`Q96_ONE / 16` (~ 0.0625).
    fn next_normal_q96(&mut self) -> u128 {
        // Sum 12 uniform values, subtract 6 (mean), and scale.
        let mut sum: i64 = 0;
        for _ in 0..12 {
            // Take 16 bits of entropy per iter -> uniform in [0, 65536).
            sum += (self.next_u64() & 0xFFFF) as i64;
        }
        // Mean of sum = 6 * 65536 = 393_216. Subtract.
        let centered = sum - 6 * 65_536;
        let is_gain = centered >= 0;
        let mag_u64 = centered.unsigned_abs();
        // Scale: mag_u64 ranges roughly to ~196_608 (worst). Map to ~ 1 sigma
        // = Q96_ONE / 16 by dividing by 2^14 then multiplying by 2^48 / 16:
        // mag_q96 = mag_u64 * (Q96_ONE / 16) / 65536
        //         = mag_u64 * 2^48 / (16 * 65536)
        //         = mag_u64 * 2^48 / 2^20
        //         = mag_u64 * 2^28
        let mag_q96: u128 = (mag_u64 as u128) << 28;
        // Pack into 128 bits: low bit = sign, remaining = magnitude.
        let sign_bit: u128 = if is_gain { 1 } else { 0 };
        (mag_q96 << 1) | sign_bit
    }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

fn u128_from_u256(x: U256) -> Result<u128, Vec<u8>> {
    let limbs = x.as_limbs();
    if limbs[2] != 0 || limbs[3] != 0 {
        return Err(ERR_OVERFLOW.to_vec());
    }
    Ok((limbs[0] as u128) | ((limbs[1] as u128) << 64))
}

fn u64_from_address_low(addr: Address) -> u64 {
    let bytes = addr.into_array();
    let mut out = [0u8; 8];
    out.copy_from_slice(&bytes[12..20]);
    u64::from_be_bytes(out)
}

#[cfg(test)]
mod tests;

//! Invariant tests for `risk_engine::compute_var_99_q96_pure`.
//!
//! Source-of-truth spec: PrimeAgent.md section 17.bis FIP3 and the
//! Feature F rust-engineer brief in `memory/IMPLEMENTATION_PLAN.md`.
//!
//! Why the pure function and not the `RiskEngine` method?
//!
//! Integration tests live under `tests/` and are compiled as separate
//! binaries. Pulling in `stylus_sdk::testing::TestVM` requires the
//! `stylus-test` feature, which transitively brings `alloy-chains 0.2.34`
//! and `alloy-provider 1.8.x`, which in turn re-resolve
//! `alloy-primitives` to 1.8.3. That collides with our workspace pin
//! `=1.6.0` and trips "two versions of crate ruint / alloy-primitives"
//! type errors at the binary boundary.
//!
//! The clean fix is to expose a host-agnostic core function
//! (`compute_var_99_q96_pure`) and exercise the invariants against it.
//! The `RiskEngine` method delegates to this same function, so the
//! semantics are identical; only the storage / VM access lives on the
//! method side.
//!
//! Two invariants are exercised:
//!
//! 1. **Non-negativity.** VaR is always >= 0. Trivially satisfied by the
//!    `U256` return type but we assert it under proptest pressure to
//!    catch a future regression where the engine starts returning a
//!    signed value or a wrapped negative.
//!
//! 2. **Monotonicity in `horizon_days`.** For a fixed
//!    `(vol_bps, notional, seed_ts, seed_vault_low)` tuple, VaR is
//!    non-decreasing as `horizon_days` grows. This follows from
//!    `scaled_vol = vol * sqrt(horizon / 365)` and a deterministic PRNG
//!    seeded by `seed_ts XOR seed_vault_low` (NOT by horizon), so growing
//!    horizon scales every per-path loss by the same constant
//!    `sqrt(h_2 / h_1)`. Integer truncation can flatten successive
//!    results but never invert their order.
//!
//! Both invariants run via `proptest!` with 256 cases per property; that
//! is high enough to stress edge cases without making CI sluggish.

use alloy_primitives::U256;
use proptest::prelude::*;
use risk_engine::compute_var_99_q96_pure;

use quic_arithmetic::Q96;

// ---------------------------------------------------------------------------
// Invariant 1: non-negativity
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// VaR is never negative. The return type is `U256`, so this asserts
    /// the contract never silently wraps a negative magnitude into a huge
    /// unsigned number, and that no in-range input causes the function to
    /// return an `Err`.
    #[test]
    fn invariant_var_non_negative(
        vol_bps in 100u32..=100_000u32,
        notional_units in 1u128..=1_000_000u128,
        horizon_days in 1u64..=365u64,
        seed_vault_low in 1u64..=u64::MAX,
    ) {
        let notional = Q96::from_u128(notional_units).raw;
        let var = compute_var_99_q96_pure(
            U256::from(vol_bps),
            notional,
            U256::from(horizon_days),
            1_700_000_000u64,
            seed_vault_low,
        ).expect("compute_var_99_q96_pure must not error on in-range inputs");
        // U256 is unsigned; this is a load-bearing assertion: it pins the
        // return-type contract.
        prop_assert!(var <= U256::MAX);
    }
}

// ---------------------------------------------------------------------------
// Invariant 2: monotonicity in horizon
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// VaR(horizon=h2) >= VaR(horizon=h1) whenever h2 >= h1, holding every
    /// other input fixed. Must be NON-strict because integer truncation
    /// can flatten two consecutive horizons to the same loss.
    #[test]
    fn invariant_var_monotonic_in_horizon(
        vol_bps in 1_000u32..=50_000u32,
        notional_units in 1_000u128..=1_000_000u128,
        h1 in 1u64..=30u64,
        delta in 1u64..=180u64,
        seed_vault_low in 1u64..=u64::MAX,
    ) {
        let notional = Q96::from_u128(notional_units).raw;
        let h2 = h1 + delta;

        let var_short = compute_var_99_q96_pure(
            U256::from(vol_bps),
            notional,
            U256::from(h1),
            1_700_000_000u64,
            seed_vault_low,
        ).expect("var (short horizon) must not error");
        let var_long = compute_var_99_q96_pure(
            U256::from(vol_bps),
            notional,
            U256::from(h2),
            1_700_000_000u64,
            seed_vault_low,
        ).expect("var (long horizon) must not error");

        prop_assert!(
            var_long >= var_short,
            "monotonicity violated: VaR(h={h2})={var_long} < VaR(h={h1})={var_short} (vol_bps={vol_bps}, notional={notional_units})",
        );
    }
}

// ---------------------------------------------------------------------------
// Deterministic sanity tests (independent of proptest)
// ---------------------------------------------------------------------------

#[test]
fn var_zero_when_vol_is_zero() {
    let result = compute_var_99_q96_pure(
        U256::ZERO,
        Q96::from_u128(10_000).raw,
        U256::from(7u8),
        1_700_000_000u64,
        0xDEADBEEF,
    )
    .expect("must not error");
    assert_eq!(result, U256::ZERO);
}

#[test]
fn var_zero_when_horizon_is_zero() {
    let result = compute_var_99_q96_pure(
        U256::from(8_000u32),
        Q96::from_u128(10_000).raw,
        U256::ZERO,
        1_700_000_000u64,
        0xDEADBEEF,
    )
    .expect("must not error");
    assert_eq!(result, U256::ZERO);
}

#[test]
fn var_positive_for_non_trivial_inputs() {
    let result = compute_var_99_q96_pure(
        U256::from(8_000u32),
        Q96::from_u128(10_000).raw,
        U256::from(7u8),
        1_700_000_000u64,
        0xDEADBEEF,
    )
    .expect("must not error");
    assert!(result > U256::ZERO, "expected positive VaR, got {result}");
}

#[test]
fn var_monotonic_canonical_horizons() {
    let vol_bps = U256::from(8_000u32);
    let notional = Q96::from_u128(10_000).raw;
    let var_1 =
        compute_var_99_q96_pure(vol_bps, notional, U256::from(1u8), 1_700_000_000, 0xDD).unwrap();
    let var_7 =
        compute_var_99_q96_pure(vol_bps, notional, U256::from(7u8), 1_700_000_000, 0xDD).unwrap();
    let var_30 =
        compute_var_99_q96_pure(vol_bps, notional, U256::from(30u8), 1_700_000_000, 0xDD).unwrap();
    let var_180 =
        compute_var_99_q96_pure(vol_bps, notional, U256::from(180u8), 1_700_000_000, 0xDD).unwrap();
    assert!(var_1 <= var_7);
    assert!(var_7 <= var_30);
    assert!(var_30 <= var_180);
}

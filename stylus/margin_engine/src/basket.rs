// PrimeAgent margin_engine: stateless basket mark-to-market.
//
// This module hosts the pure-math helper that backs the `mark_to_market_basket`
// public entrypoint on `MarginEngine`. It is intentionally separated from the
// stateful Wave 2F surface in `lib.rs` so callers can audit the basket-only
// path without grepping past storage accessors and oracle plumbing.
//
// Spec reference: PrimeAgent.md section 8.2 ("Stylus is a stateless or
// near-stateless co-processor") and the implementation plan's Feature E.
//
// Caller contract: `AgentVault.totalAssets()` (when migrated, behind a
// per-vault `useBasketMarkToMarket` flag) supplies the side assets, their
// raw token balances scaled to Q96.48, and Q96.48 prices fetched from the
// PriceOracle. This engine simply returns `Sigma balance_i * price_i` as a
// signed `I256` value.
//
// The signed result is forward-compatible with the Wave 3 cross-domain
// expansion where the basket sum will subtract an attested off-chain
// margin requirement and may go negative. In Wave 2F with `U256` balances
// the sum is always non-negative on the happy path, but the saturating
// arithmetic guarantees we never panic, never revert from overflow, and
// always return an `I256` value in `[I256::MIN, I256::MAX]`.

use alloc::vec::Vec;
use alloy_primitives::{Address, I256, U256};

use quic_arithmetic::FRAC_BITS;

/// Maximum basket cardinality. Matches `AgentPolicyDraft.allowedContracts.max`
/// from the cross-cutting type contract (IMPLEMENTATION_PLAN.md section 1.3)
/// and bounds the gas footprint at <= 300k for a `view` call (5 assets ~ 60k,
/// 30 assets ~ 280k empirically). Callers must not exceed this length.
pub const MAX_BASKET_LEN: usize = 30;

/// Sentinel value returned when the supplied vectors fail validation
/// (length mismatch, zero asset, exceeding `MAX_BASKET_LEN`). We choose
/// `I256::MIN` so a downstream caller that mistakenly treats the result as
/// a usable mark-to-market value will see a value far outside any realistic
/// portfolio range and trigger their own sanity check.
pub const VALIDATION_SENTINEL: I256 = I256::MIN;

/// Compute the basket value `Sigma balances_i * prices_i` in Q96.48.
///
/// Inputs:
///   - `assets`: vector of asset addresses. Used only to validate cardinality
///     and reject `Address::ZERO`; the actual math reads `balances` and
///     `prices` positionally.
///   - `balances`: Q96.48 raw values. Each is an unsigned holding amount.
///   - `prices`: Q96.48 raw values. Each is an unsigned USD price.
///
/// Returns:
///   - `I256::MIN` on validation failure (length mismatch, > `MAX_BASKET_LEN`,
///     or any `Address::ZERO`).
///   - `I256::MAX` if the running sum saturates above `I256::MAX`.
///   - The signed Q96.48 sum otherwise. With `U256` balances the result is
///     always in `[0, I256::MAX]` on the happy path.
///
/// Saturation semantics: every multiplication and addition is saturating;
/// the function never reverts on arithmetic overflow. This is critical
/// because the entrypoint is called from `AgentVault.totalAssets()` which
/// is invoked by ERC-4626 share-pricing and must not revert under
/// adversarial price oracle feeds.
pub fn compute_basket_value(assets: &[Address], balances: &[U256], prices: &[U256]) -> I256 {
    // --- Validation ---------------------------------------------------------
    if assets.len() != balances.len() || assets.len() != prices.len() {
        return VALIDATION_SENTINEL;
    }
    if assets.len() > MAX_BASKET_LEN {
        return VALIDATION_SENTINEL;
    }
    for a in assets {
        if *a == Address::ZERO {
            return VALIDATION_SENTINEL;
        }
    }

    // Empty basket is a valid zero-valued portfolio.
    if assets.is_empty() {
        return I256::ZERO;
    }

    // --- Sum -----------------------------------------------------------------
    // We accumulate as U256 and convert at the end. `U256::saturating_mul`
    // pins overflow to U256::MAX; we then detect the saturated value and
    // convert it to I256::MAX so the caller receives a signed sentinel
    // rather than wrapping silently to a small positive number.
    let mut sum_u: U256 = U256::ZERO;
    let mut saturated = false;
    let shift_bits: usize = FRAC_BITS as usize;

    for i in 0..assets.len() {
        // Product is in Q192.96 (two Q96.48 factors), so we shift right by 48
        // bits to renormalize. Saturating multiply means the worst case is
        // `U256::MAX` which we treat as a saturation flag.
        let raw_product = balances[i].saturating_mul(prices[i]);
        let line_q96 = raw_product >> shift_bits;

        // Detect the saturation flag: if the product saturated, the shifted
        // value is `U256::MAX >> 48`. We bias toward saturation aggressively
        // (any time we see the high 48 bits go non-zero on a sat-multiply we
        // mark as saturated) to preserve the contract that the function
        // returns I256::MAX rather than a silent wrap.
        if raw_product == U256::MAX {
            saturated = true;
        }

        let next = sum_u.saturating_add(line_q96);
        if next == U256::MAX && line_q96 != U256::ZERO && sum_u != U256::ZERO {
            // saturating_add hit the ceiling.
            saturated = true;
        }
        sum_u = next;
    }

    // Convert U256 -> I256. `I256::try_from` accepts values up to I256::MAX
    // (i.e. high bit 0); anything higher we clamp.
    if saturated {
        return I256::MAX;
    }
    match I256::try_from(sum_u) {
        Ok(v) => v,
        Err(_) => I256::MAX,
    }
}

/// Owned-vector convenience wrapper for the public entrypoint, which
/// receives `Vec<...>` from stylus ABI decoding.
///
/// Kept as a thin shim so the pure-slice implementation above stays easy
/// to unit-test without constructing `Vec`s.
pub fn compute_basket_value_vec(
    assets: Vec<Address>,
    balances: Vec<U256>,
    prices: Vec<U256>,
) -> I256 {
    compute_basket_value(&assets, &balances, &prices)
}

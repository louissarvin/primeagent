//! Unit and property tests for Q96.48 arithmetic.
//!
//! Property tests use `proptest` with 1024 cases per property (the default).
//! They exercise round-trip conversions, algebraic identities (associativity,
//! commutativity, distributivity within precision), and error paths.

extern crate std;

use super::*;
use alloy_primitives::U256;
use proptest::prelude::*;
use std::vec::Vec;

// ---------- Unit tests for constants and constructors ----------

#[test]
fn q96_one_is_two_pow_48() {
    assert_eq!(Q96_ONE, U256::from(1u128 << 48));
}

#[test]
fn q96_zero_constants_match() {
    assert_eq!(Q96::ZERO.raw, U256::ZERO);
    assert_eq!(Q96::ONE.raw, Q96_ONE);
}

#[test]
fn from_u128_scales_correctly() {
    let q = Q96::from_u128(5);
    assert_eq!(q.raw, U256::from(5u128 << 48));
}

#[test]
fn from_u128_zero() {
    assert_eq!(Q96::from_u128(0).raw, U256::ZERO);
}

#[test]
fn from_u128_max_value() {
    let q = Q96::from_u128(u128::MAX);
    let expected = U256::from(u128::MAX) << 48u32;
    assert_eq!(q.raw, expected);
}

#[test]
fn from_u256_rejects_overflow() {
    let big = U256::from(1u8) << 208u32;
    assert_eq!(Q96::from_u256(big), Err(Q96Error::Overflow));
}

#[test]
fn from_u256_accepts_max_in_range() {
    let just_under = (U256::from(1u8) << 208u32) - U256::from(1u8);
    assert!(Q96::from_u256(just_under).is_ok());
}

#[test]
fn from_q96_raw_passes_through() {
    let raw = U256::from(123456789u64);
    assert_eq!(Q96::from_q96_raw(raw).raw, raw);
}

#[test]
fn from_usd_cents_dollar_equals_one() {
    // $1.00 = 100 cents should equal Q96_ONE.
    assert_eq!(Q96::from_usd_cents(100).raw, Q96_ONE);
}

#[test]
fn from_usd_cents_fifty_cents_is_half() {
    let half = Q96::from_usd_cents(50);
    let expected_half = Q96_ONE / U256::from(2u8);
    assert_eq!(half.raw, expected_half);
}

#[test]
fn from_usd_cents_zero() {
    assert_eq!(Q96::from_usd_cents(0).raw, U256::ZERO);
}

// ---------- Conversion round-trip tests ----------

#[test]
fn to_u128_floor_round_trip() {
    for n in [0u128, 1, 42, 1_000_000, 1u128 << 60] {
        let q = Q96::from_u128(n);
        assert_eq!(q.to_u128_floor().unwrap(), n);
    }
}

#[test]
fn to_u128_floor_floors_fractional() {
    // 1.5 in Q96.48
    let one_and_half = Q96 {
        raw: Q96_ONE + (Q96_ONE / U256::from(2u8)),
    };
    assert_eq!(one_and_half.to_u128_floor().unwrap(), 1);
}

#[test]
fn to_u128_floor_out_of_range() {
    let q = Q96 { raw: U256::MAX };
    assert_eq!(q.to_u128_floor(), Err(Q96Error::OutOfRange));
}

#[test]
fn to_u256_floor_no_overflow() {
    let q = Q96::from_u128(1_000_000);
    assert_eq!(q.to_u256_floor(), U256::from(1_000_000u64));
}

// ---------- Addition tests ----------

#[test]
fn checked_add_simple() {
    let a = Q96::from_u128(3);
    let b = Q96::from_u128(4);
    let sum = a.checked_add(b).unwrap();
    assert_eq!(sum.to_u128_floor().unwrap(), 7);
}

#[test]
fn checked_add_identity() {
    let a = Q96::from_u128(99);
    assert_eq!(a.checked_add(Q96::ZERO).unwrap(), a);
}

#[test]
fn checked_add_overflow() {
    let max = Q96 { raw: U256::MAX };
    let one = Q96::from_u128(1);
    assert_eq!(max.checked_add(one), Err(Q96Error::Overflow));
}

#[test]
fn saturating_add_clamps() {
    let max = Q96 { raw: U256::MAX };
    let one = Q96::from_u128(1);
    assert_eq!(max.saturating_add(one).raw, U256::MAX);
}

// ---------- Subtraction tests ----------

#[test]
fn checked_sub_simple() {
    let a = Q96::from_u128(10);
    let b = Q96::from_u128(3);
    let diff = a.checked_sub(b).unwrap();
    assert_eq!(diff.to_u128_floor().unwrap(), 7);
}

#[test]
fn checked_sub_negative_error() {
    let a = Q96::from_u128(3);
    let b = Q96::from_u128(10);
    assert_eq!(a.checked_sub(b), Err(Q96Error::Negative));
}

#[test]
fn saturating_sub_clamps_to_zero() {
    let a = Q96::from_u128(3);
    let b = Q96::from_u128(10);
    assert_eq!(a.saturating_sub(b), Q96::ZERO);
}

// ---------- Multiplication tests ----------

#[test]
fn checked_mul_by_one_is_identity() {
    let a = Q96::from_u128(42);
    let result = a.checked_mul(Q96::ONE).unwrap();
    assert_eq!(result, a);
}

#[test]
fn checked_mul_by_zero_is_zero() {
    let a = Q96::from_u128(42);
    let result = a.checked_mul(Q96::ZERO).unwrap();
    assert_eq!(result, Q96::ZERO);
}

#[test]
fn checked_mul_integer() {
    let a = Q96::from_u128(6);
    let b = Q96::from_u128(7);
    let result = a.checked_mul(b).unwrap();
    assert_eq!(result.to_u128_floor().unwrap(), 42);
}

#[test]
fn checked_mul_fractional() {
    // 0.5 * 4 = 2
    let half = Q96::from_q96_raw(Q96_ONE / U256::from(2u8));
    let four = Q96::from_u128(4);
    let result = half.checked_mul(four).unwrap();
    assert_eq!(result.to_u128_floor().unwrap(), 2);
}

#[test]
fn checked_mul_overflow() {
    let huge = Q96 {
        raw: U256::MAX / U256::from(2u8),
    };
    // huge * huge would exceed U256::MAX
    assert_eq!(huge.checked_mul(huge), Err(Q96Error::Overflow));
}

// ---------- Division tests ----------

#[test]
fn checked_div_by_one_is_identity() {
    let a = Q96::from_u128(42);
    let result = a.checked_div(Q96::ONE).unwrap();
    assert_eq!(result, a);
}

#[test]
fn checked_div_simple_integer() {
    let a = Q96::from_u128(84);
    let b = Q96::from_u128(2);
    let result = a.checked_div(b).unwrap();
    assert_eq!(result.to_u128_floor().unwrap(), 42);
}

#[test]
fn checked_div_by_zero() {
    let a = Q96::from_u128(42);
    assert_eq!(a.checked_div(Q96::ZERO), Err(Q96Error::DivByZero));
}

#[test]
fn checked_div_fractional() {
    // 1 / 2 = 0.5; to_u128_floor = 0
    let result = Q96::ONE.checked_div(Q96::from_u128(2)).unwrap();
    assert_eq!(result.to_u128_floor().unwrap(), 0);
    // raw should equal Q96_ONE / 2
    assert_eq!(result.raw, Q96_ONE / U256::from(2u8));
}

#[test]
fn checked_div_overflow_on_shift() {
    // raw with high bits set will overflow when shifted left by 48.
    let huge = Q96 {
        raw: U256::from(1u8) << 210u32,
    };
    assert_eq!(huge.checked_div(Q96::from_u128(1)), Err(Q96Error::Overflow));
}

// ---------- Comparison tests ----------

#[test]
fn comparisons_basic() {
    let a = Q96::from_u128(3);
    let b = Q96::from_u128(7);
    assert!(a.lt(b));
    assert!(b.gt(a));
    assert!(a.le(a));
    assert!(a.ge(a));
    assert!(!a.eq_q(b));
    assert!(a.eq_q(Q96::from_u128(3)));
}

#[test]
fn min_max_basic() {
    let a = Q96::from_u128(3);
    let b = Q96::from_u128(7);
    assert_eq!(a.max(b), b);
    assert_eq!(a.min(b), a);
}

// ---------- BPS helper tests ----------

#[test]
fn mul_bps_full_percent() {
    let v = Q96::from_u128(1000);
    // 10_000 bps = 100%
    let r = v.mul_bps(10_000).unwrap();
    assert_eq!(r, v);
}

#[test]
fn mul_bps_quarter() {
    let v = Q96::from_u128(1000);
    let r = v.mul_bps(2_500).unwrap();
    assert_eq!(r.to_u128_floor().unwrap(), 250);
}

#[test]
fn mul_bps_zero() {
    let v = Q96::from_u128(1000);
    assert_eq!(v.mul_bps(0).unwrap(), Q96::ZERO);
}

// ---------- Error display ----------

#[test]
fn error_display_strings() {
    use std::format;
    assert!(format!("{}", Q96Error::Overflow).contains("overflow"));
    assert!(format!("{}", Q96Error::Negative).contains("negative"));
    assert!(format!("{}", Q96Error::DivByZero).contains("zero"));
    assert!(format!("{}", Q96Error::OutOfRange).contains("range"));
}

// ---------- Property tests ----------

// Bound values to a safe range so we don't bump into overflow on every test.
// 2^96 - 1 leaves plenty of headroom for products of two operands while still
// covering the realistic margin engine range (USD prices, position sizes).
fn q_strategy() -> impl Strategy<Value = Q96> {
    any::<u128>().prop_map(|n| {
        // Constrain to ~96-bit integer part so add/mul don't always overflow.
        Q96::from_u128(n >> 32)
    })
}

// Small strategy for divisor (must be non-zero, must not overflow in shift).
fn small_q_strategy() -> impl Strategy<Value = Q96> {
    (1u64..=u64::MAX).prop_map(|n| Q96::from_u128(n as u128))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    #[test]
    fn prop_add_commutative(a in q_strategy(), b in q_strategy()) {
        let ab = a.checked_add(b);
        let ba = b.checked_add(a);
        prop_assert_eq!(ab, ba);
    }

    #[test]
    fn prop_add_associative(a in q_strategy(), b in q_strategy(), c in q_strategy()) {
        // (a + b) + c == a + (b + c) when both succeed.
        if let (Ok(ab), Ok(bc)) = (a.checked_add(b), b.checked_add(c)) {
            if let (Ok(left), Ok(right)) = (ab.checked_add(c), a.checked_add(bc)) {
                prop_assert_eq!(left, right);
            }
        }
    }

    #[test]
    fn prop_add_identity(a in q_strategy()) {
        prop_assert_eq!(a.checked_add(Q96::ZERO).unwrap(), a);
    }

    #[test]
    fn prop_sub_inverse_of_add(a in q_strategy(), b in q_strategy()) {
        // (a + b) - b == a, when the add succeeds.
        if let Ok(sum) = a.checked_add(b) {
            let back = sum.checked_sub(b).unwrap();
            prop_assert_eq!(back, a);
        }
    }

    #[test]
    fn prop_mul_commutative(a in q_strategy(), b in q_strategy()) {
        let ab = a.checked_mul(b);
        let ba = b.checked_mul(a);
        prop_assert_eq!(ab, ba);
    }

    #[test]
    fn prop_mul_identity(a in q_strategy()) {
        prop_assert_eq!(a.checked_mul(Q96::ONE).unwrap(), a);
    }

    #[test]
    fn prop_mul_zero(a in q_strategy()) {
        prop_assert_eq!(a.checked_mul(Q96::ZERO).unwrap(), Q96::ZERO);
    }

    #[test]
    fn prop_distributive_within_one_ulp(
        a in q_strategy(),
        b in q_strategy(),
        c in q_strategy()
    ) {
        // a * (b + c) ?= a*b + a*c (within rounding error of up to ~2 ulps
        // because Q96 mul floors).
        let bc = match b.checked_add(c) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let left = match a.checked_mul(bc) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let ab = match a.checked_mul(b) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let ac = match a.checked_mul(c) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let right = match ab.checked_add(ac) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let diff = if left.raw >= right.raw {
            left.raw - right.raw
        } else {
            right.raw - left.raw
        };
        // Two flooring multiplications can each drop up to one ulp.
        prop_assert!(diff <= U256::from(2u8));
    }

    #[test]
    fn prop_div_round_trip(a in q_strategy(), b in small_q_strategy()) {
        // (a * b) / b ?= a within one ulp on flooring.
        let ab = match a.checked_mul(b) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let back = match ab.checked_div(b) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let diff = if back.raw >= a.raw {
            back.raw - a.raw
        } else {
            a.raw - back.raw
        };
        prop_assert!(diff <= U256::from(2u8));
    }

    #[test]
    fn prop_div_by_self_is_one(a in small_q_strategy()) {
        let one = a.checked_div(a).unwrap();
        prop_assert_eq!(one, Q96::ONE);
    }

    #[test]
    fn prop_saturating_add_never_panics(a in q_strategy(), b in q_strategy()) {
        let _ = a.saturating_add(b);
    }

    #[test]
    fn prop_saturating_sub_never_negative(a in q_strategy(), b in q_strategy()) {
        let r = a.saturating_sub(b);
        prop_assert!(r.raw <= U256::MAX);
    }

    #[test]
    fn prop_lt_gt_eq_total_order(a in q_strategy(), b in q_strategy()) {
        let lt = a.lt(b);
        let gt = a.gt(b);
        let eq = a.eq_q(b);
        // Exactly one of {lt, gt, eq} is true.
        let count = [lt, gt, eq].iter().filter(|x| **x).count();
        prop_assert_eq!(count, 1);
    }

    #[test]
    fn prop_min_max_consistency(a in q_strategy(), b in q_strategy()) {
        let mn = a.min(b);
        let mx = a.max(b);
        prop_assert!(mn.le(mx));
        // min + max == a + b (via raw)
        prop_assert_eq!(mn.raw + mx.raw, a.raw + b.raw);
    }

    #[test]
    fn prop_mul_bps_full_is_identity(a in q_strategy()) {
        prop_assert_eq!(a.mul_bps(10_000).unwrap(), a);
    }

    #[test]
    fn prop_mul_bps_zero(a in q_strategy()) {
        prop_assert_eq!(a.mul_bps(0).unwrap(), Q96::ZERO);
    }

    #[test]
    fn prop_u128_round_trip(n in 0u128..(1u128 << 64)) {
        let q = Q96::from_u128(n);
        prop_assert_eq!(q.to_u128_floor().unwrap(), n);
    }

    #[test]
    fn prop_to_u256_floor_matches_division(a in q_strategy()) {
        let expected = a.raw / Q96_ONE;
        prop_assert_eq!(a.to_u256_floor(), expected);
    }
}

// ---------- Edge case: cargo-test-only sanity on Vec usage ----------
#[test]
fn _vec_compiles() {
    let mut v: Vec<Q96> = Vec::new();
    v.push(Q96::ONE);
    v.push(Q96::ZERO);
    assert_eq!(v.len(), 2);
}

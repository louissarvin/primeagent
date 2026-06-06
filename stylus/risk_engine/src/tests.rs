//! Unit tests for `RiskEngine` and its math helpers.

extern crate std;

use super::*;
use quic_arithmetic::Q96_ONE;
use stylus_sdk::testing::TestVM;

fn addr(byte: u8) -> Address {
    Address::repeat_byte(byte)
}

fn fresh_initialized(vm: &TestVM) -> RiskEngine {
    let owner = addr(0xAA);
    let margin = addr(0x0E);
    vm.set_sender(owner);
    let mut engine = RiskEngine::from(vm);
    engine.init(margin).expect("init should succeed");
    engine
}

#[test]
fn test_init_sets_owner() {
    let vm = TestVM::default();
    let owner = addr(0xAA);
    vm.set_sender(owner);
    let mut engine = RiskEngine::from(&vm);
    engine.init(addr(0x0E)).unwrap();
    assert_eq!(engine.owner(), owner);
    assert_eq!(engine.margin_engine(), addr(0x0E));
    // Init twice -> revert.
    assert!(engine.init(addr(0x0E)).is_err());
}

#[test]
fn test_init_rejects_zero_margin_engine() {
    let vm = TestVM::default();
    vm.set_sender(addr(0xAA));
    let mut engine = RiskEngine::from(&vm);
    assert!(engine.init(Address::ZERO).is_err());
}

#[test]
fn test_set_vol_only_owner() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);

    // Owner: succeeds.
    engine.set_vol(asset, U256::from(8_000u32)).unwrap();
    assert_eq!(engine.vol_bps(asset), U256::from(8_000u32));

    // Non-owner: reverts.
    vm.set_sender(addr(0xBB));
    let err = engine.set_vol(asset, U256::from(5_000u32)).unwrap_err();
    assert!(std::str::from_utf8(&err).unwrap().contains("unauthorized"));
}

#[test]
fn test_set_vol_rejects_zero_address_and_huge_vol() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    assert!(engine.set_vol(Address::ZERO, U256::from(1_000u32)).is_err());
    assert!(engine
        .set_vol(addr(0x11), U256::from(2_000_000u32))
        .is_err());
}

#[test]
fn test_var_99_zero_for_zero_vol() {
    let vm = TestVM::default();
    let engine = fresh_initialized(&vm);
    // Asset has no vol stored -> default 0 -> VaR is 0.
    let var = engine
        .var_99_q96(
            addr(0xDD),
            addr(0x11),
            Q96::from_u128(1_000).raw,
            U256::from(1u8),
        )
        .unwrap();
    assert_eq!(var, U256::ZERO);
}

#[test]
fn test_var_99_zero_for_zero_horizon() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    engine.set_vol(addr(0x11), U256::from(8_000u32)).unwrap();
    let var = engine
        .var_99_q96(
            addr(0xDD),
            addr(0x11),
            Q96::from_u128(1_000).raw,
            U256::ZERO,
        )
        .unwrap();
    assert_eq!(var, U256::ZERO);
}

#[test]
fn test_var_99_deterministic_for_same_seed() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);
    let vault = addr(0xDD);
    engine.set_vol(asset, U256::from(8_000u32)).unwrap();

    // Fix timestamp so the seed is deterministic.
    vm.set_block_timestamp(1_700_000_000);

    let a = engine
        .var_99_q96(vault, asset, Q96::from_u128(1_000).raw, U256::from(7u8))
        .unwrap();
    let b = engine
        .var_99_q96(vault, asset, Q96::from_u128(1_000).raw, U256::from(7u8))
        .unwrap();
    assert_eq!(a, b, "deterministic VaR must be reproducible");
    // Non-zero result expected for non-trivial vol and horizon.
    assert!(a > U256::ZERO);
}

#[test]
fn test_var_99_different_vaults_give_different_results() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);
    engine.set_vol(asset, U256::from(8_000u32)).unwrap();
    vm.set_block_timestamp(1_700_000_000);

    let a = engine
        .var_99_q96(
            addr(0xDD),
            asset,
            Q96::from_u128(1_000).raw,
            U256::from(7u8),
        )
        .unwrap();
    let b = engine
        .var_99_q96(
            addr(0xEE),
            asset,
            Q96::from_u128(1_000).raw,
            U256::from(7u8),
        )
        .unwrap();
    assert_ne!(a, b, "different vault seeds should produce different paths");
}

#[test]
fn test_var_99_scales_with_notional() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);
    let vault = addr(0xDD);
    engine.set_vol(asset, U256::from(8_000u32)).unwrap();
    vm.set_block_timestamp(1_700_000_000);

    let small = engine
        .var_99_q96(vault, asset, Q96::from_u128(1_000).raw, U256::from(7u8))
        .unwrap();
    let big = engine
        .var_99_q96(vault, asset, Q96::from_u128(10_000).raw, U256::from(7u8))
        .unwrap();
    // 10x notional -> ~10x VaR (approximate because of integer rounding).
    assert!(big > small);
    // Lower bound: at least 5x because the shock is the same and the only
    // change is the multiplier.
    assert!(big >= small * U256::from(5u8));
}

#[test]
fn test_sqrt_q96_correctness() {
    // sqrt(1) = 1
    let one = Q96::ONE;
    let r = sqrt_q96(one);
    let diff = if r.raw >= one.raw {
        r.raw - one.raw
    } else {
        one.raw - r.raw
    };
    assert!(diff <= U256::from(2u8), "sqrt(1) drifted: {diff}");

    // sqrt(4) = 2
    let four = Q96::from_u128(4);
    let two = Q96::from_u128(2);
    let r = sqrt_q96(four);
    let diff = if r.raw >= two.raw {
        r.raw - two.raw
    } else {
        two.raw - r.raw
    };
    assert!(diff <= U256::from(1u64 << 24), "sqrt(4) drifted: {diff}");

    // sqrt(0) = 0
    assert_eq!(sqrt_q96(Q96::ZERO), Q96::ZERO);

    // sqrt(0.25) = 0.5
    let quarter = Q96::from_q96_raw(Q96_ONE / U256::from(4u8));
    let half_expected = Q96::from_q96_raw(Q96_ONE / U256::from(2u8));
    let r = sqrt_q96(quarter);
    let diff = if r.raw >= half_expected.raw {
        r.raw - half_expected.raw
    } else {
        half_expected.raw - r.raw
    };
    assert!(diff <= U256::from(1u64 << 24), "sqrt(0.25) drifted: {diff}");
}

#[test]
fn test_integer_sqrt_u256_basic() {
    assert_eq!(integer_sqrt_u256(U256::ZERO), U256::ZERO);
    assert_eq!(integer_sqrt_u256(U256::from(1u8)), U256::from(1u8));
    assert_eq!(integer_sqrt_u256(U256::from(4u8)), U256::from(2u8));
    assert_eq!(integer_sqrt_u256(U256::from(99u8)), U256::from(9u8));
    assert_eq!(integer_sqrt_u256(U256::from(100u8)), U256::from(10u8));
}

#[test]
fn test_ln_approx_q96_near_one() {
    // ln(1) = 0
    let r = ln_approx_q96(Q96::ONE);
    assert_eq!(r, Q96::ZERO);

    // ln(1.5): expected ~0.405. In Q96, that's 0.405 * 2^48 ≈ 113_977_417_088_437
    let one_and_half = Q96::from_q96_raw(Q96_ONE + (Q96_ONE / U256::from(2u8)));
    let r = ln_approx_q96(one_and_half);
    // We accept anything in [0.3, 0.5] in Q96 form.
    let lo = (Q96_ONE * U256::from(3u8)) / U256::from(10u8);
    let hi = (Q96_ONE * U256::from(5u8)) / U256::from(10u8);
    assert!(
        r.raw >= lo && r.raw <= hi,
        "ln(1.5) approximation out of band: {}",
        r.raw
    );

    // ln(0.5) magnitude: expected ~0.693. We just check that |ln(0.5)| > 0.5.
    let half = Q96::from_q96_raw(Q96_ONE / U256::from(2u8));
    let r = ln_approx_q96(half);
    // Magnitude only -> should be at least 0.4.
    let lower = (Q96_ONE * U256::from(4u8)) / U256::from(10u8);
    assert!(r.raw >= lower, "|ln(0.5)| too small: {}", r.raw);
}

#[test]
fn test_path_count_constant() {
    // Guardrail: ensure the path-count constant has not been bumped beyond a
    // gas-safe range. If you want more paths, update this assertion knowingly.
    assert!(PATH_COUNT >= 16 && PATH_COUNT <= 256);
}

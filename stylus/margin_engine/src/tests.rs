//! Unit tests for `MarginEngine`. All tests run natively against the
//! `stylus_sdk::testing::TestVM` mock host.

extern crate std;

use super::*;
use stylus_sdk::testing::TestVM;

fn addr(byte: u8) -> Address {
    Address::repeat_byte(byte)
}

/// Build a fresh, initialized MarginEngine where `owner = msg_sender`,
/// `price_oracle` and `attestor` are deterministic non-zero placeholders.
fn fresh_initialized(vm: &TestVM) -> MarginEngine {
    let owner = addr(0xAA);
    let oracle = addr(0x0E);
    let attestor = addr(0x0A);
    vm.set_sender(owner);
    let mut engine = MarginEngine::from(vm);
    engine.init(oracle, attestor).expect("init should succeed");
    engine
}

/// Encode a single `uint256` ABI-style return for `mock_static_call`.
fn encode_uint256(value: U256) -> Vec<u8> {
    let mut buf = vec![0u8; 32];
    let be = value.to_be_bytes::<32>();
    buf.copy_from_slice(&be);
    buf
}

/// Encode the calldata that `read_price_q96` produces: selector || padded(address).
fn calldata_for_price(asset: Address) -> Vec<u8> {
    let mut calldata = Vec::with_capacity(36);
    calldata.extend_from_slice(&PRICE_ORACLE_GET_PRICE_SELECTOR);
    let mut addr_word = [0u8; 32];
    addr_word[12..].copy_from_slice(asset.as_slice());
    calldata.extend_from_slice(&addr_word);
    calldata
}

#[test]
fn test_init_sets_owner() {
    let vm = TestVM::default();
    let owner = addr(0xAA);
    let oracle = addr(0x0E);
    let attestor = addr(0x0A);
    vm.set_sender(owner);
    let mut engine = MarginEngine::from(&vm);

    assert_eq!(engine.owner(), Address::ZERO);
    engine.init(oracle, attestor).unwrap();
    assert_eq!(engine.owner(), owner);
    assert_eq!(engine.price_oracle(), oracle);
    assert_eq!(engine.attestor(), attestor);

    // Calling init a second time must revert.
    assert!(engine.init(oracle, attestor).is_err());
}

#[test]
fn test_init_rejects_zero_addresses() {
    let vm = TestVM::default();
    vm.set_sender(addr(0xAA));
    let mut engine = MarginEngine::from(&vm);
    assert!(engine.init(Address::ZERO, addr(0x0A)).is_err());
    assert!(engine.init(addr(0x0E), Address::ZERO).is_err());
}

#[test]
fn test_set_margin_params_only_owner() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);

    // Sender == owner: succeeds.
    engine
        .set_margin_params(asset, U256::from(2_500u32), U256::from(1_500u32))
        .unwrap();
    assert_eq!(engine.margin_requirement_bps(asset), U256::from(2_500u32));
    assert_eq!(
        engine.liquidation_threshold_bps(asset),
        U256::from(1_500u32)
    );

    // Switch sender to a non-owner: must revert.
    vm.set_sender(addr(0xBB));
    let result = engine.set_margin_params(asset, U256::from(3_000u32), U256::from(2_000u32));
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        std::str::from_utf8(&err).unwrap().contains("unauthorized"),
        "expected unauthorized error"
    );
}

#[test]
fn test_set_margin_params_validates_bps() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);

    // liq_bps >= initial_bps is invalid.
    assert!(engine
        .set_margin_params(asset, U256::from(2_000u32), U256::from(2_000u32))
        .is_err());
    // liq_bps > initial_bps is invalid.
    assert!(engine
        .set_margin_params(asset, U256::from(2_000u32), U256::from(3_000u32))
        .is_err());
    // > 100% (10_000 bps) is invalid.
    assert!(engine
        .set_margin_params(asset, U256::from(20_000u32), U256::from(1_000u32))
        .is_err());
    // Zero address is invalid.
    assert!(engine
        .set_margin_params(Address::ZERO, U256::from(2_500u32), U256::from(1_500u32))
        .is_err());
}

#[test]
fn test_push_pull_collateral_balance() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);
    let amt = U256::from(1_000_000u64) * Q96_ONE_RAW;

    assert_eq!(engine.collateral_balance(vault, asset), U256::ZERO);
    engine.push_collateral(vault, asset, amt).unwrap();
    assert_eq!(engine.collateral_balance(vault, asset), amt);

    // Push again: balance accumulates.
    engine.push_collateral(vault, asset, amt).unwrap();
    assert_eq!(engine.collateral_balance(vault, asset), amt + amt);

    // Pull half.
    engine.pull_collateral(vault, asset, amt).unwrap();
    assert_eq!(engine.collateral_balance(vault, asset), amt);

    // Pulling more than the balance must revert.
    let too_much = amt + U256::from(1u8);
    assert!(engine.pull_collateral(vault, asset, too_much).is_err());
}

#[test]
fn test_net_collateral_usd_with_mock_oracle() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    // Push 100 units of `asset`.
    let amt = Q96::from_u128(100).raw;
    engine.push_collateral(vault, asset, amt).unwrap();

    // Price the asset at $2.00 (Q96).
    let price = Q96::from_u128(2).raw;
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset),
        Ok(encode_uint256(price)),
    );

    let total_raw = engine.net_collateral_usd_q96(vault).unwrap();
    // Expected: 100 * 2 = $200 in Q96.48.
    assert_eq!(total_raw, Q96::from_u128(200).raw);
}

#[test]
fn test_net_collateral_usd_multiple_assets_same_price() {
    // The stylus-test 0.10.7 TestVM mock_static_call stashes the *last*
    // registered return_data into a single shared slot; the per-(to, data)
    // map only routes the success/error flag. As a result, a single test that
    // queries two distinct prices in one call sees only the last price for
    // every read. We therefore exercise the multi-asset path with a *uniform*
    // price so the assertion is unaffected by that quirk. See vm.rs in
    // stylus-test-0.10.7 for the implementation.
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset_a = addr(0x11);
    let asset_b = addr(0x22);

    engine
        .push_collateral(vault, asset_a, Q96::from_u128(100).raw)
        .unwrap();
    engine
        .push_collateral(vault, asset_b, Q96::from_u128(50).raw)
        .unwrap();

    // Both assets priced at $3 -- registered last, so both reads return $3.
    let price = Q96::from_u128(3).raw;
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset_a),
        Ok(encode_uint256(price)),
    );
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset_b),
        Ok(encode_uint256(price)),
    );

    let total_raw = engine.net_collateral_usd_q96(vault).unwrap();
    // (100 + 50) * 3 = $450
    assert_eq!(total_raw, Q96::from_u128(450).raw);
}

#[test]
fn test_net_collateral_usd_oracle_failure_propagates() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    engine
        .push_collateral(vault, asset, Q96::from_u128(1).raw)
        .unwrap();
    // No mock registered: the static_call returns an error and the engine
    // surfaces ERR_PRICE_ORACLE_FAILED.
    let err = engine.net_collateral_usd_q96(vault).unwrap_err();
    let s = std::str::from_utf8(&err).unwrap();
    assert!(s.contains("price oracle"), "got: {s}");
}

#[test]
fn test_margin_used_usd_calculation() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    // 25% initial margin requirement.
    engine
        .set_margin_params(asset, U256::from(2_500u32), U256::from(1_500u32))
        .unwrap();
    // Open a $1_000 notional position (Q96.48).
    let notional = Q96::from_u128(1_000).raw;
    engine
        .set_position_notional(vault, asset, notional)
        .unwrap();

    let margin = engine.margin_used_usd_q96(vault).unwrap();
    // 1_000 * 25% = 250
    assert_eq!(margin, Q96::from_u128(250).raw);
}

#[test]
fn test_liquidation_check_below_threshold() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    // 25% initial, 15% liquidation.
    engine
        .set_margin_params(asset, U256::from(2_500u32), U256::from(1_500u32))
        .unwrap();
    // 1_000 USD of notional.
    engine
        .set_position_notional(vault, asset, Q96::from_u128(1_000).raw)
        .unwrap();
    // Push 100 USD of collateral (asset priced at $1).
    engine
        .push_collateral(vault, asset, Q96::from_u128(100).raw)
        .unwrap();
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset),
        Ok(encode_uint256(Q96::from_u128(1).raw)),
    );

    // Collateral = $100, threshold = 1_000 * 15% = $150. 100 < 150 -> liquidate.
    assert!(engine.liquidation_check(vault).unwrap());

    // Bump collateral to $200 -> safe.
    engine
        .push_collateral(vault, asset, Q96::from_u128(100).raw)
        .unwrap();
    // Need to re-register the mock because calls consume it.
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset),
        Ok(encode_uint256(Q96::from_u128(1).raw)),
    );
    assert!(!engine.liquidation_check(vault).unwrap());
}

#[test]
fn test_liquidation_check_no_notional_returns_false() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    assert!(!engine.liquidation_check(vault).unwrap());
}

#[test]
fn test_cross_domain_net_combines_on_and_off_chain() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    // 20% initial margin.
    engine
        .set_margin_params(asset, U256::from(2_000u32), U256::from(1_000u32))
        .unwrap();

    // On-chain: $500 of collateral, $1_000 notional -> $200 margin used.
    engine
        .push_collateral(vault, asset, Q96::from_u128(500).raw)
        .unwrap();
    engine
        .set_position_notional(vault, asset, Q96::from_u128(1_000).raw)
        .unwrap();
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset),
        Ok(encode_uint256(Q96::from_u128(1).raw)),
    );

    // Off-chain: $300 of collateral, $2_000 notional -> $400 margin used (worst).
    let off_collat = Q96::from_u128(300).raw;
    let off_notional = Q96::from_u128(2_000).raw;
    let result = engine
        .cross_domain_net_usd_q96(vault, off_notional, off_collat)
        .unwrap();

    // total_collat = 500 + 300 = 800
    // on_margin = 1_000 * 20% = 200
    // off_margin = 2_000 * 20% = 400 (worst)
    // net = 800 - 400 = 400
    assert_eq!(result, Q96::from_u128(400).raw);
}

#[test]
fn test_cross_domain_net_saturates_to_zero() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);

    engine
        .set_margin_params(asset, U256::from(5_000u32), U256::from(2_500u32))
        .unwrap();
    engine
        .push_collateral(vault, asset, Q96::from_u128(10).raw)
        .unwrap();
    engine
        .set_position_notional(vault, asset, Q96::from_u128(1_000).raw)
        .unwrap();
    vm.mock_static_call(
        engine.price_oracle(),
        calldata_for_price(asset),
        Ok(encode_uint256(Q96::from_u128(1).raw)),
    );

    // on_collat = 10, off_collat = 0
    // on_margin = 1_000 * 50% = 500
    // off_margin = 0
    // net = 10 - 500 -> saturating_sub clamps to 0
    let net = engine
        .cross_domain_net_usd_q96(vault, U256::ZERO, U256::ZERO)
        .unwrap();
    assert_eq!(net, U256::ZERO);
}

#[test]
fn test_only_owner_unauthorized_reverts() {
    let vm = TestVM::default();
    let mut engine = fresh_initialized(&vm);
    let asset = addr(0x11);

    vm.set_sender(addr(0xCC));
    let err = engine
        .set_margin_params(asset, U256::from(2_000u32), U256::from(1_000u32))
        .unwrap_err();
    assert!(std::str::from_utf8(&err).unwrap().contains("unauthorized"));
}

#[test]
fn test_calls_before_init_revert() {
    let vm = TestVM::default();
    let mut engine = MarginEngine::from(&vm);
    let vault = addr(0xDD);
    let asset = addr(0x11);
    assert!(engine
        .push_collateral(vault, asset, Q96::from_u128(1).raw)
        .is_err());
    assert!(engine.net_collateral_usd_q96(vault).is_err());
    assert!(engine.liquidation_check(vault).is_err());
}

// ---------------------------------------------------------------------------
// Feature E: mark_to_market_basket (stateless co-processor).
// ---------------------------------------------------------------------------
//
// These tests exercise the new additive entrypoint described in
// IMPLEMENTATION_PLAN.md section 2.E. Important properties:
//   - The basket math is pure: no oracle, no storage, no init guard.
//   - Validation failures return `I256::MIN`, not a revert (so vault
//     callers can be wrapped in non-reverting share-pricing paths).
//   - Saturating arithmetic: never panics on overflow.

use alloy_primitives::I256;

#[test]
fn test_basket_empty_returns_zero() {
    // An empty basket is the additive identity; mtm of nothing is $0.
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let result = engine.mark_to_market_basket(vec![], vec![], vec![]);
    assert_eq!(result, I256::ZERO);
}

#[test]
fn test_basket_single_asset_positive() {
    // 100 units of asset_a at $2.00 each => $200 in Q96.48.
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let asset = addr(0x11);
    let balance = Q96::from_u128(100).raw;
    let price = Q96::from_u128(2).raw;

    let result = engine.mark_to_market_basket(vec![asset], vec![balance], vec![price]);
    let expected = I256::try_from(Q96::from_u128(200).raw).unwrap();
    assert_eq!(result, expected);
    assert!(result > I256::ZERO);
}

#[test]
fn test_basket_single_asset_zero_balance() {
    // Zero balance => zero contribution, even with a non-zero price.
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let asset = addr(0x11);
    let result =
        engine.mark_to_market_basket(vec![asset], vec![U256::ZERO], vec![Q96::from_u128(2).raw]);
    assert_eq!(result, I256::ZERO);
}

#[test]
fn test_basket_mixed_three_assets() {
    // Three assets, all non-negative balances; verify sum:
    //   100 @ $2  = $200
    //    50 @ $3  = $150
    //    10 @ $7  =  $70
    //                ----
    //                $420
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let assets = vec![addr(0x11), addr(0x22), addr(0x33)];
    let balances = vec![
        Q96::from_u128(100).raw,
        Q96::from_u128(50).raw,
        Q96::from_u128(10).raw,
    ];
    let prices = vec![
        Q96::from_u128(2).raw,
        Q96::from_u128(3).raw,
        Q96::from_u128(7).raw,
    ];
    let result = engine.mark_to_market_basket(assets, balances, prices);
    let expected = I256::try_from(Q96::from_u128(420).raw).unwrap();
    assert_eq!(result, expected);
}

#[test]
fn test_basket_max_length_thirty_assets() {
    // Stress the upper bound. 30 assets at 1.0 each priced $1 => $30 total.
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let mut assets = Vec::with_capacity(30);
    let mut balances = Vec::with_capacity(30);
    let mut prices = Vec::with_capacity(30);
    for i in 0..30u8 {
        // Use distinct non-zero asset addresses (offset by 1 so 0xFF survives).
        assets.push(addr(i.wrapping_add(1)));
        balances.push(Q96::from_u128(1).raw);
        prices.push(Q96::from_u128(1).raw);
    }
    let result = engine.mark_to_market_basket(assets, balances, prices);
    let expected = I256::try_from(Q96::from_u128(30).raw).unwrap();
    assert_eq!(result, expected);
}

#[test]
fn test_basket_length_mismatch_returns_sentinel() {
    // assets.len() != balances.len() -> validation failure -> I256::MIN.
    let vm = TestVM::default();
    let engine = MarginEngine::from(&vm);
    let assets = vec![addr(0x11), addr(0x22)];
    let balances = vec![Q96::from_u128(1).raw]; // 1 != 2
    let prices = vec![Q96::from_u128(1).raw, Q96::from_u128(1).raw];
    let result = engine.mark_to_market_basket(assets, balances, prices);
    assert_eq!(result, I256::MIN);

    // Same shape but prices length mismatches.
    let assets = vec![addr(0x11)];
    let balances = vec![Q96::from_u128(1).raw];
    let prices: Vec<U256> = vec![]; // 0 != 1
    let result = engine.mark_to_market_basket(assets, balances, prices);
    assert_eq!(result, I256::MIN);

    // Length over MAX_BASKET_LEN (31 elements).
    let mut assets = Vec::with_capacity(31);
    let mut balances = Vec::with_capacity(31);
    let mut prices = Vec::with_capacity(31);
    for i in 0..31u8 {
        assets.push(addr(i.wrapping_add(1)));
        balances.push(Q96::from_u128(1).raw);
        prices.push(Q96::from_u128(1).raw);
    }
    let result = engine.mark_to_market_basket(assets, balances, prices);
    assert_eq!(result, I256::MIN);

    // Zero-address asset rejected.
    let result = engine.mark_to_market_basket(
        vec![Address::ZERO],
        vec![Q96::from_u128(1).raw],
        vec![Q96::from_u128(1).raw],
    );
    assert_eq!(result, I256::MIN);
}

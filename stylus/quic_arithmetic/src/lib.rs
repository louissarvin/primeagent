// PrimeAgent quic_arithmetic: Q96.48 fixed-point shared library.
//
// Q96.48 stores a non-negative real number `r` as `raw = r * 2^48` inside a
// `U256`. With 96 integer bits and 48 fractional bits we have 144 significant
// bits of value; the top 112 bits of the U256 are headroom for intermediate
// products. All arithmetic is checked: every public op returns `Result` or a
// saturating variant so callers cannot silently corrupt margin state.
//
// Source of truth: PrimeAgent.md Section 8.3. Spec uses I256 for signed
// positions inside `margin_engine`; this crate stays unsigned because the
// magnitudes (price, notional, collateral) are non-negative. Sign handling is
// the caller's responsibility.
//
// Pure-Rust no_std library. No Stylus entrypoint. Consumed by margin_engine
// and risk_engine.

#![no_std]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Q96.48 fixed-point arithmetic backed by `alloy_primitives::U256`.
//!
//! The Q-format convention: a value `v` is stored as `raw = floor(v * 2^48)`.
//! `Q96_ONE` is the integer `1 << 48`. Multiplications full-product into 256
//! bits and shift right by 48; divisions shift the numerator left by 48 first.
//! All ops are explicitly checked. There is no signed arithmetic; subtractions
//! that would go negative return `Q96Error::Negative`.

use alloy_primitives::U256;
use core::fmt;

/// Number of fractional bits in the Q96.48 representation.
pub const FRAC_BITS: u32 = 48;

/// Q96.48 representation of the integer 1, i.e. `1 << 48 = 281_474_976_710_656`.
pub const Q96_ONE: U256 = U256::from_limbs([1u64 << FRAC_BITS, 0, 0, 0]);

/// Q96.48 representation of zero.
pub const Q96_ZERO: U256 = U256::ZERO;

/// Errors raised by Q96.48 arithmetic operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Q96Error {
    /// An arithmetic operation overflowed the 256-bit backing integer.
    Overflow,
    /// A subtraction would produce a negative value (unsigned semantics).
    Negative,
    /// Division by zero.
    DivByZero,
    /// Conversion to a smaller integer type lost information.
    OutOfRange,
}

impl fmt::Display for Q96Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Q96Error::Overflow => f.write_str("Q96 overflow"),
            Q96Error::Negative => f.write_str("Q96 underflow (would be negative)"),
            Q96Error::DivByZero => f.write_str("Q96 division by zero"),
            Q96Error::OutOfRange => f.write_str("Q96 value out of range for target type"),
        }
    }
}

/// A non-negative Q96.48 fixed-point value.
///
/// Use [`Q96::from_u128`] for ordinary integers and [`Q96::from_q96_raw`]
/// when reading from on-chain storage that already holds a Q96.48 limb.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Q96 {
    /// Raw backing value: `floor(real * 2^48)`.
    pub raw: U256,
}

impl Q96 {
    /// The Q96.48 value `0`.
    pub const ZERO: Q96 = Q96 { raw: Q96_ZERO };

    /// The Q96.48 value `1`.
    pub const ONE: Q96 = Q96 { raw: Q96_ONE };

    /// Construct a Q96 from an integer `n`, scaling by `2^48`.
    ///
    /// Panics only if `n * 2^48` overflows `U256`, which requires `n` to exceed
    /// `2^208 - 1`. For `u128` inputs this is impossible: `2^128 << 48 = 2^176`
    /// which fits comfortably in 256 bits.
    pub fn from_u128(n: u128) -> Q96 {
        let base = U256::from(n);
        // base << 48 cannot overflow: 128 + 48 = 176 < 256.
        Q96 {
            raw: base << FRAC_BITS,
        }
    }

    /// Construct a Q96 from a U256 integer (treating it as a whole number).
    ///
    /// Returns `Q96Error::Overflow` if the input has more than 208 bits set.
    pub fn from_u256(n: U256) -> Result<Q96, Q96Error> {
        let max = U256::from(1u8) << 208u32;
        if n >= max {
            return Err(Q96Error::Overflow);
        }
        Ok(Q96 {
            raw: n << FRAC_BITS,
        })
    }

    /// Construct a Q96 directly from a raw `U256` (no shifting).
    ///
    /// Use this when reading a value that is already in Q96.48 form, e.g. from
    /// storage or from a price oracle that publishes Q96.48 prices.
    pub fn from_q96_raw(raw: U256) -> Q96 {
        Q96 { raw }
    }

    /// Construct a Q96 from a USD-cents integer.
    ///
    /// `cents = 100` represents `$1.00` and maps to `1 << 48`.
    pub fn from_usd_cents(cents: u64) -> Q96 {
        // cents * (1 << 48) / 100, computed with U256 to avoid intermediate
        // overflow for large cent counts.
        let scaled = U256::from(cents) << FRAC_BITS;
        Q96 {
            raw: scaled / U256::from(100u8),
        }
    }

    /// Truncate this Q96 to a `u128` integer (flooring fractional bits).
    ///
    /// Returns `Q96Error::OutOfRange` if the integer part exceeds `u128::MAX`.
    pub fn to_u128_floor(self) -> Result<u128, Q96Error> {
        let int_part = self.raw >> FRAC_BITS;
        let max_u128 = U256::from(u128::MAX);
        if int_part > max_u128 {
            return Err(Q96Error::OutOfRange);
        }
        // Take low 128 bits.
        let limbs = int_part.as_limbs();
        let low = limbs[0] as u128 | ((limbs[1] as u128) << 64);
        Ok(low)
    }

    /// Truncate to a `U256` integer (flooring fractional bits). Cannot fail.
    pub fn to_u256_floor(self) -> U256 {
        self.raw >> FRAC_BITS
    }

    /// Checked addition. Returns `Overflow` if the sum exceeds `U256::MAX`.
    pub fn checked_add(self, rhs: Q96) -> Result<Q96, Q96Error> {
        self.raw
            .checked_add(rhs.raw)
            .map(|raw| Q96 { raw })
            .ok_or(Q96Error::Overflow)
    }

    /// Checked subtraction (unsigned). Returns `Negative` if `rhs > self`.
    pub fn checked_sub(self, rhs: Q96) -> Result<Q96, Q96Error> {
        self.raw
            .checked_sub(rhs.raw)
            .map(|raw| Q96 { raw })
            .ok_or(Q96Error::Negative)
    }

    /// Checked multiplication. Computes `self.raw * rhs.raw / 2^48` in 256 bits.
    ///
    /// Returns `Overflow` if the full product exceeds `U256::MAX` (which
    /// requires the inputs to be near the upper bound of the Q96.48 range).
    pub fn checked_mul(self, rhs: Q96) -> Result<Q96, Q96Error> {
        let product = self.raw.checked_mul(rhs.raw).ok_or(Q96Error::Overflow)?;
        Ok(Q96 {
            raw: product >> FRAC_BITS,
        })
    }

    /// Checked division. Computes `(self.raw << 48) / rhs.raw`.
    ///
    /// Returns `DivByZero` if `rhs == 0` or `Overflow` if the left shift
    /// overflows (which requires `self.raw` to have more than 208 bits set).
    pub fn checked_div(self, rhs: Q96) -> Result<Q96, Q96Error> {
        if rhs.raw.is_zero() {
            return Err(Q96Error::DivByZero);
        }
        // checked_shl returns Option in alloy_primitives::Uint.
        let scaled = self
            .raw
            .checked_shl(FRAC_BITS as usize)
            .ok_or(Q96Error::Overflow)?;
        // Division can only fail on divide-by-zero, which we already checked.
        Ok(Q96 {
            raw: scaled / rhs.raw,
        })
    }

    /// Saturating addition. Clamps to `U256::MAX` instead of erroring.
    pub fn saturating_add(self, rhs: Q96) -> Q96 {
        Q96 {
            raw: self.raw.saturating_add(rhs.raw),
        }
    }

    /// Saturating subtraction. Clamps to zero instead of erroring.
    pub fn saturating_sub(self, rhs: Q96) -> Q96 {
        Q96 {
            raw: self.raw.saturating_sub(rhs.raw),
        }
    }

    /// Returns `true` if `self < rhs`.
    pub fn lt(self, rhs: Q96) -> bool {
        self.raw < rhs.raw
    }

    /// Returns `true` if `self > rhs`.
    pub fn gt(self, rhs: Q96) -> bool {
        self.raw > rhs.raw
    }

    /// Returns `true` if `self == rhs`.
    pub fn eq_q(self, rhs: Q96) -> bool {
        self.raw == rhs.raw
    }

    /// Returns `true` if `self <= rhs`.
    pub fn le(self, rhs: Q96) -> bool {
        self.raw <= rhs.raw
    }

    /// Returns `true` if `self >= rhs`.
    pub fn ge(self, rhs: Q96) -> bool {
        self.raw >= rhs.raw
    }

    /// Returns the maximum of two Q96 values.
    pub fn max(self, rhs: Q96) -> Q96 {
        if self.raw >= rhs.raw {
            self
        } else {
            rhs
        }
    }

    /// Returns the minimum of two Q96 values.
    pub fn min(self, rhs: Q96) -> Q96 {
        if self.raw <= rhs.raw {
            self
        } else {
            rhs
        }
    }

    /// Multiply a Q96 value by a basis-points integer.
    ///
    /// `bps = 10_000` is 100%, `bps = 2_500` is 25%.
    ///
    /// Returns `Overflow` if the intermediate multiplication overflows.
    pub fn mul_bps(self, bps: u32) -> Result<Q96, Q96Error> {
        let bps_u = U256::from(bps);
        let product = self.raw.checked_mul(bps_u).ok_or(Q96Error::Overflow)?;
        Ok(Q96 {
            raw: product / U256::from(10_000u32),
        })
    }
}

#[cfg(test)]
mod tests;

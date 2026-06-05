// Bin target shim required by cargo-stylus (>=0.6) for constructor probing
// and ABI export. The library crate provides the actual contract; this file
// only exists so `cargo run` succeeds during `cargo stylus deploy` / `export-abi`.
//
// `no_mangle` is treated as `unsafe` by recent rustc, which trips the
// crate-wide `unsafe_code = deny`. We relax the lint here (and here only)
// because this shim is the canonical Stylus entrypoint: the symbol MUST be
// named `main`, with no safe alternative within stylus-sdk 0.10.7. The
// shim has no logic; it is a no-op at runtime.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![allow(unsafe_code)]

#[cfg(not(any(test, feature = "export-abi")))]
#[no_mangle]
pub extern "C" fn main() {}

#[cfg(feature = "export-abi")]
fn main() {
    margin_engine::print_from_args();
}

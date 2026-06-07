#!/usr/bin/env bash
# init_risk_engine_arb_sepolia.sh
#
# Bootstrap the live Stylus risk engine on Arbitrum Sepolia (chain 421614).
# Calls init(marginEngine) once, then setVol(asset, vol_bps) for each of the
# five tokenised stock mocks (TSLA, AMZN, PLTR, NFLX, AMD). Mirrors the
# layout of `init_margin_engine_arb_sepolia.sh`.
#
# Usage:
#   ./init_risk_engine_arb_sepolia.sh            # live broadcast
#   ./init_risk_engine_arb_sepolia.sh --dry-run  # print cast commands only
#
# Required env (loaded from ./.env if present):
#   STYLUS_OWNER_PRIVATE_KEY   - owner EOA that ran cargo stylus deploy
#   ARB_SEPOLIA_RPC_URL        - Arbitrum Sepolia RPC endpoint
#   STYLUS_RISK_ENGINE_ADDRESS - deployed risk engine address
#   STYLUS_MARGIN_ENGINE_ADDRESS - already-deployed margin engine
#   <SYM>_ADDRESS              - ERC-20 address per symbol
#   <SYM>_VOL_BPS              - annualised vol in bps per symbol

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +o allexport
fi

require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: required env var ${var} is not set" >&2
    exit 1
  fi
}

require_env ARB_SEPOLIA_RPC_URL
require_env STYLUS_RISK_ENGINE_ADDRESS
require_env STYLUS_MARGIN_ENGINE_ADDRESS
for sym in TSLA AMZN PLTR NFLX AMD; do
  require_env "${sym}_ADDRESS"
  require_env "${sym}_VOL_BPS"
done
if [[ "${DRY_RUN}" -eq 0 ]]; then
  require_env STYLUS_OWNER_PRIVATE_KEY
fi

ENGINE="${STYLUS_RISK_ENGINE_ADDRESS}"
MARGIN="${STYLUS_MARGIN_ENGINE_ADDRESS}"
RPC="${ARB_SEPOLIA_RPC_URL}"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  [ok]   %s\n' "$1"; }
fail()  { printf '  [FAIL] %s\n' "$1" >&2; }
info()  { printf '  [info] %s\n' "$1"; }

send() {
  local label="$1"; shift
  local sig="$1"; shift
  local args=("$@")
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  DRY: cast send --rpc-url \"\$ARB_SEPOLIA_RPC_URL\" \\"
    echo "         --private-key \"\$STYLUS_OWNER_PRIVATE_KEY\" \\"
    echo "         ${ENGINE} \"${sig}\" ${args[*]}"
    return 0
  fi
  if cast send \
      --rpc-url "${RPC}" \
      --private-key "${STYLUS_OWNER_PRIVATE_KEY}" \
      "${ENGINE}" "${sig}" "${args[@]}" >/dev/null; then
    ok "${label}"
  else
    fail "${label}"
    exit 1
  fi
}

call() { cast call --rpc-url "${RPC}" "${ENGINE}" "$@"; }

normalize_addr() { echo "${1}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'; }

verify_addr() {
  local label="$1" sig="$2" expected="$3"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  DRY: cast call ${ENGINE} \"${sig}\""
    return 0
  fi
  local got
  got="$(call "${sig}")"
  if [[ "$(normalize_addr "${got}")" == "$(normalize_addr "${expected}")" ]]; then
    ok "${label} = ${got}"
  else
    fail "${label} mismatch: got ${got}, expected ${expected}"
    exit 1
  fi
}

verify_uint() {
  local label="$1" sig="$2" asset="$3" expected="$4"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  DRY: cast call ${ENGINE} \"${sig}\" ${asset}"
    return 0
  fi
  local got
  got="$(call "${sig}" "${asset}")"
  if [[ "${got}" == "${expected}" ]]; then
    ok "${label}(${asset}) = ${got}"
  else
    fail "${label}(${asset}) mismatch: got ${got}, expected ${expected}"
    exit 1
  fi
}

bold "Step 1: init(marginEngine)"
send "init" "init(address)" "${MARGIN}"
verify_addr "marginEngine()" "marginEngine()(address)" "${MARGIN}"

bold "Step 2: setVol per asset"
SYMS=(TSLA AMZN PLTR NFLX AMD)
for sym in "${SYMS[@]}"; do
  addr_var="${sym}_ADDRESS"
  vol_var="${sym}_VOL_BPS"
  addr="${!addr_var}"
  vol="${!vol_var}"

  info "${sym}: addr=${addr} vol_bps=${vol}"
  send "setVol ${sym}" "setVol(address,uint256)" "${addr}" "${vol}"
  verify_uint "volBps" "volBps(address)(uint256)" "${addr}" "${vol}"
done

bold "Done."
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  Dry run complete. Re-run without --dry-run to broadcast."
else
  echo "  Risk engine ${ENGINE} is initialized and configured."
fi

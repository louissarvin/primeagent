#!/usr/bin/env bash
# verify_risk_engine.sh
#
# Read-only inspection of the live Stylus risk engine. Calls cast call only;
# never sends a transaction. Use before and after init to confirm state.
# Mirrors `verify_margin_engine.sh`.

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
for sym in TSLA AMZN PLTR NFLX AMD; do
  require_env "${sym}_ADDRESS"
done
# verify_risk_engine.sh is read-only; even outside dry-run mode it never
# signs, so we deliberately do NOT require STYLUS_OWNER_PRIVATE_KEY.

ENGINE="${STYLUS_RISK_ENGINE_ADDRESS}"
RPC="${ARB_SEPOLIA_RPC_URL}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
row()  { printf '  %-30s %s\n' "$1" "$2"; }

if [[ "${DRY_RUN}" -eq 1 ]]; then
  bold "DRY RUN: verify_risk_engine.sh"
  echo "  Would inspect engine ${ENGINE} on ${RPC}"
  echo "  No transactions are sent; --dry-run skips the cast calls below."
  exit 0
fi

bold "Engine ${ENGINE} on ${RPC}"

OWNER="$(cast call --rpc-url "${RPC}" "${ENGINE}" "owner()(address)" 2>/dev/null || echo "<call failed>")"
MARGIN="$(cast call --rpc-url "${RPC}" "${ENGINE}" "marginEngine()(address)" 2>/dev/null || echo "<call failed>")"

row "owner()"         "${OWNER}"
row "marginEngine()"  "${MARGIN}"

if [[ "${OWNER}" == "0x0000000000000000000000000000000000000000" ]]; then
  echo
  echo "NOTE: owner is zero address. init() has not been called yet."
fi

bold "Per-asset volatility (bps)"
SYMS=(TSLA AMZN PLTR NFLX AMD)
for sym in "${SYMS[@]}"; do
  addr_var="${sym}_ADDRESS"
  addr="${!addr_var}"
  VOL="$(cast call --rpc-url "${RPC}" "${ENGINE}" \
        "volBps(address)(uint256)" "${addr}" 2>/dev/null || echo "?")"
  printf '  %-6s %s  vol=%s\n' "${sym}" "${addr}" "${VOL}"
done

bold "Done."

#!/usr/bin/env bash
# verify_margin_engine.sh
#
# Read-only inspection of the live Stylus margin engine. Calls cast call only;
# never sends a transaction. Use before and after init to confirm state.

set -euo pipefail

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
require_env STYLUS_MARGIN_ENGINE_ADDRESS
for sym in TSLA AMZN PLTR NFLX AMD; do
  require_env "${sym}_ADDRESS"
done

ENGINE="${STYLUS_MARGIN_ENGINE_ADDRESS}"
RPC="${ARB_SEPOLIA_RPC_URL}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
row()  { printf '  %-30s %s\n' "$1" "$2"; }

bold "Engine ${ENGINE} on ${RPC}"

OWNER="$(cast call --rpc-url "${RPC}" "${ENGINE}" "owner()(address)" 2>/dev/null || echo "<call failed>")"
ORACLE="$(cast call --rpc-url "${RPC}" "${ENGINE}" "priceOracle()(address)" 2>/dev/null || echo "<call failed>")"
ATTESTOR="$(cast call --rpc-url "${RPC}" "${ENGINE}" "attestor()(address)" 2>/dev/null || echo "<call failed>")"

row "owner()"        "${OWNER}"
row "priceOracle()"  "${ORACLE}"
row "attestor()"     "${ATTESTOR}"

if [[ "${OWNER}" == "0x0000000000000000000000000000000000000000" ]]; then
  echo
  echo "NOTE: owner is zero address. init() has not been called yet."
fi

bold "Per-asset margin params"
SYMS=(TSLA AMZN PLTR NFLX AMD)
for sym in "${SYMS[@]}"; do
  addr_var="${sym}_ADDRESS"
  addr="${!addr_var}"
  MR="$(cast call --rpc-url "${RPC}" "${ENGINE}" \
        "marginRequirementBps(address)(uint256)" "${addr}" 2>/dev/null || echo "?")"
  LT="$(cast call --rpc-url "${RPC}" "${ENGINE}" \
        "liquidationThresholdBps(address)(uint256)" "${addr}" 2>/dev/null || echo "?")"
  printf '  %-6s %s  mr=%s lt=%s\n' "${sym}" "${addr}" "${MR}" "${LT}"
done

bold "Done."

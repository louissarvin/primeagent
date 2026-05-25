#!/usr/bin/env bash
# prime-execute-cut.sh
#
# Execute the 48h-timelocked Diamond cut that prime-setup.sh proposed.
# Reads contracts/script/diamond_cut_proposed.json for the cutHash + propose
# timestamp; refuses to broadcast if 48h has not yet elapsed.
#
# Usage:
#   scripts/prime-execute-cut.sh
#   scripts/prime-execute-cut.sh --dry-run
#
# Required env:
#   DEPLOYER_PRIVATE_KEY
#   ANVIL_RPC_URL_ARB_SEPOLIA

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ -t 1 ]]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'
  C_BOLD='\033[1m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_RESET=''
fi
ok()   { printf "${C_GREEN}[ok]${C_RESET}    %s\n" "$1"; }
fail() { printf "${C_RED}[FAIL]${C_RESET}  %s\n" "$1" >&2; }
info() { printf "${C_BOLD}==>${C_RESET}    %s\n" "$1"; }

if [[ -f "${REPO_ROOT}/backend/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/backend/.env"
  set +o allexport
fi

CUT_JSON="${REPO_ROOT}/contracts/script/diamond_cut_proposed.json"
if [[ ! -f "${CUT_JSON}" ]]; then
  fail "no proposed cut found at ${CUT_JSON}. Run scripts/prime-setup.sh first."
  exit 1
fi

CUT_HASH="$(grep -oE '"cutHash":[[:space:]]*"[^"]+"' "${CUT_JSON}" | sed 's/.*"\(0x[a-fA-F0-9]*\)".*/\1/')"
PROPOSED_AT="$(grep -oE '"proposedAt":[[:space:]]*[0-9]+' "${CUT_JSON}" | grep -oE '[0-9]+')"
EXEC_AFTER="$(grep -oE '"executeAfter":[[:space:]]*[0-9]+' "${CUT_JSON}" | grep -oE '[0-9]+')"
NOW_TS="$(date -u +%s)"

info "loaded cut: ${CUT_HASH}"
info "proposed at: $(date -u -r "${PROPOSED_AT}" 2>/dev/null || date -u -d "@${PROPOSED_AT}")"
info "executable after: $(date -u -r "${EXEC_AFTER}" 2>/dev/null || date -u -d "@${EXEC_AFTER}")"

if (( NOW_TS < EXEC_AFTER )); then
  REMAIN=$(( EXEC_AFTER - NOW_TS ))
  H=$(( REMAIN / 3600 ))
  M=$(( (REMAIN % 3600) / 60 ))
  fail "timelock not elapsed. ${H}h ${M}m remaining."
  exit 1
fi

# Required env for broadcast
if [[ "${DRY_RUN}" -eq 0 ]]; then
  for v in DEPLOYER_PRIVATE_KEY ANVIL_RPC_URL_ARB_SEPOLIA; do
    if [[ -z "${!v:-}" ]]; then
      fail "missing required env: ${v}"
      exit 1
    fi
  done
fi

info "executing Diamond cut"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf "DRY: cd contracts && forge script script/ExecutePolicyFacetUpgrade.s.sol --broadcast --rpc-url \$ANVIL_RPC_URL_ARB_SEPOLIA --private-key \$DEPLOYER_PRIVATE_KEY\n"
else
  ( cd "${REPO_ROOT}/contracts" && forge script script/ExecutePolicyFacetUpgrade.s.sol:ExecutePolicyFacetUpgrade \
    --sig "run()" \
    --rpc-url "${ANVIL_RPC_URL_ARB_SEPOLIA}" \
    --private-key "${DEPLOYER_PRIVATE_KEY}" \
    --broadcast --slow ) || {
      fail "forge script ExecutePolicyFacetUpgrade failed"
      exit 1
  }
  ok "Diamond cut executed"
fi

# Flip BACKEND_POLICY_FACET_V2 in backend/.env
BACKEND_ENV="${REPO_ROOT}/backend/.env"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf "DRY: would set BACKEND_POLICY_FACET_V2=true in ${BACKEND_ENV}\n"
elif [[ -f "${BACKEND_ENV}" ]]; then
  if grep -qE '^BACKEND_POLICY_FACET_V2=' "${BACKEND_ENV}"; then
    awk '
      /^BACKEND_POLICY_FACET_V2=/ { print "BACKEND_POLICY_FACET_V2=true"; next }
      { print }
    ' "${BACKEND_ENV}" > "${BACKEND_ENV}.tmp" && mv "${BACKEND_ENV}.tmp" "${BACKEND_ENV}"
  else
    printf '\nBACKEND_POLICY_FACET_V2=true\n' >> "${BACKEND_ENV}"
  fi
  ok "set BACKEND_POLICY_FACET_V2=true in backend/.env"
fi

# Restart backend if PID file exists
PID_FILE=/tmp/primeagent-backend.pid
if [[ "${DRY_RUN}" -eq 0 && -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}")"
  if kill -0 "${OLD_PID}" 2>/dev/null; then
    kill "${OLD_PID}" && ok "stopped backend pid ${OLD_PID}"
    sleep 2
  fi
  ( cd "${REPO_ROOT}/backend" && nohup bun dev > /tmp/primeagent-backend.log 2>&1 & echo $! > "${PID_FILE}" )
  ok "restarted backend (new pid $(cat ${PID_FILE}))"
fi

ok "prime-execute-cut.sh complete"

#!/usr/bin/env bash
# prime-setup.sh
#
# PrimeAgent live-activation orchestrator. Idempotent. Aborts loudly on the
# first failure. Never broadcasts without operator-supplied private keys.
#
# Usage:
#   scripts/prime-setup.sh                 # full pipeline: db push + Stylus + Diamond propose
#   scripts/prime-setup.sh --dry-run       # print every command, broadcast nothing
#   scripts/prime-setup.sh --skip-broadcast  # run db push only, skip Stylus + Diamond
#   scripts/prime-setup.sh --help          # show this help
#
# Required env (loaded from backend/.env if present):
#   Backend (9 wave vars per memory/backend-build-notes.md section 4):
#     BACKEND_RISK_ENGINE_ADDRESS
#     BACKEND_DRILL_REFUND_KEY
#     BACKEND_DRILL_DEFAULT_ASSET
#     BACKEND_LIQUIDATION_EXECUTOR_ADDRESS_ARB_SEPOLIA
#     BACKEND_PREEXEC_HOOK_ADDRESS
#     BACKEND_PRESET_HASH_COMMIT_TX
#     BACKEND_FLEET_BASE_ASSET_ADDRESS
#     BACKEND_FLEET_URI_TEMPLATE
#     BACKEND_DEMO_ASSET_TSLA  (one demo asset required; AMZN/PLTR/NFLX/AMD optional)
#   Broadcast:
#     STYLUS_OWNER_PRIVATE_KEY
#     DEPLOYER_PRIVATE_KEY
#     ANVIL_RPC_URL_ARB_SEPOLIA  (Arbitrum Sepolia RPC; named ANVIL_* per scope contract)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
SKIP_BROADCAST=0

while [[ "${1:-}" != "" ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-broadcast) SKIP_BROADCAST=1 ;;
    --help|-h)
      sed -n '2,25p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# --- colors ---
if [[ -t 1 ]]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'
  C_BOLD='\033[1m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_RESET=''
fi
ok()   { printf "${C_GREEN}[ok]${C_RESET}    %s\n" "$1"; }
skip() { printf "${C_YELLOW}[skip]${C_RESET}  %s\n" "$1"; }
fail() { printf "${C_RED}[FAIL]${C_RESET}  %s\n" "$1" >&2; }
info() { printf "${C_BOLD}==>${C_RESET}    %s\n" "$1"; }
note() { printf "         %s\n" "$1"; }

# Track summary
SUMMARY_OK=()
SUMMARY_SKIP=()
SUMMARY_VARS=()

# --- load backend/.env if present (for the 9 BACKEND_* vars) ---
if [[ -f "${REPO_ROOT}/backend/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/backend/.env"
  set +o allexport
fi

# --- Step 1: env sanity ---
info "Step 1: env sanity"

REQUIRED_BACKEND=(
  BACKEND_RISK_ENGINE_ADDRESS
  BACKEND_DRILL_REFUND_KEY
  BACKEND_DRILL_DEFAULT_ASSET
  BACKEND_LIQUIDATION_EXECUTOR_ADDRESS_ARB_SEPOLIA
  BACKEND_PREEXEC_HOOK_ADDRESS
  BACKEND_PRESET_HASH_COMMIT_TX
  BACKEND_FLEET_BASE_ASSET_ADDRESS
  BACKEND_FLEET_URI_TEMPLATE
  BACKEND_DEMO_ASSET_TSLA
)
REQUIRED_BROADCAST=(STYLUS_OWNER_PRIVATE_KEY DEPLOYER_PRIVATE_KEY ANVIL_RPC_URL_ARB_SEPOLIA)

MISSING=()
for v in "${REQUIRED_BACKEND[@]}"; do
  if [[ -z "${!v:-}" ]]; then MISSING+=("$v"); fi
done

if [[ "${SKIP_BROADCAST}" -eq 0 && "${DRY_RUN}" -eq 0 ]]; then
  for v in "${REQUIRED_BROADCAST[@]}"; do
    if [[ -z "${!v:-}" ]]; then MISSING+=("$v"); fi
  done
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  fail "missing required env vars:"
  for v in "${MISSING[@]}"; do printf '         - %s\n' "$v" >&2; done
  exit 1
fi
ok "env sanity passed"
SUMMARY_OK+=("env sanity")

# --- Step 2: backend Prisma push ---
info "Step 2: backend Prisma db:push"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  note "DRY: cd backend && bun db:push"
  skip "db:push (dry-run)"
  SUMMARY_SKIP+=("db:push (dry-run)")
else
  ( cd "${REPO_ROOT}/backend" && bun db:push ) && {
    ok "db:push applied (LiquidationDrill windowSec/terminalPhase, ReputationFeedback)"
    SUMMARY_OK+=("db:push")
  } || {
    fail "db:push failed"
    exit 1
  }
fi

# --- Step 3: init margin_engine ---
info "Step 3: init margin_engine on Arb Sepolia"
MARGIN_VERIFY="${REPO_ROOT}/stylus/script/verify_margin_engine.sh"
MARGIN_INIT="${REPO_ROOT}/stylus/script/init_margin_engine_arb_sepolia.sh"
MARGIN_ALREADY_OK=0
if [[ -x "${MARGIN_VERIFY}" ]] && [[ -f "${REPO_ROOT}/stylus/script/.env" ]]; then
  # quick check: owner() non-zero AND TSLA mr non-zero
  if bash "${MARGIN_VERIFY}" 2>/dev/null | grep -q "owner().*0x0000000000000000000000000000000000000000"; then
    MARGIN_ALREADY_OK=0
  else
    MARGIN_ALREADY_OK=1
  fi
fi

if [[ "${SKIP_BROADCAST}" -eq 1 ]]; then
  skip "margin_engine init (--skip-broadcast)"
  SUMMARY_SKIP+=("margin_engine init (--skip-broadcast)")
elif [[ "${MARGIN_ALREADY_OK}" -eq 1 ]]; then
  skip "margin_engine already initialized (verify_margin_engine.sh shows non-zero owner)"
  SUMMARY_SKIP+=("margin_engine (already initialized)")
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  bash "${MARGIN_INIT}" --dry-run || true
  skip "margin_engine init (dry-run)"
  SUMMARY_SKIP+=("margin_engine init (dry-run)")
else
  # Dry-run first, then real broadcast
  note "dry-run preview:"
  bash "${MARGIN_INIT}" --dry-run | tail -5 || true
  bash "${MARGIN_INIT}" && {
    ok "margin_engine initialized + 5 setMarginParams"
    SUMMARY_OK+=("margin_engine init")
  } || {
    fail "margin_engine init failed; engine may be partially configured"
    exit 1
  }
fi

# --- Step 4: deploy risk_engine WASM ---
info "Step 4: deploy risk_engine WASM"
RISK_DEPLOYED_JSON="${REPO_ROOT}/stylus/script/risk_engine_deployed.json"
RISK_WASM="${REPO_ROOT}/stylus/target/wasm32-unknown-unknown/release/risk_engine.wasm"

if [[ -f "${RISK_DEPLOYED_JSON}" ]]; then
  RISK_ADDR="$(grep -o '"address":[^,}]*' "${RISK_DEPLOYED_JSON}" | head -1 | sed 's/.*"\(0x[a-fA-F0-9]\{40\}\)".*/\1/')"
  skip "risk_engine already deployed at ${RISK_ADDR}"
  SUMMARY_SKIP+=("risk_engine deploy (cached: ${RISK_ADDR})")
elif [[ "${SKIP_BROADCAST}" -eq 1 ]]; then
  skip "risk_engine deploy (--skip-broadcast)"
  SUMMARY_SKIP+=("risk_engine deploy (--skip-broadcast)")
  RISK_ADDR=""
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  note "DRY: cd stylus/risk_engine && cargo stylus deploy --wasm-file ${RISK_WASM} --private-key \$STYLUS_OWNER_PRIVATE_KEY"
  skip "risk_engine deploy (dry-run)"
  SUMMARY_SKIP+=("risk_engine deploy (dry-run)")
  RISK_ADDR=""
else
  if [[ ! -f "${RISK_WASM}" ]]; then
    note "building risk_engine WASM first"
    ( cd "${REPO_ROOT}/stylus" && cargo build --target wasm32-unknown-unknown --release -p risk_engine ) || {
      fail "cargo build risk_engine failed"
      exit 1
    }
  fi
  DEPLOY_OUT="$(cd "${REPO_ROOT}/stylus/risk_engine" && cargo stylus deploy \
    --wasm-file "${RISK_WASM}" \
    --private-key "${STYLUS_OWNER_PRIVATE_KEY}" 2>&1 | tee /dev/stderr)" || {
      fail "cargo stylus deploy failed"
      exit 1
  }
  RISK_ADDR="$(printf '%s\n' "${DEPLOY_OUT}" | grep -oE '0x[a-fA-F0-9]{40}' | tail -1)"
  if [[ -z "${RISK_ADDR}" ]]; then
    fail "could not parse risk_engine address from cargo stylus output"
    exit 1
  fi
  printf '{"address":"%s","deployedAt":"%s","network":"arb-sepolia"}\n' \
    "${RISK_ADDR}" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "${RISK_DEPLOYED_JSON}"
  ok "risk_engine deployed at ${RISK_ADDR}"
  SUMMARY_OK+=("risk_engine deploy (${RISK_ADDR})")
  SUMMARY_VARS+=("BACKEND_RISK_ENGINE_ADDRESS=${RISK_ADDR}")
fi

# --- Step 5: init risk_engine ---
info "Step 5: init risk_engine on Arb Sepolia"
RISK_VERIFY="${REPO_ROOT}/stylus/script/verify_risk_engine.sh"
RISK_INIT="${REPO_ROOT}/stylus/script/init_risk_engine_arb_sepolia.sh"

if [[ "${SKIP_BROADCAST}" -eq 1 ]]; then
  skip "risk_engine init (--skip-broadcast)"
  SUMMARY_SKIP+=("risk_engine init (--skip-broadcast)")
elif [[ -z "${RISK_ADDR:-}" ]]; then
  skip "risk_engine init (no address yet)"
  SUMMARY_SKIP+=("risk_engine init (no address)")
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  STYLUS_RISK_ENGINE_ADDRESS="${RISK_ADDR}" bash "${RISK_INIT}" --dry-run || true
  skip "risk_engine init (dry-run)"
  SUMMARY_SKIP+=("risk_engine init (dry-run)")
else
  RISK_ALREADY_OK=0
  if [[ -x "${RISK_VERIFY}" ]]; then
    if STYLUS_RISK_ENGINE_ADDRESS="${RISK_ADDR}" bash "${RISK_VERIFY}" 2>/dev/null \
        | grep -q "marginEngine().*0x0000000000000000000000000000000000000000"; then
      RISK_ALREADY_OK=0
    else
      RISK_ALREADY_OK=1
    fi
  fi
  if [[ "${RISK_ALREADY_OK}" -eq 1 ]]; then
    skip "risk_engine already initialized"
    SUMMARY_SKIP+=("risk_engine init (already initialized)")
  else
    note "dry-run preview:"
    STYLUS_RISK_ENGINE_ADDRESS="${RISK_ADDR}" bash "${RISK_INIT}" --dry-run | tail -5 || true
    STYLUS_RISK_ENGINE_ADDRESS="${RISK_ADDR}" bash "${RISK_INIT}" && {
      ok "risk_engine initialized + 5 setVol"
      SUMMARY_OK+=("risk_engine init")
    } || {
      fail "risk_engine init failed"
      exit 1
    }
  fi
fi

# --- Step 6: write BACKEND_RISK_ENGINE_ADDRESS to backend/.env ---
info "Step 6: update backend/.env BACKEND_RISK_ENGINE_ADDRESS"
BACKEND_ENV="${REPO_ROOT}/backend/.env"
if [[ -z "${RISK_ADDR:-}" ]]; then
  skip "skipping .env write (no risk_engine address)"
  SUMMARY_SKIP+=("backend/.env BACKEND_RISK_ENGINE_ADDRESS")
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  note "DRY: would set BACKEND_RISK_ENGINE_ADDRESS=${RISK_ADDR} in ${BACKEND_ENV}"
  skip "backend/.env write (dry-run)"
  SUMMARY_SKIP+=("backend/.env BACKEND_RISK_ENGINE_ADDRESS (dry-run)")
elif [[ ! -f "${BACKEND_ENV}" ]]; then
  printf 'BACKEND_RISK_ENGINE_ADDRESS=%s\n' "${RISK_ADDR}" > "${BACKEND_ENV}"
  ok "wrote new backend/.env with BACKEND_RISK_ENGINE_ADDRESS"
  SUMMARY_OK+=("backend/.env (new)")
else
  if grep -qE '^BACKEND_RISK_ENGINE_ADDRESS=' "${BACKEND_ENV}"; then
    # in-place sed (BSD + GNU compatible: write temp file)
    awk -v addr="${RISK_ADDR}" '
      /^BACKEND_RISK_ENGINE_ADDRESS=/ { print "BACKEND_RISK_ENGINE_ADDRESS=" addr; next }
      { print }
    ' "${BACKEND_ENV}" > "${BACKEND_ENV}.tmp" && mv "${BACKEND_ENV}.tmp" "${BACKEND_ENV}"
    ok "updated BACKEND_RISK_ENGINE_ADDRESS in backend/.env"
  else
    printf '\nBACKEND_RISK_ENGINE_ADDRESS=%s\n' "${RISK_ADDR}" >> "${BACKEND_ENV}"
    ok "appended BACKEND_RISK_ENGINE_ADDRESS to backend/.env"
  fi
  SUMMARY_OK+=("backend/.env BACKEND_RISK_ENGINE_ADDRESS=${RISK_ADDR}")
fi

# --- Step 7: propose Diamond cut ---
info "Step 7: propose Diamond cut (UpgradePolicyFacet)"
CUT_JSON="${REPO_ROOT}/contracts/script/diamond_cut_proposed.json"
TIMELOCK_SECONDS=$((48 * 60 * 60))

CUT_STILL_VALID=0
if [[ -f "${CUT_JSON}" ]]; then
  PREV_TS="$(grep -oE '"proposedAt":[[:space:]]*[0-9]+' "${CUT_JSON}" | grep -oE '[0-9]+' || echo 0)"
  NOW_TS="$(date -u +%s)"
  AGE=$(( NOW_TS - PREV_TS ))
  if (( AGE < TIMELOCK_SECONDS )); then
    CUT_STILL_VALID=1
  fi
fi

if [[ "${SKIP_BROADCAST}" -eq 1 ]]; then
  skip "Diamond cut propose (--skip-broadcast)"
  SUMMARY_SKIP+=("Diamond cut propose (--skip-broadcast)")
elif [[ "${CUT_STILL_VALID}" -eq 1 ]]; then
  skip "Diamond cut already proposed within 48h window (see ${CUT_JSON})"
  SUMMARY_SKIP+=("Diamond cut propose (cached)")
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  note "DRY: cd contracts && forge script script/UpgradePolicyFacet.s.sol --rpc-url \$ANVIL_RPC_URL_ARB_SEPOLIA"
  skip "Diamond cut propose (dry-run)"
  SUMMARY_SKIP+=("Diamond cut propose (dry-run)")
else
  PROPOSE_OUT="$(cd "${REPO_ROOT}/contracts" && forge script script/UpgradePolicyFacet.s.sol:UpgradePolicyFacet \
    --sig "run()" \
    --rpc-url "${ANVIL_RPC_URL_ARB_SEPOLIA}" \
    --private-key "${DEPLOYER_PRIVATE_KEY}" \
    --broadcast --slow 2>&1 | tee /dev/stderr)" || {
      fail "forge script UpgradePolicyFacet failed"
      exit 1
  }
  CUT_HASH="$(printf '%s\n' "${PROPOSE_OUT}" | grep -oE 'cutHash[^0-9a-fx]*0x[a-fA-F0-9]{64}' | grep -oE '0x[a-fA-F0-9]{64}' | head -1)"
  NOW_TS="$(date -u +%s)"
  EXEC_TS=$(( NOW_TS + TIMELOCK_SECONDS ))
  printf '{"cutHash":"%s","proposedAt":%d,"executeAfter":%d,"network":"arb-sepolia"}\n' \
    "${CUT_HASH:-unknown}" "${NOW_TS}" "${EXEC_TS}" > "${CUT_JSON}"
  ok "Diamond cut proposed (cutHash=${CUT_HASH:-unknown}); executable after $(date -u -r "${EXEC_TS}" 2>/dev/null || date -u -d "@${EXEC_TS}")"
  SUMMARY_OK+=("Diamond cut propose")
fi

# --- Step 8: summary ---
info "Step 8: summary"
printf "\n${C_BOLD}OK (%d):${C_RESET}\n" "${#SUMMARY_OK[@]}"
for s in "${SUMMARY_OK[@]:-}"; do printf "  ${C_GREEN}+${C_RESET} %s\n" "$s"; done
printf "\n${C_BOLD}SKIPPED (%d):${C_RESET}\n" "${#SUMMARY_SKIP[@]}"
for s in "${SUMMARY_SKIP[@]:-}"; do printf "  ${C_YELLOW}-${C_RESET} %s\n" "$s"; done
if [[ ${#SUMMARY_VARS[@]} -gt 0 ]]; then
  printf "\n${C_BOLD}NEW ENV VALUES:${C_RESET}\n"
  for v in "${SUMMARY_VARS[@]:-}"; do printf "  %s\n" "$v"; done
fi
if [[ -f "${CUT_JSON}" ]]; then
  EXEC_TS="$(grep -oE '"executeAfter":[[:space:]]*[0-9]+' "${CUT_JSON}" | grep -oE '[0-9]+')"
  if [[ -n "${EXEC_TS}" ]]; then
    printf "\n${C_BOLD}Diamond cut executable after:${C_RESET} %s\n" \
      "$(date -u -r "${EXEC_TS}" 2>/dev/null || date -u -d "@${EXEC_TS}")"
    printf "Run ${C_BOLD}scripts/prime-execute-cut.sh${C_RESET} at that time or later.\n"
  fi
fi

# --- Step 9: dev servers (operator decides) ---
info "Step 9: dev servers"
printf "Operator: start dev servers manually with:\n"
printf "  ${C_BOLD}cd backend && bun dev${C_RESET}\n"
printf "  ${C_BOLD}cd web && bun dev${C_RESET}\n"
printf "Or run with PID files:\n"
printf "  ${C_BOLD}( cd backend && nohup bun dev > /tmp/primeagent-backend.log 2>&1 & echo \$! > /tmp/primeagent-backend.pid )${C_RESET}\n"
printf "  ${C_BOLD}( cd web && nohup bun dev > /tmp/primeagent-web.log 2>&1 & echo \$! > /tmp/primeagent-web.pid )${C_RESET}\n"

ok "prime-setup.sh complete"

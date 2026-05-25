#!/usr/bin/env bash
# prime-judge-drop.sh
#
# Mint one labelled PrimeAgent Position NFT to a judge's wallet as
# post-demo memorabilia. Calls the Feature D fleet spawn endpoint with
# count: 1 and a custom nameTemplate per judge.
#
# Usage:
#   bash scripts/prime-judge-drop.sh --address 0xJUDGE [--label "Judge-LDN-2026-06-14"] [--dry-run]
#
# Required env vars (loaded from backend/.env in dry-run, otherwise from shell):
#   BACKEND_BASE_URL           e.g. https://api.primeagent.fi
#   BACKEND_OPERATOR_JWT       JWT for the demo operator session
#   BACKEND_FLEET_BASE_ASSET_ADDRESS
#   ARB_SEPOLIA_RPC_URL
#
# Exit codes:
#   0  success (or dry-run completed)
#   1  bad arguments
#   2  missing env
#   3  backend returned non-2xx
#   4  signing aborted by operator
set -euo pipefail

ADDRESS=""
LABEL="PrimeAgent-Judge"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)
      ADDRESS="$2"
      shift 2
      ;;
    --label)
      LABEL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ADDRESS" ]]; then
  echo "Error: --address is required" >&2
  exit 1
fi

if ! [[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "Error: --address must be a 0x-prefixed 40-hex address" >&2
  exit 1
fi

CLIENT_ID="judge-drop-$(date +%s)-${ADDRESS:2:8}"
NAME_TEMPLATE="${LABEL}-{judge}"

PAYLOAD=$(cat <<EOF
{
  "clientId": "${CLIENT_ID}",
  "count": 1,
  "strategyName": "tsla-pairs",
  "nameTemplate": "${NAME_TEMPLATE}",
  "parentTokenId": null,
  "policy": {
    "tokenId": null,
    "clientId": "${CLIENT_ID}",
    "presetId": "delta-neutral",
    "maxNotionalUsd": 50000,
    "dailyCapUsd": 200000,
    "durationDays": 30,
    "allowedSymbols": ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"],
    "allowedContracts": [],
    "allowedSelectors": [],
    "strategyName": "tsla-pairs",
    "presetHash": "0xa1913431eb5063f9ba2b20005ca4d43b034c47c579dd16e246f29c244e567bd1",
    "draftedAt": $(date +%s)
  }
}
EOF
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] Would POST to \${BACKEND_BASE_URL}/api/agent/fleet/spawn"
  echo "[dry-run] Address: ${ADDRESS}"
  echo "[dry-run] Label:   ${LABEL}"
  echo "[dry-run] Payload:"
  echo "${PAYLOAD}"
  exit 0
fi

: "${BACKEND_BASE_URL:?BACKEND_BASE_URL is required}"
: "${BACKEND_OPERATOR_JWT:?BACKEND_OPERATOR_JWT is required}"
: "${BACKEND_FLEET_BASE_ASSET_ADDRESS:?BACKEND_FLEET_BASE_ASSET_ADDRESS is required}"
: "${ARB_SEPOLIA_RPC_URL:?ARB_SEPOLIA_RPC_URL is required}"

# TODO(operator): replace the curl below with the production call once the
# fleet route's batched-call signing is wired into a CLI signer. For now this
# returns the batched calls; the operator pastes them into MetaMask manually
# or uses the web /launch fleet tab as a fallback path.
RESPONSE=$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${BACKEND_OPERATOR_JWT}" \
  -d "${PAYLOAD}" \
  "${BACKEND_BASE_URL}/api/agent/fleet/spawn")

if [[ -z "${RESPONSE}" ]]; then
  echo "Error: empty response from backend" >&2
  exit 3
fi

echo "${RESPONSE}"
echo
echo "Next: sign the returned batched call via MetaMask Smart Accounts,"
echo "then DM the judge at ${ADDRESS} with the resulting tx hash."

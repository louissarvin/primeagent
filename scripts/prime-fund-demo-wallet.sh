#!/usr/bin/env bash
# prime-fund-demo-wallet.sh
# Funds a fresh demo wallet for the PrimeAgent buildathon recording.
#
# What it does (only):
#   1. Validates target wallet address (0x + 40 hex)
#   2. Loads DEPLOYER_PRIVATE_KEY from contracts/.env (private, never logged)
#   3. Shows current balances of deployer and target on both chains
#   4. Sends 100 MockUSDC from deployer to target on Arbitrum Sepolia (421614)
#   5. Sends 100 USDG from deployer to target on Robinhood Chain testnet (46630)
#   6. Verifies recipient balances after each tx
#   7. Prints faucet URLs for the ETH portions (cannot be automated)
#
# Usage:
#   bash scripts/prime-fund-demo-wallet.sh <fresh_demo_wallet>
#
# Safety:
#   - This script ONLY calls ERC20 transfer() on USDC and USDG.
#   - It does NOT touch any admin function, contract config, or NFT.
#   - The deployer key is loaded into a local variable and never printed.
#   - Set DRY_RUN=1 to skip the actual sends and only print the plan.

set -uo pipefail

# ---- Colour helpers ---------------------------------------------------------
if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi
PASS="${GREEN}OK${RESET}"
FAIL="${RED}FAIL${RESET}"
WARN="${YELLOW}WARN${RESET}"

hdr()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  [%s] %s\n" "$PASS" "$1"; }
bad()  { printf "  [%s] %s\n" "$FAIL" "$1"; }
warn() { printf "  [%s] %s\n" "$WARN" "$1"; }
info() { printf "  ${DIM}%s${RESET}\n" "$1"; }

# ---- Required arg -----------------------------------------------------------
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  printf "${RED}error:${RESET} target wallet address is required\n"
  printf "usage: bash scripts/prime-fund-demo-wallet.sh <fresh_demo_wallet>\n"
  exit 2
fi
if ! [[ "$TARGET" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
  printf "${RED}error:${RESET} '%s' is not a valid 0x address\n" "$TARGET"
  exit 2
fi

# ---- Required tools ---------------------------------------------------------
for tool in cast jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf "${RED}error:${RESET} '%s' is required but not on PATH\n" "$tool"
    exit 2
  fi
done

# ---- Load deployer key from contracts/.env (never logged) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/contracts/.env"

if [ ! -f "$ENV_FILE" ]; then
  printf "${RED}error:${RESET} %s not found\n" "$ENV_FILE"
  exit 2
fi

# Extract DEPLOYER_PRIVATE_KEY without sourcing the file (avoids leaking other
# values via shell history or set -x). Strip leading whitespace and quotes.
DEPLOYER_KEY=$(grep -E '^[[:space:]]*DEPLOYER_PRIVATE_KEY=' "$ENV_FILE" \
  | head -n1 \
  | sed -E 's/^[[:space:]]*DEPLOYER_PRIVATE_KEY=//' \
  | tr -d '"'"'"'' \
  | tr -d '[:space:]')
if [ -z "$DEPLOYER_KEY" ]; then
  printf "${RED}error:${RESET} DEPLOYER_PRIVATE_KEY not found in %s\n" "$ENV_FILE"
  exit 2
fi
if ! [[ "$DEPLOYER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  printf "${RED}error:${RESET} DEPLOYER_PRIVATE_KEY in contracts/.env is not a valid 0x-prefixed 64-hex key\n"
  exit 2
fi

DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_KEY" 2>/dev/null)
if [ -z "$DEPLOYER_ADDR" ]; then
  printf "${RED}error:${RESET} could not derive deployer address from key\n"
  exit 2
fi

# ---- Config -----------------------------------------------------------------
ARB_RPC="${ARB_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
RH_RPC="${RH_RPC:-https://robinhood-testnet.g.alchemy.com/v2/xFKtAKbt3X-AmvO7b-1c-}"
USDC="0x6c3AB61F5E139AFcaDB24Fd988EEf945F155B277"
USDG="0x7E955252E15c84f5768B83c41a71F9eba181802F"

# Faucet URLs the user must hit manually.
SEPOLIA_FAUCETS=(
  "https://www.alchemy.com/faucets/arbitrum-sepolia"
  "https://faucet.quicknode.com/arbitrum/sepolia"
  "https://faucets.chain.link/arbitrum-sepolia"
)
RH_FAUCETS=(
  "https://faucet.testnet.chain.robinhood.com"
)

# Demo thresholds
MIN_USDC_HUMAN=100
MIN_USDG_HUMAN=100
MIN_SEPOLIA_ETH_HUMAN=0.1
MIN_RH_ETH_HUMAN=0.05

# ---- Banner -----------------------------------------------------------------
printf "${BOLD}PrimeAgent demo wallet funding${RESET}\n"
info "target:   $TARGET"
info "deployer: $DEPLOYER_ADDR  ${DIM}(source of USDC + USDG)${RESET}"
info "ARB RPC:  $ARB_RPC"
info "RH RPC:   $RH_RPC"
if [ "${DRY_RUN:-0}" = "1" ]; then
  warn "DRY_RUN=1 — will NOT broadcast any tx"
fi

# ---- Helpers ----------------------------------------------------------------
get_decimals() {
  local token="$1" rpc="$2"
  local d
  d=$(cast call "$token" "decimals()(uint8)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}')
  echo "${d:-6}"
}

get_balance_raw() {
  local token="$1" who="$2" rpc="$3"
  local raw
  raw=$(cast call "$token" "balanceOf(address)(uint256)" "$who" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}')
  echo "${raw:-0}"
}

get_eth_wei() {
  local who="$1" rpc="$2"
  cast balance "$who" --rpc-url "$rpc" 2>/dev/null || echo 0
}

fmt_unit() {
  local raw="$1" dec="$2"
  cast --to-unit "$raw" "$dec" 2>/dev/null || echo "$raw raw"
}

fmt_eth() {
  cast --to-unit "$1" ether 2>/dev/null || echo "$1 wei"
}

# bash big-int comparison via string sort (works for arbitrary uint256)
ge_uint() {
  # returns 0 if $1 >= $2
  local a="$1" b="$2"
  [ "$(printf "%s\n%s\n" "$a" "$b" | sort -n | tail -n1)" = "$a" ]
}

# ---- Current state ----------------------------------------------------------
hdr "Current balances"
USDC_DEC=$(get_decimals "$USDC" "$ARB_RPC")
USDG_DEC=$(get_decimals "$USDG" "$RH_RPC")

dep_eth_arb=$(get_eth_wei "$DEPLOYER_ADDR" "$ARB_RPC")
dep_usdc_raw=$(get_balance_raw "$USDC" "$DEPLOYER_ADDR" "$ARB_RPC")
dep_eth_rh=$(get_eth_wei "$DEPLOYER_ADDR" "$RH_RPC")
dep_usdg_raw=$(get_balance_raw "$USDG" "$DEPLOYER_ADDR" "$RH_RPC")

tgt_eth_arb=$(get_eth_wei "$TARGET" "$ARB_RPC")
tgt_usdc_raw=$(get_balance_raw "$USDC" "$TARGET" "$ARB_RPC")
tgt_eth_rh=$(get_eth_wei "$TARGET" "$RH_RPC")
tgt_usdg_raw=$(get_balance_raw "$USDG" "$TARGET" "$RH_RPC")

printf "%-40s %-25s %-25s\n" "                                        " "DEPLOYER" "TARGET"
printf "%-40s %-25s %-25s\n" "Arb Sepolia ETH"   "$(fmt_eth $dep_eth_arb)"    "$(fmt_eth $tgt_eth_arb)"
printf "%-40s %-25s %-25s\n" "MockUSDC (chain 421614)" "$(fmt_unit $dep_usdc_raw $USDC_DEC)" "$(fmt_unit $tgt_usdc_raw $USDC_DEC)"
printf "%-40s %-25s %-25s\n" "RH Chain ETH (chain 46630)" "$(fmt_eth $dep_eth_rh)"  "$(fmt_eth $tgt_eth_rh)"
printf "%-40s %-25s %-25s\n" "USDG (chain 46630)"        "$(fmt_unit $dep_usdg_raw $USDG_DEC)" "$(fmt_unit $tgt_usdg_raw $USDG_DEC)"

# ---- Pre-flight gates -------------------------------------------------------
hdr "Pre-flight checks"

# Need deployer Sepolia ETH for the USDC transfer gas (rough: 100k gas at 0.1 gwei
# ~= 0.00001 ETH on Arb Sepolia, but factor 100x headroom).
MIN_DEP_ETH_ARB=1000000000000000   # 0.001 ETH
MIN_DEP_ETH_RH=1000000000000000    # 0.001 ETH
USDC_NEEDED=$((MIN_USDC_HUMAN * 10**USDC_DEC))
USDG_NEEDED=$((MIN_USDG_HUMAN * 10**USDG_DEC))

if ge_uint "$dep_eth_arb" "$MIN_DEP_ETH_ARB"; then
  ok "deployer has Arb Sepolia gas ($(fmt_eth $dep_eth_arb))"
else
  bad "deployer Arb Sepolia ETH too low ($(fmt_eth $dep_eth_arb), need >= 0.001 for gas)"
  exit 1
fi
if ge_uint "$dep_usdc_raw" "$USDC_NEEDED"; then
  ok "deployer has >= 100 MockUSDC"
else
  bad "deployer MockUSDC too low ($(fmt_unit $dep_usdc_raw $USDC_DEC))"
  exit 1
fi
if ge_uint "$dep_eth_rh" "$MIN_DEP_ETH_RH"; then
  ok "deployer has RH Chain gas ($(fmt_eth $dep_eth_rh))"
else
  bad "deployer RH Chain ETH too low ($(fmt_eth $dep_eth_rh), need >= 0.001 for gas)"
  exit 1
fi
if ge_uint "$dep_usdg_raw" "$USDG_NEEDED"; then
  ok "deployer has >= 100 USDG"
else
  bad "deployer USDG too low ($(fmt_unit $dep_usdg_raw $USDG_DEC))"
  exit 1
fi

# Skip transfers if already above threshold.
SEND_USDC=1
SEND_USDG=1
if ge_uint "$tgt_usdc_raw" "$USDC_NEEDED"; then
  ok "target already has >= 100 MockUSDC; skipping USDC transfer"
  SEND_USDC=0
fi
if ge_uint "$tgt_usdg_raw" "$USDG_NEEDED"; then
  ok "target already has >= 100 USDG; skipping USDG transfer"
  SEND_USDG=0
fi

# ---- Transfer USDC ----------------------------------------------------------
hdr "Transfer 100 MockUSDC on Arbitrum Sepolia (421614)"
if [ "$SEND_USDC" = "0" ]; then
  info "skipped (target already funded)"
else
  if [ "${DRY_RUN:-0}" = "1" ]; then
    info "DRY_RUN: cast send $USDC \"transfer(address,uint256)\" $TARGET $USDC_NEEDED"
  else
    if ! out=$(cast send "$USDC" "transfer(address,uint256)" "$TARGET" "$USDC_NEEDED" \
        --rpc-url "$ARB_RPC" --private-key "$DEPLOYER_KEY" --json 2>&1); then
      bad "USDC transfer failed: $out"
      exit 1
    fi
    tx=$(printf "%s" "$out" | jq -r '.transactionHash // empty' 2>/dev/null)
    status=$(printf "%s" "$out" | jq -r '.status // empty' 2>/dev/null)
    if [ -z "$tx" ]; then
      bad "USDC transfer: no transactionHash in response"
      printf "%s\n" "$out" | head -c 500
      exit 1
    fi
    if [ "$status" = "0x1" ] || [ "$status" = "1" ] || [ "$status" = "success" ]; then
      ok "USDC transfer succeeded"
    else
      warn "USDC transfer status: $status — verify on Arbiscan"
    fi
    info "tx: https://sepolia.arbiscan.io/tx/$tx"
    # Verify recipient balance.
    new_raw=$(get_balance_raw "$USDC" "$TARGET" "$ARB_RPC")
    if ge_uint "$new_raw" "$USDC_NEEDED"; then
      ok "target MockUSDC now: $(fmt_unit $new_raw $USDC_DEC)"
    else
      bad "post-transfer balance still too low: $(fmt_unit $new_raw $USDC_DEC)"
    fi
  fi
fi

# ---- Transfer USDG ----------------------------------------------------------
hdr "Transfer 100 USDG on Robinhood Chain testnet (46630)"
if [ "$SEND_USDG" = "0" ]; then
  info "skipped (target already funded)"
else
  if [ "${DRY_RUN:-0}" = "1" ]; then
    info "DRY_RUN: cast send $USDG \"transfer(address,uint256)\" $TARGET $USDG_NEEDED"
  else
    if ! out=$(cast send "$USDG" "transfer(address,uint256)" "$TARGET" "$USDG_NEEDED" \
        --rpc-url "$RH_RPC" --private-key "$DEPLOYER_KEY" --json 2>&1); then
      bad "USDG transfer failed: $out"
      exit 1
    fi
    tx=$(printf "%s" "$out" | jq -r '.transactionHash // empty' 2>/dev/null)
    status=$(printf "%s" "$out" | jq -r '.status // empty' 2>/dev/null)
    if [ -z "$tx" ]; then
      bad "USDG transfer: no transactionHash in response"
      printf "%s\n" "$out" | head -c 500
      exit 1
    fi
    if [ "$status" = "0x1" ] || [ "$status" = "1" ] || [ "$status" = "success" ]; then
      ok "USDG transfer succeeded"
    else
      warn "USDG transfer status: $status — verify on Blockscout"
    fi
    info "tx: https://explorer.testnet.chain.robinhood.com/tx/$tx"
    new_raw=$(get_balance_raw "$USDG" "$TARGET" "$RH_RPC")
    if ge_uint "$new_raw" "$USDG_NEEDED"; then
      ok "target USDG now: $(fmt_unit $new_raw $USDG_DEC)"
    else
      bad "post-transfer balance still too low: $(fmt_unit $new_raw $USDG_DEC)"
    fi
  fi
fi

# ---- ETH portion (faucets only) ---------------------------------------------
hdr "ETH funding (manual — cannot be auto-funded by this script)"

if ge_uint "$tgt_eth_arb" "100000000000000000"; then
  ok "target Arb Sepolia ETH: $(fmt_eth $tgt_eth_arb) (>= 0.1)"
else
  warn "target Arb Sepolia ETH: $(fmt_eth $tgt_eth_arb) — need >= 0.1"
  printf "  faucet options:\n"
  for f in "${SEPOLIA_FAUCETS[@]}"; do printf "    %s\n" "$f"; done
fi
if ge_uint "$tgt_eth_rh" "50000000000000000"; then
  ok "target RH Chain ETH: $(fmt_eth $tgt_eth_rh) (>= 0.05)"
else
  warn "target RH Chain ETH: $(fmt_eth $tgt_eth_rh) — need >= 0.05"
  printf "  faucet:\n"
  for f in "${RH_FAUCETS[@]}"; do printf "    %s\n" "$f"; done
  info "If no public faucet exists, bridge from Arb Sepolia or ask the team for testnet ETH."
fi

# ---- Final summary ----------------------------------------------------------
hdr "Next step"
printf "Run preflight against the funded wallet:\n"
printf "  ${BOLD}bash scripts/prime-preflight.sh %s${RESET}\n" "$TARGET"

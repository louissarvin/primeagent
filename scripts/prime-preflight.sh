#!/usr/bin/env bash
# prime-preflight.sh
# Verifies every prerequisite for recording the PrimeAgent demo (DEMOSCRIPT.md Part 2).
#
# Checks:
#   1. Backend on :3700 reachable, /health ready:true (covers DB + attestor + parity)
#   2. Web on :3200 reachable
#   3. Contracts deployed (Factory, McpAttestor, MarginEngine on Arb Sepolia;
#      RhChainSwap on RH Chain testnet)
#   4. Demo wallet has enough Sepolia ETH + MockUSDC on 421614
#   5. Demo wallet has enough RH Chain ETH + USDG on 46630
#   6. Attestor cron is live (latest attest tx on Blockscout less than 90s old)
#   7. Prints the Arbiscan tab URL the presenter should pre-stage
#
# Usage:
#   bash scripts/prime-preflight.sh <demo_wallet_address>
#
# Exit codes:
#   0 = all green, safe to record
#   1 = at least one P0 check failed
#   2 = missing required argument or tool

set -uo pipefail

# ---- Colour helpers ---------------------------------------------------------
if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi

PASS="${GREEN}PASS${RESET}"
FAIL="${RED}FAIL${RESET}"
WARN="${YELLOW}WARN${RESET}"

fails=0
warns=0

ok()   { printf "  [%s] %s\n" "$PASS" "$1"; }
bad()  { printf "  [%s] %s\n" "$FAIL" "$1"; fails=$((fails + 1)); }
warn() { printf "  [%s] %s\n" "$WARN" "$1"; warns=$((warns + 1)); }
hdr()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }
info() { printf "  ${DIM}%s${RESET}\n" "$1"; }

# ---- Required args ----------------------------------------------------------
WALLET="${1:-}"
if [ -z "$WALLET" ]; then
  printf "${RED}error:${RESET} demo wallet address is required\n"
  printf "usage: bash scripts/prime-preflight.sh <demo_wallet_address>\n"
  exit 2
fi
if ! [[ "$WALLET" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
  printf "${RED}error:${RESET} '%s' is not a valid 0x address\n" "$WALLET"
  exit 2
fi

# ---- Required tools ---------------------------------------------------------
need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "${RED}error:${RESET} '%s' is required but not on PATH\n" "$1"
    exit 2
  fi
}
need_tool curl
need_tool jq

HAS_CAST=1
if ! command -v cast >/dev/null 2>&1; then
  HAS_CAST=0
fi

# ---- Config -----------------------------------------------------------------
BACKEND_URL="${BACKEND_URL:-http://localhost:3700}"
WEB_URL="${WEB_URL:-http://localhost:3200}"

ARB_SEPOLIA_RPC="${ARB_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
RH_CHAIN_RPC="${RH_CHAIN_RPC:-https://rpc.testnet.chain.robinhood.com}"

# Arbitrum Sepolia 421614
FACTORY="0x8235890d157f7c67ED6bcD42b0C2137942b8bA38"
MCP_ATTESTOR="0x6a31469E1Aef69cEc8466399D94456AD4555AD41"
MARGIN_ENGINE="0x43d0c3365fdf1706bd1236d14502890278bd0cd9"
# Mock USDC used by AgentVault as baseAsset on Sepolia. See contracts/README.md.
MOCK_USDC="0x6c3AB61F5E139AFcaDB24Fd988EEf945F155B277"

# Robinhood Chain testnet 46630
RH_CHAIN_SWAP="0xe0E0dbe2Ec2e1107310cB5e4842F8D35AE4314B3"
USDG="0x7E955252E15c84f5768B83c41a71F9eba181802F"

# Thresholds (DEMOSCRIPT pre-flight checklist)
MIN_SEPOLIA_ETH_WEI=100000000000000000   # 0.1 ETH
MIN_RH_CHAIN_ETH_WEI=50000000000000000   # 0.05 ETH
MIN_USDC=100000000                       # 100 USDC (6 decimals)
MIN_USDG=100000000                       # 100 USDG (6 decimals)

# Blockscout API for Arbitrum Sepolia
BLOCKSCOUT_API="https://arbitrum-sepolia.blockscout.com/api/v2"

ATTESTOR_ARBISCAN_URL="https://sepolia.arbiscan.io/address/${MCP_ATTESTOR}"

printf "${BOLD}PrimeAgent demo pre-flight${RESET}\n"
info "wallet:  $WALLET"
info "backend: $BACKEND_URL"
info "web:     $WEB_URL"

# ---- 1. Backend health ------------------------------------------------------
hdr "1. Backend health"
health_body=$(curl -fsS --max-time 5 "$BACKEND_URL/health" 2>/dev/null || true)
agent_total=0   # used later by attestor freshness check
if [ -z "$health_body" ]; then
  bad "backend unreachable at $BACKEND_URL/health"
else
  ready=$(printf "%s" "$health_body" | jq -r '.ready // .data.ready // empty' 2>/dev/null)
  if [ "$ready" = "true" ]; then
    ok "backend /health ready:true"
  else
    bad "backend /health did not return ready:true (got: $(printf "%s" "$health_body" | head -c 200))"
  fi

  # Sub-checks (the real /health envelope nests them under .checks).
  db_ok=$(printf "%s" "$health_body" | jq -r '.checks.db.ok // empty' 2>/dev/null)
  db_ms=$(printf "%s" "$health_body" | jq -r '.checks.db.latencyMs // empty' 2>/dev/null)
  if [ "$db_ok" = "true" ]; then
    ok "Postgres reachable (${db_ms}ms)"
  elif [ -n "$db_ok" ]; then
    bad "Postgres /health says ok:false"
  fi

  att_ok=$(printf "%s" "$health_body" | jq -r '.checks.attestor.ok // empty' 2>/dev/null)
  att_cfg=$(printf "%s" "$health_body" | jq -r '.checks.attestor.configured // empty' 2>/dev/null)
  att_signer=$(printf "%s" "$health_body" | jq -r '.checks.attestor.signerAddress // empty' 2>/dev/null)
  if [ "$att_ok" = "true" ] && [ "$att_cfg" = "true" ]; then
    ok "Attestor configured (signer: $att_signer)"
  elif [ -n "$att_ok" ]; then
    bad "Attestor not configured (ok:$att_ok configured:$att_cfg)"
  fi

  idx_ok=$(printf "%s" "$health_body" | jq -r '.checks.indexer.ok // empty' 2>/dev/null)
  idx_subs=$(printf "%s" "$health_body" | jq -r '.checks.indexer.subscriptions // empty' 2>/dev/null)
  if [ "$idx_ok" = "true" ]; then
    ok "On-chain indexer alive (${idx_subs} subscriptions)"
  elif [ -n "$idx_ok" ]; then
    bad "Indexer reports ok:false"
  fi

  parity=$(printf "%s" "$health_body" | jq -r '.checks.attestorParity.arbSepolia // empty' 2>/dev/null)
  if [ "$parity" = "ok" ]; then
    ok "Attestor parity (Arb Sepolia): on-chain attestor() matches signer"
  elif [ -n "$parity" ]; then
    bad "Attestor parity (Arb Sepolia): $parity"
  fi

  agent_total=$(printf "%s" "$health_body" | jq -r '.checks.agents.total // 0' 2>/dev/null)
  agent_total="${agent_total:-0}"
  info "agents in DB: $agent_total"
fi

# ---- 2. Web reachable -------------------------------------------------------
hdr "2. Web dev server"
web_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$WEB_URL/" 2>/dev/null || true)
web_code="${web_code:-000}"
if [ "$web_code" = "200" ]; then
  ok "web responding 200 at $WEB_URL/"
elif [ "$web_code" = "000" ]; then
  bad "web unreachable at $WEB_URL"
else
  warn "web at $WEB_URL returned HTTP $web_code (may still work if SSR redirects)"
fi

# ---- 3. Contracts deployed --------------------------------------------------
hdr "3. Contracts deployed"
if [ "$HAS_CAST" -eq 0 ]; then
  warn "'cast' not on PATH; skipping on-chain checks. Install Foundry: https://book.getfoundry.sh/getting-started/installation"
else
  check_code() {
    local label="$1" addr="$2" rpc="$3"
    # Up to 3 attempts because the public RH Chain testnet RPC flakes
    # intermittently. A single empty response is not enough to declare
    # a contract missing.
    local code=""
    local attempt
    for attempt in 1 2 3; do
      code=$(cast code "$addr" --rpc-url "$rpc" 2>/dev/null || echo "")
      if [ -n "$code" ] && [ "$code" != "0x" ]; then
        break
      fi
      sleep 1
    done
    if [ -n "$code" ] && [ "$code" != "0x" ]; then
      ok "$label deployed at $addr"
    else
      bad "$label has no code at $addr after 3 attempts (chain: $rpc)"
    fi
  }
  check_code "Factory"       "$FACTORY"       "$ARB_SEPOLIA_RPC"
  check_code "McpAttestor"   "$MCP_ATTESTOR"  "$ARB_SEPOLIA_RPC"
  check_code "MarginEngine"  "$MARGIN_ENGINE" "$ARB_SEPOLIA_RPC"
  check_code "MockUSDC"      "$MOCK_USDC"     "$ARB_SEPOLIA_RPC"
  check_code "RhChainSwap"   "$RH_CHAIN_SWAP" "$RH_CHAIN_RPC"
  check_code "USDG"          "$USDG"          "$RH_CHAIN_RPC"
fi

# ---- 4. Demo wallet on Arb Sepolia ------------------------------------------
hdr "4. Demo wallet on Arbitrum Sepolia (421614)"
if [ "$HAS_CAST" -eq 0 ]; then
  warn "skipping (no cast)"
else
  eth_wei=$(cast balance "$WALLET" --rpc-url "$ARB_SEPOLIA_RPC" 2>/dev/null || echo 0)
  if [ -z "$eth_wei" ] || [ "$eth_wei" = "0" ]; then
    bad "Sepolia ETH balance: 0 (need >= 0.1 ETH)"
  elif [ "$(printf "%s\n%s\n" "$eth_wei" "$MIN_SEPOLIA_ETH_WEI" | sort -n | head -n1)" = "$MIN_SEPOLIA_ETH_WEI" ]; then
    eth_human=$(cast --to-unit "$eth_wei" ether 2>/dev/null || echo "$eth_wei wei")
    ok "Sepolia ETH balance: $eth_human (>= 0.1)"
  else
    eth_human=$(cast --to-unit "$eth_wei" ether 2>/dev/null || echo "$eth_wei wei")
    bad "Sepolia ETH balance: $eth_human (need >= 0.1 ETH)"
  fi

  usdc_raw=$(cast call "$MOCK_USDC" "balanceOf(address)(uint256)" "$WALLET" --rpc-url "$ARB_SEPOLIA_RPC" 2>/dev/null | awk '{print $1}' || echo 0)
  usdc_raw="${usdc_raw:-0}"
  if [ "$(printf "%s\n%s\n" "$usdc_raw" "$MIN_USDC" | sort -n | head -n1)" = "$MIN_USDC" ]; then
    usdc_human=$(cast --to-unit "$usdc_raw" 6 2>/dev/null || echo "$usdc_raw raw")
    ok "MockUSDC balance: $usdc_human (>= 100)"
  else
    usdc_human=$(cast --to-unit "$usdc_raw" 6 2>/dev/null || echo "$usdc_raw raw")
    bad "MockUSDC balance: $usdc_human (need >= 100 USDC). Mint at MockUSDC=$MOCK_USDC."
  fi
fi

# ---- 5. Demo wallet on RH Chain testnet -------------------------------------
hdr "5. Demo wallet on Robinhood Chain testnet (46630)"
if [ "$HAS_CAST" -eq 0 ]; then
  warn "skipping (no cast)"
else
  rh_eth_wei=$(cast balance "$WALLET" --rpc-url "$RH_CHAIN_RPC" 2>/dev/null || echo 0)
  rh_eth_wei="${rh_eth_wei:-0}"
  if [ "$(printf "%s\n%s\n" "$rh_eth_wei" "$MIN_RH_CHAIN_ETH_WEI" | sort -n | head -n1)" = "$MIN_RH_CHAIN_ETH_WEI" ]; then
    rh_eth_human=$(cast --to-unit "$rh_eth_wei" ether 2>/dev/null || echo "$rh_eth_wei wei")
    ok "RH Chain ETH balance: $rh_eth_human (>= 0.05)"
  else
    rh_eth_human=$(cast --to-unit "$rh_eth_wei" ether 2>/dev/null || echo "$rh_eth_wei wei")
    bad "RH Chain ETH balance: $rh_eth_human (need >= 0.05 ETH for gas on chain 46630)"
  fi

  usdg_raw=$(cast call "$USDG" "balanceOf(address)(uint256)" "$WALLET" --rpc-url "$RH_CHAIN_RPC" 2>/dev/null | awk '{print $1}' || echo 0)
  usdg_raw="${usdg_raw:-0}"
  if [ "$(printf "%s\n%s\n" "$usdg_raw" "$MIN_USDG" | sort -n | head -n1)" = "$MIN_USDG" ]; then
    usdg_human=$(cast --to-unit "$usdg_raw" 6 2>/dev/null || echo "$usdg_raw raw")
    ok "USDG balance: $usdg_human (>= 100)"
  else
    usdg_human=$(cast --to-unit "$usdg_raw" 6 2>/dev/null || echo "$usdg_raw raw")
    bad "USDG balance: $usdg_human (need >= 100 USDG on chain 46630). Token=$USDG."
  fi
fi

# ---- 6. Attestor cron freshness (Blockscout) --------------------------------
hdr "6. Attestor cron freshness"
# Pre-mint, the cron has zero AgentPolicy rows to iterate, so no on-chain tx
# is expected. Stale Blockscout state is INFORMATIONAL until at least one
# agent exists in the DB.
attest_json=$(curl -fsS --max-time 8 "$BLOCKSCOUT_API/addresses/$MCP_ATTESTOR/transactions?filter=to" 2>/dev/null || true)
if [ -z "$attest_json" ]; then
  warn "Blockscout API unreachable; could not verify attestor freshness. Open $ATTESTOR_ARBISCAN_URL manually."
else
  last_ts=$(printf "%s" "$attest_json" | jq -r '.items[0].timestamp // empty' 2>/dev/null)
  if [ -z "$last_ts" ] || [ "$last_ts" = "null" ]; then
    if [ "$agent_total" = "0" ]; then
      info "no on-chain attest tx yet (expected: 0 agents in DB. Will fire <=60s after first mint.)"
    else
      bad "no transactions found on McpAttestor $MCP_ATTESTOR (cron may be down)"
    fi
  else
    if last_epoch=$(date -d "$last_ts" +%s 2>/dev/null); then
      :
    elif last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_ts%.*}" +%s 2>/dev/null); then
      :
    else
      last_epoch=""
    fi
    if [ -z "$last_epoch" ]; then
      warn "found tx but could not parse timestamp '$last_ts'. Inspect manually."
    else
      now=$(date +%s)
      age=$((now - last_epoch))
      if [ "$age" -le 90 ]; then
        ok "last attestor tx ${age}s ago (cron alive)"
      elif [ "$age" -le 300 ]; then
        warn "last attestor tx ${age}s ago (within 5min grace; cron may be slow)"
      elif [ "$agent_total" = "0" ]; then
        info "last attestor tx ${age}s ago. 0 agents in DB so cron has nothing to post; fresh tx will fire <=60s after first mint."
      else
        bad "last attestor tx ${age}s ago (>5min with ${agent_total} agent(s) in DB; cron stalled. Restart backend.)"
      fi
    fi
  fi
fi

# ---- 7. Pre-stage Arbiscan tab ---------------------------------------------
hdr "7. Pre-stage Arbiscan tab"
info "Open this URL in a browser tab BEFORE recording so Scene 4 can cut to it:"
info "  $ATTESTOR_ARBISCAN_URL"

# ---- Summary ----------------------------------------------------------------
hdr "Summary"
if [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then
  printf "${GREEN}${BOLD}All green. Safe to record.${RESET}\n"
  exit 0
elif [ "$fails" -eq 0 ]; then
  printf "${YELLOW}${BOLD}%d warning(s), 0 failures. Demo can record but inspect warnings above.${RESET}\n" "$warns"
  exit 0
else
  printf "${RED}${BOLD}%d failure(s), %d warning(s). Do NOT record yet.${RESET}\n" "$fails" "$warns"
  exit 1
fi

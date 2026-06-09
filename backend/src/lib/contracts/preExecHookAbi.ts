/**
 * Feature J: PrimeAgentPreExecHook ABI fragment.
 *
 * The hook is the on-chain enforcement gate the strategy executor simulates
 * against via viem `simulateContract`. Custom errors are declared so viem
 * decodes them into `shortMessage` on revert; the executor surfaces these
 * verbatim to the operator (Feature J definition-of-done).
 *
 * Source: `contracts/src/modules/PrimeAgentPreExecHook.sol:70` per the
 * Feature J research memo. Backend build notes TODO #4 calls this out as a
 * placeholder pending canonical ABI; we keep the surface narrow (preCheck
 * + the five typed errors) so a future ABI bump only adds, never breaks.
 */

export const PRIME_AGENT_PRE_EXEC_HOOK_ABI = [
  {
    type: 'function',
    name: 'preCheck',
    stateMutability: 'view',
    inputs: [
      { name: 'kernel', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'error',
    name: 'ContractNotAllowed',
    inputs: [{ name: 'target', type: 'address' }],
  },
  {
    type: 'error',
    name: 'SelectorNotAllowed',
    inputs: [{ name: 'selector', type: 'bytes4' }],
  },
  {
    type: 'error',
    name: 'NotionalCapExceeded',
    inputs: [
      { name: 'requested', type: 'uint256' },
      { name: 'cap', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'DailyCapExceeded',
    inputs: [
      { name: 'requested', type: 'uint256' },
      { name: 'remaining', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'PolicyExpired',
    inputs: [{ name: 'expiredAt', type: 'uint64' }],
  },
] as const;

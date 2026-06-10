/**
 * PriceOraclePoster worker. Per PrimeAgent.md section 7.13.bis.
 *
 * Every 60 seconds, for each configured asset:
 *   1) Compute a deterministic-jittered priceQ96 (testnet placeholder; the
 *      production swap-in is a real feed).
 *   2) Read `signerSetEpoch` from PriceOracle (cached, invalidated by the
 *      indexer's `SignerSetEpochBumped` event listener).
 *   3) Sign the EIP-712 `Price(address,uint256,uint64,uint64)` typed-data
 *      with each of the 3+ price signer keys.
 *   4) Submit `postPrices(asset, [p,p,p], [ts,ts,ts], [s1,s2,s3])` via the
 *      attestor wallet client, with a Timeboost-aware `maxPriorityFeePerGas`.
 *
 * Per-asset failures are caught and logged; the worker continues to the
 * next asset. Structured logging via `forSvc('priceOraclePoster')`.
 */

import cron from 'node-cron';
import { type Address, type Hex, getAddress, sha256 as viemSha256, stringToHex } from 'viem';

import {
  ARB_SEPOLIA_CHAIN_ID,
  type SupportedChainId,
  getAttestorWalletClient,
  getPriceSignerAccounts,
  getPublicClient,
} from '../lib/viem.ts';
import { PRICE_ORACLE_ABI } from '../lib/contracts/abis.ts';
import { getContractAddress } from '../lib/contracts/addresses.ts';
import { usdToQ96 } from '../lib/units.ts';
import { signTypedDataWith } from '../lib/eip712.ts';
import { currentPriorityTipWei } from '../services/arbGasInfo.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('priceOraclePoster');

const SCHEDULE = '*/1 * * * *';
const PRICE_TYPES = {
  Price: [
    { name: 'asset', type: 'address' },
    { name: 'priceQ96', type: 'uint256' },
    { name: 'ts', type: 'uint64' },
    { name: 'signerSetEpoch', type: 'uint64' },
  ],
} as const;

let isRunning = false;
let disabledLogged = false;

// signerSetEpoch cache. The indexer's SignerSetEpochBumped watcher calls
// `invalidateSignerSetEpoch` to bust this. Keeps `postPrices` cheap on hot
// ticks without missing an epoch bump.
const epochCache = new Map<SupportedChainId, bigint>();

export function invalidateSignerSetEpoch(chainId?: SupportedChainId): void {
  if (typeof chainId === 'undefined') {
    epochCache.clear();
    log.info('signerSetEpoch cache cleared (all chains)');
    return;
  }
  epochCache.delete(chainId);
  log.info({ chainId }, 'signerSetEpoch cache invalidated');
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envChainId(name: string, fallback: SupportedChainId): SupportedChainId {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (n === 421614 || n === 46630) return n as SupportedChainId;
  return fallback;
}

function parseAssetList(csv: string): Address[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
    .map((s) => getAddress(s));
}

function truncateStack(err: unknown): string {
  const e = err as Error;
  const msg = e?.message ?? String(err);
  return msg.length > 400 ? `${msg.slice(0, 400)}...` : msg;
}

function deterministicJitter(asset: Address): number {
  const fiveMinSlot = Math.floor(Date.now() / 1000 / 300);
  const input = `${asset.toLowerCase()}|${fiveMinSlot}`;
  const hashHex = viemSha256(stringToHex(input));
  const sample = parseInt(hashHex.slice(2, 8), 16);
  return sample / 0xffffff;
}

async function readSignerSetEpoch(
  chainId: SupportedChainId,
  priceOracleAddress: Address,
): Promise<bigint> {
  const cached = epochCache.get(chainId);
  if (typeof cached !== 'undefined') return cached;

  const publicClient = getPublicClient(chainId);
  const epoch = (await publicClient.readContract({
    address: priceOracleAddress,
    abi: PRICE_ORACLE_ABI,
    functionName: 'signerSetEpoch',
  })) as bigint;

  epochCache.set(chainId, epoch);
  return epoch;
}

async function tickForAsset(
  asset: Address,
  chainId: SupportedChainId,
  basePriceUsd: number,
): Promise<void> {
  const publicClient = getPublicClient(chainId);
  const priceOracleAddress = getContractAddress(chainId, 'priceOracle');
  const signers = getPriceSignerAccounts();

  const signerSetEpoch = await readSignerSetEpoch(chainId, priceOracleAddress);

  const jitter = deterministicJitter(asset);
  const usdPrice = basePriceUsd * (0.98 + 0.04 * jitter);
  const priceQ96 = usdToQ96(usdPrice);
  const ts = BigInt(Math.floor(Date.now() / 1000));

  const domain = {
    name: 'PrimeAgent.PriceOracle',
    version: '1',
    chainId,
    verifyingContract: priceOracleAddress,
  } as const;

  const message = { asset, priceQ96, ts, signerSetEpoch };

  const usedSigners = signers.slice(0, 3);
  const sigs: Hex[] = [];
  for (const s of usedSigners) {
    const sig = await signTypedDataWith(
      s as unknown as Parameters<typeof signTypedDataWith>[0],
      domain,
      PRICE_TYPES,
      'Price',
      message,
    );
    sigs.push(sig);
  }

  const prices = sigs.map(() => priceQ96);
  const timestamps = sigs.map(() => ts);

  const walletClient = getAttestorWalletClient(chainId);
  const senderAccount = walletClient.account;
  if (!senderAccount) {
    log.warn({ chainId }, 'wallet client has no account; skipping');
    return;
  }

  try {
    const { request } = await publicClient.simulateContract({
      address: priceOracleAddress,
      abi: PRICE_ORACLE_ABI,
      functionName: 'postPrices',
      args: [asset, prices, timestamps, sigs],
      account: senderAccount,
    });
    // Cast: simulateContract returns a legacy-typed request; viem accepts
    // eip1559 fee fields at write time. See attestPoster.ts for context.
    // Wave E1: dynamic priority tip via ArbGasInfo precompile reader.
    const tip = await currentPriorityTipWei(chainId);
    const writeArgs =
      tip > 0n
        ? ({ ...request, type: 'eip1559', maxPriorityFeePerGas: tip } as unknown as typeof request)
        : request;
    const txHash = await walletClient.writeContract(writeArgs);
    log.info(
      {
        chainId,
        txHash,
        oracle_signers: usedSigners.length,
        data: { asset, priceQ96: priceQ96.toString() },
      },
      'postPrices submitted',
    );
  } catch (err) {
    log.error(
      {
        chainId,
        err_class: (err as Error)?.name,
        data: { asset },
      },
      `postPrices failed: ${truncateStack(err)}`,
    );
  }
}

async function tick(): Promise<void> {
  if (isRunning) {
    log.debug('previous run still active, skipping');
    return;
  }
  isRunning = true;
  try {
    const chainId = envChainId('PRICE_CHAIN_ID', ARB_SEPOLIA_CHAIN_ID);
    const assets = parseAssetList(envString('BACKEND_PRICE_ASSETS_ARB_SEPOLIA', ''));
    const basePriceUsd = Number(envString('BACKEND_PRICE_BASE_USD_DEFAULT', '100'));

    if (assets.length === 0) {
      if (!disabledLogged) {
        log.info({ chainId }, 'disabled (no assets configured)');
        disabledLogged = true;
      }
      return;
    }

    let signers;
    try {
      signers = getPriceSignerAccounts();
    } catch (err) {
      if (!disabledLogged) {
        log.info(
          { chainId, err_class: (err as Error)?.name },
          `disabled (signer key error): ${truncateStack(err)}`,
        );
        disabledLogged = true;
      }
      return;
    }
    if (signers.length < 3) {
      if (!disabledLogged) {
        log.info({ chainId, oracle_signers: signers.length }, 'disabled (need >=3 signer keys)');
        disabledLogged = true;
      }
      return;
    }

    for (const asset of assets) {
      try {
        await tickForAsset(asset, chainId, basePriceUsd);
      } catch (err) {
        log.error(
          { chainId, data: { asset }, err_class: (err as Error)?.name },
          `asset tick failed: ${truncateStack(err)}`,
        );
      }
    }
  } catch (err) {
    log.error({ err_class: (err as Error)?.name }, `tick error: ${truncateStack(err)}`);
  } finally {
    isRunning = false;
  }
}

export function startPriceOraclePosterWorker(): void {
  log.info('priceOraclePoster scheduled');
  cron.schedule(SCHEDULE, tick);
}

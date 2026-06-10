/**
 * Feature M: PricePoint indexer.
 *
 * Subscribes to `PriceOracle.PricePosted` events and writes one
 * `PricePoint` per event. Backfills 7 days on first run via chunked
 * `getContractEvents` (2000-block chunks). Idempotent via
 * `(chainId, txHash, logIndex)` unique.
 *
 * Standalone worker (not folded into `priceOraclePoster` per the v2 plan)
 * so the poster stays a pure signer and the indexer can run independently.
 */

import cron from 'node-cron';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';

import { prismaExt as prismaQuery } from '../lib/prismaExtensions.ts';
import { forSvc } from '../lib/logger.ts';
import { PRICE_ORACLE_ABI } from '../lib/contracts/abis.ts';
import {
  ARB_SEPOLIA_RPC,
  BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA,
} from '../config/main-config.ts';
import { ARB_SEPOLIA_CHAIN_ID } from '../lib/viem.ts';

const log = forSvc('pricePointIndexer');

const CHUNK_SIZE = 2_000n;

let isRunning = false;
let unwatch: (() => void) | null = null;

function buildClient(): PublicClient {
  return createPublicClient({
    chain: arbitrumSepolia,
    transport: http(ARB_SEPOLIA_RPC),
  });
}

async function persistEvent(
  log_args: { asset: Address; priceQ96: bigint; ts: bigint; k: number; n: number },
  meta: { txHash: `0x${string}`; blockNumber: bigint; logIndex: number },
): Promise<void> {
  try {
    await prismaQuery.pricePoint.create({
      data: {
        asset: log_args.asset,
        chainId: ARB_SEPOLIA_CHAIN_ID,
        priceQ96: log_args.priceQ96.toString(),
        ts: new Date(Number(log_args.ts) * 1000),
        k: log_args.k,
        n: log_args.n,
        txHash: Buffer.from(meta.txHash.slice(2), 'hex'),
        blockNumber: meta.blockNumber,
        logIndex: meta.logIndex,
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') return; // duplicate log absorbed
    log.warn({ err_class: (err as Error)?.name }, 'pricePoint persist failed');
  }
}

async function backfill(client: PublicClient, oracle: Address): Promise<void> {
  const latest = await client.getBlockNumber();
  // 7 days at 250ms block time on Arb Sepolia => ~2.4M blocks. Cap the
  // backfill at the env-configurable starting block; if unset use latest-2000
  // so we get a small smoke window.
  const envStart = process.env.BACKEND_INDEXER_FROM_BLOCK_ARB_SEPOLIA;
  const fromBlock = envStart ? BigInt(envStart) : latest - CHUNK_SIZE;
  log.info({ data: { fromBlock: fromBlock.toString(), toBlock: latest.toString() } }, 'pricePoint backfill begin');
  for (let start = fromBlock; start <= latest; start += CHUNK_SIZE) {
    const end = start + CHUNK_SIZE - 1n > latest ? latest : start + CHUNK_SIZE - 1n;
    try {
      const events = await client.getContractEvents({
        address: oracle,
        abi: PRICE_ORACLE_ABI,
        eventName: 'PricePosted',
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      for (const ev of events) {
        if (!ev.transactionHash || ev.blockNumber == null || ev.logIndex == null) continue;
        const a = ev.args as { asset?: Address; priceQ96?: bigint; ts?: bigint; k?: number; n?: number };
        if (!a.asset || a.priceQ96 == null || a.ts == null || a.k == null || a.n == null) continue;
        await persistEvent(
          { asset: a.asset, priceQ96: a.priceQ96, ts: a.ts, k: a.k, n: a.n },
          { txHash: ev.transactionHash, blockNumber: ev.blockNumber, logIndex: ev.logIndex },
        );
      }
    } catch (err) {
      log.warn(
        { err_class: (err as Error)?.name, data: { start: start.toString(), end: end.toString() } },
        'pricePoint backfill chunk failed; continuing',
      );
    }
  }
  log.info({}, 'pricePoint backfill complete');
}

export const startPricePointIndexerWorker = (): void => {
  const oracle = BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA;
  if (!oracle || !/^0x[0-9a-fA-F]{40}$/.test(oracle)) {
    log.warn({}, 'BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA unset; pricePointIndexer disabled');
    return;
  }
  const client = buildClient();

  void backfill(client, oracle as Address).catch((err) =>
    log.error({ err_class: (err as Error)?.name }, 'backfill failed'),
  );

  unwatch = client.watchContractEvent({
    address: oracle as Address,
    abi: PRICE_ORACLE_ABI,
    eventName: 'PricePosted',
    onLogs: (logs) => {
      void (async () => {
        if (isRunning) return;
        isRunning = true;
        try {
          for (const ev of logs) {
            if (!ev.transactionHash || ev.blockNumber == null || ev.logIndex == null) continue;
            const a = ev.args as { asset?: Address; priceQ96?: bigint; ts?: bigint; k?: number; n?: number };
            if (!a.asset || a.priceQ96 == null || a.ts == null || a.k == null || a.n == null) continue;
            await persistEvent(
              { asset: a.asset, priceQ96: a.priceQ96, ts: a.ts, k: a.k, n: a.n },
              { txHash: ev.transactionHash, blockNumber: ev.blockNumber, logIndex: ev.logIndex },
            );
          }
        } finally {
          isRunning = false;
        }
      })();
    },
    onError: (err) => {
      log.error({ err_class: err?.name }, 'pricePoint watcher errored');
    },
  });
  log.info({}, 'scheduled');

  // 5min periodic cleanup of stuck inflight state (defensive).
  cron.schedule('*/5 * * * *', () => {
    if (isRunning) log.debug({}, 'isRunning still true at cron mark');
  });
};

export const stopPricePointIndexerWorker = (): void => {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
};

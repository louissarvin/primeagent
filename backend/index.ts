import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import { APP_PORT, IS_PROD, PUBLIC_ORIGIN, LANGGRAPH_PG_URL } from './src/config/main-config.ts';
import { logger } from './src/lib/logger.ts';
import { runBootGuards } from './src/lib/attestorBoot.ts';
import { startOnchainIndexer } from './src/workers/onchainIndexer.ts';
import { stopAllAgents } from './src/agent/runtime.ts';
import { closeAllMcpClients } from './src/mcp/clientPool.ts';
// Import the loop + risk callbacks so their `register*Handler` side effects
// run at boot. The runtime expects both handlers to be registered before
// `startAgent` is called (Wave C dispatches that from the route layer).
import './src/agent/loop.ts';
import './src/agent/riskCallbacks.ts';

// Routes
import { siweRoutes } from './src/routes/auth/siwe.ts';
import { oauthRoutes } from './src/routes/auth/oauth.ts';
import { mcpRoutes } from './src/mcp/server.ts';
import { agentRoutes } from './src/routes/agentRoutes.ts';
import { agentChatRoutes } from './src/routes/agentChatRoutes.ts';
import { agentActionsRoutes } from './src/routes/agentActionsRoutes.ts';
import { agentProposalsRoutes } from './src/routes/agentProposalsRoutes.ts';
import { agentPolicyRoutes } from './src/routes/agentPolicyRoutes.ts';
import { agentFleetRoutes } from './src/routes/agentFleetRoutes.ts';
import { pnlRoutes } from './src/routes/pnlRoutes.ts';
import { paymasterRoutes } from './src/routes/paymasterRoutes.ts';
import { opsRoutes } from './src/routes/opsRoutes.ts';
import { rhChainRoutes } from './src/routes/rhChainRoutes.ts';
// Wave J-Q new routes
import { agentStrategyRoutes } from './src/routes/agentStrategyRoutes.ts';
import { agentSimulatorRoutes } from './src/routes/agentSimulatorRoutes.ts';
import { agentAuditRoutes } from './src/routes/agentAuditRoutes.ts';
import { fxRoutes } from './src/routes/fxRoutes.ts';

// Middlewares
import { registerSecurity } from './src/middlewares/security.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startAttestPosterWorker } from './src/workers/attestPoster.ts';
import { startPriceOraclePosterWorker } from './src/workers/priceOraclePoster.ts';
import { startTokenRefresherWorker } from './src/workers/tokenRefresher.ts';
import { startSiweNonceCleanupWorker } from './src/workers/siweNonceCleanup.ts';
import { startCircuitBreakerWorker } from './src/workers/circuitBreaker.ts';
import { startStylusHealthCheckWorker } from './src/workers/stylusHealthCheck.ts';
import { startReputationFeedbackWorker } from './src/workers/reputationFeedback.ts';
import { startTriggerWatcherWorker } from './src/workers/triggerWatcher.ts';
import { startPricePointIndexerWorker } from './src/workers/pricePointIndexer.ts';
import { assertPresetHashes } from './src/agent/risk/presets.ts';
import { startWebhookEmitter } from './src/services/webhookEmitter.ts';
import { flushErrorLogs } from './src/utils/errorHandler.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  logger: false,
});

// Security (helmet + rate-limit) MUST be registered before any other
// plugin so the headers and global rate limiter apply to every route,
// including cors preflight responses.
await registerSecurity(fastify);

// Wave C1: CORS allowlist. Production rejects unknown origins; dev keeps a
// permissive fallback so localhost-on-any-port works during development.
//
// `PUBLIC_ORIGIN` may be a comma-separated list (mirroring the MCP origin
// allowlist convention in src/mcp/server.ts).
const corsAllowlist = PUBLIC_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

// Fastify CORS OriginFunction signature: `(origin, callback)` where callback
// is `(err, allow)`. Documented at
// https://github.com/fastify/fastify-cors#async-cors
fastify.register(FastifyCors, {
  origin: IS_PROD
    ? async (origin: string | undefined): Promise<boolean> => {
        if (!origin) return true; // server-to-server / curl
        return corsAllowlist.includes(origin);
      }
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  // `Last-Event-ID` is sent by EventSource / SSE on reconnect so the server
  // can resume from the last seen sequence id; the browser requires the
  // server to allow it explicitly via CORS preflight.
  allowedHeaders: ['Content-Type', 'Authorization', 'token', 'Last-Event-ID'],
});

// Root redirects to the canonical /health probe; the dedicated route is
// supplied by `opsRoutes`. We keep `/` as a 302 so existing dashboards or
// uptime checks pointed at the bare host stay functional.
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.redirect('/health', 302);
});

// Register routes with prefixes
// Example: fastify.register(adminRoutes, { prefix: '/admin' })
// Example: fastify.register(userRoutes, { prefix: '/user' })
fastify.register(opsRoutes);
fastify.register(siweRoutes, { prefix: '/auth/siwe' });
fastify.register(oauthRoutes, { prefix: '/auth/robinhood' });
fastify.register(mcpRoutes, { prefix: '/mcp' });
fastify.register(agentRoutes, { prefix: '/api/agent' });
fastify.register(agentChatRoutes, { prefix: '/api/agent' });
fastify.register(agentActionsRoutes, { prefix: '/api/agent' });
fastify.register(agentProposalsRoutes, { prefix: '/api/agent' });
fastify.register(agentPolicyRoutes, { prefix: '/api/agent/policy' });
fastify.register(agentFleetRoutes, { prefix: '/api/agent/fleet' });
fastify.register(pnlRoutes, { prefix: '/api/agent' });
fastify.register(paymasterRoutes, { prefix: '/paymaster' });
fastify.register(rhChainRoutes, { prefix: '/api/rh-chain' });
// Wave J-Q
fastify.register(agentStrategyRoutes, { prefix: '/api/agent' });
fastify.register(agentSimulatorRoutes, { prefix: '/api/agent' });
fastify.register(agentAuditRoutes, { prefix: '/api/agent' });
fastify.register(fxRoutes, { prefix: '/api/fx' });

const start = async (): Promise<void> => {
  try {
    // Boot-time guards: assert the local attestor key matches what the
    // on-chain RobinhoodMcpAttestor.attestor() storage slot trusts. In prod
    // a mismatch is fatal; in dev it warns and continues.
    await runBootGuards();

    // Risk preset hash audit (Feature C). Logs the 5 computed hashes; when
    // PINNED_PRESET_HASHES is populated this assertion enforces drift
    // checks. F-21: in production, drift is a hard boot failure. Continuing
    // would silently desync the backend's policy hashes from the on-chain
    // commitment, masking a compromised supply chain.
    // Wave-J: surface LangGraph checkpointer URL posture at boot. Empty
    // string means we fall back to MemorySaver (logged elsewhere); the
    // log here is the canonical visibility for ops dashboards.
    logger.info(
      { svc: 'boot', data: { langgraph_pg_configured: LANGGRAPH_PG_URL.length > 0 } },
      'LangGraph PostgresSaver URL posture',
    );

    const presetsOk = assertPresetHashes();
    if (!presetsOk && IS_PROD) {
      fastify.log.error({ svc: 'boot' }, 'preset hash drift detected; refusing to start');
      process.exit(1);
    }

    // Start workers + services
    startWebhookEmitter();
    startErrorLogCleanupWorker();
    startAttestPosterWorker();
    startPriceOraclePosterWorker();
    startTokenRefresherWorker();
    startSiweNonceCleanupWorker();
    startCircuitBreakerWorker();
    startStylusHealthCheckWorker();
    startReputationFeedbackWorker();
    // Wave J-Q
    startTriggerWatcherWorker();
    startPricePointIndexerWorker();

    // Mount the on-chain indexer AFTER workers (so the AgentPolicy writes
    // are observable to the attest worker on its next tick) but BEFORE the
    // HTTP listener so SSE clients connecting at t=0 already have a feed.
    await startOnchainIndexer();

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`Server started successfully on port ${port}`);
    console.log(`http://localhost:${port}`);
    logger.info({ svc: 'boot', data: { port } }, 'PrimeAgent backend ready');
  } catch (error) {
    logger.error(
      { svc: 'boot', err_class: (error as Error)?.name },
      `error starting server: ${(error as Error)?.message ?? String(error)}`,
    );
    process.exit(1);
  }
};

// Graceful shutdown: stop every running agent and close every pooled MCP
// client before exit. Registered ONCE via `process.once` so a duplicate
// signal does not double-fire. Wave C will extend this with HTTP listener
// drain when the SSE routes land.
async function gracefulShutdown(reason: string): Promise<void> {
  logger.info({ svc: 'boot', data: { reason } }, 'graceful shutdown begin');
  // Drain in-flight error-log writes first so the fastify reply machinery
  // does not get torn down while a `prisma.errorLog.create` is still in
  // flight (which surfaces as `Cannot writeHead headers after they are
  // sent to the client` warnings in the test runner).
  try {
    await flushErrorLogs();
  } catch (err) {
    logger.error(
      { svc: 'boot', err_class: (err as Error)?.name },
      'flushErrorLogs failed during shutdown',
    );
  }
  try {
    await stopAllAgents();
  } catch (err) {
    logger.error(
      { svc: 'boot', err_class: (err as Error)?.name },
      'stopAllAgents failed during shutdown',
    );
  }
  try {
    await closeAllMcpClients();
  } catch (err) {
    logger.error(
      { svc: 'boot', err_class: (err as Error)?.name },
      'closeAllMcpClients failed during shutdown',
    );
  }
  try {
    await fastify.close();
  } catch (err) {
    logger.error(
      { svc: 'boot', err_class: (err as Error)?.name },
      'fastify.close failed during shutdown',
    );
  }
  process.exit(0);
}

process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

start();

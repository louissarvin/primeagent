import type { FastifyReply } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { IS_DEV } from '../config/main-config.ts';
import { logger } from '../lib/logger.ts';

interface ErrorContext {
  [key: string]: unknown;
}

/**
 * In-flight error-log writes. `handleError` performs `errorLog.create`
 * fire-and-forget so a slow DB never blocks the HTTP response; the trade-off
 * is that under test teardown the fastify reply can be torn down before the
 * write resolves, surfacing as `Cannot writeHead headers after they are sent
 * to the client` warnings. Tracking the in-flight set lets `flushErrorLogs`
 * (called from graceful shutdown) and `awaitErrorLogQueue` (called from
 * tests immediately before `app.close()`) await every pending promise.
 */
const inflightErrorWrites = new Set<Promise<unknown>>();

/**
 * Await every in-flight `errorLog.create` promise and resolve. Safe to call
 * from `index.ts` SIGINT/SIGTERM handlers; resolves to `undefined` when the
 * queue is empty.
 */
export async function flushErrorLogs(): Promise<void> {
  if (inflightErrorWrites.size === 0) return;
  const pending = Array.from(inflightErrorWrites);
  // `allSettled` so a single rejected write does not block the rest.
  await Promise.allSettled(pending);
}

/**
 * Test-only helper: identical contract to `flushErrorLogs`. Kept as a
 * named alias so call sites read clearly in tests
 * (`await awaitErrorLogQueue(); await app.close();`).
 */
export async function awaitErrorLogQueue(): Promise<void> {
  await flushErrorLogs();
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: string;
    stack?: string;
  };
  data: null;
  timestamp?: string;
}

/**
 * Main error handler - logs to database and returns standardized error response
 */
export const handleError = async (
  reply: FastifyReply,
  statusCode: number,
  message: string,
  errorCode: string,
  originalError: Error | null = null,
  context: ErrorContext | null = null
): Promise<FastifyReply> => {
  try {
    const request = reply.request;
    const userId = (request as { user?: { id: string } }).user?.id || null;

    // Extract request information
    const requestInfo = {
      method: request.method,
      path: request.url,
      userAgent: request.headers['user-agent'] || null,
      ip: request.ip || request.headers['x-forwarded-for'] || request.socket?.remoteAddress || null,
    };

    // Prepare error log data
    const errorLogData = {
      errorCode,
      message,
      statusCode,
      stack: originalError?.stack || null,
      context: context ? JSON.stringify(context) : null,
      userId,
      ...requestInfo,
    };

    // Log to database (non-blocking). The promise is tracked in
    // `inflightErrorWrites` so `flushErrorLogs` / `awaitErrorLogQueue`
    // can drain on graceful shutdown and in tests. We attach `.finally`
    // to remove the entry once the write settles either way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writePromise = ((prismaQuery as any).errorLog as {
      create: (args: { data: typeof errorLogData }) => Promise<unknown>;
    })
      .create({ data: errorLogData })
      .catch((dbError: unknown) => {
        logger.error(
          {
            err_class: (dbError as Error)?.name,
            data: { msg: (dbError as Error)?.message ?? String(dbError) },
          },
          'failed to persist error log row',
        );
      });
    inflightErrorWrites.add(writePromise);
    void writePromise.finally(() => {
      inflightErrorWrites.delete(writePromise);
    });

    // Structured emission for the live demo / log shippers.
    logger.error(
      {
        err_code: errorCode,
        err_class: originalError?.name,
        data: {
          statusCode,
          userId,
          path: requestInfo.path,
          method: requestInfo.method,
          msg: message,
          originalMsg: originalError?.message,
        },
      },
      `request error: ${errorCode}`,
    );

    // Send standardized error response
    const response: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message,
        ...(IS_DEV &&
          originalError && {
            details: originalError.message,
            stack: originalError.stack,
          }),
      },
      data: null,
      timestamp: new Date().toISOString(),
    };

    // Send synchronously, then mark the reply as hijacked so Fastify's
    // wrap-thenable (`lib/wrap-thenable.js`) short-circuits via its
    // `reply[kReplyHijacked] === true` guard. Without this hijack, the
    // wrap-thenable double-sends the reply when callers `return handleError(...)`
    // from preHandlers because `reply.sent` (derived from
    // `raw.writableEnded`) is still false at the point the wrapper runs.
    // The hijack is safe here because we have already issued the final
    // response and no other hook should write to this reply.
    reply.code(statusCode).send(response);
    try {
      reply.hijack();
    } catch {
      // hijack throws only on already-hijacked replies; nothing to do.
    }
    return reply;
  } catch (handlerError) {
    // The error handler itself failed; emit through the structured
    // logger so we still see it in production log streams.
    logger.error(
      {
        err_class: (handlerError as Error)?.name,
        data: { msg: (handlerError as Error)?.message ?? String(handlerError) },
      },
      'error handler itself threw',
    );

    // Fallback response if error handler fails
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: errorCode,
        message,
      },
      data: null,
    });
  }
};

/**
 * Handle validation errors (missing/invalid fields)
 */
export const handleValidationError = (reply: FastifyReply, missingFields: string[]): Promise<FastifyReply> => {
  return handleError(reply, 400, `Missing required fields: ${missingFields.join(', ')}`, 'VALIDATION_ERROR', null, {
    missingFields,
  });
};

/**
 * Handle resource not found errors
 */
export const handleNotFoundError = (reply: FastifyReply, resource: string): Promise<FastifyReply> => {
  return handleError(reply, 404, `${resource} not found`, 'NOT_FOUND', null, { resource });
};

/**
 * Handle unauthorized errors (401)
 */
export const handleUnauthorizedError = (reply: FastifyReply, reason: string = 'Unauthorized'): Promise<FastifyReply> => {
  return handleError(reply, 401, reason, 'UNAUTHORIZED');
};

/**
 * Handle forbidden errors (403)
 */
export const handleForbiddenError = (reply: FastifyReply, reason: string = 'Forbidden'): Promise<FastifyReply> => {
  return handleError(reply, 403, reason, 'FORBIDDEN');
};

/**
 * Handle database errors
 */
export const handleDatabaseError = (
  reply: FastifyReply,
  operation: string,
  originalError: Error
): Promise<FastifyReply> => {
  return handleError(reply, 500, `Database error during ${operation}`, 'DATABASE_ERROR', originalError, { operation });
};

/**
 * Handle internal server errors
 */
export const handleServerError = (reply: FastifyReply, originalError: Error): Promise<FastifyReply> => {
  return handleError(reply, 500, 'Internal server error', 'INTERNAL_ERROR', originalError);
};

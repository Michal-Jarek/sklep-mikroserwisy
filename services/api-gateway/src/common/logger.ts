import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';
import { Logger, pino } from 'pino';
import { LogLevel, SERVICE_NAME } from '../config/app-config';
import { PATHS } from '../routes';

// Never log credentials, tokens or cookies (request and response headers). Request bodies are not logged.
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers.authorization',
  'res.headers.cookie',
  'res.headers["set-cookie"]',
];

/** JSON logs on stdout: time, level, service, msg (+ requestId and userId inside requests). */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  });
}

const HEALTH_PATHS: readonly string[] = [PATHS.healthLive, PATHS.healthReady];

/** Type and message of the error pino-http puts on the log line of a 5xx answer, without its stack. */
class ResponseErrorSummary {
  constructor(
    readonly type: string,
    readonly message: string,
  ) {}
}

/**
 * Error serializer of the request logger: runs after the standard one, which turns any value with a message
 * into an error with a stack (an empty one too); raw is the logged value. A summary stays type + message.
 */
export function serializeError(error: unknown): unknown {
  const raw = (error as { raw?: unknown } | null)?.raw;
  return raw instanceof ResponseErrorSummary ? { type: raw.type, message: raw.message } : error;
}

/** Request as pino-std-serializers gives it to a custom serializer (url is already originalUrl when set). */
interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
  headers: Record<string, unknown>;
  remoteAddress?: string;
  remotePort?: number;
}

/**
 * Request serializer of the request logger: the path without the query string, no query and params.
 * Search parameters can carry personal data (e.g. an e-mail in ?q=). The same goes for Referer: with
 * Referrer-Policy same-origin every API call of the page /?q=... carries the full page address, so its
 * query is cut too (in a copy of the headers, req stays unchanged). Headers stay, redacted by REDACTED_PATHS.
 */
export function serializeRequest(req: SerializedRequest): SerializedRequest {
  const referer = req.headers.referer;
  return {
    id: req.id,
    method: req.method,
    url: (req.url ?? '').split('?', 1)[0],
    headers: typeof referer === 'string' ? { ...req.headers, referer: referer.split('?', 1)[0] } : req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

/** A health check from Consul: only health paths count, so a client cannot hide other requests with this User-Agent. */
export function isConsulHealthCheck(req: IncomingMessage): boolean {
  // When pino-http asks, the Nest middleware layer (middie) has already cut req.url down to "/"; originalUrl keeps it.
  const path = ((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?', 1)[0];
  return HEALTH_PATHS.includes(path) && (req.headers['user-agent']?.startsWith('Consul Health Check') ?? false);
}

/**
 * nestjs-pino options. The request id comes from Fastify (genReqId), so logs, the X-Request-Id
 * header and error bodies share one value. Inside a request PinoLogger.assign({ userId, targetService,
 * upstream }) adds the fields to every later log line of that request, including "request completed".
 */
export function loggerModuleParams(logger: Logger): Params {
  return {
    // Explicit: the default route of nestjs-pino 5.3 ("{/*splat}") matches nothing with Nest 12 on Fastify.
    forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
    // Fields from PinoLogger.assign() also go to the "request completed" line.
    assignResponse: true,
    pinoHttp: {
      logger,
      genReqId: (req: IncomingMessage) => req.id,
      customProps: (req: IncomingMessage) => ({ requestId: req.id }),
      // Consul runs the readiness check every 10 s; the result is visible in Consul. Without these
      // lines the word "Consul" in the logs means a problem with Consul (one line per change of state).
      autoLogging: { ignore: (req: IncomingMessage) => isConsulHealthCheck(req) },
      // pino-http adds Error('failed with status code ...') with a stack to the line of every 5xx answer. Such an
      // answer is not an exception of the Gateway (those are logged by sendError with the stack): type and message only.
      customErrorObject: (_req: IncomingMessage, _res: ServerResponse, error: Error, value: Record<string, unknown>) => ({
        ...value,
        err: new ResponseErrorSummary(error.name, error.message),
      }),
      serializers: { req: serializeRequest, err: serializeError },
    },
  };
}

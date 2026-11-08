import type { IncomingMessage } from 'node:http';
import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';
import { Logger, pino } from 'pino';
import { LogLevel, SERVICE_NAME } from '../config/app-config';

// Never log credentials or tokens. Emails are not logged at all (log userId instead).
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
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

/**
 * nestjs-pino options. The request id comes from Fastify (genReqId), so logs, the X-Request-Id
 * header and error bodies share one value. Inside a request use PinoLogger.assign({ userId })
 * to add the user id to every later log line of that request.
 */
export function loggerModuleParams(logger: Logger): Params {
  return {
    // Explicit: the default route of nestjs-pino 5.3 ("{/*splat}") matches nothing with Nest 12 on Fastify.
    forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
    // Fields from PinoLogger.assign() (userId) also go to the "request completed" line.
    assignResponse: true,
    pinoHttp: {
      logger,
      genReqId: (req: IncomingMessage) => req.id,
      customProps: (req: IncomingMessage) => ({ requestId: req.id }),
    },
  };
}

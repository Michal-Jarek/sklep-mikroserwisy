import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from 'pino';
import { ERROR_MESSAGES, type ErrorCode } from './app-exception';
import type { ErrorResponse } from './error-response';
import { resolveRequestId } from './request-id';

interface ClientErrorAnswer {
  status: number;
  error: ErrorCode;
  message: string;
  log: string;
}

const MALFORMED = 'Malformed HTTP request rejected';

// Errors of the Node HTTP parser and server with their own answer; anything else -> 400.
const ANSWERS: Record<string, ClientErrorAnswer> = {
  // Headers over the Node limit (16 KB).
  HPE_HEADER_OVERFLOW: { status: 431, error: 'REQUEST_HEADER_FIELDS_TOO_LARGE', message: ERROR_MESSAGES.headersTooLarge, log: MALFORMED },
  // Headers and body not received within requestTimeout (fastify-adapter.ts).
  ERR_HTTP_REQUEST_TIMEOUT: { status: 408, error: 'REQUEST_TIMEOUT', message: ERROR_MESSAGES.requestTimeout, log: 'HTTP request not received in time' },
};
const BAD_REQUEST: ClientErrorAnswer = { status: 400, error: 'VALIDATION_ERROR', message: ERROR_MESSAGES.badRequest, log: MALFORMED };

/**
 * Raw HTTP response for a request that Node rejected before Fastify (Fastify clientErrorHandler):
 * headers over the Node limit (16 KB) -> 431, request not received in time -> 408, anything else -> 400.
 * Same team format and headers as other responses, with a new request id; the connection is closed afterwards.
 */
export function clientErrorResponse(
  errorCode: string | undefined,
  instanceId: string,
): { requestId: string; status: number; log: string; raw: string } {
  const requestId = resolveRequestId(undefined);
  const answer = (errorCode === undefined ? undefined : ANSWERS[errorCode]) ?? BAD_REQUEST;
  const body: ErrorResponse = { status: answer.status, error: answer.error, message: answer.message, requestId };
  const payload = JSON.stringify(body);
  const raw =
    `HTTP/1.1 ${answer.status} ${STATUS_CODES[answer.status]}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    `X-Request-Id: ${requestId}\r\n` +
    `X-Gateway-Instance-Id: ${instanceId}\r\n` +
    'Connection: close\r\n\r\n' +
    payload;
  return { requestId, status: answer.status, log: answer.log, raw };
}

export function createClientErrorHandler(
  instanceId: string,
  logger: Pick<Logger, 'info'>,
): (error: Error & { code?: string }, socket: Socket) => void {
  return (error, socket) => {
    // The client is gone, or an answer has already started on this connection (e.g. 413 while the client
    // keeps sending the body): nothing more to write. Node's default handler checks the same.
    const response = (socket as Socket & { _httpMessage?: { headersSent?: boolean } | null })._httpMessage;
    if (error.code === 'ECONNRESET' || !socket.writable || response?.headersSent === true) {
      socket.destroy();
      return;
    }
    const { requestId, status, log, raw } = clientErrorResponse(error.code, instanceId);
    logger.info({ requestId, statusCode: status, reason: error.code }, log);
    socket.end(raw);
  };
}

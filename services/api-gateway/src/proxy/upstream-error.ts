/**
 * Kind of a failed proxy attempt (decision 11, Z14):
 * - unreachable: no connection to the instance (502, the instance is evicted, GET/HEAD retried once);
 * - timeout: no response within proxy.timeoutSeconds (504, no retry);
 * - failed: another I/O error without a response (502, no retry);
 * - rejected: the HTTP client of the Gateway refused to build the request from what the client sent
 *   (a header or query undici does not accept). Nothing was sent: 400, not a failure of the service
 *   (not counted by the circuit, no eviction, no retry).
 */
export type UpstreamErrorKind = 'unreachable' | 'timeout' | 'failed' | 'rejected';

// UND_ERR_CONNECT_TIMEOUT arrives from reply-from with status 504, but it means "no connection".
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'FST_REPLY_FROM_GATEWAY_TIMEOUT']);
const REJECTED_CODES = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED']);

function codeOf(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
    return value.code;
  }
  return undefined;
}

/**
 * Classifies an error passed to the reply-from onError callback by error.cause.code and error.code,
 * never by the statusCode of reply-from (e.g. ECONNREFUSED comes as FST_REPLY_FROM_INTERNAL_SERVER_ERROR
 * with cause.code). The code is for the log.
 */
export function classifyUpstreamError(error: unknown): { kind: UpstreamErrorKind; code: string } {
  const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const codes = [codeOf(cause), codeOf(error)].filter((code): code is string => code !== undefined);
  const unreachable = codes.find((code) => UNREACHABLE_CODES.has(code));
  if (unreachable) {
    return { kind: 'unreachable', code: unreachable };
  }
  const timeout = codes.find((code) => TIMEOUT_CODES.has(code));
  if (timeout) {
    return { kind: 'timeout', code: timeout };
  }
  const rejected = codes.find((code) => REJECTED_CODES.has(code));
  if (rejected) {
    return { kind: 'rejected', code: rejected };
  }
  return { kind: 'failed', code: codes[0] ?? 'UNKNOWN' };
}

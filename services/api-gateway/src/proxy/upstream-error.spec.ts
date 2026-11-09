import { classifyUpstreamError } from './upstream-error';

// Shapes of the errors reply-from passes to onError (code of reply-from, cause = error of undici or Node).
function replyFromError(code: string, causeCode?: string): Error {
  const error = new Error('reply-from error', causeCode ? { cause: Object.assign(new Error('cause'), { code: causeCode }) } : undefined);
  return Object.assign(error, { code });
}

describe('classifyUpstreamError (decision 11, Z14)', () => {
  it.each([
    ['FST_REPLY_FROM_INTERNAL_SERVER_ERROR', 'ECONNREFUSED', 'ECONNREFUSED'],
    ['FST_REPLY_FROM_INTERNAL_SERVER_ERROR', 'EHOSTUNREACH', 'EHOSTUNREACH'],
    ['ECONNRESET', 'ECONNRESET', 'ECONNRESET'],
    // reply-from gives a connection timeout the status 504, but it is "no connection".
    ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'],
    ['UND_ERR_CONNECT_TIMEOUT', undefined, 'UND_ERR_CONNECT_TIMEOUT'],
  ])('%s with cause %s -> unreachable', (code, causeCode, expected) => {
    expect(classifyUpstreamError(replyFromError(code, causeCode))).toEqual({ kind: 'unreachable', code: expected });
  });

  it.each([
    ['FST_REPLY_FROM_GATEWAY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'],
    ['FST_REPLY_FROM_GATEWAY_TIMEOUT', undefined, 'FST_REPLY_FROM_GATEWAY_TIMEOUT'],
  ])('%s with cause %s -> timeout', (code, causeCode, expected) => {
    expect(classifyUpstreamError(replyFromError(code, causeCode))).toEqual({ kind: 'timeout', code: expected });
  });

  it.each([
    ['UND_ERR_SOCKET', 'UND_ERR_SOCKET', 'UND_ERR_SOCKET'],
    ['FST_REPLY_FROM_SERVICE_UNAVAILABLE', 'ENOTFOUND', 'ENOTFOUND'],
    ['FST_REPLY_FROM_INTERNAL_SERVER_ERROR', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'],
  ])('%s with cause %s -> failed (502, no retry)', (code, causeCode, expected) => {
    expect(classifyUpstreamError(replyFromError(code, causeCode))).toEqual({ kind: 'failed', code: expected });
  });

  it.each([
    // The header Expect (W1); a header or query undici does not accept.
    ['FST_REPLY_FROM_INTERNAL_SERVER_ERROR', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_NOT_SUPPORTED'],
    ['FST_REPLY_FROM_INTERNAL_SERVER_ERROR', 'UND_ERR_INVALID_ARG', 'UND_ERR_INVALID_ARG'],
    ['UND_ERR_INVALID_ARG', undefined, 'UND_ERR_INVALID_ARG'],
  ])('%s with cause %s -> rejected (400, not a failure of the service)', (code, causeCode, expected) => {
    expect(classifyUpstreamError(replyFromError(code, causeCode))).toEqual({ kind: 'rejected', code: expected });
  });

  it('an error without a code -> failed UNKNOWN', () => {
    expect(classifyUpstreamError(new Error('x'))).toEqual({ kind: 'failed', code: 'UNKNOWN' });
    expect(classifyUpstreamError('text')).toEqual({ kind: 'failed', code: 'UNKNOWN' });
  });
});

import { jest } from '@jest/globals';
import type { Socket } from 'node:net';
import { clientErrorResponse, createClientErrorHandler } from './client-error';
import { codeFromStatusName } from './error-response';

function fakeSocket(writable = true) {
  return { writable, end: jest.fn(), destroy: jest.fn() };
}

describe('clientErrorHandler', () => {
  it('builds 431 for too large headers with a new request id and closes the connection', () => {
    const { requestId, status, raw } = clientErrorResponse('HPE_HEADER_OVERFLOW', 'api-gateway-x');
    expect(status).toBe(431);
    expect(raw.startsWith('HTTP/1.1 431 Request Header Fields Too Large\r\n')).toBe(true);
    expect(raw).toContain(`X-Request-Id: ${requestId}\r\n`);
    expect(raw).toContain('X-Gateway-Instance-Id: api-gateway-x\r\n');
    expect(raw).toContain('Connection: close\r\n');
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(raw).toContain(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
    expect(JSON.parse(body)).toEqual({
      status: 431,
      error: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
      message: 'Request headers are too large',
      requestId,
    });
  });

  it('builds 408 REQUEST_TIMEOUT for a request not received in time (N1, requestTimeout)', () => {
    const { requestId, status, raw } = clientErrorResponse('ERR_HTTP_REQUEST_TIMEOUT', 'api-gateway-x');
    expect(status).toBe(408);
    expect(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n')).toBe(true);
    expect(raw).toContain(`X-Request-Id: ${requestId}\r\n`);
    expect(raw).toContain('X-Gateway-Instance-Id: api-gateway-x\r\n');
    expect(raw).toContain('Connection: close\r\n');
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(raw).toContain(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
    expect(JSON.parse(body)).toEqual({ status: 408, error: 'REQUEST_TIMEOUT', message: 'Request was not received in time', requestId });
    // The code comes from the status name (stage 2, Z6).
    expect(codeFromStatusName(408)).toBe('REQUEST_TIMEOUT');
  });

  it('builds 400 VALIDATION_ERROR for any other parse error', () => {
    const { status, raw } = clientErrorResponse('HPE_INVALID_METHOD', 'api-gateway-x');
    expect(status).toBe(400);
    expect(raw.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(clientErrorResponse(undefined, 'api-gateway-x').status).toBe(400);
    expect(JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Bad request' });
  });

  it('writes the answer and logs the request id, or only closes a socket that cannot be written', () => {
    const logger = { info: jest.fn() };
    const handler = createClientErrorHandler('api-gateway-x', logger);

    const open = fakeSocket();
    handler(Object.assign(new Error('Parse Error'), { code: 'HPE_HEADER_OVERFLOW' }), open as unknown as Socket);
    expect(open.end).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toBe('Malformed HTTP request rejected');

    const slow = fakeSocket();
    handler(Object.assign(new Error('Request timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), slow as unknown as Socket);
    expect(String(slow.end.mock.calls[0][0]).startsWith('HTTP/1.1 408 ')).toBe(true);
    expect(logger.info.mock.calls[1][0]).toMatchObject({ statusCode: 408, reason: 'ERR_HTTP_REQUEST_TIMEOUT' });
    expect(logger.info.mock.calls[1][1]).toBe('HTTP request not received in time');

    const reset = fakeSocket();
    handler(Object.assign(new Error('reset'), { code: 'ECONNRESET' }), reset as unknown as Socket);
    const closed = fakeSocket(false);
    handler(Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID_METHOD' }), closed as unknown as Socket);
    expect(reset.end).not.toHaveBeenCalled();
    expect(reset.destroy).toHaveBeenCalled();
    expect(closed.destroy).toHaveBeenCalled();
  });

  it('does not write a second answer when one has already started on the connection (e.g. 413, then a timeout)', () => {
    const logger = { info: jest.fn() };
    const handler = createClientErrorHandler('api-gateway-x', logger);
    const answered = Object.assign(fakeSocket(), { _httpMessage: { headersSent: true } });
    handler(Object.assign(new Error('Request timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), answered as unknown as Socket);
    expect(answered.end).not.toHaveBeenCalled();
    expect(answered.destroy).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();

    const notYet = Object.assign(fakeSocket(), { _httpMessage: { headersSent: false } });
    handler(Object.assign(new Error('Request timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), notYet as unknown as Socket);
    expect(String(notYet.end.mock.calls[0][0]).startsWith('HTTP/1.1 408 ')).toBe(true);
  });
});

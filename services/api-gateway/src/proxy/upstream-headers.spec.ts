import { buildUpstreamHeaders, filterResponseHeaders, mergeVary } from './upstream-headers';

const ANONYMOUS = { requestId: 'rid-1', clientIp: '172.21.0.1', identity: null };

describe('buildUpstreamHeaders (guidelines 3.2)', () => {
  it('removes every X-User-* of the client, whatever the case and number', () => {
    const headers = buildUpstreamHeaders(
      { 'x-user-id': '00000000-0000-0000-0000-000000000001, second', 'X-User-Roles': 'ADMIN,SERVICE', 'X-USER-EMAIL': 'a@b.c' },
      ANONYMOUS,
    );
    expect(Object.keys(headers).filter((name) => name.toLowerCase().startsWith('x-user-'))).toEqual([]);
  });

  it('removes Authorization, Forwarded, X-Forwarded-*, X-Real-IP, Proxy-Authorization and Expect', () => {
    const headers = buildUpstreamHeaders(
      {
        authorization: 'Bearer abc',
        expect: '100-continue',
        'proxy-authorization': 'Basic x',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-host': 'evil',
        'x-forwarded-proto': 'https',
        'X-Real-IP': '1.2.3.4',
      },
      ANONYMOUS,
    );
    expect(headers).toEqual({ 'x-request-id': 'rid-1', 'x-forwarded-for': '172.21.0.1' });
  });

  it('removes hop-by-hop headers and the names listed in Connection; Content-Length is recomputed by the client', () => {
    const headers = buildUpstreamHeaders(
      {
        connection: 'x-hop, Keep-Alive',
        'x-hop': '1',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        trailer: 'x-checksum',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'proxy-connection': 'keep-alive',
        'content-length': '12',
        accept: 'application/json',
      },
      ANONYMOUS,
    );
    expect(headers).toEqual({ accept: 'application/json', 'x-request-id': 'rid-1', 'x-forwarded-for': '172.21.0.1' });
  });

  it('replaces X-Forwarded-For with one address and X-Request-Id with the id of the request', () => {
    const headers = buildUpstreamHeaders({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'x-request-id': 'zly id!' }, ANONYMOUS);
    expect(headers['x-forwarded-for']).toBe('172.21.0.1');
    expect(headers['x-request-id']).toBe('rid-1');
  });

  it('sets X-User-Id and X-User-Roles (comma-separated) for an identity, replacing the client values', () => {
    const headers = buildUpstreamHeaders(
      { 'x-user-id': 'fake', 'X-User-Roles': 'SERVICE' },
      { ...ANONYMOUS, identity: { userId: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e', roles: ['CUSTOMER', 'ADMIN'] } },
    );
    expect(headers['x-user-id']).toBe('0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e');
    expect(headers['x-user-roles']).toBe('CUSTOMER,ADMIN');
    expect(Object.keys(headers).filter((name) => name.startsWith('x-user-'))).toEqual(['x-user-id', 'x-user-roles']);
  });

  it('removes the method overrides X-HTTP-Method-Override, X-HTTP-Method and X-Method-Override, whatever the case (Z25)', () => {
    const headers = buildUpstreamHeaders(
      {
        'X-HTTP-Method-Override': 'DELETE',
        'x-http-method': 'DELETE',
        'X-METHOD-OVERRIDE': 'DELETE',
        'x-custom-ok': 'y',
      },
      ANONYMOUS,
    );
    expect(headers).toEqual({ 'x-custom-ok': 'y', 'x-request-id': 'rid-1', 'x-forwarded-for': '172.21.0.1' });
  });

  it('removes every header with "_" in its name, a header without "_" stays (Z25)', () => {
    const headers = buildUpstreamHeaders(
      {
        X_User_Id: '00000000-0000-0000-0000-000000000000',
        X_Forwarded_For: '1.2.3.4',
        x_request_id: 'from-client',
        Some_Header: 'x',
        _: 'x',
        'X-Custom_Mixed': 'x',
        'X-Custom-Ok': 'y',
      },
      ANONYMOUS,
    );
    expect(headers).toEqual({ 'x-custom-ok': 'y', 'x-request-id': 'rid-1', 'x-forwarded-for': '172.21.0.1' });
  });

  it('X_User_Roles: ADMIN,SERVICE of a logged-in CUSTOMER does not reach the service (Z25)', () => {
    const headers = buildUpstreamHeaders(
      { X_User_Roles: 'ADMIN,SERVICE', 'X-User-Roles': 'ADMIN' },
      { ...ANONYMOUS, identity: { userId: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e', roles: ['CUSTOMER'] } },
    );
    expect(headers['x-user-roles']).toBe('CUSTOMER');
    expect(Object.keys(headers).filter((name) => name.includes('_'))).toEqual([]);
    expect(Object.values(headers).join(' ')).not.toMatch(/ADMIN|SERVICE/);
  });

  it('keeps everything else unchanged (Cookie, Content-Type, Accept, Host, custom headers)', () => {
    const client = {
      host: '172.21.0.9:9000',
      cookie: 'a=1; b=2',
      'content-type': 'application/json; charset=utf-8',
      accept: '*/*',
      'x-stub-status': '404',
      'x-custom': ['a', 'b'],
    };
    expect(buildUpstreamHeaders(client, ANONYMOUS)).toEqual({ ...client, 'x-request-id': 'rid-1', 'x-forwarded-for': '172.21.0.1' });
  });
});

describe('filterResponseHeaders (decision 19, Z11)', () => {
  const GATEWAY = new Set(['x-request-id', 'x-gateway-instance-id', 'content-security-policy', 'x-frame-options']);

  it('removes Server and X-Powered-By', () => {
    expect(filterResponseHeaders({ server: 'echo-stub', 'X-Powered-By': 'Express', 'content-type': 'application/json' }, GATEWAY)).toEqual({
      'content-type': 'application/json',
    });
  });

  it('drops service headers the Gateway has already set (the Gateway value wins)', () => {
    const headers = filterResponseHeaders(
      { 'x-request-id': 'from-service', 'X-Gateway-Instance-Id': 'x', 'content-security-policy': "default-src *", 'x-frame-options': 'ALLOW' },
      GATEWAY,
    );
    expect(headers).toEqual({});
  });

  it('keeps X-Instance-Id, Set-Cookie, Retry-After, Content-Length and other headers unchanged', () => {
    const service = {
      'x-instance-id': 'e3stub-product-service-1',
      'set-cookie': ['k19=1; Path=/x; HttpOnly', 'b=2'],
      'retry-after': '7',
      'content-length': '42',
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer',
      vary: 'Accept',
    };
    expect(filterResponseHeaders(service, GATEWAY)).toEqual(service);
  });

  it('removes every Access-Control-* of the service (CORS belongs to the Gateway, decision 21)', () => {
    expect(
      filterResponseHeaders(
        {
          'Access-Control-Allow-Origin': '*',
          'access-control-allow-credentials': 'true',
          'Access-Control-Expose-Headers': 'X-Internal',
          'access-control-max-age': '86400',
          'content-type': 'application/json',
        },
        GATEWAY,
      ),
    ).toEqual({ 'content-type': 'application/json' });
  });

  it('removes hop-by-hop headers and the names listed in Connection', () => {
    expect(
      filterResponseHeaders(
        { connection: 'keep-alive, x-hop', 'keep-alive': 'timeout=5', 'x-hop': '1', 'transfer-encoding': 'chunked', trailer: 'x', etag: '"1"' },
        GATEWAY,
      ),
    ).toEqual({ etag: '"1"' });
  });
});

describe('mergeVary (pitfall 5b)', () => {
  it('no Vary set by the Gateway -> undefined (the service value passes unchanged)', () => {
    expect(mergeVary(undefined, 'Accept-Encoding')).toBeUndefined();
    expect(mergeVary('', 'Accept-Encoding')).toBeUndefined();
  });

  it('joins the Gateway and the service values without duplicates (case-insensitive)', () => {
    expect(mergeVary('Origin', 'Accept-Encoding')).toBe('Origin, Accept-Encoding');
    expect(mergeVary('Origin', 'accept-encoding, origin')).toBe('Origin, accept-encoding');
    expect(mergeVary('Origin, Access-Control-Request-Headers', ['Accept', 'Accept-Language'])).toBe(
      'Origin, Access-Control-Request-Headers, Accept, Accept-Language',
    );
    expect(mergeVary('Origin', undefined)).toBe('Origin');
  });

  it('"*" on either side wins', () => {
    expect(mergeVary('Origin', '*')).toBe('*');
    expect(mergeVary('*', 'Accept')).toBe('*');
  });
});

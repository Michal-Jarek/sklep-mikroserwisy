import { readFileSync } from 'node:fs';
import { ConfigValidationError, parseGatewayConfig, SCALAR_DEFAULTS, validateGatewayConfig } from './gateway-config';

// The KV document from the repository (tests run in services/api-gateway).
const REPO_DOCUMENT = readFileSync('../../deploy/consul/config/api-gateway.yaml', 'utf8');

// Smallest valid document: the three required keys, empty.
function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { routes: {}, access: [], rateLimit: { routes: [] }, ...extra };
}

function rejects(doc: unknown, field: string): void {
  let error: unknown;
  try {
    validateGatewayConfig(doc);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigValidationError);
  expect((error as Error).message.startsWith(`${field} `)).toBe(true);
}

describe('gateway configuration (KV document)', () => {
  it('reads the document from the repository', () => {
    const config = parseGatewayConfig(REPO_DOCUMENT);
    expect(config.logLevel).toBe('info');
    expect(config.jwt).toEqual({ issuer: 'sklep-auth', audience: 'sklep-api' });
    expect(config.proxy).toEqual({ timeoutSeconds: 10 });
    expect(config.routes.size).toBe(11);
    expect(config.routes.get('categories')).toBe('product-service');
    expect(config.access).toHaveLength(16);
    expect(config.access[0]).toEqual({ methods: 'ANY', pattern: ['auth', '**'], access: 'public' });
    expect(config.access[5]).toEqual({ methods: ['GET', 'HEAD'], pattern: ['users', 'me', '**'], access: 'authenticated' });
    expect(config.access[13]).toEqual({ methods: ['GET', 'HEAD'], pattern: ['inventory', '*'], access: 'public' });
    expect(config.access[15]).toEqual({ methods: ['PATCH'], pattern: ['shipments', '*', 'status'], access: 'ADMIN' });
    expect(config.rateLimit).toEqual({
      global: { max: 300, timeWindowSeconds: 60 },
      routes: [
        { method: 'POST', path: '/auth/login', max: 5, timeWindowSeconds: 60 },
        { method: 'POST', path: '/auth/register', max: 10, timeWindowSeconds: 60 },
      ],
    });
    expect(config.cors).toEqual({ allowedOrigins: [] });
  });

  it('uses defaults for missing scalar fields and keeps routes, rules and limits empty', () => {
    const config = validateGatewayConfig(minimal());
    expect(config).toEqual({
      logLevel: SCALAR_DEFAULTS.logLevel,
      jwt: SCALAR_DEFAULTS.jwt,
      proxy: SCALAR_DEFAULTS.proxy,
      routes: new Map(),
      access: [],
      rateLimit: { global: SCALAR_DEFAULTS.rateLimit.global, routes: [] },
      cors: { allowedOrigins: [] },
    });
  });

  it('lets environment variables override KV values', () => {
    const config = parseGatewayConfig(REPO_DOCUMENT, { logLevel: 'debug', jwtIssuer: 'env-issuer', jwtAudience: 'env-aud' });
    expect(config.logLevel).toBe('debug');
    expect(config.jwt).toEqual({ issuer: 'env-issuer', audience: 'env-aud' });
  });

  it('ignores unknown keys', () => {
    const config = validateGatewayConfig(
      minimal({ other: 1, jwt: { issuer: 'i', extra: true }, access: [{ methods: ['GET'], path: '/a', access: 'public', note: 'x' }] }),
    );
    expect(config.jwt.issuer).toBe('i');
    expect(config.access).toHaveLength(1);
  });

  it('treats ANY in a method list as any method', () => {
    const config = validateGatewayConfig(minimal({ access: [{ methods: ['GET', 'ANY'], path: '/a', access: 'public' }] }));
    expect(config.access[0].methods).toBe('ANY');
    expect(validateGatewayConfig(minimal({ access: [{ methods: ['ANY', 'ANY'], path: '/a', access: 'public' }] })).access[0].methods).toBe('ANY');
  });

  describe('rejects the whole document', () => {
    it('when it is not a mapping', () => {
      rejects(['a'], 'document');
      rejects(null, 'document');
    });

    it('without the required keys routes, access and rateLimit.routes (e.g. a typo in a key name)', () => {
      rejects({ access: [], rateLimit: { routes: [] } }, 'routes');
      rejects({ routes: {}, acess: [], rateLimit: { routes: [] } }, 'access');
      rejects({ routes: {}, access: null, rateLimit: { routes: [] } }, 'access');
      rejects({ routes: {}, access: [] }, 'rateLimit');
      rejects({ routes: {}, access: [], rateLimit: { global: { max: 1 } } }, 'rateLimit.routes');
    });

    it('on a wrong type', () => {
      rejects(minimal({ routes: [] }), 'routes');
      rejects(minimal({ access: {} }), 'access');
      rejects(minimal({ access: ['x'] }), 'access[0]');
      rejects(minimal({ rateLimit: { routes: {} } }), 'rateLimit.routes');
      rejects(minimal({ jwt: 'x' }), 'jwt');
      rejects(minimal({ jwt: { issuer: 5 } }), 'jwt.issuer');
      rejects(minimal({ jwt: { audience: '' } }), 'jwt.audience');
      rejects(minimal({ proxy: { timeoutSeconds: '10' } }), 'proxy.timeoutSeconds');
      rejects(minimal({ cors: { allowedOrigins: 'http://a' } }), 'cors.allowedOrigins');
      rejects(minimal({ cors: { allowedOrigins: [1] } }), 'cors.allowedOrigins[0]');
      rejects(minimal({ access: [{ methods: 'GET', path: '/a', access: 'public' }] }), 'access[0].methods');
    });

    it('on an unknown access level, with the field in the message', () => {
      expect(() => parseGatewayConfig(REPO_DOCUMENT.replace(/access: public \}$/m, 'access: everyone }'))).toThrow(
        'access[0].access must be one of public, authenticated, ADMIN, blocked',
      );
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a' }] }), 'access[0].access');
    });

    it('on a method outside the list (ANY only in access rules)', () => {
      rejects(minimal({ access: [{ methods: ['TRACE'], path: '/a', access: 'public' }] }), 'access[0].methods[0]');
      rejects(minimal({ access: [{ methods: ['get'], path: '/a', access: 'public' }] }), 'access[0].methods[0]');
      rejects(minimal({ access: [{ methods: [], path: '/a', access: 'public' }] }), 'access[0].methods');
      rejects(minimal({ rateLimit: { routes: [{ method: 'ANY', path: '/a', max: 1, timeWindowSeconds: 1 }] } }), 'rateLimit.routes[0].method');
    });

    it('on a method outside the list next to ANY (N5: every item is checked)', () => {
      rejects(minimal({ access: [{ methods: ['ANY', 'BOGUS'], path: '/a', access: 'public' }] }), 'access[0].methods[1]');
      rejects(minimal({ access: [{ methods: ['GETT', 'ANY'], path: '/a', access: 'public' }] }), 'access[0].methods[0]');
      rejects(minimal({ access: [{ methods: ['ANY', 1], path: '/a', access: 'public' }] }), 'access[0].methods[1]');
    });

    it('on ** that is not the last segment', () => {
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a/**/b', access: 'public' }] }), 'access[0].path');
    });

    it('on a path that does not start with / or has an invalid segment', () => {
      rejects(minimal({ access: [{ methods: ['GET'], path: 'products', access: 'public' }] }), 'access[0].path');
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a//b', access: 'public' }] }), 'access[0].path');
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a/', access: 'public' }] }), 'access[0].path');
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a b', access: 'public' }] }), 'access[0].path');
      rejects(minimal({ access: [{ methods: ['GET'], path: '/a*', access: 'public' }] }), 'access[0].path');
      rejects(minimal({ rateLimit: { routes: [{ method: 'POST', path: 'auth/login', max: 1, timeWindowSeconds: 1 }] } }), 'rateLimit.routes[0].path');
      rejects(minimal({ rateLimit: { routes: [{ method: 'POST', path: '/auth/*', max: 1, timeWindowSeconds: 1 }] } }), 'rateLimit.routes[0].path');
    });

    it('on a resource or service name outside ^[a-z][a-z0-9-]*$', () => {
      rejects(minimal({ routes: { Products: 'product-service' } }), 'routes key "Products"');
      rejects(minimal({ routes: { '1x': 'product-service' } }), 'routes key "1x"');
      rejects(minimal({ routes: { products: 'Product_Service' } }), 'routes.products');
      rejects(minimal({ routes: { products: 5 } }), 'routes.products');
    });

    it('on max, timeWindowSeconds or timeoutSeconds <= 0, and on a non-integer max or window', () => {
      const limit = { method: 'POST', path: '/auth/login', max: 5, timeWindowSeconds: 60 };
      rejects(minimal({ rateLimit: { routes: [{ ...limit, max: 0 }] } }), 'rateLimit.routes[0].max');
      rejects(minimal({ rateLimit: { routes: [{ ...limit, max: 1.5 }] } }), 'rateLimit.routes[0].max');
      rejects(minimal({ rateLimit: { routes: [{ ...limit, timeWindowSeconds: -1 }] } }), 'rateLimit.routes[0].timeWindowSeconds');
      rejects(minimal({ rateLimit: { routes: [{ ...limit, max: undefined }] } }), 'rateLimit.routes[0].max');
      rejects(minimal({ rateLimit: { routes: [], global: { max: 0 } } }), 'rateLimit.global.max');
      rejects(minimal({ rateLimit: { routes: [], global: { timeWindowSeconds: 0.5 } } }), 'rateLimit.global.timeWindowSeconds');
      rejects(minimal({ proxy: { timeoutSeconds: 0 } }), 'proxy.timeoutSeconds');
      expect(validateGatewayConfig(minimal({ proxy: { timeoutSeconds: 2.5 } })).proxy.timeoutSeconds).toBe(2.5);
    });

    it('on an unknown logLevel', () => {
      rejects(minimal({ logLevel: 'loud' }), 'logLevel');
    });
  });

  it('throws on invalid YAML without the document text in the message', () => {
    expect(() => parseGatewayConfig('routes: {a: [unclosed\nhidden-value-123')).toThrow();
    try {
      parseGatewayConfig('routes: {a: [unclosed\nhidden-value-123');
    } catch (error) {
      expect((error as Error).message).not.toContain('hidden-value-123');
    }
  });
});

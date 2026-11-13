// Unit tests of report.mjs (node --test, no network). Run in the image as in postman/README.md.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  RATE_LIMIT_HINT,
  buildReport,
  createTrace,
  exitCode,
  readSkipped,
  redact,
  summaryLines,
  targetOrigins,
  traceEvent,
  urlParts,
  writeReport,
} from './report.mjs';

const ORIGINS = targetOrigins({
  baseUrl: 'http://127.0.0.1:8090/api/v1',
  mailpitUrl: 'http://127.0.0.1:8025',
  consulUrl: 'http://127.0.0.1:8500',
});
const PASSWORD = 'admin-password-from-stdin-0123';
const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl';
const ALL_KEYS = ['assertions', 'item', 'method', 'path', 'status', 'target', 'timeMs'];

const url = (text) => ({ toString: () => text });
const response = (code, body = '{}', headers = []) => ({ code, responseTime: 12, headers, text: () => body });

function stats({ assertions = 0, assertionsFailed = 0, requests = 0, requestsFailed = 0 } = {}) {
  return {
    assertions: { total: assertions, pending: 0, failed: assertionsFailed },
    requests: { total: requests, pending: 0, failed: requestsFailed },
  };
}

function report({ trace = createTrace(ORIGINS), skipped = [], failures = [], strict = false, runStats = stats() } = {}) {
  return buildReport({
    collection: 'shop-purchase',
    environment: 'compose',
    runId: '20261113104500-3f2a',
    customerEmail: 'scenario-20261113104500-3f2a@sklep.local',
    startedAt: '2026-11-13T10:45:00.000Z',
    durationMs: 1000,
    strict,
    summary: { run: { stats: runStats, failures } },
    skipped,
    trace,
    secrets: [PASSWORD],
  });
}

// Admin login as newman emits it: password in the body, token in the response, cookies both ways.
function loginTrace() {
  const trace = createTrace(ORIGINS);
  traceEvent(trace, 'beforeItem', null, { cursor: { ref: 'r1' }, item: { name: 'Log in as admin' } });
  traceEvent(trace, 'request', null, {
    cursor: { ref: 'r1' },
    item: { name: 'Log in as admin' },
    request: {
      method: 'POST',
      url: url('http://127.0.0.1:8090/api/v1/auth/login?email=admin@sklep.local'),
      headers: [
        { key: 'Authorization', value: `Bearer ${ACCESS_TOKEN}` },
        { key: 'Cookie', value: 'refresh_token=old-refresh-value' },
      ],
      body: { mode: 'raw', raw: JSON.stringify({ email: 'admin@sklep.local', password: PASSWORD }) },
    },
    response: response(200, JSON.stringify({ accessToken: ACCESS_TOKEN, tokenType: 'Bearer', expiresIn: 900 }), [
      { key: 'Set-Cookie', value: 'refresh_token=new-refresh-value; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict' },
    ]),
  });
  traceEvent(trace, 'assertion', null, { cursor: { ref: 'r1' }, assertion: '[S10] admin login 200 with ADMIN in the token roles' });
  return trace;
}

describe('report items', () => {
  it('never contain the password from the request body, the token or the cookies', () => {
    const text = JSON.stringify(report({ trace: loginTrace() }));
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes(ACCESS_TOKEN));
    assert.ok(!text.includes('eyJ'));
    assert.ok(!text.includes('refresh_token'));
    assert.ok(!text.includes('Authorization'));
    assert.ok(!/cookie/i.test(text));
  });

  it('have exactly the whitelisted keys; path without host and query', () => {
    const [item] = report({ trace: loginTrace() }).items;
    assert.deepEqual(Object.keys(item).sort(), ALL_KEYS);
    assert.deepEqual(item, {
      item: 'Log in as admin',
      target: 'shop',
      method: 'POST',
      path: '/api/v1/auth/login',
      status: 200,
      timeMs: 12,
      assertions: [{ name: '[S10] admin login 200 with ADMIN in the token roles', passed: true }],
    });
  });

  it('name the target by the environment URL: shop, mailpit, consul, otherwise null', () => {
    assert.deepEqual(urlParts(url('http://127.0.0.1:8090/api/v1/products?q=a@b.pl&size=5'), ORIGINS), { target: 'shop', path: '/api/v1/products' });
    assert.deepEqual(urlParts(url('http://127.0.0.1:8025/api/v1/search?query=to:a@b.pl'), ORIGINS), { target: 'mailpit', path: '/api/v1/search' });
    assert.deepEqual(urlParts('http://127.0.0.1:8500/v1/health/service/order-service?passing=true', ORIGINS), { target: 'consul', path: '/v1/health/service/order-service' });
    assert.deepEqual(urlParts('http://example.com/x?y=1', ORIGINS), { target: null, path: '/x' });
    assert.deepEqual(urlParts('not a url', ORIGINS), { target: null, path: null });
  });

  it('get one entry per request (pm.sendRequest too) and assertions of the latest request of the item', () => {
    const trace = createTrace(ORIGINS);
    traceEvent(trace, 'beforeItem', null, { cursor: { ref: 'r2' }, item: { name: 'Set stock' } });
    // pm.sendRequest: anonymous item, same cursor as the item
    traceEvent(trace, 'request', null, { cursor: { ref: 'r2' }, item: {}, request: { method: 'GET', url: url('http://127.0.0.1:8090/api/v1/products?size=100') }, response: response(200) });
    traceEvent(trace, 'assertion', null, { cursor: { ref: 'r2' }, assertion: '[S11] list' });
    traceEvent(trace, 'request', null, { cursor: { ref: 'r2' }, item: { name: 'Set stock' }, request: { method: 'PUT', url: url('http://127.0.0.1:8090/api/v1/inventory/1') }, response: response(200) });
    traceEvent(trace, 'assertion', { message: 'expected 1 to equal 2' }, { cursor: { ref: 'r2' }, assertion: '[S11] put' });
    const { items } = report({ trace });
    assert.deepEqual(
      items.map((item) => [item.item, item.method, item.path, item.assertions]),
      [
        ['Set stock', 'GET', '/api/v1/products', [{ name: '[S11] list', passed: true }]],
        ['Set stock', 'PUT', '/api/v1/inventory/1', [{ name: '[S11] put', passed: false }]],
      ],
    );
  });

  it('keep an assertion of a skipped request (pre-request script) with null request fields', () => {
    const trace = createTrace(ORIGINS);
    traceEvent(trace, 'beforeItem', null, { cursor: { ref: 'r3' }, item: { name: 'Order flow (stage 8)' } });
    traceEvent(trace, 'assertion', { message: 'order flow is implemented in stage 8' }, { cursor: { ref: 'r3' }, assertion: '[S80] order flow (stage 8)' });
    const [item] = report({ trace }).items;
    assert.deepEqual(Object.keys(item).sort(), ALL_KEYS);
    assert.deepEqual(item, {
      item: 'Order flow (stage 8)',
      target: null,
      method: null,
      path: null,
      status: null,
      timeMs: null,
      assertions: [{ name: '[S80] order flow (stage 8)', passed: false }],
    });
  });

  it('fill the request fields of that entry when the item sends a request after the assertion', () => {
    const trace = createTrace(ORIGINS);
    traceEvent(trace, 'beforeItem', null, { cursor: { ref: 'r4' }, item: { name: 'Probe' } });
    traceEvent(trace, 'assertion', null, { cursor: { ref: 'r4' }, assertion: 'pre-request check' });
    traceEvent(trace, 'request', null, { cursor: { ref: 'r4' }, item: { name: 'Probe' }, request: { method: 'GET', url: url('http://127.0.0.1:8500/v1/x') }, response: response(200) });
    assert.equal(trace.items.length, 1);
    assert.equal(trace.items[0].target, 'consul');
  });

  it('show status null for a request without a response', () => {
    const trace = createTrace(ORIGINS);
    traceEvent(trace, 'beforeItem', null, { cursor: { ref: 'r5' }, item: { name: 'Cart' } });
    traceEvent(trace, 'request', new Error('connect ECONNREFUSED'), { cursor: { ref: 'r5' }, item: { name: 'Cart' }, request: { method: 'GET', url: url('http://127.0.0.1:8090/api/v1/cart') } });
    assert.deepEqual(trace.items[0], { item: 'Cart', target: 'shop', method: 'GET', path: '/api/v1/cart', status: null, timeMs: null, assertions: [] });
  });
});

describe('skipped checks', () => {
  it('come from the environment variable skipped (JSON), only {item, reason, checks}', () => {
    const value = JSON.stringify([{ item: 'Set stock of seed product', reason: 'inventory-service rejects UUID productId', checks: ['S11'], extra: 'dropped' }]);
    assert.deepEqual(readSkipped(value), [{ item: 'Set stock of seed product', reason: 'inventory-service rejects UUID productId', checks: ['S11'] }]);
    assert.deepEqual(readSkipped(undefined), []);
    assert.deepEqual(readSkipped('[]'), []);
  });

  it('reject a value that is not a list of {item, reason, checks}', () => {
    assert.throws(() => readSkipped('not json'));
    assert.throws(() => readSkipped('{}'), /not a JSON array/);
    assert.throws(() => readSkipped('[{"item":"x","reason":"y"}]'), /\{item, reason, checks\}/);
  });
});

describe('failures', () => {
  it('list the item, the assertion name and the message; other errors without an assertion', () => {
    const failures = [
      { error: { name: 'AssertionError', test: '[S61] subtotal = unitPrice x 2', message: 'expected 100 to equal 200' }, source: { name: 'Add 2 x Algorytmy' } },
      { error: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:8090' }, source: { name: 'Get the cart' } },
    ];
    assert.deepEqual(report({ failures }).failures, [
      { item: 'Add 2 x Algorytmy', assertion: '[S61] subtotal = unitPrice x 2', message: 'expected 100 to equal 200' },
      { item: 'Get the cart', assertion: null, message: 'connect ECONNREFUSED 127.0.0.1:8090' },
    ]);
  });

  it('never carry the password or a JWT, even if a message had them', () => {
    const failures = [{ error: { name: 'AssertionError', test: 'x', message: `expected '${ACCESS_TOKEN}' and ${PASSWORD}` }, source: { name: 'Log in' } }];
    const [failure] = report({ failures }).failures;
    assert.equal(failure.message, "expected '<redacted>' and <redacted>");
    assert.equal(redact('no secrets here', [PASSWORD, undefined]), 'no secrets here');
  });
});

describe('result and exit code', () => {
  const skipped = [{ item: 'Order flow (stage 8)', reason: 'order-service not registered', checks: ['S80'] }];

  it('passed (0) with no failures, also with skipped checks', () => {
    const result = report({ skipped, runStats: stats({ assertions: 10, requests: 5 }) });
    assert.equal(result.result, 'PASSED');
    assert.equal(exitCode(result), 0);
  });

  it('failed (1) with --strict and a skipped check', () => {
    const result = report({ skipped, strict: true, runStats: stats({ assertions: 10, requests: 5 }) });
    assert.equal(result.result, 'FAILED');
    assert.equal(exitCode(result), 1);
  });

  it('passed (0) with --strict and nothing skipped', () => {
    assert.equal(exitCode(report({ strict: true, runStats: stats({ assertions: 10, requests: 5 }) })), 0);
  });

  it('failed (1) with a failed assertion, a request error or a script error', () => {
    assert.equal(exitCode(report({ runStats: stats({ assertions: 10, assertionsFailed: 1 }) })), 1);
    assert.equal(exitCode(report({ runStats: stats({ requests: 5, requestsFailed: 1 }) })), 1);
    const scriptError = [{ error: { name: 'TypeError', message: 'x is undefined' }, source: { name: 'Item' } }];
    assert.equal(exitCode(report({ failures: scriptError })), 1);
  });

  it('copies the counts from the newman stats', () => {
    const result = report({ runStats: stats({ assertions: 95, assertionsFailed: 2, requests: 80, requestsFailed: 1 }) });
    assert.deepEqual(result.assertions, { total: 95, failed: 2 });
    assert.deepEqual(result.requests, { total: 80, failed: 1 });
  });
});

describe('rate limit at the shop entrance', () => {
  function rateLimited(path, body, origin = 'http://127.0.0.1:8090') {
    const trace = createTrace(ORIGINS);
    traceEvent(trace, 'request', null, { cursor: { ref: 'r6' }, item: { name: 'x' }, request: { method: 'POST', url: url(`${origin}${path}`) }, response: response(429, body) });
    return trace.rateLimited;
  }
  const tooMany = JSON.stringify({ status: 429, error: 'TOO_MANY_REQUESTS', message: 'Too many requests', requestId: 'r' });

  it('is detected on 429 TOO_MANY_REQUESTS at /auth/login and /auth/register', () => {
    assert.equal(rateLimited('/api/v1/auth/login', tooMany), true);
    assert.equal(rateLimited('/api/v1/auth/register', tooMany), true);
  });

  it('is not detected for a locked account, other paths or other targets', () => {
    assert.equal(rateLimited('/api/v1/auth/login', JSON.stringify({ status: 429, error: 'TOO_MANY_ATTEMPTS' })), false);
    assert.equal(rateLimited('/api/v1/products', tooMany), false);
    assert.equal(rateLimited('/api/v1/auth/login', tooMany, 'http://127.0.0.1:8025'), false);
    assert.equal(rateLimited('/api/v1/auth/login', 'not json'), false);
  });
});

describe('summary lines', () => {
  it('print SKIPPED per skip, the hint, then RESULT last', () => {
    const skipped = [
      { item: 'Get product Algorytmy', reason: 'inventory-service rejects UUID productId', checks: ['S47a'] },
      { item: 'Order flow (stage 8)', reason: 'order-service not registered', checks: ['S80'] },
    ];
    const result = report({ skipped, strict: true, runStats: stats({ assertions: 95, requests: 80 }) });
    assert.deepEqual(summaryLines(result, true, 'postman/reports/20261113T104500Z-compose-shop-purchase.json'), [
      'SKIPPED: Get product Algorytmy — inventory-service rejects UUID productId (S47a)',
      'SKIPPED: Order flow (stage 8) — order-service not registered (S80)',
      RATE_LIMIT_HINT,
      'RESULT: FAILED — assertions 95, failed 0, skipped checks 2, strict; report: postman/reports/20261113T104500Z-compose-shop-purchase.json',
    ]);
  });

  it('print only RESULT when nothing was skipped', () => {
    const result = report({ runStats: stats({ assertions: 3, requests: 3 }) });
    assert.deepEqual(summaryLines(result, false, 'postman/reports/r.json'), [
      'RESULT: PASSED — assertions 3, failed 0, skipped checks 0; report: postman/reports/r.json',
    ]);
  });
});

describe('report file', () => {
  async function inTempDir(test) {
    const dir = await mkdtemp(join(tmpdir(), 'report-test-'));
    try {
      await test(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('is written as JSON into a new file, the directory is created', () =>
    inTempDir(async (dir) => {
      const file = join(dir, 'reports', 'r.json');
      const content = report();
      await writeReport(file, content, 'postman/reports/r.json');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), content);
    }));

  it('never overwrites an existing file (two runs in the same second): error with the file name, content kept', () =>
    inTempDir(async (dir) => {
      const file = join(dir, 'r.json');
      await writeFile(file, 'report of the other run\n');
      await assert.rejects(writeReport(file, report(), 'postman/reports/r.json'), {
        message: 'report postman/reports/r.json already exists (another run in the same second), run again',
      });
      assert.equal(await readFile(file, 'utf8'), 'report of the other run\n');
    }));
});

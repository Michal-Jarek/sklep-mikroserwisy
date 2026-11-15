// Unit tests of service-run.ts (node --test, no network). Events are shaped as newman 6.2.3 emits them (checked in
// stage 10a): pm.sendRequest emits `request` with the cursor of its item but another, unnamed item.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SetupError } from './common.ts';
import { RATE_LIMIT_HINT } from './report.ts';
import {
  SERVICES,
  collectionResult,
  countEvent,
  createCounter,
  detailLines,
  foldersOf,
  htmlName,
  missingFolders,
  parseServiceArguments,
  phaseExitCode,
  resultLine,
  skippedItems,
  totalLines,
} from './service-run.ts';
import type { CollectionResult, Counter, RunStats } from './service-run.ts';

const GATEWAY = 'http://127.0.0.1:8090/api/v1';
const counts = (total: number, failed = 0) => ({ total, failed });

function stats({ requests = 0, assertions = 0, assertionsFailed = 0, testScripts = 0, prerequest = 0, requestsFailed = 0 } = {}): RunStats {
  return {
    requests: counts(requests, requestsFailed),
    assertions: counts(assertions, assertionsFailed),
    testScripts: counts(0, testScripts),
    prerequestScripts: counts(0, prerequest),
  };
}

const url = (text: string) => ({ toString: () => text });

/** beforeItem + the own request of an item. */
function item(counter: Counter, ref: string, name: string, method: string, address: string, code = 200): void {
  countEvent(counter, 'beforeItem', { cursor: { ref }, item: { id: `id-${ref}`, name } });
  countEvent(counter, 'request', { cursor: { ref }, item: { id: `id-${ref}`, name }, request: { method, url: url(address) }, response: { code } });
}

/** pm.sendRequest inside the item `ref`: another item id, no name. */
function sendRequest(counter: Counter, ref: string, method: string, address: string, code = 200): void {
  countEvent(counter, 'request', { cursor: { ref }, item: { id: `send-${ref}-${address}` }, request: { method, url: url(address) }, response: { code } });
}

function result(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    service: 'user-service',
    requests: 5,
    assertions: 10,
    failed: 0,
    skipped: [],
    rateLimited: [],
    gatewayRequests: 5,
    logins: 0,
    registrations: 0,
    ...overrides,
  };
}

describe('services and arguments', () => {
  it('runs the 10 collections in the order of the guidelines, auth-service last', () => {
    assert.equal(SERVICES.length, 10);
    assert.equal(SERVICES[0].name, 'api-gateway');
    assert.equal(SERVICES[9].name, 'auth-service');
    assert.equal(new Set(SERVICES.map(({ port }) => port)).size, 10);
  });

  it('runs start once (api-gateway) and via Gateway everywhere in the gateway phase, direct in the direct phase', () => {
    assert.deepEqual(foldersOf('gateway', 'api-gateway'), ['start', 'via Gateway']);
    assert.deepEqual(foldersOf('gateway', 'cart-service'), ['via Gateway']);
    assert.deepEqual(foldersOf('direct', 'api-gateway'), ['direct']);
  });

  it('names missing folders and HTML reports', () => {
    assert.deepEqual(missingFolders({ item: [{ name: 'start' }, { name: 'direct' }] }, ['start', 'via Gateway']), ['via Gateway']);
    assert.deepEqual(missingFolders(null, ['direct']), ['direct']);
    assert.equal(htmlName('k8s', 'gateway', 'order-service'), 'k8s-gateway-order-service.html');
  });

  it('parses the arguments of a phase', () => {
    const argv = ['--phase', 'gateway', '--env', 'k8s', '--environment', 'e.json', '--services-dir', '/s', '--html-dir', '/h'];
    assert.deepEqual(parseServiceArguments(argv), { phase: 'gateway', env: 'k8s', environment: 'e.json', servicesDir: '/s', htmlDir: '/h' });
  });

  it('rejects a wrong phase, a missing argument, an unknown option and direct in k8s', () => {
    const base = ['--env', 'compose', '--environment', 'e.json', '--services-dir', '/s', '--html-dir', '/h'];
    assert.throws(() => parseServiceArguments(['--phase', 'all', ...base]), SetupError);
    assert.throws(() => parseServiceArguments(['--phase', 'direct', ...base.slice(2)]), SetupError);
    assert.throws(() => parseServiceArguments(['--phase', 'direct', '--verbose', ...base]), SetupError);
    assert.throws(() => parseServiceArguments(['--phase', 'direct', ...base].map((arg) => (arg === 'compose' ? 'k8s' : arg))), /compose only/);
  });
});

describe('counter', () => {
  it('counts requests to the shop entrance with pm.sendRequest, logins and registrations; Mailpit is not the entrance', () => {
    const counter = createCounter(GATEWAY);
    item(counter, 'r1', 'Register', 'POST', `${GATEWAY}/auth/register`, 201);
    item(counter, 'r2', 'Log in customer', 'POST', `${GATEWAY}/auth/login`);
    item(counter, 'r3', 'Log in admin', 'post', `${GATEWAY}/auth/login`);
    item(counter, 'r4', 'Wait for the shipment', 'GET', `${GATEWAY}/shipments`);
    sendRequest(counter, 'r4', 'GET', `${GATEWAY}/shipments?try=2`);
    sendRequest(counter, 'r4', 'GET', 'http://127.0.0.1:8025/api/v1/messages');
    assert.equal(counter.gatewayRequests, 5);
    assert.equal(counter.logins, 2);
    assert.equal(counter.registrations, 1);
    assert.deepEqual(skippedItems(counter), []);
  });

  it('finds an item that was started but never sent, also when its pre-request script sent pm.sendRequest', () => {
    const counter = createCounter(GATEWAY);
    item(counter, 'r1', 'Sent', 'GET', `${GATEWAY}/products`);
    countEvent(counter, 'beforeItem', { cursor: { ref: 'r2' }, item: { id: 'id-r2', name: 'Skipped' } });
    sendRequest(counter, 'r2', 'GET', `${GATEWAY}/cart`);
    assert.deepEqual(skippedItems(counter), ['Skipped']);
    assert.equal(counter.gatewayRequests, 2);
  });

  it('records every answer 429 with the item, method and path', () => {
    const counter = createCounter(GATEWAY);
    item(counter, 'r1', 'Log in', 'POST', `${GATEWAY}/auth/login?x=1`, 429);
    assert.deepEqual(counter.rateLimited, [{ item: 'Log in', method: 'POST', path: '/api/v1/auth/login' }]);
  });

  it('counts nothing for the entrance in the direct phase', () => {
    const counter = createCounter();
    item(counter, 'r1', 'Health', 'GET', 'http://api-gateway:8080/health/live');
    assert.equal(counter.gatewayRequests, 0);
    assert.deepEqual(skippedItems(counter), []);
  });
});

describe('results, lines and exit codes', () => {
  it('sums failed assertions, scripts and requests into failed', () => {
    const counter = createCounter(GATEWAY);
    item(counter, 'r1', 'A', 'GET', `${GATEWAY}/a`);
    const found = collectionResult('cart-service', stats({ requests: 3, assertions: 9, assertionsFailed: 2, testScripts: 1, prerequest: 1, requestsFailed: 1 }), counter);
    assert.equal(found.failed, 5);
    assert.equal(resultLine('compose', 'gateway', found), 'compose gateway cart-service: requests 3, assertions 9, failed 5, skipped 0');
  });

  it('lists skipped items and answers 429 under the result line; in direct the 429 is judged by the assertions', () => {
    const limited = result({ skipped: ['Skipped'], rateLimited: [{ item: 'Log in', method: 'POST', path: '/api/v1/auth/login' }] });
    assert.deepEqual(detailLines('gateway', limited), ['  SKIPPED Skipped', '  429 POST /api/v1/auth/login (Log in)']);
    assert.deepEqual(detailLines('direct', limited), ['  SKIPPED Skipped', '  429 POST /api/v1/auth/login (Log in, judged by the assertions)']);
  });

  it('prints the totals of the gateway phase with the requests to the entrance, logins and registrations', () => {
    const lines = totalLines('compose', 'gateway', [result({ logins: 2, registrations: 1, gatewayRequests: 3 }), result()], 0);
    assert.deepEqual(lines, [
      'compose gateway total: collections 2, requests 10, assertions 20, failed 0, skipped 0, 429 answers 0; shop entrance: requests 8, logins 2, registrations 1',
    ]);
    assert.doesNotMatch(totalLines('compose', 'direct', [result()], 0)[0], /shop entrance/);
  });

  it('adds the hint after an answer 429 in the gateway phase and names setup errors', () => {
    const lines = totalLines('k8s', 'gateway', [result({ rateLimited: [{ item: 'x', method: 'GET', path: '/x' }] })], 1);
    assert.match(lines[0], /429 answers 1;.*; setup errors 1$/);
    assert.equal(lines[1], RATE_LIMIT_HINT);
  });

  it('counts answers 429 of the phase direct without the hint (Z9: the limit test of Auth expects one)', () => {
    const lines = totalLines('compose', 'direct', [result({ rateLimited: [{ item: 'Login rate limit (429)', method: 'POST', path: '/auth/login' }] })], 0);
    assert.deepEqual(lines, [
      'compose direct total: collections 1, requests 5, assertions 10, failed 0, skipped 0, 429 answers 1 (direct: judged by the assertions)',
    ]);
  });

  it('ends with 0 when everything passed, 1 after a failure, a skipped item or a gateway answer 429, 2 after a setup error', () => {
    const limited = result({ rateLimited: [{ item: 'x', method: 'POST', path: '/auth/login' }] });
    for (const phase of ['direct', 'gateway'] as const) {
      assert.equal(phaseExitCode(phase, [result(), result()], 0), 0);
      assert.equal(phaseExitCode(phase, [result(), result({ failed: 1 })], 0), 1);
      assert.equal(phaseExitCode(phase, [result({ skipped: ['x'] })], 0), 1);
      assert.equal(phaseExitCode(phase, [result({ failed: 3 })], 1), 2);
    }
    assert.equal(phaseExitCode('gateway', [limited], 0), 1);
    // Z9: in direct the answer 429 is judged by the assertions (a failed one makes failed > 0).
    assert.equal(phaseExitCode('direct', [limited], 0), 0);
    assert.equal(phaseExitCode('direct', [{ ...limited, failed: 1 }], 0), 1);
  });
});

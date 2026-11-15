// Unit tests of collection-check.ts on small collections built here (node --test, no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEMA_V21, budgetOf, checkCollection, jwtCount, scriptBudget, secretVariablesWithValue } from './collection-check.ts';
import type { PostmanCollection, PostmanEvent, PostmanItem } from './collection-check.ts';

const test = (...lines: string[]): PostmanEvent => ({ listen: 'test', script: { exec: lines } });
const prerequest = (...lines: string[]): PostmanEvent => ({ listen: 'prerequest', script: { exec: lines } });
const STATUS = "pm.test('status', () => pm.response.to.have.status(200));";

function request(name: string, method: string, url: string, extra: Partial<PostmanItem> = {}, header: { key: string; value: string }[] = []): PostmanItem {
  return { name, event: [test(STATUS)], request: { method, url, header }, ...extra };
}

/** A collection that follows every rule (C1–C7). */
function valid(): PostmanCollection {
  return {
    info: { schema: SCHEMA_V21 },
    variable: [{ key: 'password', value: '' }],
    item: [
      {
        name: 'start',
        item: [
          request('Register', 'POST', '{{gatewayUrl}}/auth/register'),
          request('Log in customer', 'POST', '{{gatewayUrl}}/auth/login'),
          request('Log in admin', 'POST', '{{gatewayUrl}}/auth/login'),
        ],
      },
      {
        name: 'direct',
        event: [prerequest('// shop:direct-request-id', "pm.request.headers.upsert({ key: 'X-Request-Id', value: '1' });"), test('// shop:error-format')],
        item: [
          request('Own service', 'GET', '{{baseUrl}}/health/live', {}, [{ key: 'X-User-Id', value: '{{userId}}' }]),
          {
            name: 'Prepare data',
            item: [
              request('Product', 'POST', '{{productServiceUrl}}/products', {
                event: [test(STATUS), prerequest("pm.sendRequest(pm.variables.replaceIn('{{userServiceUrl}}/users'), () => {});")],
              }),
            ],
          },
        ],
      },
      {
        name: 'via Gateway',
        event: [test('// shop:error-format')],
        item: [
          request('Profile', 'GET', '{{gatewayUrl}}/users/me', {}, [{ key: 'Authorization', value: 'Bearer {{customerToken}}' }]),
          request('Poll', 'GET', '{{gatewayUrl}}/shipments', {
            event: [test(STATUS, '// shop:budget 10', "const poll = () => pm.sendRequest(pm.environment.get('gatewayUrl') + '/shipments', () => {});")],
          }),
        ],
      },
    ],
  };
}

const folder = (collection: PostmanCollection, name: string): PostmanItem => collection.item?.find((item) => item.name === name) as PostmanItem;
const first = (collection: PostmanCollection, name: string): PostmanItem => folder(collection, name).item?.[0] as PostmanItem;

/** checkCollection of a changed copy of the valid collection. */
function violationsAfter(change: (collection: PostmanCollection) => void, service = 'user-service'): string[] {
  const collection = valid();
  change(collection);
  return checkCollection(service, collection);
}

describe('checkCollection', () => {
  it('accepts a collection that follows the rules', () => {
    assert.deepEqual(checkCollection('user-service', valid()), []);
  });

  const cases: [string, (collection: PostmanCollection) => void, RegExp, string?][] = [
    ['schema other than v2.1', (c) => Object.assign(c, { info: { schema: 'v2.0' } }), /info\.schema/],
    ['folders in another order', (c) => c.item?.reverse(), /top level must be exactly/],
    ['a request outside the three folders', (c) => c.item?.push(request('Loose', 'GET', '{{baseUrl}}/x')), /top level must be exactly/],
    ['scripts on the collection level', (c) => Object.assign(c, { event: [prerequest('pm.request.headers.add({key: "X-User-Id", value: "1"});')] }), /collection level/],
    ['auth on the collection level', (c) => Object.assign(c, { auth: { type: 'bearer' } }), /auth on the collection level/],
    ['a collection variable adminPassword with a value', (c) => c.variable?.push({ key: 'adminPassword', value: 'x' }), /adminPassword has a value/],
    ['a request without pm.test', (c) => Object.assign(first(c, 'via Gateway'), { event: [] }), /no pm\.test with a status assertion/],
    ['pm.test without a status assertion', (c) => Object.assign(first(c, 'via Gateway'), { event: [test("pm.test('body', () => pm.expect(1).to.equal(1));")] }), /no pm\.test/],
    ['pm.execution.skipRequest', (c) => first(c, 'direct').event?.push(prerequest('pm.execution.skipRequest();')), /pm\.execution\.skipRequest/],
    ['postman.setNextRequest', (c) => first(c, 'direct').event?.push(test(STATUS, "postman.setNextRequest('x');")), /postman\.setNextRequest/],
    ['no direct-request-id script in direct', (c) => folder(c, 'direct').event?.shift(), /folder direct has no prerequest script/],
    ['no error-format script in via Gateway', (c) => Object.assign(folder(c, 'via Gateway'), { event: [] }), /folder via Gateway has no test script/],
    ['folder scripts in start', (c) => Object.assign(folder(c, 'start'), { event: [test('// x')] }), /folder start has folder scripts/],
    ['{{gatewayUrl}} in direct', (c) => folder(c, 'direct').item?.push(request('Wrong', 'GET', '{{gatewayUrl}}/users/me')), /address must start with \{\{baseUrl\}\}/],
    ['{{baseUrl}} in via Gateway', (c) => folder(c, 'via Gateway').item?.push(request('Wrong', 'GET', '{{baseUrl}}/users')), /address must start with \{\{gatewayUrl\}\}/],
    ['a direct address in a script of via Gateway', (c) => first(c, 'via Gateway').event?.push(prerequest("pm.sendRequest(pm.environment.get('cartServiceUrl') + '/cart', () => {});")), /uses cartServiceUrl/],
    ['a literal address in a request', (c) => folder(c, 'direct').item?.push(request('Literal', 'GET', 'http://user-service:8082/users')), /literal http\(s\):\/\/ in the address/],
    ['a literal address in a script', (c) => first(c, 'via Gateway').event?.push(prerequest("pm.sendRequest('https://shop.localhost/api/v1/x', () => {});")), /literal http\(s\):\/\/ in a prerequest script/],
    ['Authorization header in direct', (c) => folder(c, 'direct').item?.push(request('Auth', 'GET', '{{baseUrl}}/x', {}, [{ key: 'authorization', value: 'Bearer x' }])), /header Authorization in direct/],
    ['bearer auth in direct', (c) => folder(c, 'direct').item?.push({ ...request('Auth', 'GET', '{{baseUrl}}/x'), auth: { type: 'bearer' } }), /auth bearer in direct/],
    ['basic auth to RabbitMQ outside notification-service', (c) => folder(c, 'direct').item?.push(request('Rabbit', 'GET', '{{rabbitmqUrl}}/api/queues', { request: { method: 'GET', url: '{{rabbitmqUrl}}/api/queues', auth: { type: 'basic' } } })), /auth basic in direct/],
    ['Authorization in a script of direct', (c) => first(c, 'direct').event?.push(prerequest("pm.request.headers.add({ key: 'Authorization', value: 'x' });")), /Authorization in a prerequest script of direct/],
    ['X-User-Id in via Gateway', (c) => folder(c, 'via Gateway').item?.push(request('Forged', 'GET', '{{gatewayUrl}}/users/me', {}, [{ key: 'X-User-Id', value: '1' }])), /X-User-\* headers \(allowed 0\)/],
    ['X-User-Roles set in a script of via Gateway', (c) => first(c, 'via Gateway').event?.push(prerequest("pm.request.headers.upsert({ key: 'X-User-Roles', value: 'ADMIN' });")), /X-User-\* header set in a prerequest script/],
    ['/auth/login in via Gateway', (c) => folder(c, 'via Gateway').item?.push(request('Login', 'POST', '{{gatewayUrl}}/auth/login')), /\/auth\/login in via Gateway/],
    ['/auth/login in a script of via Gateway', (c) => first(c, 'via Gateway').event?.push(prerequest("pm.sendRequest({ url: pm.environment.get('gatewayUrl') + '/auth/login', method: 'POST' }, () => {});")), /\/auth\/login in a prerequest script/],
    ['a third login in start', (c) => folder(c, 'start').item?.push(request('Again', 'POST', '{{gatewayUrl}}/auth/login')), /start must have exactly 1 POST/],
    ['no admin login in start', (c) => folder(c, 'start').item?.pop(), /start must have exactly 1 POST/],
  ];
  for (const [name, change, expected] of cases) {
    it(`finds ${name}`, () => {
      const violations = violationsAfter(change);
      assert.ok(
        violations.some((violation) => expected.test(violation)),
        `expected ${expected} in ${JSON.stringify(violations)}`,
      );
    });
  }

  it('allows basic auth to {{rabbitmqUrl}} in direct of notification-service only', () => {
    const rabbit = request('Queue', 'GET', '{{rabbitmqUrl}}/api/queues/%2F/notification.q', {
      request: { method: 'GET', url: '{{rabbitmqUrl}}/api/queues/%2F/notification.q', auth: { type: 'basic' } },
    });
    assert.deepEqual(violationsAfter((c) => folder(c, 'direct').item?.push(rabbit), 'notification-service'), []);
  });

  it('allows one request with X-User-* in via Gateway of api-gateway, not two', () => {
    const forged = request('Forged', 'GET', '{{gatewayUrl}}/users/me', {}, [{ key: 'X-User-Roles', value: 'ADMIN' }]);
    assert.deepEqual(violationsAfter((c) => folder(c, 'via Gateway').item?.push(forged), 'api-gateway'), []);
    const twice = violationsAfter((c) => folder(c, 'via Gateway').item?.push(forged, forged), 'api-gateway');
    assert.ok(twice.some((violation) => /2 requests with X-User-\* headers \(allowed 1\)/.test(violation)), JSON.stringify(twice));
  });

  it('allows {{mailpitUrl}} in via Gateway of notification-service only', () => {
    const mail = request('Mail', 'GET', '{{mailpitUrl}}/api/v1/messages');
    assert.deepEqual(violationsAfter((c) => folder(c, 'via Gateway').item?.push(mail), 'notification-service'), []);
    assert.ok(violationsAfter((c) => folder(c, 'via Gateway').item?.push(mail)).some((violation) => /\{\{mailpitUrl\}\}/.test(violation)));
  });

  it('reads scripts written as one string', () => {
    const collection = valid();
    Object.assign(first(collection, 'via Gateway'), { event: [{ listen: 'test', script: { exec: STATUS } }] });
    assert.deepEqual(checkCollection('user-service', collection), []);
  });
});

describe('budget', () => {
  it('counts a script by its marker, else by its pm.sendRequest calls', () => {
    assert.equal(scriptBudget("pm.sendRequest('a'); pm.sendRequest('b');"), 2);
    assert.equal(scriptBudget('// shop:budget 12\nconst poll = () => pm.sendRequest(url, next);'), 12);
    assert.equal(scriptBudget('pm.test("x", () => {});'), 0);
  });

  it('counts requests, their scripts and folder scripts once per request under the folder', () => {
    const collection = valid();
    // via Gateway: 2 requests + the marker 10 of "Poll".
    assert.equal(budgetOf(folder(collection, 'via Gateway')), 12);
    folder(collection, 'via Gateway').event?.push(prerequest("pm.sendRequest(pm.environment.get('gatewayUrl') + '/x', () => {});"));
    assert.equal(budgetOf(folder(collection, 'via Gateway')), 14);
    assert.equal(budgetOf(folder(collection, 'start')), 3);
  });
});

describe('secret values', () => {
  it('names password/token variables that have a value', () => {
    assert.deepEqual(
      secretVariablesWithValue([
        { key: 'adminPassword', value: 'x' },
        { key: 'customerToken', value: '' },
        { key: 'refreshTOKEN', value: 'y' },
        { key: 'baseUrl', value: 'http://a' },
        { key: 'rabbitmqAdminPassword' },
      ]),
      ['adminPassword', 'refreshTOKEN'],
    );
  });

  it('counts JWT-like texts', () => {
    assert.equal(jwtCount('a eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln b eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0'), 2);
    assert.equal(jwtCount('eyJshort.x'), 0);
  });
});

// Unit tests of common.ts (node --test). checkEntrance connects to a closed port on 127.0.0.1 only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { SetupError, checkEntrance, parseStdin, setVariable, valuesOf } from './common.ts';

const ALLOWED = { ADMIN_EMAIL: 'adminEmail', ADMIN_PASSWORD: 'adminPassword' } as const;
const PASSWORD = 'admin-password-from-stdin-0123';

describe('parseStdin', () => {
  it('maps the allowed keys to variable names, the value may contain "="', () => {
    assert.deepEqual(parseStdin(`ADMIN_EMAIL=a@sklep.local\nADMIN_PASSWORD=${PASSWORD}=x\n\n`, ALLOWED), {
      adminEmail: 'a@sklep.local',
      adminPassword: `${PASSWORD}=x`,
    });
  });

  it('rejects another key by the line number, without the value', () => {
    assert.throws(
      () => parseStdin(`ADMIN_EMAIL=a@sklep.local\nRABBITMQ_ADMIN_PASSWORD=${PASSWORD}\n`, ALLOWED),
      (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.equal(error.message, 'stdin line 2: expected ADMIN_EMAIL=<value> or ADMIN_PASSWORD=<value>');
        return true;
      },
    );
    assert.throws(() => parseStdin(PASSWORD, ALLOWED), (error: unknown) => error instanceof SetupError && !error.message.includes(PASSWORD));
  });
});

describe('environment variables', () => {
  it('sets an existing variable (enabled again) or adds a new one; valuesOf skips disabled ones', () => {
    const environment = { values: [{ key: 'adminPassword', value: '', type: 'secret', enabled: false }, { key: 'off', value: 'x', enabled: false }] };
    setVariable(environment, 'adminPassword', 'p');
    setVariable(environment, 'gatewayUrl', 'http://127.0.0.1:8090/api/v1');
    assert.deepEqual(valuesOf(environment), { adminPassword: 'p', gatewayUrl: 'http://127.0.0.1:8090/api/v1' });
  });
});

describe('checkEntrance', () => {
  it('fails with a setup error when nothing answers', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(checkEntrance(`http://127.0.0.1:${port}/api/v1`), (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.match(error.message, /^shop entrance http:\/\/127\.0\.0\.1:\d+\/api\/v1 is not reachable/);
      return true;
    });
  });

  it('fails when the answer is not from the API Gateway (no X-Gateway-Instance-Id) and passes when it is', async () => {
    let gateway = false;
    const server = createServer((_req, res) => {
      res.writeHead(401, gateway ? { 'x-gateway-instance-id': 'gw-1' } : {});
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    try {
      await assert.rejects(checkEntrance(base), SetupError);
      gateway = true;
      await checkEntrance(base);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

import { jest } from '@jest/globals';
import { buildAppConfig } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulKvRawPath } from '../routes';
import { consulFetch, consulStatusError } from './consul-http';

const ENV = { CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' };
const TOKEN = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function mockFetch() {
  return jest.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(new Response('')));
}

describe('consulFetch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends CONSUL_HTTP_TOKEN in X-Consul-Token, next to the headers of the call', async () => {
    const spy = mockFetch();
    const { consul } = buildAppConfig({ ...ENV, CONSUL_HTTP_TOKEN: TOKEN });

    await consulFetch(consul, consulKvRawPath('config/api-gateway/data'));
    await consulFetch(consul, CONSUL_REGISTER_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });

    expect(spy.mock.calls[0][0]).toBe(`http://consul:8500${consulKvRawPath('config/api-gateway/data')}`);
    expect(spy.mock.calls[0][1]?.headers).toEqual({ 'X-Consul-Token': TOKEN });
    expect(spy.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Consul-Token': TOKEN },
    });
  });

  it('sends no X-Consul-Token without CONSUL_HTTP_TOKEN (Docker Compose, Consul without ACL)', async () => {
    const spy = mockFetch();
    for (const env of [ENV, { ...ENV, CONSUL_HTTP_TOKEN: '' }]) {
      const { consul } = buildAppConfig(env);
      await consulFetch(consul, consulKvRawPath('config/api-gateway/data'));
      await consulFetch(consul, CONSUL_REGISTER_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    }

    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls.map(([, init]) => init?.headers)).toEqual([
      undefined,
      { 'Content-Type': 'application/json' },
      undefined,
      { 'Content-Type': 'application/json' },
    ]);
  });
});

describe('consulStatusError', () => {
  it('names the token variable on 403 (ACL) and keeps other statuses short', () => {
    expect(consulStatusError('Consul registration', 403).message).toBe(
      'Consul registration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)',
    );
    expect(consulStatusError('Consul', 500).message).toBe('Consul responded with 500');
  });
});

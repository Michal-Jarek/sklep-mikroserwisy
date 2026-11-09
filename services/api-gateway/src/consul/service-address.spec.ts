import { jest } from '@jest/globals';
import { LoopbackAddressError, localAddressTowards, resolveServiceAddress } from './service-address';

const CONSUL = { host: 'consul', port: 8500 };

describe('resolveServiceAddress', () => {
  it('prefers SERVICE_ADDRESS without looking at the route', async () => {
    const route = jest.fn(() => Promise.resolve('172.20.0.5'));
    await expect(resolveServiceAddress('host.docker.internal', CONSUL, route)).resolves.toBe('host.docker.internal');
    expect(route).not.toHaveBeenCalled();
  });

  it('takes the local address of the route to Consul', async () => {
    const route = jest.fn(() => Promise.resolve('172.20.0.5'));
    await expect(resolveServiceAddress('', CONSUL, route)).resolves.toBe('172.20.0.5');
    expect(route).toHaveBeenCalledWith('consul', 8500);
  });

  it('fails with a request for SERVICE_ADDRESS when the route uses a loopback address', async () => {
    const result = resolveServiceAddress('', { host: '127.0.0.1', port: 8500 }, () => Promise.resolve('127.0.0.1'));
    await expect(result).rejects.toBeInstanceOf(LoopbackAddressError);
    await expect(result).rejects.toThrow('set SERVICE_ADDRESS');
  });

  it('passes on a DNS error (Consul container stopped), so the caller can retry', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND consul'), { code: 'ENOTFOUND' });
    const result = resolveServiceAddress('', CONSUL, () => Promise.reject(dnsError));
    await expect(result).rejects.toBe(dnsError);
    await expect(result).rejects.not.toBeInstanceOf(LoopbackAddressError);
  });
});

describe('localAddressTowards (real DNS lookup and UDP socket, no packet sent)', () => {
  it('returns the loopback address for a local Consul, so the startup asks for SERVICE_ADDRESS', async () => {
    await expect(localAddressTowards('127.0.0.1', 8500)).resolves.toBe('127.0.0.1');
    await expect(resolveServiceAddress('', { host: 'localhost', port: 8500 })).rejects.toBeInstanceOf(LoopbackAddressError);
  });
});

import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { CONSUL_TIMEOUT_MS } from './consul-http';

/** The route to Consul goes through the loopback interface: Consul could not reach this address. */
export class LoopbackAddressError extends Error {
  constructor(consulHost: string) {
    super(
      `The route to Consul (${consulHost}) uses a loopback address; set SERVICE_ADDRESS to an address Consul can reach (e.g. host.docker.internal)`,
    );
    this.name = 'LoopbackAddressError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Local IPv4 address of the route to host: DNS lookup, then connect() of a UDP socket (no packet
 * is sent) and its local address. The Gateway is in two networks (backend, edge) and the order of
 * interfaces in the container is random; only the backend address is reachable for Consul (decision 5).
 */
export async function localAddressTowards(host: string, port: number): Promise<string> {
  const { address } = await withTimeout(lookup(host, { family: 4 }), CONSUL_TIMEOUT_MS, `DNS lookup of ${host} timed out`);
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, address, () => resolve());
    });
    return socket.address().address;
  } finally {
    socket.close();
  }
}

export type RouteAddressFn = (host: string, port: number) => Promise<string>;

/**
 * SERVICE_ADDRESS when set, otherwise the local address of the route to the Consul agent.
 * Throws LoopbackAddressError for 127.0.0.0/8 (e.g. a local run with CONSUL_HOST=127.0.0.1)
 * and the lookup error when CONSUL_HOST cannot be resolved (e.g. the consul container is stopped).
 */
export async function resolveServiceAddress(
  configured: string,
  consul: { host: string; port: number },
  routeAddress: RouteAddressFn = localAddressTowards,
): Promise<string> {
  if (configured) {
    return configured;
  }
  const address = await routeAddress(consul.host, consul.port);
  if (address.startsWith('127.')) {
    throw new LoopbackAddressError(consul.host);
  }
  return address;
}

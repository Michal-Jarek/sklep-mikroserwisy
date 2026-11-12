import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Logger } from 'pino';
import type { TrustedProxy } from '../config/app-config';
import { describeError } from '../consul/consul-http';

// Host names are resolved again this often (a container that restarts can get a new address).
export const TRUSTED_PROXIES_REFRESH_MS = 10_000;
// The startup waits at most this long for the first lookup; a later answer still counts.
export const TRUSTED_PROXIES_START_WAIT_MS = 2_000;
// After a temporary DNS error (not "no such name") the last addresses stay trusted at most this long after the last
// successful lookup (Z9): a removed container's address may be given to another container.
export const TRUSTED_PROXIES_STALE_MS = 60_000;

/** All addresses of a host name (dns.lookup with all: true); rejects when the name cannot be resolved. */
export type LookupAll = (hostname: string) => Promise<string[]>;

const lookupAll: LookupAll = async (hostname) => (await lookup(hostname, { all: true })).map((result) => result.address);

const IPV4_MAPPED = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/i;

/** ::ffff:a.b.c.d (an IPv4 client of a dual-stack socket) -> a.b.c.d; any other value unchanged. */
export function normalizeAddress(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  return mapped && isIPv4(mapped[1]) ? mapped[1] : address;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
  return isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
}

function addAddress(list: BlockList, address: string): void {
  const normalized = normalizeAddress(address);
  const kind = family(normalized);
  if (kind) {
    list.addAddress(normalized, kind);
  }
}

/** State of one host name after its last lookup. */
type NameState = 'resolved' | 'missing' | 'stale' | 'unresolved';

interface HostName {
  // Trusted addresses now (sorted, normalized); empty = the name is not trusted.
  addresses: string[];
  // Time of the last successful lookup; undefined before the first one.
  resolvedAt?: number;
  // undefined before the first lookup.
  state?: NameState;
}

const FAILURE_MESSAGES: Record<Exclude<NameState, 'resolved'>, (name: string) => string> = {
  missing: (name) => `Trusted proxy ${name} cannot be resolved: the name does not exist, it is not trusted`,
  stale: (name) => `Trusted proxy ${name} cannot be resolved, its last known addresses stay trusted for at most 60 s`,
  unresolved: (name) => `Trusted proxy ${name} cannot be resolved, it is not trusted`,
};

/**
 * Peers whose X-Forwarded-For the Gateway believes (TRUSTED_PROXIES, guidelines 3.3). Addresses and CIDR ranges are
 * fixed; host names are resolved at startup (the startup waits at most 2 s) and every 10 s. A name that does not exist
 * (ENOTFOUND, e.g. the container was removed) stops being trusted at once; after a temporary DNS error the last known
 * addresses stay trusted at most 60 s after the last successful lookup (Z9); before the first success a name trusts
 * nothing. One warning per change of state of a name; a changed set of addresses is logged as "Trusted proxies
 * updated" with the names and their addresses.
 */
export class TrustedProxies {
  private readonly fixed = new BlockList();
  private readonly hostnames = new Map<string, HostName>();
  private resolvedList = new BlockList();
  private refreshing?: Promise<void>;

  constructor(
    entries: readonly TrustedProxy[],
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
    private readonly lookupAddresses: LookupAll = lookupAll,
  ) {
    for (const entry of entries) {
      if (entry.kind === 'hostname') {
        this.hostnames.set(entry.name, { addresses: [] });
      } else if (entry.kind === 'subnet') {
        this.fixed.addSubnet(entry.address, entry.prefix, isIPv4(entry.address) ? 'ipv4' : 'ipv6');
      } else {
        addAddress(this.fixed, entry.address);
      }
    }
  }

  /** True when a connection from this address may tell the client address in X-Forwarded-For. */
  isTrusted(address: string | undefined): boolean {
    if (!address) {
      return false;
    }
    const normalized = normalizeAddress(address);
    const kind = family(normalized);
    return kind !== null && (this.fixed.check(normalized, kind) || this.resolvedList.check(normalized, kind));
  }

  /** First lookup of the host names (at most 2 s), then a lookup every 10 s; the timer does not keep the process alive. */
  async start(): Promise<void> {
    if (this.hostnames.size === 0) {
      return;
    }
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      this.refresh(),
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, TRUSTED_PROXIES_START_WAIT_MS);
        wait.unref();
      }),
    ]);
    clearTimeout(wait);
    setInterval(() => void this.refresh(), TRUSTED_PROXIES_REFRESH_MS).unref();
  }

  /** One lookup of every host name at a time: a slow DNS answer is not asked again before it arrives. */
  refresh(): Promise<void> {
    this.refreshing ??= this.resolveAll().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async resolveAll(): Promise<void> {
    const changed = await Promise.all([...this.hostnames].map(([name, host]) => this.resolve(name, host)));
    if (changed.includes(true)) {
      const list = new BlockList();
      for (const host of this.hostnames.values()) {
        host.addresses.forEach((address) => addAddress(list, address));
      }
      this.resolvedList = list;
      const trustedProxies = Object.fromEntries([...this.hostnames].map(([name, host]) => [name, host.addresses]));
      this.logger.info({ trustedProxies }, 'Trusted proxies updated');
    }
  }

  /** Looks the name up and updates its addresses; true when they changed. */
  private async resolve(name: string, host: HostName): Promise<boolean> {
    let addresses: string[];
    try {
      addresses = [...new Set((await this.lookupAddresses(name)).map(normalizeAddress))].sort();
      if (host.state !== undefined && host.state !== 'resolved') {
        this.logger.info({ trustedProxy: name }, `Trusted proxy ${name} can be resolved again`);
      }
      host.state = 'resolved';
      host.resolvedAt = Date.now();
    } catch (error) {
      const missing = (error as { code?: unknown } | null)?.code === 'ENOTFOUND';
      const fresh = host.resolvedAt !== undefined && Date.now() - host.resolvedAt < TRUSTED_PROXIES_STALE_MS;
      const state: NameState = missing ? 'missing' : fresh ? 'stale' : 'unresolved';
      if (state !== host.state) {
        host.state = state;
        this.logger.warn({ trustedProxy: name, reason: describeError(error) }, FAILURE_MESSAGES[state](name));
      }
      addresses = state === 'stale' ? host.addresses : [];
    }
    if (host.addresses.join(',') === addresses.join(',')) {
      return false;
    }
    host.addresses = addresses;
    return true;
  }
}

// Logic of the service collection runs (services.ts) without I/O: services and folders, arguments, counters from
// the newman events, summary lines and exit codes. postman/README.md, "Kolekcje usług".
import { parseArgs } from 'node:util';
import { SetupError, messageOf } from './common.ts';
import { RATE_LIMIT_HINT } from './report.ts';

/** The 10 service collections in the order of a run (wytyczne 10a §3.1): auth-service last, it logs the customer out. */
export const SERVICES = [
  { name: 'api-gateway', port: 8080 },
  { name: 'user-service', port: 8082 },
  { name: 'product-service', port: 8083 },
  { name: 'inventory-service', port: 8084 },
  { name: 'cart-service', port: 8085 },
  { name: 'order-service', port: 8086 },
  { name: 'shipping-service', port: 8089 },
  { name: 'review-service', port: 8088 },
  { name: 'notification-service', port: 8087 },
  { name: 'auth-service', port: 8081 },
] as const;

export type ServiceName = (typeof SERVICES)[number]['name'];
export type Phase = 'direct' | 'gateway';
export type EnvName = 'compose' | 'k8s';

/** Top-level folders of every service collection, in this order (konwencje C1). */
export const FOLDERS = { start: 'start', direct: 'direct', gateway: 'via Gateway' } as const;
/** The collection whose folder `start` runs once per run (gateway phase). */
export const START_SERVICE: ServiceName = 'api-gateway';

const USAGE =
  'usage: node services.ts --phase <direct|gateway> --env <compose|k8s> --environment <file> --services-dir <dir> --html-dir <dir>';

export interface ServiceArguments {
  phase: Phase;
  env: EnvName;
  environment: string;
  servicesDir: string;
  htmlDir: string;
}

export function parseServiceArguments(argv: string[]): ServiceArguments {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        phase: { type: 'string' },
        env: { type: 'string' },
        environment: { type: 'string' },
        'services-dir': { type: 'string' },
        'html-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new SetupError(`${messageOf(error)}\n${USAGE}`);
  }
  const { phase, env, environment } = values;
  const servicesDir = values['services-dir'];
  const htmlDir = values['html-dir'];
  if ((phase !== 'direct' && phase !== 'gateway') || (env !== 'compose' && env !== 'k8s') || !environment || !servicesDir || !htmlDir) {
    throw new SetupError(USAGE);
  }
  // NetworkPolicy of the cluster lets only the Gateway reach the services (wytyczne 10a §1).
  if (phase === 'direct' && env !== 'compose') {
    throw new SetupError('the phase direct runs in compose only');
  }
  return { phase, env, environment, servicesDir, htmlDir };
}

/** Folders newman runs for a collection: `direct`, or `start` (once per run) and `via Gateway`. */
export function foldersOf(phase: Phase, service: ServiceName): string[] {
  if (phase === 'direct') {
    return [FOLDERS.direct];
  }
  return service === START_SERVICE ? [FOLDERS.start, FOLDERS.gateway] : [FOLDERS.gateway];
}

/** Folders of `foldersOf` that the collection (top-level item names) does not have. */
export function missingFolders(collection: unknown, folders: readonly string[]): string[] {
  const items = (collection as { item?: { name?: unknown }[] } | null)?.item;
  const names = new Set(Array.isArray(items) ? items.map((item) => item?.name) : []);
  return folders.filter((folder) => !names.has(folder));
}

/** File name of the HTML report: <env>-<phase>-<service>.html (wytyczne 10a §3.6). */
export function htmlName(env: EnvName, phase: Phase, service: ServiceName): string {
  return `${env}-${phase}-${service}.html`;
}

/** The parts of a newman event argument the counter reads. */
export interface ServiceEvent {
  cursor?: { ref?: string };
  item?: { id?: string; name?: string };
  request?: { method?: string; url?: unknown };
  response?: { code?: number };
}

export interface RateLimited {
  item: string | null;
  method: string | null;
  path: string | null;
}

/**
 * Counters of one collection run. An item is requested when newman emits `request` for the item itself;
 * pm.sendRequest emits `request` with another (unnamed) item and counts as a request only.
 */
export interface Counter {
  gatewayOrigin: string | null;
  items: Map<string, { id: string | null; name: string | null }>;
  requested: Set<string>;
  gatewayRequests: number;
  logins: number;
  registrations: number;
  rateLimited: RateLimited[];
}

/** `gatewayUrl` = the shop entrance of the gateway phase (requests to it are counted), undefined in direct. */
export function createCounter(gatewayUrl?: string): Counter {
  return {
    gatewayOrigin: gatewayUrl ? new URL(gatewayUrl).origin : null,
    items: new Map(),
    requested: new Set(),
    gatewayRequests: 0,
    logins: 0,
    registrations: 0,
    rateLimited: [],
  };
}

function parseUrl(url: unknown): URL | null {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/** Records one newman event ('beforeItem' or 'request'); `o` as emitted by newman. */
export function countEvent(counter: Counter, event: string, o: ServiceEvent | undefined): void {
  const ref = o?.cursor?.ref;
  if (!o || !ref) {
    return;
  }
  if (event === 'beforeItem') {
    counter.items.set(ref, { id: o.item?.id ?? null, name: o.item?.name ?? null });
    return;
  }
  if (event !== 'request') {
    return;
  }
  const own = counter.items.get(ref);
  if (own && own.id !== null && o.item?.id === own.id) {
    counter.requested.add(ref);
  }
  const url = parseUrl(o.request?.url);
  const method = o.request?.method?.toUpperCase() ?? null;
  if (url && url.origin === counter.gatewayOrigin) {
    counter.gatewayRequests += 1;
    if (method === 'POST' && url.pathname.endsWith('/auth/login')) {
      counter.logins += 1;
    } else if (method === 'POST' && url.pathname.endsWith('/auth/register')) {
      counter.registrations += 1;
    }
  }
  if (o.response?.code === 429) {
    counter.rateLimited.push({ item: own?.name ?? null, method, path: url?.pathname ?? null });
  }
}

/** Names of the items started but never sent (pm.execution.skipRequest, a skipped request). */
export function skippedItems(counter: Counter): string[] {
  return [...counter.items].filter(([ref]) => !counter.requested.has(ref)).map(([, item]) => item.name ?? '(unnamed)');
}

interface Counts {
  total: number;
  failed: number;
}

/** The parts of summary.run.stats the runner reads. */
export interface RunStats {
  requests: Counts;
  assertions: Counts;
  testScripts: Counts;
  prerequestScripts: Counts;
}

export interface CollectionResult {
  service: ServiceName;
  requests: number;
  assertions: number;
  /** Failed assertions + failed test and pre-request scripts + failed requests (no answer). */
  failed: number;
  skipped: string[];
  rateLimited: RateLimited[];
  gatewayRequests: number;
  logins: number;
  registrations: number;
}

export function collectionResult(service: ServiceName, stats: RunStats, counter: Counter): CollectionResult {
  return {
    service,
    requests: stats.requests.total,
    assertions: stats.assertions.total,
    failed: stats.assertions.failed + stats.testScripts.failed + stats.prerequestScripts.failed + stats.requests.failed,
    skipped: skippedItems(counter),
    rateLimited: counter.rateLimited,
    gatewayRequests: counter.gatewayRequests,
    logins: counter.logins,
    registrations: counter.registrations,
  };
}

/** `<env> <phase> <service>: requests R, assertions A, failed F, skipped S` (wytyczne 10a §3.1). */
export function resultLine(env: EnvName, phase: Phase, result: CollectionResult): string {
  return `${env} ${phase} ${result.service}: requests ${result.requests}, assertions ${result.assertions}, failed ${result.failed}, skipped ${result.skipped.length}`;
}

/**
 * Lines under the result line: skipped items and answers 429. In the phase direct an answer 429 comes from the limit
 * of the service itself (e.g. the login limit test of Auth): listed, judged by the assertions of the collection (Z9).
 */
export function detailLines(phase: Phase, result: CollectionResult): string[] {
  const judged = phase === 'direct' ? ', judged by the assertions' : '';
  return [
    ...result.skipped.map((item) => `  SKIPPED ${item}`),
    ...result.rateLimited.map(({ item, method, path }) => `  429 ${method ?? '?'} ${path ?? '?'} (${item ?? '?'}${judged})`),
  ];
}

const sum = (results: readonly CollectionResult[], pick: (result: CollectionResult) => number): number =>
  results.reduce((total, result) => total + pick(result), 0);

/**
 * Total line of a phase; the gateway phase adds the requests to the shop entrance (also pm.sendRequest), logins and
 * registrations (budget of wytyczne 10a §3.7). The hint follows an answer 429 in the gateway phase (limits of the
 * shop entrance); in the phase direct answers 429 are counted only (Z9).
 */
export function totalLines(env: EnvName, phase: Phase, results: readonly CollectionResult[], setupErrors: number): string[] {
  const rateLimited = sum(results, (result) => result.rateLimited.length);
  let line =
    `${env} ${phase} total: collections ${results.length}, requests ${sum(results, (r) => r.requests)}, ` +
    `assertions ${sum(results, (r) => r.assertions)}, failed ${sum(results, (r) => r.failed)}, ` +
    `skipped ${sum(results, (r) => r.skipped.length)}, 429 answers ${rateLimited}`;
  if (phase === 'direct' && rateLimited > 0) {
    line += ' (direct: judged by the assertions)';
  }
  if (phase === 'gateway') {
    line +=
      `; shop entrance: requests ${sum(results, (r) => r.gatewayRequests)}, logins ${sum(results, (r) => r.logins)}, ` +
      `registrations ${sum(results, (r) => r.registrations)}`;
  }
  if (setupErrors > 0) {
    line += `; setup errors ${setupErrors}`;
  }
  return phase === 'gateway' && rateLimited > 0 ? [line, RATE_LIMIT_HINT] : [line];
}

/**
 * 2 after any setup error, 1 after a failure, a skipped item or (gateway phase only, Z9) an answer 429, otherwise 0.
 */
export function phaseExitCode(phase: Phase, results: readonly CollectionResult[], setupErrors: number): 0 | 1 | 2 {
  if (setupErrors > 0) {
    return 2;
  }
  const rateLimited = (result: CollectionResult) => phase === 'gateway' && result.rateLimited.length > 0;
  return results.some((result) => result.failed > 0 || result.skipped.length > 0 || rateLimited(result)) ? 1 : 0;
}

// Static rules of the service collections (konwencje 10a C1–C7, wytyczne 10a §3.8), used by collection.test.ts.
// Each check returns a list of violations ("<service>: <where>: <rule>"); an empty list = the collection is fine.
// No network, no newman: the collection JSON only.

export const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
export const TOP_FOLDERS = ['start', 'direct', 'via Gateway'] as const;
/** Requests of one run through the shop entrance: one `start` + `via Gateway` of the 10 collections (§3.7). */
export const BUDGET_LIMIT = 140;

// Address variables (§3.2, C4): direct = the own service and the other services in compose; start and via Gateway =
// the shop entrance (+ Mailpit in notification-service).
export const DIRECT_URL_VARIABLES = [
  'baseUrl',
  'apiGatewayUrl',
  'authServiceUrl',
  'userServiceUrl',
  'productServiceUrl',
  'inventoryServiceUrl',
  'cartServiceUrl',
  'orderServiceUrl',
  'notificationServiceUrl',
  'reviewServiceUrl',
  'shippingServiceUrl',
  'rabbitmqUrl',
];
const ADDRESS_VARIABLES = new Set([...DIRECT_URL_VARIABLES, 'gatewayUrl', 'mailpitUrl', 'consulUrl']);
const NOTIFICATION = 'notification-service';
const GATEWAY = 'api-gateway';

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SECRET_NAME = /password|token/i;
const FORBIDDEN_FLOW = ['pm.execution.skipRequest', 'postman.setNextRequest', 'pm.execution.setNextRequest'];
const STATUS_ASSERTION = ['pm.response.to.have.status(', 'pm.expect(pm.response.code)'];
const BUDGET_MARKER = /\/\/ shop:budget (\d+)/;
const SEND_REQUEST = 'pm.sendRequest(';
// {{name}} and pm.<scope>.get('name') in scripts.
const SCRIPT_VARIABLE = /\{\{(\w+)\}\}|\.get\(\s*['"`](\w+)['"`]\s*\)/g;
// A header X-User-* set in a script: {'X-User-Id': …}, {key: 'X-User-Roles', …}, headers.add('X-User-Id', …).
const SCRIPT_USER_HEADER = /['"`]X-User-(Id|Roles)['"`]\s*[:,]/i;
const SCRIPT_AUTHORIZATION = /['"`]Authorization['"`]/i;
const LITERAL_URL = /https?:\/\//i;

export interface PostmanScript {
  exec?: string[] | string;
}

export interface PostmanEvent {
  listen?: string;
  script?: PostmanScript;
}

export interface PostmanHeader {
  key?: string;
  value?: string;
  disabled?: boolean;
}

export interface PostmanAuth {
  type?: string;
}

export interface PostmanRequest {
  method?: string;
  url?: string | { raw?: string; host?: string[] | string };
  header?: PostmanHeader[];
  auth?: PostmanAuth;
}

export interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest | string;
  event?: PostmanEvent[];
  auth?: PostmanAuth;
}

export interface PostmanCollection extends PostmanItem {
  info?: { schema?: string };
  variable?: { key?: string; value?: unknown }[];
}

/** Text of a script (lines joined with \n). */
export function scriptText(event: PostmanEvent): string {
  const exec = event.script?.exec ?? [];
  return Array.isArray(exec) ? exec.join('\n') : String(exec);
}

const nonEmpty = (events: PostmanEvent[] | undefined): PostmanEvent[] => (events ?? []).filter((event) => scriptText(event).trim() !== '');

function firstLine(event: PostmanEvent): string {
  return scriptText(event).split('\n')[0].trim();
}

const join = (path: string, child: PostmanItem): string => (path ? `${path} / ${child.name ?? '?'}` : (child.name ?? '?'));

/** Request items under `item` (recursive) with their path "folder / sub-folder / name". */
export function requestsOf(item: PostmanItem, path = item.name ?? ''): { path: string; item: PostmanItem }[] {
  if (item.request !== undefined) {
    return [{ path, item }];
  }
  return (item.item ?? []).flatMap((child) => requestsOf(child, join(path, child)));
}

/** Every event of `item` and its children with the path of its owner. */
function eventsOf(item: PostmanItem, path = item.name ?? ''): { path: string; event: PostmanEvent }[] {
  return [
    ...nonEmpty(item.event).map((event) => ({ path: path || '(collection)', event })),
    ...(item.item ?? []).flatMap((child) => eventsOf(child, join(path, child))),
  ];
}

export function urlOf(request: PostmanItem['request']): string {
  if (typeof request === 'string') {
    return request;
  }
  const url = request?.url;
  if (typeof url === 'string') {
    return url;
  }
  if (url?.raw !== undefined) {
    return url.raw;
  }
  return Array.isArray(url?.host) ? url.host.join('.') : String(url?.host ?? '');
}

const methodOf = (request: PostmanItem['request']): string =>
  (typeof request === 'string' ? 'GET' : (request?.method ?? 'GET')).toUpperCase();

const headersOf = (request: PostmanItem['request']): PostmanHeader[] =>
  typeof request === 'string' ? [] : (request?.header ?? []).filter((header) => !header.disabled);

/** Leading {{variable}} of an address, or null. */
function addressVariable(url: string): string | null {
  return /^\{\{(\w+)\}\}/.exec(url.trim())?.[1] ?? null;
}

/** Address variables referenced in a script. */
function scriptAddressVariables(text: string): string[] {
  return [...text.matchAll(SCRIPT_VARIABLE)].map((match) => match[1] ?? match[2]).filter((name) => ADDRESS_VARIABLES.has(name));
}

/** Requests to the shop entrance a script can send: the marker `// shop:budget <N>`, else each pm.sendRequest( = 1. */
export function scriptBudget(text: string): number {
  const marker = BUDGET_MARKER.exec(text);
  return marker ? Number(marker[1]) : text.split(SEND_REQUEST).length - 1;
}

/**
 * Budget of a folder (C6): 1 per request + the budget of its scripts; a script of a folder runs for every request
 * under that folder, so its budget counts once per such request.
 */
export function budgetOf(folder: PostmanItem): number {
  if (folder.request !== undefined) {
    return 1 + nonEmpty(folder.event).reduce((total, event) => total + scriptBudget(scriptText(event)), 0);
  }
  const own = nonEmpty(folder.event).reduce((total, event) => total + scriptBudget(scriptText(event)), 0);
  const children = folder.item ?? [];
  return own * requestsOf(folder).length + children.reduce((total, child) => total + budgetOf(child), 0);
}

/** Number of JWT-like texts in a text (a file of a collection or an environment). */
export function jwtCount(text: string): number {
  return text.match(JWT_PATTERN)?.length ?? 0;
}

/** Variables with "password" or "token" in the name and a value (C1, §3.6): their names. */
export function secretVariablesWithValue(variables: readonly { key?: string; value?: unknown }[] | undefined): string[] {
  return (variables ?? [])
    .filter(({ key, value }) => SECRET_NAME.test(key ?? '') && value !== undefined && value !== null && String(value) !== '')
    .map(({ key }) => key ?? '?');
}

/** The top-level folder of a collection by name (undefined when missing). */
export function folderOf(collection: PostmanCollection, name: string): PostmanItem | undefined {
  return (collection.item ?? []).find((item) => item.name === name && Array.isArray(item.item));
}

function checkShape(service: string, collection: PostmanCollection): string[] {
  const violations: string[] = [];
  if (collection.info?.schema !== SCHEMA_V21) {
    violations.push(`${service}: info.schema is not ${SCHEMA_V21}`);
  }
  const names = (collection.item ?? []).map((item) => item.name);
  if (JSON.stringify(names) !== JSON.stringify(TOP_FOLDERS) || TOP_FOLDERS.some((name) => !folderOf(collection, name))) {
    violations.push(`${service}: top level must be exactly the folders ${TOP_FOLDERS.join(', ')} (found: ${names.join(', ')})`);
  }
  if (nonEmpty(collection.event).length > 0) {
    violations.push(`${service}: scripts on the collection level (move them to the folder direct)`);
  }
  if (collection.auth && collection.auth.type !== 'noauth') {
    violations.push(`${service}: auth on the collection level (${collection.auth.type})`);
  }
  for (const key of secretVariablesWithValue(collection.variable)) {
    violations.push(`${service}: collection variable ${key} has a value (must be empty)`);
  }
  return violations;
}

function checkRequestsAndScripts(service: string, collection: PostmanCollection): string[] {
  const violations: string[] = [];
  for (const { path, item } of requestsOf(collection, '')) {
    const tests = nonEmpty(item.event).filter((event) => event.listen === 'test').map(scriptText).join('\n');
    if (!tests.includes('pm.test(') || !STATUS_ASSERTION.some((assertion) => tests.includes(assertion))) {
      violations.push(`${service}: ${path}: no pm.test with a status assertion (pm.response.to.have.status( or pm.expect(pm.response.code))`);
    }
    if (LITERAL_URL.test(urlOf(item.request))) {
      violations.push(`${service}: ${path}: literal http(s):// in the address`);
    }
  }
  for (const { path, event } of eventsOf(collection, '')) {
    const text = scriptText(event);
    for (const call of FORBIDDEN_FLOW) {
      if (text.includes(call)) {
        violations.push(`${service}: ${path}: ${call} in a ${event.listen ?? '?'} script`);
      }
    }
    if (LITERAL_URL.test(text)) {
      violations.push(`${service}: ${path}: literal http(s):// in a ${event.listen ?? '?'} script`);
    }
  }
  return violations;
}

function checkFolderScripts(service: string, collection: PostmanCollection): string[] {
  const violations: string[] = [];
  const marker = (folder: string, listen: string, line: string) => {
    const events = nonEmpty(folderOf(collection, folder)?.event).filter((event) => event.listen === listen);
    if (!events.some((event) => firstLine(event) === line)) {
      violations.push(`${service}: folder ${folder} has no ${listen} script starting with "${line}"`);
    }
  };
  marker('direct', 'prerequest', '// shop:direct-request-id');
  marker('direct', 'test', '// shop:error-format');
  marker('via Gateway', 'test', '// shop:error-format');
  if (nonEmpty(folderOf(collection, 'start')?.event).length > 0) {
    violations.push(`${service}: folder start has folder scripts`);
  }
  return violations;
}

function checkAddresses(service: string, folderName: string, folder: PostmanItem, allowed: readonly string[]): string[] {
  const violations: string[] = [];
  for (const { path, item } of requestsOf(folder)) {
    const variable = addressVariable(urlOf(item.request));
    if (variable === null || !allowed.includes(variable)) {
      violations.push(`${service}: ${path}: address must start with {{${allowed.join('}} or {{')}}} (found ${variable ? `{{${variable}}}` : 'no variable'})`);
    }
  }
  for (const { path, event } of eventsOf(folder)) {
    for (const variable of new Set(scriptAddressVariables(scriptText(event)))) {
      if (!allowed.includes(variable)) {
        violations.push(`${service}: ${path}: ${event.listen ?? '?'} script uses ${variable}, not an address of the folder ${folderName}`);
      }
    }
  }
  return violations;
}

function checkDirectHeaders(service: string, folder: PostmanItem): string[] {
  const violations: string[] = [];
  if (folder.auth && folder.auth.type !== 'noauth') {
    violations.push(`${service}: folder direct has auth ${folder.auth.type}`);
  }
  for (const { path, item } of requestsOf(folder)) {
    if (headersOf(item.request).some((header) => /^authorization$/i.test(header.key ?? ''))) {
      violations.push(`${service}: ${path}: header Authorization in direct`);
    }
    const auth = typeof item.request === 'string' ? undefined : (item.request?.auth ?? item.auth);
    const rabbitmqBasic = service === NOTIFICATION && auth?.type === 'basic' && addressVariable(urlOf(item.request)) === 'rabbitmqUrl';
    if (auth && auth.type !== 'noauth' && !rabbitmqBasic) {
      violations.push(`${service}: ${path}: auth ${auth.type} in direct`);
    }
  }
  for (const { path, event } of eventsOf(folder)) {
    if (SCRIPT_AUTHORIZATION.test(scriptText(event))) {
      violations.push(`${service}: ${path}: Authorization in a ${event.listen ?? '?'} script of direct`);
    }
  }
  return violations;
}

function checkGatewayHeaders(service: string, folder: PostmanItem): string[] {
  const violations: string[] = [];
  const withUserHeaders = requestsOf(folder).filter(({ item }) => headersOf(item.request).some((header) => /^x-user-/i.test(header.key ?? '')));
  // The one exception (§3.5): api-gateway checks that a forged X-User-Roles: ADMIN without a token gives 401.
  const allowed = service === GATEWAY ? 1 : 0;
  if (withUserHeaders.length > allowed) {
    violations.push(`${service}: via Gateway has ${withUserHeaders.length} requests with X-User-* headers (allowed ${allowed}): ${withUserHeaders.map(({ path }) => path).join('; ')}`);
  }
  for (const { path, item } of requestsOf(folder)) {
    if (urlOf(item.request).includes('/auth/login')) {
      violations.push(`${service}: ${path}: /auth/login in via Gateway (logins only in start)`);
    }
  }
  for (const { path, event } of eventsOf(folder)) {
    const text = scriptText(event);
    if (text.includes('/auth/login')) {
      violations.push(`${service}: ${path}: /auth/login in a ${event.listen ?? '?'} script of via Gateway`);
    }
    if (SCRIPT_USER_HEADER.test(text)) {
      violations.push(`${service}: ${path}: X-User-* header set in a ${event.listen ?? '?'} script of via Gateway`);
    }
  }
  return violations;
}

/** Requests of `start` (C5, C7): exactly 1 POST {{gatewayUrl}}/auth/register and 2 POST {{gatewayUrl}}/auth/login. */
export function checkStart(service: string, start: PostmanItem): string[] {
  const requests = requestsOf(start).map(({ item }) => `${methodOf(item.request)} ${urlOf(item.request).trim()}`);
  const register = requests.filter((request) => request === 'POST {{gatewayUrl}}/auth/register').length;
  const login = requests.filter((request) => request === 'POST {{gatewayUrl}}/auth/login').length;
  if (requests.length !== 3 || register !== 1 || login !== 2) {
    return [`${service}: start must have exactly 1 POST {{gatewayUrl}}/auth/register and 2 POST {{gatewayUrl}}/auth/login (found: ${requests.join('; ')})`];
  }
  return [];
}

/** All rules of one collection (C1–C5); the rules across collections (C6 budget, C7 identical start) are separate. */
export function checkCollection(service: string, collection: PostmanCollection): string[] {
  const violations = [...checkShape(service, collection), ...checkRequestsAndScripts(service, collection), ...checkFolderScripts(service, collection)];
  const start = folderOf(collection, 'start');
  const direct = folderOf(collection, 'direct');
  const gateway = folderOf(collection, 'via Gateway');
  const gatewayAddresses = service === NOTIFICATION ? ['gatewayUrl', 'mailpitUrl'] : ['gatewayUrl'];
  if (start) {
    violations.push(...checkAddresses(service, 'start', start, ['gatewayUrl']), ...checkStart(service, start));
  }
  if (direct) {
    violations.push(...checkAddresses(service, 'direct', direct, DIRECT_URL_VARIABLES), ...checkDirectHeaders(service, direct));
  }
  if (gateway) {
    violations.push(...checkAddresses(service, 'via Gateway', gateway, gatewayAddresses), ...checkGatewayHeaders(service, gateway));
  }
  return violations;
}

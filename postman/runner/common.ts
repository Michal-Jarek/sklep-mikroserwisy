// Shared by run.ts (purchase scenario) and services.ts (service collections): setup errors, stdin with secrets,
// JSON files, Postman environments and the check of the shop entrance.
import { readFile } from 'node:fs/promises';

const PREFLIGHT_TIMEOUT_MS = 5000;
// The Gateway answers within its own 10 s budget; a request without an answer must not hold the run.
export const REQUEST_TIMEOUT_MS = 15000;

/** An error of the setup (arguments, files, stdin, shop entrance, newman exception, secret in a report): exit code 2. */
export class SetupError extends Error {}

export interface EnvironmentVariable {
  key: string;
  value: unknown;
  type?: string;
  enabled?: boolean;
}

export interface Environment {
  values: EnvironmentVariable[];
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Lines KEY=value from stdin -> { <variable name>: value } for the keys of `allowed` (stdin key -> variable name).
 * The values are never printed: an invalid line is reported by its number only.
 */
export async function readStdin<V extends string>(allowed: Readonly<Record<string, V>>): Promise<Partial<Record<V, string>>> {
  const values: Partial<Record<V, string>> = {};
  if (process.stdin.isTTY) {
    return values;
  }
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return parseStdin(text, allowed);
}

/** The parsing part of readStdin (exported for the unit tests). */
export function parseStdin<V extends string>(text: string, allowed: Readonly<Record<string, V>>): Partial<Record<V, string>> {
  const values: Partial<Record<V, string>> = {};
  text.split('\n').forEach((line, index) => {
    if (line === '') {
      return;
    }
    const separator = line.indexOf('=');
    const key = separator > 0 ? line.slice(0, separator) : '';
    if (!Object.hasOwn(allowed, key)) {
      const expected = Object.keys(allowed)
        .map((name) => `${name}=<value>`)
        .join(' or ');
      throw new SetupError(`stdin line ${index + 1}: expected ${expected}`);
    }
    values[allowed[key]] = line.slice(separator + 1);
  });
  return values;
}

export async function readJson(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new SetupError(`cannot read the ${what} ${file}: ${messageOf(error)}`);
  }
}

export function isEnvironment(value: unknown): value is Environment {
  return Array.isArray((value as { values?: unknown } | null)?.values);
}

export function setVariable(environment: Environment, key: string, value: string): void {
  const existing = environment.values.find((variable) => variable.key === key);
  if (existing) {
    Object.assign(existing, { value, enabled: true });
  } else {
    environment.values.push({ key, value, type: 'default', enabled: true });
  }
}

/** { key: value } of the enabled variables of an environment. */
export function valuesOf(environment: Environment): Record<string, unknown> {
  return Object.fromEntries(environment.values.filter((variable) => variable.enabled !== false).map((variable) => [variable.key, variable.value]));
}

// Z1 (stage 6b): GET <entrance>/cart without a token is answered by the Gateway itself (401, no service is called);
// the X-Gateway-Instance-Id header shows that nginx (or the Ingress) and the Gateway answer.
export async function checkEntrance(baseUrl: string): Promise<void> {
  let response: Response | null = null;
  try {
    response = await fetch(`${baseUrl}/cart`, { redirect: 'manual', signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    await response.body?.cancel();
  } catch {
    response = null;
  }
  if (!response?.headers.has('x-gateway-instance-id')) {
    throw new SetupError(`shop entrance ${baseUrl} is not reachable (no answer from the API Gateway)`);
  }
}

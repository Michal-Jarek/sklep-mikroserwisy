// Runs a Postman collection with newman (API, reporter cli) against the shop entrance and writes a report
// with whitelisted fields only. Started by postman/run.sh in the shop-scenario:dev image (postman/README.md).
//   node run.ts --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict]
// stdin: zero or more lines KEY=value (ADMIN_EMAIL, ADMIN_PASSWORD), set in the newman environment in memory only.
// Exit codes: 0 passed, 1 failed, 2 setup error (arguments, files, stdin, shop entrance, newman exception).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import newman from 'newman';
import type { NewmanRunOptions, NewmanRunSummary } from 'newman';
import { buildReport, createTrace, exitCode, readSkipped, summaryLines, targetOrigins, traceEvent, writeReport } from './report.ts';
import type { NewmanEvent, Skip, Trace } from './report.ts';

const USAGE =
  'usage: node run.ts --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict]';
const STDIN_VARIABLES = { ADMIN_EMAIL: 'adminEmail', ADMIN_PASSWORD: 'adminPassword' } as const;
const PREFLIGHT_TIMEOUT_MS = 5000;
// The Gateway answers within its own 10 s budget; a request without an answer must not hold the run.
const REQUEST_TIMEOUT_MS = 15000;

class SetupError extends Error {}

interface Arguments {
  collection: string;
  environment: string;
  name: string;
  report: string;
  folder: string[];
  strict: boolean;
}

interface EnvironmentVariable {
  key: string;
  value: unknown;
  type?: string;
  enabled?: boolean;
}

interface Environment {
  values: EnvironmentVariable[];
}

type StdinValues = Partial<Record<(typeof STDIN_VARIABLES)[keyof typeof STDIN_VARIABLES], string>>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseArguments(argv: string[]): Arguments {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        collection: { type: 'string' },
        environment: { type: 'string' },
        name: { type: 'string' },
        report: { type: 'string' },
        folder: { type: 'string', multiple: true },
        strict: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new SetupError(`${messageOf(error)}\n${USAGE}`);
  }
  const { collection, environment, name, report } = values;
  if (!collection || !environment || !name || !report) {
    throw new SetupError(USAGE);
  }
  return { collection, environment, name, report, folder: values.folder ?? [], strict: values.strict ?? false };
}

// The values are never printed: an invalid line is reported by its number only.
async function readStdin(): Promise<StdinValues> {
  const values: StdinValues = {};
  if (process.stdin.isTTY) {
    return values;
  }
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  text.split('\n').forEach((line, index) => {
    if (line === '') {
      return;
    }
    const separator = line.indexOf('=');
    const key = separator > 0 ? line.slice(0, separator) : '';
    if (!Object.hasOwn(STDIN_VARIABLES, key)) {
      throw new SetupError(`stdin line ${index + 1}: expected ADMIN_EMAIL=<value> or ADMIN_PASSWORD=<value>`);
    }
    values[STDIN_VARIABLES[key as keyof typeof STDIN_VARIABLES]] = line.slice(separator + 1);
  });
  return values;
}

async function readJson(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new SetupError(`cannot read the ${what} ${file}: ${messageOf(error)}`);
  }
}

function setVariable(environment: Environment, key: string, value: string): void {
  const existing = environment.values.find((variable) => variable.key === key);
  if (existing) {
    Object.assign(existing, { value, enabled: true });
  } else {
    environment.values.push({ key, value, type: 'default', enabled: true });
  }
}

// Z1: GET <baseUrl>/cart without a token is answered by the Gateway itself (401, no service is called);
// the X-Gateway-Instance-Id header shows that nginx and the Gateway answer.
async function checkEntrance(baseUrl: string): Promise<void> {
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

// <yyyymmddhhmmss UTC>-<4 hex digits>, e.g. 20261113104500-3f2a
function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
}

function runNewman(options: NewmanRunOptions, trace: Trace): Promise<NewmanRunSummary> {
  return new Promise((resolve, reject) => {
    const run = newman.run(options, (error, summary) => (error ? reject(error) : resolve(summary)));
    for (const event of ['beforeItem', 'request', 'assertion']) {
      run.on(event, (err: unknown, o: NewmanEvent) => traceEvent(trace, event, err, o));
    }
  });
}

function isCollection(value: unknown): value is { info: { name: string } } {
  return typeof (value as { info?: { name?: unknown } } | null)?.info?.name === 'string';
}

function isEnvironment(value: unknown): value is Environment {
  return Array.isArray((value as { values?: unknown } | null)?.values);
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const fromStdin = await readStdin();
  const collection = await readJson(args.collection, 'collection');
  const environment = await readJson(args.environment, 'environment');
  if (!isCollection(collection) || !isEnvironment(environment)) {
    throw new SetupError(`${args.collection} is not a Postman collection or ${args.environment} is not a Postman environment`);
  }
  const values = Object.fromEntries(environment.values.map((variable) => [variable.key, variable.value]));
  if (!values.baseUrl) {
    throw new SetupError(`the environment ${args.environment} has no baseUrl`);
  }

  await checkEntrance(String(values.baseUrl));

  const started = new Date();
  const runId = newRunId(started);
  const customerEmail = `scenario-${runId}@sklep.local`;
  for (const [key, value] of Object.entries({ ...fromStdin, runId, customerEmail, skipped: '[]' })) {
    setVariable(environment, key, value);
  }

  const trace = createTrace(targetOrigins(values));
  let summary: NewmanRunSummary;
  try {
    summary = await runNewman(
      {
        collection: collection as NewmanRunOptions['collection'],
        environment: environment as NewmanRunOptions['environment'],
        folder: args.folder.length > 0 ? args.folder : undefined,
        reporters: ['cli'],
        timeoutRequest: REQUEST_TIMEOUT_MS,
      },
      trace,
    );
  } catch (error) {
    throw new SetupError(`newman run failed: ${messageOf(error)}`);
  }
  const runError: unknown = (summary.run as { error?: unknown }).error;
  if (runError) {
    throw new SetupError(`newman run failed: ${(runError as { message?: string }).message ?? String(runError)}`);
  }

  let skipped: Skip[];
  try {
    skipped = readSkipped(summary.environment.get('skipped'));
  } catch (error) {
    throw new SetupError(messageOf(error));
  }
  const report = buildReport({
    collection: collection.info.name,
    environment: args.name,
    runId,
    customerEmail,
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    strict: args.strict,
    summary: summary as unknown as Parameters<typeof buildReport>[0]['summary'],
    skipped,
    trace,
    secrets: [fromStdin.adminPassword],
  });
  const shownAs = `postman/reports/${basename(args.report)}`;
  try {
    await writeReport(args.report, report, shownAs);
  } catch (error) {
    throw new SetupError(messageOf(error));
  }
  for (const line of summaryLines(report, trace.rateLimited, shownAs)) {
    console.log(line);
  }
  return exitCode(report);
}

// Node as PID 1 in the container ignores signals without a handler: Ctrl+C and docker stop end the run here.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`interrupted (${signal}), no report written`);
    process.exit(2);
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : `newman run failed: ${messageOf(error)}`);
  process.exitCode = 2;
}

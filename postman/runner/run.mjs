// Runs a Postman collection with newman (API, reporter cli) against the shop entrance and writes a report
// with whitelisted fields only. Started by postman/run.sh in the shop-scenario:dev image (postman/README.md).
//   node run.mjs --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict]
// stdin: zero or more lines KEY=value (ADMIN_EMAIL, ADMIN_PASSWORD), set in the newman environment in memory only.
// Exit codes: 0 passed, 1 failed, 2 setup error (arguments, files, stdin, shop entrance, newman exception).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import newman from 'newman';
import { buildReport, createTrace, exitCode, readSkipped, summaryLines, targetOrigins, traceEvent, writeReport } from './report.mjs';

const USAGE =
  'usage: node run.mjs --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict]';
const STDIN_VARIABLES = { ADMIN_EMAIL: 'adminEmail', ADMIN_PASSWORD: 'adminPassword' };
const PREFLIGHT_TIMEOUT_MS = 5000;
// The Gateway answers within its own 10 s budget; a request without an answer must not hold the run.
const REQUEST_TIMEOUT_MS = 15000;

class SetupError extends Error {}

function parseArguments(argv) {
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
    throw new SetupError(`${error.message}\n${USAGE}`);
  }
  for (const key of ['collection', 'environment', 'name', 'report']) {
    if (!values[key]) {
      throw new SetupError(USAGE);
    }
  }
  return { ...values, folder: values.folder ?? [], strict: values.strict ?? false };
}

// The values are never printed: an invalid line is reported by its number only.
async function readStdin() {
  const values = {};
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
    values[STDIN_VARIABLES[key]] = line.slice(separator + 1);
  });
  return values;
}

async function readJson(file, what) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new SetupError(`cannot read the ${what} ${file}: ${error.message}`);
  }
}

function setVariable(environment, key, value) {
  const existing = environment.values.find((variable) => variable.key === key);
  if (existing) {
    Object.assign(existing, { value, enabled: true });
  } else {
    environment.values.push({ key, value, type: 'default', enabled: true });
  }
}

// Z1: GET <baseUrl>/cart without a token is answered by the Gateway itself (401, no service is called);
// the X-Gateway-Instance-Id header shows that nginx and the Gateway answer.
async function checkEntrance(baseUrl) {
  let response = null;
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
function newRunId(now) {
  return `${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
}

function runNewman(options, trace) {
  return new Promise((resolve, reject) => {
    const run = newman.run(options, (error, summary) => (error ? reject(error) : resolve(summary)));
    for (const event of ['beforeItem', 'request', 'assertion']) {
      run.on(event, (err, o) => traceEvent(trace, event, err, o));
    }
  });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const fromStdin = await readStdin();
  const collection = await readJson(args.collection, 'collection');
  const environment = await readJson(args.environment, 'environment');
  if (typeof collection.info?.name !== 'string' || !Array.isArray(environment.values)) {
    throw new SetupError(`${args.collection} is not a Postman collection or ${args.environment} is not a Postman environment`);
  }
  const values = Object.fromEntries(environment.values.map((variable) => [variable.key, variable.value]));
  if (!values.baseUrl) {
    throw new SetupError(`the environment ${args.environment} has no baseUrl`);
  }

  await checkEntrance(values.baseUrl);

  const started = new Date();
  const runId = newRunId(started);
  const customerEmail = `scenario-${runId}@sklep.local`;
  for (const [key, value] of Object.entries({ ...fromStdin, runId, customerEmail, skipped: '[]' })) {
    setVariable(environment, key, value);
  }

  const trace = createTrace(targetOrigins(values));
  let summary;
  try {
    summary = await runNewman(
      {
        collection,
        environment,
        folder: args.folder.length > 0 ? args.folder : undefined,
        reporters: ['cli'],
        timeoutRequest: REQUEST_TIMEOUT_MS,
      },
      trace,
    );
  } catch (error) {
    throw new SetupError(`newman run failed: ${error.message}`);
  }
  if (summary.run.error) {
    throw new SetupError(`newman run failed: ${summary.run.error.message ?? summary.run.error}`);
  }

  let skipped;
  try {
    skipped = readSkipped(summary.environment.get('skipped'));
  } catch (error) {
    throw new SetupError(error.message);
  }
  const report = buildReport({
    collection: collection.info.name,
    environment: args.name,
    runId,
    customerEmail,
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    strict: args.strict,
    summary,
    skipped,
    trace,
    secrets: [fromStdin.adminPassword],
  });
  const shownAs = `postman/reports/${basename(args.report)}`;
  try {
    await writeReport(args.report, report, shownAs);
  } catch (error) {
    throw new SetupError(error.message);
  }
  for (const line of summaryLines(report, trace.rateLimited, shownAs)) {
    console.log(line);
  }
  return exitCode(report);
}

// Node as PID 1 in the container ignores signals without a handler: Ctrl+C and docker stop end the run here.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`interrupted (${signal}), no report written`);
    process.exit(2);
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : `newman run failed: ${error.message}`);
  process.exitCode = 2;
}

// Runs a Postman collection with newman (API, reporter cli) against the shop entrance and writes a report
// with whitelisted fields only. Started by postman/run.sh in the shop-scenario:dev image (postman/README.md).
//   node run.ts --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict] [--html <file>]
// stdin: zero or more lines KEY=value (ADMIN_EMAIL, ADMIN_PASSWORD), set in the newman environment in memory only.
// --html: also an HTML report (newman-reporter-html), written to /tmp first and copied to <file> only without
// secrets (html.ts). Exit codes: 0 passed, 1 failed, 2 setup error (arguments, files, stdin, shop entrance,
// newman exception, secret in the HTML report).
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import newman from 'newman';
import type { NewmanRunOptions, NewmanRunSummary } from 'newman';
import { REQUEST_TIMEOUT_MS, SetupError, checkEntrance, isEnvironment, messageOf, readJson, readStdin, setVariable } from './common.ts';
import { htmlReporterOptions, publishHtml, secretValuesOf } from './html.ts';
import { buildReport, createTrace, exitCode, readSkipped, summaryLines, targetOrigins, traceEvent, writeReport } from './report.ts';
import type { NewmanEvent, Skip, Trace } from './report.ts';

const USAGE =
  'usage: node run.ts --collection <file> --environment <file> --name <environment name> --report <file> [--folder <name>]... [--strict] [--html <file>]';
const STDIN_VARIABLES = { ADMIN_EMAIL: 'adminEmail', ADMIN_PASSWORD: 'adminPassword' } as const;
// The HTML report is written here first (tmpfs of the container), see html.ts.
const HTML_TMP_DIR = '/tmp';

interface Arguments {
  collection: string;
  environment: string;
  name: string;
  report: string;
  folder: string[];
  strict: boolean;
  html: string | undefined;
}

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
        html: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new SetupError(`${messageOf(error)}\n${USAGE}`);
  }
  const { collection, environment, name, report } = values;
  if (!collection || !environment || !name || !report) {
    throw new SetupError(USAGE);
  }
  return { collection, environment, name, report, folder: values.folder ?? [], strict: values.strict ?? false, html: values.html };
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

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const fromStdin = await readStdin(STDIN_VARIABLES);
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

  const htmlTmp = args.html ? join(HTML_TMP_DIR, basename(args.html)) : undefined;
  const trace = createTrace(targetOrigins(values));
  let summary: NewmanRunSummary;
  try {
    summary = await runNewman(
      {
        collection: collection as NewmanRunOptions['collection'],
        environment: environment as NewmanRunOptions['environment'],
        folder: args.folder.length > 0 ? args.folder : undefined,
        timeoutRequest: REQUEST_TIMEOUT_MS,
        ...(htmlTmp ? { ...htmlReporterOptions(htmlTmp), reporters: ['cli', 'html'] } : { reporters: ['cli'] }),
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

  // Before the JSON report: a secret in the HTML report ends the run with code 2 and no report at all.
  let htmlShownAs: string | undefined;
  if (args.html && htmlTmp) {
    htmlShownAs = `docs/raport/newman/${basename(args.html)}`;
    const secrets = [fromStdin.adminPassword ?? '', ...secretValuesOf(summary.environment.toJSON().values ?? [])];
    try {
      await publishHtml(htmlTmp, args.html, secrets, htmlShownAs);
    } catch (error) {
      throw error instanceof SetupError ? error : new SetupError(`cannot write the HTML report ${htmlShownAs}: ${messageOf(error)}`);
    }
  }

  const shownAs = `postman/reports/${basename(args.report)}`;
  try {
    await writeReport(args.report, report, shownAs);
  } catch (error) {
    throw new SetupError(messageOf(error));
  }
  if (htmlShownAs) {
    console.log(`HTML report: ${htmlShownAs}`);
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

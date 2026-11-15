// One phase of the service collection runs (postman/run.sh <env> --services, postman/README.md "Kolekcje usług"):
//   node services.ts --phase <direct|gateway> --env <compose|k8s> --environment <file> --services-dir <dir> --html-dir <dir>
// direct: folder `direct` of the 10 collections in the compose network sklep_backend, baseUrl = http://<service>:<port>;
//   stdin: RABBITMQ_ADMIN_PASSWORD (only the notification-service collection gets it).
// gateway: folder `start` once (collection api-gateway), then `via Gateway` of the 10 collections through the shop
//   entrance; the environment at the end of a collection and one cookie jar go on to the next collection;
//   stdin: ADMIN_EMAIL, ADMIN_PASSWORD (only the collection with `start` gets the password).
// Both phases, only in tests of the secret scan (run.sh with SHOP_TEST_SECRET): TEST_SECRET = a fake secret, set as the
//   environment variable testSecretPassword of every collection and scanned like the real ones.
// Output: one line per collection, totals, report paths; never values of secrets. HTML reports: html.ts.
// Exit codes: 0 passed, 1 failed (assertion, script, request, skipped item, answer 429 in the gateway phase), 2 setup
// error. Answers 429 in the phase direct come from the limits of the services themselves: counted, judged by the
// assertions (Z9).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import newman from 'newman';
import type { NewmanRunOptions, NewmanRunSummary } from 'newman';
import { REQUEST_TIMEOUT_MS, SetupError, checkEntrance, isEnvironment, messageOf, readJson, readStdin, setVariable, valuesOf } from './common.ts';
import type { Environment } from './common.ts';
import { htmlReporterOptions, publishHtml, safeLine, secretValuesOf } from './html.ts';
import type { NewmanFailure } from './report.ts';
import {
  SERVICES,
  START_SERVICE,
  collectionResult,
  countEvent,
  createCounter,
  detailLines,
  foldersOf,
  htmlName,
  missingFolders,
  parseServiceArguments,
  phaseExitCode,
  resultLine,
  totalLines,
} from './service-run.ts';
import type { CollectionResult, Counter, RunStats, ServiceEvent } from './service-run.ts';

const STDIN_VARIABLES = {
  direct: { RABBITMQ_ADMIN_PASSWORD: 'rabbitmqAdminPassword', TEST_SECRET: 'testSecretPassword' },
  gateway: { ADMIN_EMAIL: 'adminEmail', ADMIN_PASSWORD: 'adminPassword', TEST_SECRET: 'testSecretPassword' },
} as const;
const HTML_TMP_DIR = '/tmp';
const SHOWN_HTML_DIR = 'docs/raport/newman';
const MAX_FAILURE_LINES = 20;

// The cookie jar class of newman itself (the option cookieJar accepts only its CookieJar instances).
const { CookieJar } = createRequire(import.meta.url)('@postman/tough-cookie') as { CookieJar: new () => object };

function runCollection(options: NewmanRunOptions, counter: Counter): Promise<NewmanRunSummary> {
  return new Promise((resolve, reject) => {
    const run = newman.run(options, (error, summary) => (error ? reject(error) : resolve(summary)));
    for (const event of ['beforeItem', 'request']) {
      run.on(event, (_err: unknown, o: ServiceEvent) => countEvent(counter, event, o));
    }
  });
}

function failureLines(failures: readonly NewmanFailure[], secrets: readonly string[]): string[] {
  const lines = failures.slice(0, MAX_FAILURE_LINES).map((failure) => {
    const error = failure.error ?? {};
    const what = error.test ? `${error.test} — ` : '';
    return safeLine(`  FAILED ${failure.source?.name ?? '?'}: ${what}${error.message ?? error.name ?? ''}`, secrets);
  });
  if (failures.length > MAX_FAILURE_LINES) {
    lines.push(`  ... and ${failures.length - MAX_FAILURE_LINES} more failures (HTML report)`);
  }
  return lines;
}

const copyOf = (environment: Environment): Environment => JSON.parse(JSON.stringify(environment)) as Environment;

async function main(): Promise<number> {
  const args = parseServiceArguments(process.argv.slice(2));
  const fromStdin: Record<string, string | undefined> = await readStdin<string>(STDIN_VARIABLES[args.phase]);
  const secretKey = args.phase === 'direct' ? 'rabbitmqAdminPassword' : 'adminPassword';
  const secrets = new Set<string>();
  if (!fromStdin[secretKey]) {
    throw new SetupError(`${args.phase === 'direct' ? 'RABBITMQ_ADMIN_PASSWORD' : 'ADMIN_PASSWORD'} is missing on stdin`);
  }
  secrets.add(fromStdin[secretKey]);
  if (fromStdin.testSecretPassword) {
    secrets.add(fromStdin.testSecretPassword);
  }

  const base = await readJson(args.environment, 'environment');
  if (!isEnvironment(base)) {
    throw new SetupError(`${args.environment} is not a Postman environment`);
  }
  let gatewayUrl: string | undefined;
  if (args.phase === 'direct' && fromStdin.testSecretPassword) {
    setVariable(base, 'testSecretPassword', fromStdin.testSecretPassword);
  }
  if (args.phase === 'gateway') {
    for (const [key, value] of Object.entries(fromStdin)) {
      setVariable(base, key, value ?? '');
    }
    gatewayUrl = String(valuesOf(base).gatewayUrl ?? '');
    if (!gatewayUrl) {
      throw new SetupError(`the environment ${args.environment} has no gatewayUrl`);
    }
    await checkEntrance(gatewayUrl);
  }

  const cookieJar = args.phase === 'gateway' ? new CookieJar() : undefined;
  let environment = base;
  const results: CollectionResult[] = [];
  const reports: { tmp: string; target: string; shownAs: string }[] = [];
  let setupErrors = 0;

  for (const service of SERVICES) {
    const folders = foldersOf(args.phase, service.name);
    const file = join(args.servicesDir, service.name, 'postman', `${service.name}.postman_collection.json`);
    const name = htmlName(args.env, args.phase, service.name);
    try {
      const collection = await readJson(file, 'collection');
      const missing = missingFolders(collection, folders);
      if (missing.length > 0) {
        throw new SetupError(`the collection has no folder ${missing.map((folder) => `"${folder}"`).join(', ')}`);
      }
      let runEnvironment = environment;
      if (args.phase === 'direct') {
        runEnvironment = copyOf(base);
        setVariable(runEnvironment, 'baseUrl', `http://${service.name}:${service.port}`);
        if (service.name === 'notification-service') {
          setVariable(runEnvironment, 'rabbitmqAdminPassword', fromStdin.rabbitmqAdminPassword ?? '');
        }
      }
      const counter = createCounter(gatewayUrl);
      const tmp = join(HTML_TMP_DIR, name);
      let summary: NewmanRunSummary;
      try {
        summary = await runCollection(
          {
            collection: collection as NewmanRunOptions['collection'],
            environment: runEnvironment as NewmanRunOptions['environment'],
            folder: folders,
            timeoutRequest: REQUEST_TIMEOUT_MS,
            ...(cookieJar ? { cookieJar: cookieJar as NewmanRunOptions['cookieJar'] } : {}),
            ...htmlReporterOptions(tmp),
          },
          counter,
        );
      } catch (error) {
        throw new SetupError(`newman run failed: ${messageOf(error)}`);
      }
      const runError: unknown = (summary.run as { error?: unknown }).error;
      if (runError) {
        throw new SetupError(`newman run failed: ${(runError as { message?: string }).message ?? String(runError)}`);
      }
      const endEnvironment = summary.environment.toJSON() as Environment;
      for (const value of secretValuesOf(endEnvironment.values ?? [])) {
        secrets.add(value);
      }
      if (args.phase === 'gateway') {
        environment = { values: endEnvironment.values ?? [] };
        // Only `start` logs in; the collections after it get no admin password (least privilege).
        if (service.name === START_SERVICE) {
          setVariable(environment, 'adminPassword', '');
        }
      }
      const result = collectionResult(service.name, summary.run.stats as unknown as RunStats, counter);
      results.push(result);
      console.log(resultLine(args.env, args.phase, result));
      for (const line of [...detailLines(args.phase, result), ...failureLines(summary.run.failures as unknown as NewmanFailure[], [...secrets])]) {
        console.log(line);
      }
      reports.push({ tmp, target: join(args.htmlDir, name), shownAs: `${SHOWN_HTML_DIR}/${name}` });
    } catch (error) {
      setupErrors += 1;
      console.log(safeLine(`${args.env} ${args.phase} ${service.name}: SETUP ERROR ${messageOf(error)}`, [...secrets]));
    }
  }

  // Scanned at the end of the phase with every secret value seen in the phase (a token may change on the way).
  for (const report of reports) {
    try {
      await publishHtml(report.tmp, report.target, [...secrets], report.shownAs);
      console.log(`report: ${report.shownAs}`);
    } catch (error) {
      setupErrors += 1;
      console.log(error instanceof SetupError ? error.message : `cannot write the HTML report ${report.shownAs}: ${messageOf(error)}`);
    }
  }
  for (const line of totalLines(args.env, args.phase, results, setupErrors)) {
    console.log(line);
  }
  return phaseExitCode(args.phase, results, setupErrors);
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

// Report of a newman run built from whitelisted fields only: no bodies, headers, cookies or environment
// values ever reach it (postman/README.md, "Raport"). run.mjs feeds the newman events and summary; the only I/O
// here is writeReport.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const RATE_LIMIT_HINT = 'hint: rate limit of the shop entrance reached, wait 60 s and run again';

// Environment variables with the base URLs -> target name in the report.
const TARGET_VARIABLES = { baseUrl: 'shop', mailpitUrl: 'mailpit', consulUrl: 'consul' };
const RATE_LIMITED_PATH = /\/auth\/(login|register)$/;
// JWT-like text; replaced in free-text fields as a second line of defence (assertions never compare tokens).
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g;

/** Map origin -> target from the environment values ({ baseUrl, mailpitUrl, consulUrl }). */
export function targetOrigins(values) {
  const origins = new Map();
  for (const [key, target] of Object.entries(TARGET_VARIABLES)) {
    if (values[key]) {
      origins.set(new URL(values[key]).origin, target);
    }
  }
  return origins;
}

/** Target and path (no host, no query) of a request URL; postman-collection Url objects print the full URL. */
export function urlParts(url, origins) {
  try {
    const parsed = new URL(String(url));
    return { target: origins.get(parsed.origin) ?? null, path: parsed.pathname };
  } catch {
    return { target: null, path: null };
  }
}

/**
 * Collected newman events. One entry per HTTP request (also pm.sendRequest); an assertion belongs to the latest
 * request of its item. An assertion before any request of the item (pre-request script of a skipped request)
 * gets an entry without request fields (null).
 */
export function createTrace(origins) {
  return { origins, items: [], latest: new Map(), names: new Map(), withoutRequest: new Set(), rateLimited: false };
}

function errorCodeOf(response) {
  try {
    return JSON.parse(response.text()).error ?? null;
  } catch {
    return null;
  }
}

function newEntry(trace, ref) {
  const entry = { item: trace.names.get(ref) ?? null, target: null, method: null, path: null, status: null, timeMs: null, assertions: [] };
  trace.items.push(entry);
  trace.latest.set(ref, entry);
  return entry;
}

/** Records one newman event ('beforeItem', 'request' or 'assertion'); (err, o) as emitted by newman. */
export function traceEvent(trace, event, err, o) {
  const ref = o?.cursor?.ref;
  if (!ref) {
    return;
  }
  if (event === 'beforeItem') {
    trace.names.set(ref, o.item?.name ?? null);
  } else if (event === 'request') {
    let entry = trace.latest.get(ref);
    if (entry && trace.withoutRequest.has(entry)) {
      trace.withoutRequest.delete(entry);
    } else {
      entry = newEntry(trace, ref);
    }
    const { target, path } = urlParts(o.request?.url, trace.origins);
    Object.assign(entry, {
      target,
      method: o.request?.method ?? null,
      path,
      status: o.response?.code ?? null,
      timeMs: o.response?.responseTime ?? null,
    });
    if (entry.status === 429 && target === 'shop' && RATE_LIMITED_PATH.test(path) && errorCodeOf(o.response) === 'TOO_MANY_REQUESTS') {
      trace.rateLimited = true;
    }
  } else if (event === 'assertion') {
    let entry = trace.latest.get(ref);
    if (!entry) {
      entry = newEntry(trace, ref);
      trace.withoutRequest.add(entry);
    }
    entry.assertions.push({ name: String(o.assertion), passed: !err && !o.skipped });
  }
}

/** Value of the environment variable `skipped` (JSON written by the collection) -> [{ item, reason, checks }]. */
export function readSkipped(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('environment variable skipped is not a JSON array');
  }
  return parsed.map((entry) => {
    const valid = typeof entry?.item === 'string' && typeof entry.reason === 'string' && Array.isArray(entry.checks) && entry.checks.every((check) => typeof check === 'string');
    if (!valid) {
      throw new Error('environment variable skipped has an entry other than {item, reason, checks}');
    }
    return { item: entry.item, reason: entry.reason, checks: [...entry.checks] };
  });
}

/** Removes known secret values and JWT-like text from a free-text field. */
export function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join('<redacted>');
    }
  }
  return result.replace(JWT_PATTERN, '<redacted>');
}

function failureOf(failure, secrets) {
  const error = failure.error ?? {};
  return {
    item: failure.source?.name ?? null,
    assertion: error.name === 'AssertionError' && error.test ? redact(error.test, secrets) : null,
    message: redact(error.message ?? error, secrets),
  };
}

function uniqueChecks(skipped) {
  return [...new Set(skipped.flatMap((entry) => entry.checks))];
}

/**
 * The report (fields of the contract only). `summary` is the newman summary (run.stats, run.failures),
 * `skipped` from readSkipped, `trace` from createTrace/traceEvent, `secrets` = values to remove from texts.
 */
export function buildReport({ collection, environment, runId, customerEmail, startedAt, durationMs, strict, summary, skipped, trace, secrets = [] }) {
  const { stats } = summary.run;
  const failures = summary.run.failures.map((failure) => failureOf(failure, secrets));
  const passed = stats.assertions.failed === 0 && stats.requests.failed === 0 && failures.length === 0 && !(strict && skipped.length > 0);
  return {
    collection,
    environment,
    runId,
    customerEmail,
    startedAt,
    durationMs,
    strict,
    result: passed ? 'PASSED' : 'FAILED',
    requests: { total: stats.requests.total, failed: stats.requests.failed },
    assertions: { total: stats.assertions.total, failed: stats.assertions.failed },
    skipped,
    failures,
    items: trace.items.map((entry) => ({ ...entry, assertions: entry.assertions.map(({ name, passed: ok }) => ({ name: redact(name, secrets), passed: ok })) })),
  };
}

/**
 * Writes the report as a new file: an existing file (another run within the same second) is never overwritten.
 * Errors name the file by `shownAs` (the path for the user, e.g. postman/reports/<file>).
 */
export async function writeReport(file, report, shownAs) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    throw new Error(
      error.code === 'EEXIST'
        ? `report ${shownAs} already exists (another run in the same second), run again`
        : `cannot write the report ${shownAs}: ${error.message}`,
    );
  }
}

/** Exit code of the run: 0 passed, 1 failed (also any skipped check with --strict). */
export function exitCode(report) {
  return report.result === 'PASSED' ? 0 : 1;
}

/** Lines printed after the newman output: SKIPPED for each skip, hint on 429 at login/registration, RESULT last. */
export function summaryLines(report, rateLimited, reportPath) {
  const lines = report.skipped.map((entry) => `SKIPPED: ${entry.item} — ${entry.reason} (${entry.checks.join(', ')})`);
  if (rateLimited) {
    lines.push(RATE_LIMIT_HINT);
  }
  const strict = report.strict ? ', strict' : '';
  lines.push(
    `RESULT: ${report.result} — assertions ${report.assertions.total}, failed ${report.assertions.failed}, ` +
      `skipped checks ${uniqueChecks(report.skipped).length}${strict}; report: ${reportPath}`,
  );
  return lines;
}

// HTML reports (newman-reporter-html 1.0.5, postman/README.md "Raporty HTML"). newman writes each report to /tmp of
// the container (tmpfs) first; publishHtml scans it for secrets and only a clean report reaches docs/raport/newman/.
// A report with a secret is removed and the run ends with code 2; the message has counts only, never values.
// Assertion messages shorten long values (chai: "expected 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij…' to equal …"), so the scan
// looks for pieces of the values and for the start of a JWT, not only for whole values.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { SetupError } from './common.ts';

// The start of a JWT (base64url of '{"…'): the pattern of wytyczne 10a §3.6 without the dot and the second part
// (Z7), so a token cut short by an assertion message also matches.
const JWT_START = /eyJ[A-Za-z0-9_-]{10,}/g;
const SECRET_NAME = /password|token/i;
// Shorter values of password/token variables (e.g. a placeholder "invalid") are not secrets and would match
// ordinary text of the report; the generated passwords (48 hex) and tokens (JWT) are much longer.
export const MIN_SECRET_LENGTH = 8;
// A value at least this long counts as found when any piece of this length occurs (a shortened value shows its start).
export const PIECE_LENGTH = 10;
export const HIDDEN_LINE = '  <hidden: the message contains a secret, a piece of it or a JWT>';
// Entities of handlebars 4 ({{ }} in the templates of the reporter) and numeric ones.
const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

/** newman options of the html reporter writing to `file`. */
export function htmlReporterOptions(file: string): { reporters: string[]; reporter: { html: { export: string } } } {
  return { reporters: ['html'], reporter: { html: { export: file } } };
}

/** Values of the variables whose names contain "password" or "token" (any case), at least MIN_SECRET_LENGTH long. */
export function secretValuesOf(variables: readonly { key: string; value: unknown }[]): string[] {
  return variables
    .filter(({ key, value }) => SECRET_NAME.test(key) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(({ value }) => value as string);
}

function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** The text as it is, with HTML entities decoded and also with JSON escapes (\" \\ \/) removed. */
function variantsOf(text: string): string[] {
  const decoded = decodeHtml(text);
  return [...new Set([text, decoded, decoded.replace(/\\(["\\/])/g, '$1')])];
}

const distinctOf = (secrets: readonly string[]): string[] => [...new Set(secrets.filter((secret) => secret.length > 0))];

/** piece -> index in `secrets` for the values of at least PIECE_LENGTH characters. */
function piecesOf(secrets: readonly string[]): Map<string, number> {
  const pieces = new Map<string, number>();
  secrets.forEach((secret, index) => {
    for (let start = 0; start + PIECE_LENGTH <= secret.length; start += 1) {
      pieces.set(secret.slice(start, start + PIECE_LENGTH), index);
    }
  });
  return pieces;
}

/**
 * Number of the given secret values found in `text` (a value shorter than PIECE_LENGTH as a whole, a longer one by
 * any piece of PIECE_LENGTH characters; also HTML- and JSON-escaped) and of texts that start like a JWT.
 */
export function findSecrets(text: string, secrets: readonly string[]): { values: number; jwt: number } {
  const distinct = distinctOf(secrets);
  const pieces = piecesOf(distinct);
  const found = new Set<number>();
  for (const variant of variantsOf(text)) {
    for (let start = 0; start + PIECE_LENGTH <= variant.length; start += 1) {
      const index = pieces.get(variant.slice(start, start + PIECE_LENGTH));
      if (index !== undefined) {
        found.add(index);
      }
    }
    distinct.forEach((secret, index) => {
      if (secret.length < PIECE_LENGTH && variant.includes(secret)) {
        found.add(index);
      }
    });
  }
  return { values: found.size, jwt: text.match(JWT_START)?.length ?? 0 };
}

/** True when `text` holds a secret value or a piece of it, or a JWT start (findSecrets finds anything). */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  const found = findSecrets(text, secrets);
  return found.values > 0 || found.jwt > 0;
}

/** A line for the output: the line itself, or as a whole HIDDEN_LINE when it holds a secret, a piece of it or a JWT start. */
export function safeLine(line: string, secrets: readonly string[]): string {
  return containsSecret(line, secrets) ? HIDDEN_LINE : line;
}

/**
 * Copies the report `tmpFile` to `target` (an older report of the same name is replaced) when it holds no secret,
 * and removes `tmpFile`. With a secret both files are removed and a SetupError names the report by `shownAs`.
 */
export async function publishHtml(tmpFile: string, target: string, secrets: readonly string[], shownAs: string): Promise<void> {
  const text = await readFile(tmpFile, 'utf8');
  const found = findSecrets(text, secrets);
  if (found.values > 0 || found.jwt > 0) {
    await rm(tmpFile, { force: true });
    await rm(target, { force: true });
    throw new SetupError(
      `secret found in the HTML report ${shownAs} (secret values ${found.values}, JWT-like texts ${found.jwt}), the report is removed`,
    );
  }
  await writeFile(target, text);
  await rm(tmpFile, { force: true });
}

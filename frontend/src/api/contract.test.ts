// K35: the table "Endpointy używane przez frontend" in docs/frontend-api.md, API_ENDPOINTS of the client
// and the MSW handlers list exactly the same endpoints (both directions).
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractPath, handlers } from '../mocks/handlers';
import { API_ENDPOINTS } from './paths';

const TABLE_HEADING = '## Endpointy używane przez frontend';
const ROW = /^\|\s*`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`\s*\|/;

/** `METHOD /path` from the first column of the table, until the next heading. */
function documentedEndpoints(markdown: string): string[] {
  const start = markdown.indexOf(TABLE_HEADING);
  if (start < 0) {
    throw new Error(`Heading "${TABLE_HEADING}" not found in docs/frontend-api.md`);
  }
  const section = markdown.slice(start + TABLE_HEADING.length).split(/\n## /)[0];
  return section
    .split('\n')
    .map((line) => ROW.exec(line))
    .filter((match) => match !== null)
    .map((match) => `${match[1]} ${match[2]}`);
}

function difference(left: string[], right: string[]): string[] {
  return left.filter((endpoint) => !right.includes(endpoint));
}

function report(name: string, actual: string[], documented: string[]): string {
  return [
    `${name} differs from docs/frontend-api.md:`,
    `  missing in ${name}: ${difference(documented, actual).join(', ') || '-'}`,
    `  not in the document: ${difference(actual, documented).join(', ') || '-'}`,
  ].join('\n');
}

// Path relative to this file (Vite does not serve files outside frontend/, so it is read from disk).
const documented = documentedEndpoints(readFileSync(new URL('../../../docs/frontend-api.md', import.meta.url), 'utf8'));

describe('contract K35: document = client = mocks', () => {
  it('has the 31 endpoints of the table, without duplicates', () => {
    expect(documented).toHaveLength(31);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('API_ENDPOINTS of the client equals the table', () => {
    const client = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    const same = difference(client, documented).length === 0 && difference(documented, client).length === 0;
    expect(same, report('API_ENDPOINTS', client, documented)).toBe(true);
    expect(client).toHaveLength(new Set(client).size);
  });

  it('MSW handlers equal the table', () => {
    const mocked = handlers.map((h) => `${String(h.info.method)} ${contractPath(h)}`);
    const same = difference(mocked, documented).length === 0 && difference(documented, mocked).length === 0;
    expect(same, report('MSW handlers', mocked, documented)).toBe(true);
    expect(mocked).toHaveLength(new Set(mocked).size);
  });
});

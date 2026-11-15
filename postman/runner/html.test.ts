// Unit tests of html.ts (node --test, no network): the secret scan, the hidden output lines and the copy of a clean
// report. Only fake secrets (random-looking test values), never real ones.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SetupError } from './common.ts';
import { HIDDEN_LINE, MIN_SECRET_LENGTH, PIECE_LENGTH, findSecrets, htmlReporterOptions, publishHtml, safeLine, secretValuesOf } from './html.ts';

// A fake value from stdin (48 hex characters like deploy/create-secrets.sh) and a fake JWT.
const STDIN_SECRET = '5f0c2a9e71d84b36a0e9c4f7b2d18e6a93c05b7f1e4d2a68';
const FAKE_JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlcyI6WyJBRE1JTiJdfQ.ZmFrZS1zaWduYXR1cmUtdmFsdWU';
// chai shortens long values in assertion messages: the first ~37 characters and "…".
const chaiShort = (value: string) => `expected '${value.slice(0, 37)}…' to equal 'x'`;
const CLEAN = '<html><body><h1>compose-gateway-api-gateway</h1><p>status is 200</p><td>2f9d4c1e-8a37-4b62-9e05-7c1d3b8a6f40</td></body></html>';

const exists = async (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'html-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('secret values', () => {
  it('takes values of password/token variables (any case) of at least MIN_SECRET_LENGTH characters', () => {
    const values = secretValuesOf([
      { key: 'adminToken', value: FAKE_JWT },
      { key: 'customerPASSWORD', value: 'x'.repeat(MIN_SECRET_LENGTH) },
      { key: 'refreshToken', value: 'short' },
      { key: 'customerEmail', value: 'postman-1@sklep.local' },
      { key: 'rabbitmqAdminPassword', value: '' },
      { key: 'tokenCount', value: 12345678 },
    ]);
    assert.deepEqual(values, [FAKE_JWT, 'x'.repeat(MIN_SECRET_LENGTH)]);
  });

  it('finds a whole value, a value shortened like chai and any piece of PIECE_LENGTH characters', () => {
    assert.deepEqual(findSecrets(`expected '${STDIN_SECRET}' to be empty`, [STDIN_SECRET]), { values: 1, jwt: 0 });
    assert.deepEqual(findSecrets(chaiShort(STDIN_SECRET), [STDIN_SECRET]), { values: 1, jwt: 0 });
    assert.deepEqual(findSecrets(`…${STDIN_SECRET.slice(20, 20 + PIECE_LENGTH)}…`, [STDIN_SECRET]), { values: 1, jwt: 0 });
    assert.deepEqual(findSecrets(`…${STDIN_SECRET.slice(20, 20 + PIECE_LENGTH - 1)}…`, [STDIN_SECRET]), { values: 0, jwt: 0 });
  });

  it('finds HTML-escaped and JSON-escaped values; a value shorter than PIECE_LENGTH only as a whole', () => {
    const special = `pa"ss<wo>rd='1'&x`;
    assert.deepEqual(findSecrets('pa&quot;ss&lt;wo&gt;rd&#x3D;&#x27;1&#x27;&amp;x', [special]), { values: 1, jwt: 0 });
    assert.deepEqual(findSecrets('pa\\"ss<wo>rd=\'1\'&x', [special]), { values: 1, jwt: 0 });
    assert.deepEqual(findSecrets('a short1 b', ['short123']), { values: 0, jwt: 0 });
    assert.deepEqual(findSecrets('a short123 b', ['short123']), { values: 1, jwt: 0 });
  });

  it('finds JWTs whole, shortened like chai and as the header only, without knowing the value', () => {
    // Header and payload of a whole JWT both start with eyJ.
    assert.equal(findSecrets(`token ${FAKE_JWT}`, []).jwt, 2);
    assert.equal(findSecrets(chaiShort(FAKE_JWT), []).jwt, 1);
    assert.equal(findSecrets(FAKE_JWT.split('.')[0], []).jwt, 1);
    assert.equal(findSecrets('eyJhbGciOi', []).jwt, 0);
  });

  it('finds nothing in a clean report, with duplicate and empty values', () => {
    assert.deepEqual(findSecrets(CLEAN, [STDIN_SECRET, STDIN_SECRET, '', FAKE_JWT]), { values: 0, jwt: 0 });
  });

  it('configures the html reporter with the export file', () => {
    assert.deepEqual(htmlReporterOptions('/tmp/x.html'), { reporters: ['html'], reporter: { html: { export: '/tmp/x.html' } } });
  });
});

describe('safeLine', () => {
  it('hides a whole output line with a shortened value, a piece of it or a JWT start', () => {
    for (const line of [
      `  FAILED Quote: quotes the secret — ${chaiShort(STDIN_SECRET)}`,
      `  FAILED x: y ${STDIN_SECRET.slice(5, 5 + PIECE_LENGTH)}`,
      `  FAILED Quote: quotes the token — ${chaiShort(FAKE_JWT)}`,
      `compose gateway api-gateway: SETUP ERROR newman run failed: ${FAKE_JWT.split('.')[0]}`,
    ]) {
      assert.equal(safeLine(line, [STDIN_SECRET]), HIDDEN_LINE);
    }
  });

  it('keeps a line without secrets', () => {
    const line = '  FAILED Profile: status is 200 — expected response to have status code 200 but got 401';
    assert.equal(safeLine(line, [STDIN_SECRET, FAKE_JWT]), line);
  });
});

describe('publishHtml', () => {
  it('copies a clean report over an older one and removes the temporary file', () =>
    withDir(async (dir) => {
      const tmp = join(dir, 'tmp.html');
      const target = join(dir, 'compose-gateway-api-gateway.html');
      await writeFile(tmp, CLEAN);
      await writeFile(target, 'older report');
      await publishHtml(tmp, target, [STDIN_SECRET, FAKE_JWT], 'docs/raport/newman/compose-gateway-api-gateway.html');
      assert.equal(await readFile(target, 'utf8'), CLEAN);
      assert.equal(await exists(tmp), false);
    }));

  for (const [what, content] of [
    ['a value from stdin', `<td>AssertionError: expected '${STDIN_SECRET}' to be empty</td>`],
    ['a value from stdin shortened like chai', `<td>AssertionError: ${chaiShort(STDIN_SECRET)}</td>`],
    ['the first 20 characters of a value from stdin', `<td>${STDIN_SECRET.slice(0, 20)}&#x3D;</td>`],
    ['a JWT shortened like chai', `<td>${chaiShort(FAKE_JWT)}</td>`],
    ['the header of a JWT', `<td>${FAKE_JWT.split('.')[0]}</td>`],
  ] as const) {
    it(`removes the report and an older one with ${what} (exit code 2), the error has no value`, () =>
      withDir(async (dir) => {
        const tmp = join(dir, 'tmp.html');
        const target = join(dir, 'compose-scenario.html');
        await writeFile(tmp, content);
        await writeFile(target, CLEAN);
        await assert.rejects(publishHtml(tmp, target, [STDIN_SECRET], 'docs/raport/newman/compose-scenario.html'), (error: unknown) => {
          assert.ok(error instanceof SetupError, 'SetupError = exit code 2 of the runner');
          assert.match(error.message, /^secret found in the HTML report docs\/raport\/newman\/compose-scenario\.html \(secret values \d, JWT-like texts \d\), the report is removed$/);
          assert.ok(!error.message.includes(STDIN_SECRET.slice(0, PIECE_LENGTH)) && !error.message.includes('eyJ'));
          return true;
        });
        assert.equal(await exists(tmp), false);
        assert.equal(await exists(target), false);
      }));
  }
});

// Static checks without newman and network (node --test, postman/README.md):
// - the collection shop-purchase: no check is skipped any more (stage 8: Inventory and Review take UUID, Order and
//   Shipping exist; a new skip reason is a decision of the project owner) and the check ids [S..] are exactly the
//   documented list (postman/README.md, "Co sprawdza kolekcja");
// - the 10 service collections (konwencje 10a C1–C7, rules in collection-check.ts) and the environments: shape,
//   assertions, folder scripts, addresses, headers, identical `start`, budget of the shop entrance, no secrets.
// The service collections are read from ../../services/<service>/postman/: in the container the folders are mounted
// read-only to /opt/scenario/services/<service>/postman (postman/test.sh).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BUDGET_LIMIT, budgetOf, checkCollection, folderOf, jwtCount, requestsOf, secretVariablesWithValue } from './collection-check.ts';
import type { PostmanCollection } from './collection-check.ts';
import { SERVICES, START_SERVICE } from './service-run.ts';

// Next to runner/ both in the repository and in the container (/opt/scenario/work/collections); a missing file fails.
const COLLECTION = new URL('../collections/shop-purchase.postman_collection.json', import.meta.url);

// 49 check ids in the order of the folders.
const CHECK_IDS = [
  'S01', 'S02', 'S03',
  'S10', 'S11', 'S12',
  'S20', 'S21', 'S22', 'S23',
  'S30', 'S31',
  'S40', 'S41', 'S42', 'S43', 'S44', 'S45', 'S46', 'S47', 'S47a', 'S47r', 'S48',
  'S50', 'S51',
  'S60', 'S61', 'S62', 'S63', 'S64', 'S65', 'S66', 'S67',
  'S70', 'S71', 'S72', 'S73',
  'S80', 'S81', 'S82', 'S83', 'S84', 'S85', 'S86', 'S87', 'S88', 'S89',
  'S90', 'S91',
];

const TEST_NAME = /pm\.test\(\s*['"`]([^'"`]*)/g;

interface Node {
  event?: { script: { exec: string[] } }[];
  item?: Node[];
}

/** All script lines of the collection (collection, folder and item events) as one text. */
function scriptText(): string {
  const collection = JSON.parse(readFileSync(COLLECTION, 'utf8')) as Node;
  const lines: string[] = [];
  const walk = (node: Node) => {
    for (const event of node.event ?? []) {
      lines.push(...event.script.exec);
    }
    for (const child of node.item ?? []) {
      walk(child);
    }
  };
  walk(collection);
  return lines.join('\n');
}

describe('collection shop-purchase', () => {
  it('skips no check: no skip reason and no skipped request', () => {
    const text = scriptText();
    assert.equal(text.split('skipped.push(').length - 1, 0, 'skip reasons');
    // The only skipRequest left: the stock loop of S11 when "List seed products" failed (its [S11] assertion fails).
    assert.equal(text.split('pm.execution.skipRequest()').length - 1, 2, 'skipped requests (S11 loop only)');
  });

  it('names its assertions with exactly the 49 check ids', () => {
    const text = scriptText();
    const names = [...text.matchAll(TEST_NAME)].map(([, name]) => name);
    assert.equal(names.length, text.split('pm.test(').length - 1, 'every assertion has a literal name');
    const ids = new Set<string>();
    for (const name of names) {
      const id = /^\[(S[0-9]{2}[a-z]?)\] /.exec(name)?.[1];
      assert.ok(id, `assertion without a check id: ${name}`);
      ids.add(id);
    }
    assert.deepEqual([...ids].sort(), [...CHECK_IDS].sort());
    assert.equal(CHECK_IDS.length, 49);
  });
});

const SERVICES_DIR = new URL('../../services/', import.meta.url);
const ENVIRONMENTS_DIR = new URL('../environments/', import.meta.url);

const collectionFile = (service: string) => new URL(`${service}/postman/${service}.postman_collection.json`, SERVICES_DIR);

/** Environment files: postman/environments/*.json and services/<service>/postman/*.postman_environment.json. */
function environmentFiles(): URL[] {
  const files = readdirSync(ENVIRONMENTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => new URL(name, ENVIRONMENTS_DIR));
  for (const { name: service } of SERVICES) {
    const dir = new URL(`${service}/postman/`, SERVICES_DIR);
    files.push(...readdirSync(dir).filter((name) => name.endsWith('.postman_environment.json')).map((name) => new URL(name, dir)));
  }
  return files;
}

describe('service collections', () => {
  const texts = new Map(SERVICES.map(({ name }) => [name, readFileSync(collectionFile(name), 'utf8')]));
  const collections = new Map([...texts].map(([name, text]) => [name, JSON.parse(text) as PostmanCollection]));

  for (const { name } of SERVICES) {
    it(`${name}: shape, assertions, folder scripts, addresses and headers (C1–C5)`, (t) => {
      const collection = collections.get(name) as PostmanCollection;
      const counts = ['start', 'direct', 'via Gateway'].map((folder) => {
        const found = folderOf(collection, folder);
        return `${folder} ${found ? requestsOf(found).length : '-'}`;
      });
      t.diagnostic(`${name}: requests ${counts.join(', ')}; pm.test calls ${(texts.get(name)?.split('pm.test(').length ?? 1) - 1}`);
      assert.deepEqual(checkCollection(name, collection), []);
    });
  }

  it('has the same folder start in all 10 collections (C7)', () => {
    const canonical = JSON.stringify(folderOf(collections.get(START_SERVICE) as PostmanCollection, 'start') ?? null);
    const different = SERVICES.filter(({ name }) => JSON.stringify(folderOf(collections.get(name) as PostmanCollection, 'start') ?? null) !== canonical);
    assert.notEqual(canonical, 'null', `${START_SERVICE} has no folder start`);
    assert.deepEqual(
      different.map(({ name }) => name),
      [],
      `folder start differs from ${START_SERVICE}`,
    );
  });

  it(`stays within ${BUDGET_LIMIT} requests to the shop entrance per run (C6)`, (t) => {
    const start = folderOf(collections.get(START_SERVICE) as PostmanCollection, 'start');
    const parts = SERVICES.map(({ name }) => {
      const gateway = folderOf(collections.get(name) as PostmanCollection, 'via Gateway');
      return { name, budget: gateway ? budgetOf(gateway) : 0 };
    });
    const total = (start ? budgetOf(start) : 0) + parts.reduce((sum, part) => sum + part.budget, 0);
    t.diagnostic(`budget: start ${start ? budgetOf(start) : 0}, ${parts.map(({ name, budget }) => `${name} ${budget}`).join(', ')}; total ${total}`);
    assert.ok(total <= BUDGET_LIMIT, `budget ${total} > ${BUDGET_LIMIT}`);
  });

  it('has no JWT-like text in the collections', () => {
    assert.deepEqual(
      [...texts].filter(([, text]) => jwtCount(text) > 0).map(([name]) => name),
      [],
    );
  });
});

describe('environments', () => {
  it('have empty values of password/token variables and no JWT-like text', (t) => {
    const files = environmentFiles();
    t.diagnostic(`environment files: ${files.length}`);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const environment = JSON.parse(text) as { values?: { key?: string; value?: unknown }[] };
      assert.ok(Array.isArray(environment.values), `${file.pathname} has no values`);
      violations.push(...secretVariablesWithValue(environment.values).map((key) => `${file.pathname}: ${key} has a value`));
      if (jwtCount(text) > 0) {
        violations.push(`${file.pathname}: JWT-like text`);
      }
    }
    assert.deepEqual(violations, []);
  });
});

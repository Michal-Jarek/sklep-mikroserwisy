// Static checks of the collection shop-purchase (node --test, no newman, no network): no check is skipped any more
// (stage 8: Inventory and Review take UUID, Order and Shipping exist; a new skip reason is a decision of the project
// owner) and the check ids [S..] are exactly the documented list (postman/README.md, "Co sprawdza kolekcja").
// Run in the image together with report.test.ts (postman/README.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

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

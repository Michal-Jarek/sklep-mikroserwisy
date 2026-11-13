// Static checks of the collection shop-purchase (node --test, no newman, no network): skips use only the four fixed
// reasons (a new reason is a decision of the project owner) and the check ids [S..] are exactly the documented list
// (postman/README.md, "Co sprawdza kolekcja"). Run in the image together with report.test.mjs (postman/README.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Next to runner/ both in the repository and in the container (/opt/scenario/work/collections); a missing file fails.
const COLLECTION = new URL('../collections/shop-purchase.postman_collection.json', import.meta.url);

// The four fixed skip reasons and the checks each of them skips.
const SKIP_REASONS = {
  'inventory-service rejects UUID productId': ['S11', 'S12', 'S47a', 'S63', 'S64'],
  'review-service rejects UUID productId': ['S47r'],
  'order-service not registered': ['S80'],
  'shipping-service not registered': ['S81'],
};

// 41 check ids in the order of the folders.
const CHECK_IDS = [
  'S01', 'S02', 'S03',
  'S10', 'S11', 'S12',
  'S20', 'S21', 'S22', 'S23',
  'S30', 'S31',
  'S40', 'S41', 'S42', 'S43', 'S44', 'S45', 'S46', 'S47', 'S47a', 'S47r', 'S48',
  'S50', 'S51',
  'S60', 'S61', 'S62', 'S63', 'S64', 'S65', 'S66', 'S67',
  'S70', 'S71', 'S72', 'S73',
  'S80', 'S81',
  'S90', 'S91',
];

const SKIP_PUSH = /skipped\.push\(\{ item: pm\.info\.requestName, reason: '([^']*)', checks: (\[[^\]]*\]) \}\)/g;
const TEST_NAME = /pm\.test\(\s*['"`]([^'"`]*)/g;

/** All script lines of the collection (collection, folder and item events) as one text. */
function scriptText() {
  const collection = JSON.parse(readFileSync(COLLECTION, 'utf8'));
  const lines = [];
  const walk = (node) => {
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
  it('skips only with the four fixed reasons, each for its own checks', () => {
    const text = scriptText();
    const pushes = [...text.matchAll(SKIP_PUSH)];
    assert.equal(pushes.length, text.split('skipped.push(').length - 1, 'every skip has a literal reason and checks');
    const skippedBy = {};
    for (const [, reason, checks] of pushes) {
      assert.ok(Object.hasOwn(SKIP_REASONS, reason), `unknown skip reason: ${reason}`);
      skippedBy[reason] = [...(skippedBy[reason] ?? []), ...JSON.parse(checks)];
    }
    for (const reason of Object.keys(skippedBy)) {
      skippedBy[reason] = [...new Set(skippedBy[reason])].sort();
    }
    const expected = Object.fromEntries(Object.entries(SKIP_REASONS).map(([reason, checks]) => [reason, [...checks].sort()]));
    assert.deepEqual(skippedBy, expected);
  });

  it('names its assertions with exactly the 41 check ids, other assertions only [fallback]', () => {
    const text = scriptText();
    const names = [...text.matchAll(TEST_NAME)].map(([, name]) => name);
    assert.equal(names.length, text.split('pm.test(').length - 1, 'every assertion has a literal name');
    const ids = new Set();
    for (const name of names) {
      const id = /^\[(S[0-9]{2}[a-z]?)\] /.exec(name)?.[1];
      assert.ok(id || name.startsWith('[fallback] '), `assertion without a check id: ${name}`);
      if (id) {
        ids.add(id);
      }
    }
    assert.deepEqual([...ids].sort(), [...CHECK_IDS].sort());
    assert.equal(CHECK_IDS.length, 41);
  });
});

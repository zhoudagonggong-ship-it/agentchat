import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadRelease, newer, type Release } from '../src/release.ts';

test('compares versions the way people write them', () => {
  assert.equal(newer('v0.2.0', '0.1.0'), true);
  assert.equal(newer('1.10.0', '1.9.2'), true);
  assert.equal(newer('0.1.0', '0.1.0'), false);
  assert.equal(newer('0.1', '0.1.1'), false);
});

test('a download is checked against the published SHA-256', async (t) => {
  const zip = Buffer.from('zip bytes');
  t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  const good: Release = { version: '0.2.0', zip: 'https://x/AllinOne-0.2.0.zip', sha256: createHash('sha256').update(zip).digest('hex'), notes: '' };
  assert.deepEqual(await downloadRelease(good), zip);
  await assert.rejects(downloadRelease({ ...good, sha256: '0'.repeat(64) }), /校验不通过/);
});

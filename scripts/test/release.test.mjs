import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVersions } from '../check-version.mjs';

test('release identity agrees with every artifact manifest', () => {
  assert.equal(checkVersions(Array(4).fill('0.1.0'), 'v0.1.0'), '0.1.0');
  assert.equal(checkVersions(Array(4).fill('0.2.0-beta.1')), '0.2.0-beta.1');
  assert.throws(() => checkVersions(['0.1.0', '0.1.0', '0.1.1', '0.1.0']));
  assert.throws(() => checkVersions(Array(4).fill('0.1.0'), 'v0.2.0'));
  assert.throws(() => checkVersions(Array(4).fill('0.1.0'), '0.1.0'));
  assert.throws(() => checkVersions(Array(4).fill('bad')));
});

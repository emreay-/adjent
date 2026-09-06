import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectText } from '../repo-hygiene.mjs';

test('a placeholder or CI path cannot hide another sensitive value on its line', () => {
  const credential = 'gh' + 'p_' + 'a'.repeat(24);
  const findings = inspectText('<user> /home/runner ' + credential);
  assert.deepEqual(findings, [{ line: 1, kind: 'credential shape' }]);
  assert.ok(!JSON.stringify(findings).includes(credential));
});

test('recognizes both platform home paths without printing matched text', () => {
  const text = ['C:' + '\\Users\\' + 'synthetic-person', '/home/' + 'synthetic-person', '/Users/' + 'synthetic-person'].join('\n');
  assert.deepEqual(inspectText(text).map((f) => f.line), [1, 2, 3]);
  assert.equal(inspectText('C:\\Users\\<user> /home/<user> /Users/<user>').length, 0);
});

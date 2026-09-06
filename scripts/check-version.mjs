import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function checkVersions(versions, tag = '') {
  const expected = versions[0];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
    throw new Error('Invalid workspace version');
  }
  if (versions.length !== 4 || versions.some((v) => v !== expected)) {
    throw new Error('All four package versions must agree');
  }
  if (tag && tag !== `v${expected}`) throw new Error('Release tag must match the package version exactly');
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const versions = ['package.json', ...['core', 'cli', 'desktop'].map((p) => `packages/${p}/package.json`)]
    .map((p) => JSON.parse(readFileSync(new URL(p, root), 'utf8')).version);
  console.log(`Workspace version: ${checkVersions(versions, process.env.RELEASE_TAG ?? '')}`);
}

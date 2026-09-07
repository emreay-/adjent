import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireDesktop = createRequire(new URL('../../packages/desktop/package.json', import.meta.url));
const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
const requireCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parse } = requireCore('yaml');
const { validateConfiguration } = requireBuilder('app-builder-lib/out/util/config/config.js');
const { DebugLogger } = requireBuilder('builder-util');

test('packaging configuration satisfies the installed Electron Builder schema', async () => {
  const config = parse(readFileSync(new URL('../../packages/desktop/electron-builder.yml', import.meta.url), 'utf8'));
  await validateConfiguration(config, new DebugLogger(false));
});

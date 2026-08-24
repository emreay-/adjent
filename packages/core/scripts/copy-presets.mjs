/**
 * Copy the preset YAML into dist/, the way the desktop package copies its
 * renderer assets. The `.yaml` files are the source of truth — including their
 * comments, which is the whole point — so they are shipped rather than
 * generated into code.
 */
import { cp, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', 'presets');
const to = path.join(here, '..', 'dist', 'presets');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log('presets copied');

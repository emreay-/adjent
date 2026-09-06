/** Prepare a reviewable source tree without copying Git history or local state. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectText } from './repo-hygiene.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const scratch = path.join(root, 'scratch');
const output = path.join(scratch, 'public-source');
try {
  const files = [...new Set(execFileSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`,
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean))].sort();
  await mkdir(scratch, { recursive: true });
  if (await realpath(scratch) !== path.join(await realpath(root), 'scratch')) {
    throw new Error('Scratch directory must stay inside the workspace');
  }
  // Fail if an earlier export exists; never delete or overwrite a review copy.
  await mkdir(output);
  const manifest = {};
  for (const name of files) {
    const input = path.join(root, name);
    let stat;
    try { stat = await lstat(input); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular source files may be exported');
    const data = await readFile(input);
    if (inspectText(data.toString('utf8')).length) throw new Error('Resolve working-file hygiene findings before export');
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
    manifest[name] = createHash('sha256').update(data).digest('hex');
  }
  await writeFile(path.join(output, 'PUBLICATION-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`Exported ${Object.keys(manifest).length} source files to scratch/public-source with SHA-256 manifest.`);
  console.log('No Git history, credentials, ignored files or build outputs were copied. Review before publication.');
} catch {
  console.error('Source export did not complete. Check hygiene, permissions, and whether scratch/public-source already exists.');
  process.exitCode = 1;
}

/** Render the real panel with synthetic data; never start the monitor. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireDesktop = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const electron = requireDesktop('electron');
const temp = await mkdtemp(path.join(tmpdir(), 'adjent-preview-'));
const output = path.join(root, 'docs', 'assets', 'panel.png');
const env = { ...process.env, ADJENT_PREVIEW_DATA: temp, ADJENT_PREVIEW_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(path.dirname(output), { recursive: true });
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(root, 'scripts', 'screenshot-runtime.cjs')], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Do not copy runtime logs containing profile paths into a public artifact.
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = chunk.split('\n').find((line) => line.startsWith('PREVIEW_ERROR:'));
      if (message) console.error(message.replaceAll(temp, '<temporary>').replaceAll(root, '<repository>'));
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Screenshot timed out')); }, 30_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (status) => { clearTimeout(timer); resolve(status); });
  });
  if (code !== 0) throw new Error(`Synthetic renderer check failed (${code})`);
  console.log('Rendered docs/assets/panel.png using synthetic data; panel and IPC checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

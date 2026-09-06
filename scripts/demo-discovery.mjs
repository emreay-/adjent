/** Reproducible public walkthrough: real CLI decisions, synthetic inputs only. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/main.js');
const output = path.join(root, 'docs/assets');
const demoHome = mkdtempSync(path.join(tmpdir(), 'adjent-discovery-'));
const env = { ...process.env, HOME: demoHome, USERPROFILE: demoHome, NO_COLOR: '1' };
delete env.ELECTRON_RUN_AS_NODE;

function run(args, expected) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  // Error output can contain host paths. Do not copy it into public artifacts.
  assert.ok(!result.error && !result.signal, 'CLI process must finish; build first');
  assert.equal(result.status, expected, `Unexpected exit code for ${args[0]}`);
  return result.stdout;
}

try {
  const loop = spawnSync(process.execPath, [path.join(root, 'scripts/demo-loop.mjs')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(loop.status, 0, 'The existing loop demo must succeed; build first');
  const plain = loop.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const alarm = plain.split('\n').find((line) => line.includes('Looks like a loop'))?.trim();
  assert.ok(alarm, 'The real rule engine must emit the loop alarm');

  const day = path.join(demoHome, '.codex/sessions/2024/01/15');
  mkdirSync(day, { recursive: true });
  const rollout = path.join(day, 'rollout-2024-01-15T12-00-00-00000000-0000-4000-8000-000000000003.jsonl');
  function quota(utilization, age = 0) {
    const now = Date.now();
    writeFileSync(rollout, JSON.stringify({
      timestamp: new Date(now - age).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', rate_limits: {
        plan_type: 'demo',
        primary: { used_percent: utilization, window_minutes: 300,
          resets_at: Math.floor((now + 2 * 3_600_000) / 1000) },
      } },
    }) + '\n');
  }
  const check = ['check', '--backend', 'codex', '--budget', '20%', '--max-age', '10m', '--json'];
  run(check, 3);
  quota(58);
  const pass = JSON.parse(run(check, 0));
  assert.equal(pass.ok, true);
  quota(88);
  const fail = JSON.parse(run(check, 4));
  assert.equal(fail.ok, false);
  quota(58, 30 * 60_000);
  run(check, 5);
  quota(58);
  run(['gate', 'hold', '--reason', 'review demo worker', '--until', '30m', '--quiet'], 0);
  const held = JSON.parse(run(check, 4));
  assert.equal(held.gateHeld, true);
  run(['gate', 'release', '--quiet'], 0);
  run(check, 0);

  const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const panel = readFileSync(path.join(output, 'panel.png')).toString('base64');
  const scenes = [
    { title: 'One view of your AI work.', eyebrow: '01 / FOR HUMANS',
      lines: ['Claude Code + Codex, together.', 'Reported quota. Estimated agent burn.', 'A tray panel for the next decision.'],
      code: ['SOURCE DEMO', 'pnpm install --frozen-lockfile', 'pnpm -r build', 'node scripts/demo-discovery.mjs'] },
    { title: 'Notice a repeating worker.', eyebrow: '02 / INVESTIGATE THE EVIDENCE',
      lines: ['14 uniform turns. 15-minute lookback.', 'Turn metadata only; no retained messages.', 'A hypothesis for a person or orchestrator.'],
      code: ['$ node scripts/demo-loop.mjs', alarm.replace(/^.*?(\[warn\])/, '$1'),
        'Demo burn floor: 0 (no learned fit yet).', 'Real rule engine. Invented session.'] },
    { title: 'Check before scheduling.', eyebrow: '03 / FOR AGENT ORCHESTRATORS',
      lines: ['Require 20% remaining, with fresh data.', '58% used: pass. 88% used: defer.', 'The caller owns the scheduling decision.'],
      code: ['$ adjent check --backend codex', '    --budget 20% --max-age 10m --quiet',
        '58% used -> exit 0    88% used -> exit 4', 'CLI results verified against synthetic files.'] },
    { title: 'Respect an advisory hold.', eyebrow: '04 / HUMANS AND AGENTS SHARE THE CONTRACT',
      lines: ['Headroom can exist while work should wait.', 'An explicit hold makes check return 4.', 'Adjent never starts or stops a worker.'],
      code: ['$ adjent gate hold --until 30m', '    --reason "review demo worker"',
        '$ adjent check --budget 20% --quiet', 'exit 4 -> caller defers; release is explicit.'] },
  ];
  const textLines = (lines, y, cls, step) => lines.map((line, i) =>
    `<text x="445" y="${y + i * step}" class="${cls}">${escape(line)}</text>`).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="title desc">
<title id="title">Adjent: Claude Code and Codex monitoring for humans and agents</title>
<desc id="desc">Thirty-second repeating synthetic walkthrough. Actual panel preview; separate real CLI runs verify a loop alarm, quota pass and fail, and an advisory hold. Text equivalent in docs/articles/README.md.</desc>
<style>
text{font-family:Arial,sans-serif;fill:#edf0f5}.brand{font-size:35px;font-weight:700}.tag{font-size:18px;fill:#afb8cc}.eyebrow{font-size:15px;fill:#82d6b5;letter-spacing:1px}.heading{font-size:34px;font-weight:700}.body{font-size:22px;fill:#d0d7e5}.code{font-family:Consolas,monospace;font-size:18px;fill:#d5f0e5}.foot{font-size:15px;fill:#afb8cc}.scene{opacity:0;animation:show 30s linear infinite}.s0{animation-delay:0s}.s1{animation-delay:-22.5s}.s2{animation-delay:-15s}.s3{animation-delay:-7.5s}@keyframes show{0%,24.99%{opacity:1}25%,100%{opacity:0}}@media(prefers-reduced-motion:reduce){.scene{animation:none;opacity:0}.s0{opacity:1}}
</style>
<rect width="1280" height="640" rx="18" fill="#10131c"/>
<text x="48" y="59" class="brand">adjent</text><text x="210" y="56" class="tag">Claude Code + Codex · Tray UI + CLI</text>
<rect x="1080" y="29" width="150" height="35" rx="17" fill="#26312f"/><text x="1104" y="52" class="eyebrow">EARLY WIP</text>
<image x="48" y="100" width="323" height="476" xlink:href="data:image/png;base64,${panel}"/>
${scenes.map((scene, i) => `<g class="scene s${i}">
<text x="445" y="136" class="eyebrow">${escape(scene.eyebrow)}</text>
<text x="445" y="190" class="heading">${escape(scene.title)}</text>
${textLines(scene.lines, 245, 'body', 36)}
<rect x="422" y="351" width="810" height="174" rx="12" fill="#1b2230"/>
${textLines(scene.code, 388, 'code', 32)}
<text x="445" y="564" class="foot">${i + 1} / 4 · 30-second walkthrough · repeats</text>
</g>`).join('\n')}
<text x="48" y="613" class="foot">Synthetic data throughout · panel preview and CLI runs are separate examples</text>
<text x="927" y="613" class="foot">github.com/emreay-/adjent</text>
</svg>\n`;
  writeFileSync(path.join(output, 'demo.svg'), svg);
  console.log('Verified loop alarm and exit codes: pass 0, insufficient 4, missing 3, stale 5, hold 4, release 0.');
  console.log('Generated docs/assets/demo.svg (30-second synthetic walkthrough).');

  if (process.argv.includes('--social-preview')) {
    const requireDesktop = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
    const rendered = spawnSync(requireDesktop('electron'), [path.join(root, 'scripts/demo-preview.cjs')], {
      env: { ...env, ADJENT_DEMO_PROFILE: demoHome }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(rendered.status, 0, 'Social preview renderer must succeed; check Electron/display setup');
    console.log('Generated docs/assets/social-preview.png (1280 × 640).');
  }
} finally {
  rmSync(demoHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

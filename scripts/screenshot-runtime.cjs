const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { trustedIpc } = require('../packages/desktop/dist/security.js');

const profile = process.env.ADJENT_PREVIEW_DATA;
const output = process.env.ADJENT_PREVIEW_OUTPUT;
if (!profile || !output) throw new Error('Use node scripts/screenshot.mjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setPath('crashDumps', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '2');

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const core = await import(pathToFileURL(path.join(__dirname, '../packages/core/dist/index.js')).href);
  const now = Date.UTC(2024, 0, 15, 12);
  const hour = 3_600_000;
  const totals = { input: 12_000, cacheWrite: 80_000, cacheRead: 900_000, output: 30_000, thinking: 8_000 };
  const mkLimit = (backend, key, label, utilization, windowMinutes, remaining, binding) => ({
    limit: { backend, key, label, utilization, windowMinutes, resetsAt: now + remaining * hour,
      source: 'reported', scope: null, severity: null, vendorActive: binding, observedAt: now },
    burn: { pctPerHour: binding ? 12 : 1, updatedAt: now },
    verdict: binding ? 'ahead' : 'on-pace', paceLinePct: binding ? 40 : 30,
    exhaustsAt: binding ? now + 3.5 * hour : null, binding, tokens: totals,
  });
  const limits = [mkLimit('claude', 'session', 'Claude · 5h', 58, 300, 3, true),
    mkLimit('claude', 'weekly_all', 'Claude · 7d', 24, 10080, 96, false),
    mkLimit('codex', 'codex:5h', 'Codex · 5h', 18, 300, 2, false)];
  const agents = ['demo-api', 'demo-web', 'demo-cli'].map((label, i) => ({
    id: `demo-agent-${i}`, backend: i === 1 ? 'codex' : 'claude', label,
    projectPath: `/work/${label}`, gitBranch: 'main', model: i === 1 ? 'model-y' : 'model-x',
    effort: 'high', entrypoint: 'cli', parentId: null, pid: null, state: i === 2 ? 'idle' : 'live',
    startedAt: now - hour, lastActivityAt: now - (i === 2 ? 14 * 60_000 : 0), totals,
  }));
  const payload = {
    state: { generatedAt: now, backends: ['claude', 'codex'].map((id) => ({ id,
      displayName: id === 'claude' ? 'Claude Code' : 'Codex', version: null,
      plan: 'demo-plan', rateLimitTier: null, health: 'ok', healthDetail: null })),
      agents, limits, agentBurns: [{ agentId: agents[0].id, pctPerHour: 7.2, confidence: 'medium' },
        { agentId: agents[1].id, pctPerHour: 2.4, confidence: 'medium' }],
      agentShapes: [], epsilon: 0.2, fitConfidence: 'medium' },
    alarmHistory: [], history: [8, 16, 27, 39, 48, 58].map((u, i) => ({
      t: now - (5 - i) * 24 * 60_000, w: 'claude:session', u,
    })), settings: { ...core.DEFAULT_SETTINGS, theme: 'dark', vendorDisplay: 'name' },
    explanations: core.EXPLANATIONS, provenanceNote: core.PROVENANCE_NOTE,
  };
  const file = path.join(__dirname, '../packages/desktop/dist/renderer/panel.html');
  const win = new BrowserWindow({ width: 380, height: 560, show: false, frame: false,
    webPreferences: { preload: path.join(__dirname, 'screenshot-preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: true } });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trustedIpc(ipcMain, () => [{ contents: win.webContents, url: pathToFileURL(file).href }])
    .handle('preview:state', () => payload);
  await win.loadFile(file);
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (document.getElementById('hero').textContent === '58%') return resolve();
      if (++attempts > 100) return reject(new Error('No synthetic state'));
      setTimeout(check, 20);
    }; check();
  })`);
  const valid = await win.webContents.executeJavaScript(`
    document.getElementById('renderError').hidden &&
    document.getElementById('agents').textContent.includes('demo-api') &&
    document.querySelectorAll('#chart path').length > 0 &&
    typeof window.require === 'undefined' && typeof window.process === 'undefined'
  `);
  if (!valid) throw new Error('Panel or sandbox check failed');
  await win.webContents.executeJavaScript('document.fonts.ready');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const capture = await win.webContents.capturePage();
  await writeFile(output, capture.toPNG());
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error('PREVIEW_ERROR: ' + error.message);
  app.exit(1);
});

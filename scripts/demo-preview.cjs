/** Capture the authored SVG's first scene, using an isolated Electron profile. */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const profile = process.env.ADJENT_DEMO_PROFILE;
if (!profile) throw new Error('Use node scripts/demo-discovery.mjs --social-preview');
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file|data):/.test(details.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 640, useContentSize: true,
    show: false, webPreferences: { sandbox: true, contextIsolation: true,
      nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(path.join(__dirname, '../docs/assets/demo.svg'));
  const valid = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const scenes = [...document.querySelectorAll('.scene')];
    const animations = document.getAnimations();
    if (scenes.length !== 4 || animations.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      for (const animation of animations) { animation.pause(); animation.currentTime = i * 7500 + 100; }
      const visible = scenes.filter(scene => Number(getComputedStyle(scene).opacity) > 0.99);
      if (visible.length !== 1 || visible[0] !== scenes[i]) return false;
    }
    return [...document.querySelectorAll('text')].every(text => {
      const box = text.getBBox(); return box.x >= 0 && box.x + box.width <= 1250 && box.y + box.height <= 640;
    });
  })()`);
  if (!valid) throw new Error('Animation timing or text bounds failed');
  await win.webContents.executeJavaScript(`
    document.querySelectorAll('.scene').forEach((scene, i) => {
      scene.style.animation = 'none'; scene.style.opacity = i === 0 ? '1' : '0';
    }); document.fonts.ready;
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeFile(path.join(__dirname, '../docs/assets/social-preview.png'),
    (await win.webContents.capturePage()).toPNG());
  win.destroy(); app.quit();
}).catch(() => app.exit(1));

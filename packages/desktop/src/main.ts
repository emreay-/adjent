/**
 * Electron main: tray icon (one arc, one status colour), popover panel
 * (frameless 380×560, closes on blur), native toasts routed by severity.
 * Form factor per docs/UI.md. One deliberate deviation from ARCHITECTURE.md:
 * the renderer is plain HTML/JS rather than React+Vite for now — the IPC
 * contract (one AppState push) is identical, so swapping later is contained.
 */
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen } from 'electron';
import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
import * as path from 'node:path';
// Desktop is CJS (electron's require hook needs it); core is ESM — bridge with
// a dynamic import(), which Node16-mode TS preserves instead of lowering.
import type { Alarm, AppState, Monitor, Sink } from '@adjent/core' with { 'resolution-mode': 'import' };
const coreImport = import('@adjent/core');

const TICK_MS = 30_000;
const PANEL_W = 380;
const PANEL_H = 560;

let tray: TrayType | null = null;
let panel: BrowserWindowType | null = null;
let monitor: Monitor;
let alarmsPaused = false;
const recentAlarms: Alarm[] = [];

// ---------------------------------------------------------------------------
// Tray icon: drawn into an RGBA buffer — an arc filled to the binding limit's
// utilization, coloured by verdict. No text badge (docs/UI.md).
// ---------------------------------------------------------------------------
const COLORS: Record<string, [number, number, number]> = {
  'on-pace': [0x0c, 0xa3, 0x0c],
  ahead: [0xfa, 0xb2, 0x19],
  over: [0xd0, 0x3b, 0x3b],
  idle: [0x80, 0x88, 0x90],
};

function trayImage(utilization: number, verdict: string, size = 16): Electron.NativeImage {
  const rgb = COLORS[verdict] ?? COLORS['idle']!;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size / 2 - 0.5;
  const rInner = rOuter - Math.max(2.5, size / 5);
  const sweep = (Math.max(0, Math.min(100, utilization)) / 100) * 2 * Math.PI;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      if (dist > rOuter || dist < rInner) continue;
      // angle from 12 o'clock, clockwise
      let ang = Math.atan2(dx, -dy);
      if (ang < 0) ang += 2 * Math.PI;
      const filled = ang <= sweep;
      const i = (y * size + x) * 4;
      const alpha = filled ? 255 : 70;
      buf[i] = rgb[0]!;
      buf[i + 1] = rgb[1]!;
      buf[i + 2] = rgb[2]!;
      buf[i + 3] = alpha;
    }
  }
  const img = nativeImage.createFromBuffer(buf, { width: size, height: size });
  return img;
}

// ---------------------------------------------------------------------------
function createPanel(): BrowserWindowType {
  const win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  win.on('blur', () => win.hide()); // a question you ask, not a window you manage
  return win;
}

function togglePanel(): void {
  if (!panel || panel.isDestroyed()) panel = createPanel();
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const x = Math.min(Math.max(cursor.x - PANEL_W / 2, wa.x + 8), wa.x + wa.width - PANEL_W - 8);
  const y = cursor.y < wa.y + wa.height / 2 ? wa.y + 8 : wa.y + wa.height - PANEL_H - 8;
  panel.setPosition(Math.round(x), Math.round(y));
  panel.show();
  pushState();
}

function pushState(): void {
  const s = monitor.state;
  if (s && panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.webContents.send('state', { state: s, alarms: recentAlarms.slice(-5) });
  }
}

// ---------------------------------------------------------------------------
// Sinks (docs/ALARMS.md routing): tray tint is implicit in the icon; toast is
// a native Notification; both honor the pause switch.
// ---------------------------------------------------------------------------
class ToastSink implements Sink {
  readonly id = 'toast';
  async deliver(a: Alarm): Promise<void> {
    if (alarmsPaused || !Notification.isSupported()) return;
    const n = new Notification({
      title: a.title,
      body: a.body,
      urgency: a.severity === 'critical' ? 'critical' : 'normal',
      timeoutType: a.severity === 'critical' ? 'never' : 'default',
    });
    n.on('click', () => togglePanel());
    n.show();
  }
}

class TraySink implements Sink {
  readonly id = 'tray';
  async deliver(a: Alarm): Promise<void> {
    recentAlarms.push(a);
    if (recentAlarms.length > 20) recentAlarms.shift();
  }
}

// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  app.setAppUserModelId('dev.adjent.app'); // required for Windows toasts

  const core = await coreImport;
  const config = await core.loadConfig();
  monitor = new core.Monitor({ providers: [new core.ClaudeProvider(), new core.CodexProvider()], config });
  monitor.router.register(new ToastSink());
  monitor.router.register(new TraySink());

  tray = new Tray(trayImage(0, 'idle'));
  tray.setToolTip('Adjent');
  tray.on('click', togglePanel);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open panel', click: togglePanel },
      {
        label: 'Pause alarms',
        type: 'checkbox',
        checked: false,
        click: (item) => {
          alarmsPaused = item.checked;
        },
      },
      { type: 'separator' },
      { label: 'Quit Adjent', click: () => app.quit() },
    ]),
  );

  monitor.on('state', (s: AppState) => {
    const binding = s.windows.find((w) => w.binding);
    if (tray) {
      tray.setImage(trayImage(binding?.window.utilization ?? 0, binding?.verdict ?? 'idle'));
      tray.setToolTip(
        binding
          ? `Adjent — ${binding.window.label} ${Math.round(binding.window.utilization)}%`
          : 'Adjent — no quota data',
      );
    }
    pushState();
  });

  ipcMain.on('panel:close', () => panel?.hide());
  ipcMain.on('panel:refresh', () => void monitor.tick());

  const loop = async (): Promise<void> => {
    try {
      await monitor.tick();
    } catch {
      /* a bad tick never kills the shell */
    }
    setTimeout(() => void loop(), TICK_MS);
  };
  void loop();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', togglePanel);
  app.on('window-all-closed', () => {
    /* tray app: stay resident — default would quit */
  });
  void app.whenReady().then(start);
}

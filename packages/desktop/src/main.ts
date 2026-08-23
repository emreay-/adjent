/**
 * Electron main: tray glyph, popover panel, optional always-on-top widget,
 * native toasts. Form factor per docs/UI.md.
 *
 * Two stated deviations from ARCHITECTURE.md, both contained:
 *  - the renderer is plain HTML/JS rather than React+Vite; the IPC contract
 *    (one AppState push) is unchanged, so swapping later is local.
 *  - this package is CJS because Electron's require hook needs it; the ESM
 *    core is reached through a dynamic import().
 */
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron';
import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
import * as path from 'node:path';
import type { Alarm, AppState, Monitor, Settings, Sink } from '@adjent/core' with { 'resolution-mode': 'import' };
import { makeTrayIcon } from './trayicon.js';

const coreImport = import('@adjent/core');

/** Design sizes at uiScale = 1; both scale with the setting. */
const PANEL_W = 380;
const PANEL_H = 560;
const WIDGET_W = 340;
const WIDGET_H = 96;

let tray: TrayType | null = null;
let panel: BrowserWindowType | null = null;
let widget: BrowserWindowType | null = null;
let monitor: Monitor;
let settings: Settings;
let core: Awaited<typeof coreImport>;
let tickTimer: NodeJS.Timeout | null = null;
let lastTooltip = 'Adjent';
const recentAlarms: Alarm[] = [];

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function updateTray(utilization: number, pace: number, verdict: string, tooltip: string): void {
  if (!tray) return;
  lastTooltip = tooltip;
  const dpi = Math.max(1, Math.round(screen.getPrimaryDisplay().scaleFactor));
  tray.setImage(
    makeTrayIcon(nativeImage, {
      utilization,
      pace,
      verdict,
      style: settings.trayStyle,
      thickness: settings.trayThickness,
      // Linux panels render larger than the Windows 16px slot.
      logicalSize: process.platform === 'win32' ? 16 : 22,
      scaleFactor: Math.min(3, dpi + 1), // oversample: crisp, never blurry
    }),
  );
  tray.setToolTip(tooltip);
}

function buildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open panel', click: () => togglePanel() },
      {
        label: 'Pinned widget (always visible)',
        type: 'checkbox',
        checked: settings.widgetEnabled,
        click: (item) => void applySettings({ widgetEnabled: item.checked }),
      },
      { label: 'Notifications…', click: () => togglePanel('notifications') },
      { label: 'Settings…', click: () => togglePanel('settings') },
      { type: 'separator' },
      {
        label: 'Pause alarms',
        type: 'checkbox',
        checked: settings.alarmsPaused,
        click: (item) => void applySettings({ alarmsPaused: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit Adjent', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function createPanel(): BrowserWindowType {
  const win = new BrowserWindow({
    width: Math.round(PANEL_W * settings.uiScale),
    height: Math.round(PANEL_H * settings.uiScale),
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
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(settings.uiScale);
    pushState();
  });
  win.on('blur', () => win.hide()); // a question you ask, not a window you manage
  return win;
}

function togglePanel(view?: 'settings' | 'notifications'): void {
  if (!panel || panel.isDestroyed()) panel = createPanel();
  if (panel.isVisible() && !view) {
    panel.hide();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  const w = Math.round(PANEL_W * settings.uiScale);
  const h = Math.round(PANEL_H * settings.uiScale);
  panel.setSize(w, h);
  const x = Math.min(Math.max(cursor.x - w / 2, wa.x + 8), wa.x + wa.width - w - 8);
  const y = cursor.y < wa.y + wa.height / 2 ? wa.y + 8 : wa.y + wa.height - h - 8;
  panel.setPosition(Math.round(x), Math.round(y));
  panel.show();
  if (view) panel.webContents.send('view', view);
  pushState();
}

// ---------------------------------------------------------------------------
// Pinned widget — the answer to "visible without opening the tray flyout"
// ---------------------------------------------------------------------------
function createWidget(): BrowserWindowType {
  const w = Math.round(WIDGET_W * settings.uiScale);
  const h = Math.round(WIDGET_H * settings.uiScale);
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = settings.widgetPosition ?? { x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16 };
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    // A taskbar button gives a directly clickable entry on the lower bar,
    // which tray-overflow promotion cannot (Windows owns that decision).
    skipTaskbar: !settings.widgetTaskbarButton,
    title: 'Adjent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(settings.uiScale);
    pushState();
  });
  win.on('moved', () => {
    const [x = 0, y = 0] = win.getPosition();
    void applySettings({ widgetPosition: { x, y } }, { rebuildWidget: false });
  });
  return win;
}

function syncWidget(): void {
  if (widget && !widget.isDestroyed()) {
    widget.destroy();
    widget = null;
  }
  if (settings.widgetEnabled) widget = createWidget();
}

// ---------------------------------------------------------------------------
function pushState(): void {
  const s = monitor?.state;
  if (!s) return;
  const binding = s.limits.find((w) => w.binding);
  const payload = {
    state: s,
    // Recent few for the summary strip; the full log for the notifications tab.
    alarms: recentAlarms.slice(-5),
    alarmHistory: monitor.alarms(),
    // Real utilization samples so the chart draws the measured curve.
    history: binding ? monitor.historyFor(`${binding.limit.backend}:${binding.limit.key}`) : [],
    settings,
    explanations: core.EXPLANATIONS,
    provenanceNote: core.PROVENANCE_NOTE,
  };
  for (const win of [panel, widget]) {
    if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('state', payload);
  }
}

async function applySettings(patch: Partial<Settings>, opts: { rebuildWidget?: boolean } = {}): Promise<void> {
  const prev = settings;
  settings = core.coerceSettings({ ...settings, ...patch });
  await core.saveSettings(settings);

  if (settings.theme !== prev.theme) nativeTheme.themeSource = settings.theme;

  const scaleChanged = settings.uiScale !== prev.uiScale;
  if (scaleChanged) {
    if (panel && !panel.isDestroyed()) {
      panel.webContents.setZoomFactor(settings.uiScale);
      panel.setSize(Math.round(PANEL_W * settings.uiScale), Math.round(PANEL_H * settings.uiScale));
    }
  }
  if (settings.trayStyle !== prev.trayStyle || settings.trayThickness !== prev.trayThickness) {
    const b = monitor?.state?.limits.find((w) => w.binding);
    updateTray(b?.limit.utilization ?? 0, b?.paceLinePct ?? 0, b?.verdict ?? 'idle', lastTooltip);
  }
  if (settings.tickIntervalSec !== prev.tickIntervalSec) restartLoop();
  if (
    opts.rebuildWidget !== false &&
    (settings.widgetEnabled !== prev.widgetEnabled || settings.widgetTaskbarButton !== prev.widgetTaskbarButton || scaleChanged)
  ) {
    syncWidget();
  }
  buildTrayMenu();
  pushState();
}

// ---------------------------------------------------------------------------
// Sinks (docs/ALARMS.md routing)
// ---------------------------------------------------------------------------
class ToastSink implements Sink {
  readonly id = 'toast';
  async deliver(a: Alarm): Promise<void> {
    if (settings.alarmsPaused || !Notification.isSupported()) return;
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
function restartLoop(): void {
  if (tickTimer) clearTimeout(tickTimer);
  const loop = async (): Promise<void> => {
    try {
      await monitor.tick();
    } catch {
      /* a bad tick never kills the shell */
    }
    tickTimer = setTimeout(() => void loop(), settings.tickIntervalSec * 1000);
  };
  void loop();
}

async function start(): Promise<void> {
  app.setAppUserModelId('dev.adjent.app'); // required for Windows toasts

  core = await coreImport;
  settings = await core.loadSettings();
  // Drives prefers-color-scheme in every renderer — the stylesheets already
  // key off it, so no per-window theming code is needed.
  nativeTheme.themeSource = settings.theme;
  const config = await core.loadConfig();
  monitor = new core.Monitor({ providers: [new core.ClaudeProvider(), new core.CodexProvider()], config });
  monitor.router.register(new ToastSink());
  monitor.router.register(new TraySink());

  tray = new Tray(nativeImage.createEmpty());
  updateTray(0, 0, 'idle', 'Adjent — starting');
  tray.on('click', () => togglePanel());
  buildTrayMenu();

  monitor.on('state', (s: AppState) => {
    const b = s.limits.find((w) => w.binding);
    updateTray(
      b?.limit.utilization ?? 0,
      b?.paceLinePct ?? 0,
      b?.verdict ?? 'idle',
      b ? `Adjent — ${b.limit.label} ${Math.round(b.limit.utilization)}%` : 'Adjent — no quota data',
    );
    pushState();
  });

  ipcMain.on('panel:close', () => panel?.hide());
  ipcMain.on('panel:refresh', () => void monitor.tick());
  ipcMain.on('widget:open-panel', () => togglePanel());
  ipcMain.on('settings:set', (_e, patch: Partial<Settings>) => void applySettings(patch));
  ipcMain.on('alarms:clear', () => {
    void monitor.clearAlarmHistory().then(pushState);
  });
  ipcMain.on('help:taskbar', () => {
    // Windows owns tray-icon promotion; deep-link to the exact settings page.
    if (process.platform === 'win32') void shell.openExternal('ms-settings:taskbar');
  });

  syncWidget();
  restartLoop();

  // Flush durable state on the way out so the next launch is not a cold start.
  app.on('before-quit', () => {
    void monitor.flush();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());
  app.on('window-all-closed', () => {
    /* tray app: stay resident — the default would quit */
  });
  void app.whenReady().then(start);
}

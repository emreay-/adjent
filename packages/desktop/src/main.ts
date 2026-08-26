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
import { readFile } from 'node:fs/promises';
import type {
  Alarm,
  AlarmConfig,
  AppState,
  ConfigWatcher,
  Diagnostic,
  Monitor,
  Settings,
  Sink,
} from '@adjent/core' with { 'resolution-mode': 'import' };
import { makeTrayIcon } from './trayicon.js';

const coreImport = import('@adjent/core');

/**
 * The packaged icon, used for the taskbar button and alt-tab. Absent in a
 * dev checkout until `pnpm icons` has run, and Electron ignores a missing
 * path, so this needs no guard.
 */
const APP_ICON = path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/** Design sizes at uiScale = 1; both scale with the setting. */
const PANEL_W = 380;
const PANEL_H = 560;
const WIDGET_W = 340;
const WIDGET_H = 96;

let tray: TrayType | null = null;
let configWatcher: ConfigWatcher | null = null;
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

/** Severity in one character, for a menu label with no room for a chip. */
const SEV_MARK: Record<string, string> = { info: '·', warn: '▲', critical: '■' };
const ellipsis = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function buildTrayMenu(): void {
  if (!tray) return;
  const latest = recentAlarms[recentAlarms.length - 1] ?? null;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(latest
        ? [
            { label: `${SEV_MARK[latest.severity] ?? ''} ${ellipsis(latest.title, 48)}`, enabled: false },
            { label: 'Show it', click: () => togglePanel('notifications') },
            { type: 'separator' as const },
          ]
        : []),
      { label: 'Open panel', click: () => togglePanel() },
      {
        label: 'Pinned widget (always visible)',
        type: 'checkbox',
        checked: settings.widgetEnabled,
        click: (item) => void applySettings({ widgetEnabled: item.checked }),
      },
      { label: 'Notifications…', click: () => togglePanel('notifications') },
      { label: 'Alarm rules…', click: () => togglePanel('rules') },
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

/**
 * Hot reload of alarms.yaml, which ARCHITECTURE.md and ALARMS.md both promise.
 *
 * A broken file keeps the running rules rather than reverting to defaults:
 * reverting would quietly replace someone's tuned rules with rules they never
 * chose, at the moment they are editing and not looking at the tray. The
 * problem is reported once, as an `info` alarm, on a cooldown — a save that is
 * broken tends to be saved again a few seconds later.
 */
const CONFIG_INVALID_COOLDOWN_MS = 10 * 60_000;
let lastConfigComplaintAt = 0;

function startConfigReload(): void {
  const path = core.configPath();
  configWatcher = new core.ConfigWatcher(path);

  configWatcher.on('config', (config: AlarmConfig) => {
    monitor?.setConfig(config);
    // Say so: a reload that changes behaviour silently is indistinguishable
    // from one that did not happen.
    notify({
      id: 'config-reloaded',
      ruleId: 'config',
      severity: 'info',
      title: 'Alarm rules reloaded',
      body: `${config.rules.length} ${config.rules.length === 1 ? 'rule' : 'rules'} in force.`,
      firedAt: Date.now(),
      backend: null,
      limitKey: null,
      agentId: null,
    });
  });

  configWatcher.on('invalid', (diagnostics: Diagnostic[]) => {
    const now = Date.now();
    if (now - lastConfigComplaintAt < CONFIG_INVALID_COOLDOWN_MS) return;
    lastConfigComplaintAt = now;
    const first = diagnostics.find((d) => d.level === 'error');
    notify({
      id: 'config-invalid',
      ruleId: 'config',
      severity: 'info',
      title: 'alarms.yaml has an error — previous rules still running',
      body: first ? `${first.path}: ${first.message}` : 'the file could not be parsed',
      firedAt: now,
      backend: null,
      limitKey: null,
      agentId: null,
    });
  });

  void configWatcher.prime().then(() => configWatcher?.start());
}

/**
 * Raise an alarm about Adjent itself. Goes through the monitor so it is
 * recorded in alarms.jsonl like any other — the notifications view reads that
 * file, and a config error is exactly the sort someone reads later.
 */
function notify(alarm: Alarm): void {
  recentAlarms.push(alarm);
  void monitor?.recordAlarm(alarm);
}

/**
 * What Adjent makes of a piece of YAML: what it complained about, and what
 * would actually run. Both halves matter — loading is deliberately lenient, so
 * “no errors” and "the rules you meant" are different questions, and a warning
 * means a key was ignored rather than that anything failed.
 *
 * `null` text is the no-file case, which runs on the built-in defaults.
 */
function inspect(text: string | null): {
  diagnostics: Diagnostic[];
  failed: boolean;
  effective: AlarmConfig;
} {
  if (text === null) return { diagnostics: [], failed: false, effective: core.DEFAULT_CONFIG };
  const { config, diagnostics } = core.parseConfig(text);
  return { diagnostics, failed: core.hasErrors(diagnostics), effective: config };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function createPanel(): BrowserWindowType {
  const win = new BrowserWindow({
    icon: APP_ICON,
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

function togglePanel(view?: 'settings' | 'notifications' | 'rules'): void {
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
  // Draw what is known immediately, then correct it if the reading is old
  // enough to be worth a collection. Waiting for the tick would show an empty
  // panel; not asking for one would show a stale panel and never say so.
  pushState();
  refreshIfStale();
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
    icon: APP_ICON,
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
    // Ordered by urgency for display — soonest to stop you first — so the
    // collapsed list continues the ranking the hero started rather than
    // arriving in whatever order the vendors happened to report. Sorted on a
    // copy: nothing else should depend on the order limits are stored in.
    state: { ...s, limits: [...s.limits].sort(core.compareUrgency) },
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

/**
 * The sink named in `routing` as `tray` (docs/ALARMS.md). It holds the recent
 * few and puts the latest at the top of the tray menu, which is the only place
 * an alarm is legible without opening anything.
 *
 * It used to feed a "Recent alarms" strip on the panel's dashboard as well.
 * That strip is gone: the notifications view shows the same records with their
 * day, their severity and the state they fired in, so the strip was the same
 * information, worse, on the surface with the tightest component budget.
 */
class TraySink implements Sink {
  readonly id = 'tray';
  async deliver(a: Alarm): Promise<void> {
    recentAlarms.push(a);
    if (recentAlarms.length > 20) recentAlarms.shift();
    buildTrayMenu();
  }
}

// ---------------------------------------------------------------------------
/**
 * When the numbers were last collected. Not the same as when they were last
 * *pushed*: the panel is hidden most of the time and receives nothing while it
 * is, so on reopen it gets whatever the last tick produced.
 */
let lastTickAt = 0;

async function tickNow(): Promise<void> {
  lastTickAt = Date.now();
  try {
    await monitor.tick();
  } catch {
    /* a bad tick never kills the shell */
  }
}

/**
 * Collect on open, unless something just did.
 *
 * You open a tray panel to find out where you are *now*, and at the default
 * cadence the answer could be half a minute old before it is drawn. A tick is
 * a few file reads and at most one quota request, so paying for one at the
 * moment someone is actually looking is the right trade.
 *
 * The floor is what keeps that honest: opening and closing the panel
 * repeatedly must not turn into a request per click.
 */
const OPEN_REFRESH_FLOOR_MS = 5_000;
function refreshIfStale(): void {
  if (Date.now() - lastTickAt < OPEN_REFRESH_FLOOR_MS) return;
  void tickNow();
}

function restartLoop(): void {
  if (tickTimer) clearTimeout(tickTimer);
  const loop = async (): Promise<void> => {
    await tickNow();
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
  startConfigReload();

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
  ipcMain.on('panel:refresh', () => void tickNow());
  ipcMain.on('widget:open-panel', () => togglePanel());
  ipcMain.on('settings:set', (_e, patch: Partial<Settings>) => void applySettings(patch));
  // Tier 3 (docs/UI.md § Any limit, on demand): the panel pulls one limit's
  // history and exact token split when the user opens it. Pull, not push —
  // shipping every limit's breakdown on every tick would be most of a
  // megabyte of JSON a second for something usually not on screen.
  ipcMain.handle('limit:detail', (_e, key: string) => monitor?.limitDetail(key) ?? null);

  // ------------------------------------------------------------------------
  // The alarm rules, editable in the panel.
  //
  // Authoring rules was CLI-only, which meant the one surface that shows what
  // the rules *did* had no way to change them: seeing a rule fire four times an
  // hour and having to leave for a terminal to quieten it is the wrong shape.
  //
  // The editor is over the YAML itself rather than a form. The file is the
  // documented interface (docs/ALARMS.md), the presets are commented and are
  // meant to be read, and a form would silently drop every key it did not
  // model. What the panel adds is the part a text editor cannot: the
  // diagnostics and the effective rule set, live, before the file is saved.
  // ------------------------------------------------------------------------
  ipcMain.handle('rules:load', async () => {
    const file = core.configPath();
    let text: string | null = null;
    try {
      text = await readFile(file, 'utf-8');
    } catch {
      // No file is the normal case, not an error: most installs run on the
      // built-in defaults. Offer those as the starting point, not a blank page.
      text = null;
    }
    return { path: file, exists: text !== null, text, ...inspect(text) };
  });
  ipcMain.handle('rules:check', (_e, text: string) => inspect(text));
  ipcMain.handle('rules:preset', async (_e, name: string) => {
    if (!core.isPresetName(name)) return null;
    const text = await core.readPreset(name);
    return { text, ...inspect(text) };
  });
  ipcMain.handle('rules:save', async (_e, text: string) => {
    const checked = inspect(text);
    // Refuse to write a file with an error in it. Saving it would be legal —
    // the loader is lenient and the watcher keeps the running rules — but it
    // would leave a file on disk that does not do what it says it does.
    if (checked.failed) return { ok: false, ...checked };
    try {
      await core.saveConfigText(text);
    } catch (err) {
      return { ok: false, ...checked, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, ...checked };
  });
  ipcMain.handle('rules:presets', () =>
    core.PRESET_NAMES.map((name) => ({ name, summary: core.PRESET_SUMMARY[name] })),
  );
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
    // Hand the icon back explicitly. Windows keeps a tray icon on screen until
    // its owner removes it, so a shell that exits without doing so leaves a
    // dead glyph behind that only disappears when the user happens to mouse
    // over it — and a killed process never gets this far at all.
    tray?.destroy();
    tray = null;
    configWatcher?.close();
    configWatcher = null;
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

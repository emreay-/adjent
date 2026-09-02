/**
 * Persisted user settings (~/.adjent/settings.json).
 *
 * Kept in core rather than the shell because it is plain typed JSON
 * persistence with no UI imports — core stays UI-agnostic, and the CLI can
 * read the same file for poll cadence. A missing or broken file degrades to
 * defaults rather than to an error.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * How plainly to say which vendor a row belongs to.
 *
 * With one backend installed this is noise, which is why `none` is the
 * default; with both, "which of these is Codex?" is a question the agents list
 * could not answer at all — a limit's label carries the vendor, but an agent
 * row never did.
 *
 * `icon` draws Adjent's own small monograms, not the vendors' logos: nothing
 * is fetched at runtime (README: local-first, sends nothing anywhere), and no
 * third-party trademark is redistributed.
 */
export type VendorDisplay = 'none' | 'name' | 'icon';

/** Which tray glyph to draw. See brand/assets/tray for the vector masters. */
export type TrayStyle = 'robot' | 'ring' | 'a-mark';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  /** Panel/widget zoom. 1 = design size. Clamped to [0.8, 2.0]. */
  uiScale: number;
  /** Follow the OS, or pin light/dark. Drives prefers-color-scheme directly. */
  theme: Theme;
  /** Tray glyph: the robot head, the gauge ring, or the A-mark. */
  trayStyle: TrayStyle;
  /** Ring thickness as a fraction of the icon radius. Clamped to [0.18, 0.5]. */
  trayThickness: number;
  /** Show the always-on-top compact strip (docs/UI.md § pinned widget). */
  widgetEnabled: boolean;
  /** Give the widget a taskbar button so it is clickable from the taskbar. */
  widgetTaskbarButton: boolean;
  widgetPosition: { x: number; y: number } | null;
  /** Monitor tick cadence. Clamped to [10, 300]. */
  tickIntervalSec: number;
  alarmsPaused: boolean;
  /**
   * POST alarms routed to the `webhook` sink here. Null (the default) means the
   * sink is not built at all, and a routing table naming it reports itself as
   * unroutable rather than dropping alarms in silence.
   */
  alarmWebhookUrl: string | null;
  /**
   * Whether a *rule* may take an action — today, set the advisory gate.
   *
   * Off by default, and the default is the point: automation that can hold
   * your work should be something you turned on, not something you discover.
   * **This governs automation only.** A person running `adjent gate hold` is
   * never subject to it, because the switch exists to bound what Adjent does
   * on its own, not what you do deliberately (§4 Q1, sub-decision 3).
   */
  actions: { enabled: boolean };
  /** How plainly to mark which vendor a row belongs to. */
  vendorDisplay: VendorDisplay;
}

export const DEFAULT_SETTINGS: Settings = {
  uiScale: 1,
  theme: 'system',
  trayStyle: 'robot',
  trayThickness: 0.34,
  widgetEnabled: false,
  widgetTaskbarButton: true,
  widgetPosition: null,
  tickIntervalSec: 30,
  alarmsPaused: false,
  alarmWebhookUrl: null,
  actions: { enabled: false },
  vendorDisplay: 'none',
};

export const settingsPath = (): string => path.join(os.homedir(), '.adjent', 'settings.json');

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export function coerceSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pos = r['widgetPosition'];
  const p = typeof pos === 'object' && pos !== null ? (pos as Record<string, unknown>) : null;
  const theme = r['theme'];
  return {
    uiScale: clamp(r['uiScale'], 0.8, 2.0, DEFAULT_SETTINGS.uiScale),
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    trayStyle: r['trayStyle'] === 'ring' || r['trayStyle'] === 'a-mark' ? r['trayStyle'] : 'robot',
    trayThickness: clamp(r['trayThickness'], 0.18, 0.5, DEFAULT_SETTINGS.trayThickness),
    widgetEnabled: r['widgetEnabled'] === true,
    widgetTaskbarButton: r['widgetTaskbarButton'] !== false,
    widgetPosition:
      p && typeof p['x'] === 'number' && typeof p['y'] === 'number'
        ? { x: p['x'] as number, y: p['y'] as number }
        : null,
    tickIntervalSec: clamp(r['tickIntervalSec'], 10, 300, DEFAULT_SETTINGS.tickIntervalSec),
    alarmsPaused: r['alarmsPaused'] === true,
    alarmWebhookUrl: typeof r['alarmWebhookUrl'] === 'string' && r['alarmWebhookUrl'].trim() !== ''
      ? (r['alarmWebhookUrl'] as string).trim()
      : null,
    // Anything but an explicit `true` is off. A malformed settings file must
    // not be a way to enable automation by accident.
    actions: { enabled: (r['actions'] as Record<string, unknown> | undefined)?.['enabled'] === true },
    vendorDisplay:
      r['vendorDisplay'] === 'name' || r['vendorDisplay'] === 'icon' ? r['vendorDisplay'] : 'none',
  };
}

export async function loadSettings(file: string = settingsPath()): Promise<Settings> {
  try {
    return coerceSettings(JSON.parse(await fs.readFile(file, 'utf-8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Writes only into ~/.adjent — never into a vendor directory (CLAUDE.md rule 1). */
export async function saveSettings(s: Settings, file: string = settingsPath()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(coerceSettings(s), null, 2) + '\n', 'utf-8');
  } catch {
    /* a failed write must not take the app down */
  }
}

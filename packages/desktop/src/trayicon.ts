/**
 * Tray glyph rendering.
 *
 * The glyph is an instrument, not a shrunken logo. It answers the panel's one
 * question at a glance: two columns standing on a common foot, the left one
 * filled to the binding limit's utilization, the right one marked at the pace
 * line. Taller-than-the-mark means burning faster than the window allows, and
 * the size of the difference is the size of the problem — a reading that
 * survives with the colour ignored entirely.
 *
 * Everything is authored on the pixel grid and rendered with hard edges: rows
 * and columns only, no diagonals, no antialiasing. Device pixels are an integer
 * upscale of the logical grid, so the glyph is crisp at any scale factor rather
 * than resampled. The empty part of each column is drawn in the same hue at low
 * alpha, so the track reads on light and dark panels without a second colour.
 */
import type { NativeImage } from 'electron';
import type { TrayStyle } from '@adjent/core' with { 'resolution-mode': 'import' };

export const VERDICT_RGB: Record<string, [number, number, number]> = {
  'on-pace': [0x0c, 0xa3, 0x0c],
  ahead: [0xfa, 0xb2, 0x19],
  over: [0xd0, 0x3b, 0x3b],
  idle: [0x86, 0x93, 0xa0],
};

/** Mask levels. The track is the same hue at TRACK_ALPHA; the reading is opaque. */
const EMPTY = 0;
const TRACK = 1;
const SOLID = 2;
const TRACK_ALPHA = 0.3;

/** Proportions of the logical grid, so 16px and 22px slots stay on-grid. */
const FOOT_H = 1 / 8;
const COL_W = 5 / 16;
const MEASURED_X = 2 / 16;
const DATUM_X = 9 / 16;
const SIDE_INSET = 1 / 16;

export interface TrayIconOptions {
  /** Vendor-reported utilization of the binding limit, 0..100+. */
  utilization: number;
  /** Where utilization would be if the window were burned evenly — the pace line. */
  pace?: number;
  verdict: string;
  /** `ring` draws both columns; `disc` drops the pace column for cluttered panels. */
  style: TrayStyle;
  /** Scales column width. 0.28 is the drawn weight. */
  thickness: number;
  /** Logical size in px (16 is the Windows tray slot; 22 suits most Linux panels). */
  logicalSize: number;
  /** Device pixels per logical px — 2 or 3 keeps it sharp on HiDPI. */
  scaleFactor: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The glyph as a logical-resolution level mask — the whole design lives here. */
export function renderTrayMask(o: TrayIconOptions): { mask: Uint8Array; n: number } {
  const n = Math.max(8, Math.round(o.logicalSize));
  const mask = new Uint8Array(n * n);
  const set = (x0: number, y0: number, w: number, h: number, v: number): void => {
    for (let y = y0; y < y0 + h; y++) {
      if (y < 0 || y >= n) continue;
      for (let x = x0; x < x0 + w; x++) if (x >= 0 && x < n) mask[y * n + x] = v;
    }
  };

  const footH = Math.max(1, Math.round(n * FOOT_H));
  const span = n - footH;
  const inset = Math.max(0, Math.round(n * SIDE_INSET));
  const weight = clamp(o.thickness / 0.28, 0.7, 1.6);
  const colW = Math.max(2, Math.round(n * COL_W * weight));
  const measuredX = Math.round(n * MEASURED_X);
  const datumX = Math.round(n * DATUM_X);
  /** Rows of column filled by a percentage. */
  const rows = (pct: number): number => Math.round((span * clamp(pct, 0, 100)) / 100);

  // The foot is the one fixed element: it makes the columns read as standing on
  // a baseline, and it keeps the idle glyph from being an empty rectangle.
  set(inset, span, n - 2 * inset, footH, SOLID);

  set(measuredX, 0, colW, span, TRACK);
  if (o.style !== 'disc') set(datumX, 0, colW, span, TRACK);

  // Idle means nothing is being measured: the tracks and the foot stand alone.
  if (o.verdict === 'idle') return { mask, n };

  const filled = rows(o.utilization);
  set(measuredX, span - filled, colW, filled, SOLID);

  if (o.style !== 'disc') {
    // The pace column is marked, not filled — it is a reference, not a quantity.
    const at = rows(o.pace ?? 0);
    if (at > 0) set(datumX, span - at, colW, Math.max(1, Math.round(n / 32)), SOLID);
  }
  return { mask, n };
}

/**
 * Returns the raw RGBA buffer plus its pixel dimensions. Kept free of the
 * electron import so it is unit-testable; the caller wraps it in nativeImage.
 */
export function renderTrayBuffer(o: TrayIconOptions): { buf: Buffer; px: number } {
  const { mask, n } = renderTrayMask(o);
  // Integer upscale only — a fractional one would reintroduce soft edges.
  const scale = Math.max(1, Math.round(o.scaleFactor));
  const px = n * scale;
  const buf = Buffer.alloc(px * px * 4);
  const rgb = VERDICT_RGB[o.verdict] ?? VERDICT_RGB['idle']!;

  for (let y = 0; y < px; y++) {
    const my = Math.floor(y / scale);
    for (let x = 0; x < px; x++) {
      const v = mask[my * n + Math.floor(x / scale)]!;
      if (v === EMPTY) continue;
      const i = (y * px + x) * 4;
      buf[i] = rgb[0]!;
      buf[i + 1] = rgb[1]!;
      buf[i + 2] = rgb[2]!;
      buf[i + 3] = v === TRACK ? Math.round(TRACK_ALPHA * 255) : 255;
    }
  }
  return { buf, px };
}

export function makeTrayIcon(
  nativeImage: { createFromBuffer(b: Buffer, o: { width: number; height: number; scaleFactor: number }): NativeImage },
  o: TrayIconOptions,
): NativeImage {
  const { buf, px } = renderTrayBuffer(o);
  return nativeImage.createFromBuffer(buf, { width: px, height: px, scaleFactor: Math.max(1, Math.round(o.scaleFactor)) });
}

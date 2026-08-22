/**
 * Tray glyph rendering.
 *
 * The tray glyph is a *reduction* of the brand mark, not a miniature of it.
 * The mark is a plate with two rules knocked out of it at a 1:2 slope; at 16px
 * a plate plus two knockouts is three features in 256 pixels, and it renders as
 * a coloured blob with dirt on it. So the tray inverts figure and ground and
 * keeps only the two rules: a heavy one for the measured burn, a lighter one
 * for the datum it is measured against. The gap between them is the drift.
 *
 * Everything here is authored on the pixel grid and rendered with hard edges —
 * no supersampling, no antialiasing. A 1:2 slope steps exactly one pixel across
 * for every two down, which reads as a clean line at tray size, where an
 * antialiased diagonal reads as a jagged smear. Device pixels are an integer
 * upscale of the logical grid, so the glyph stays crisp at any scale factor.
 */
import type { NativeImage } from 'electron';
import type { TrayStyle } from '@adjent/core' with { 'resolution-mode': 'import' };

export const VERDICT_RGB: Record<string, [number, number, number]> = {
  'on-pace': [0x0c, 0xa3, 0x0c],
  ahead: [0xfa, 0xb2, 0x19],
  over: [0xd0, 0x3b, 0x3b],
  idle: [0x86, 0x93, 0xa0],
};

/** Rows of rise per pixel of horizontal drift — the mark's 1:2 slope. */
const SLOPE_STEP = 2;
/** Proportions of the logical grid, so 16, 22 and 24px slots all stay on-grid. */
const MEASURED_W = 0.25;
const DATUM_W = 0.1875;
const DATUM_X = 0.625;
/** Where the measured rule sits at zero burn — touching the datum — and how far it travels. */
const MEASURED_X0 = 0.375;

export interface TrayIconOptions {
  utilization: number;
  verdict: string;
  /** `ring` draws both rules; `disc` drops the datum, leaving one heavier rule. */
  style: TrayStyle;
  /** Scales rule weight. 0.28 is the drawn weight. */
  thickness: number;
  /** Logical size in px (16 is the Windows tray slot; 22 suits most Linux panels). */
  logicalSize: number;
  /** Device pixels per logical px — 2 or 3 keeps it sharp on HiDPI. */
  scaleFactor: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Paints one sheared rule into the mask. `x0` is its foot, at the bottom row;
 * the rule drifts one pixel right for every `SLOPE_STEP` rows of rise.
 */
function rule(mask: Uint8Array, n: number, x0: number, w: number): void {
  for (let y = 0; y < n; y++) {
    const off = Math.floor((n - 1 - y) / SLOPE_STEP);
    for (let i = 0; i < w; i++) {
      const x = x0 + off + i;
      if (x >= 0 && x < n) mask[y * n + x] = 1;
    }
  }
}

/** The glyph as a logical-resolution on/off mask — the whole design lives here. */
export function renderTrayMask(o: TrayIconOptions): { mask: Uint8Array; n: number } {
  const n = Math.max(8, Math.round(o.logicalSize));
  const mask = new Uint8Array(n * n);
  const weight = clamp(o.thickness / 0.28, 0.7, 1.6);

  const wDatum = Math.max(1, Math.round(n * DATUM_W * weight));
  const wMeasured = Math.max(2, Math.round(n * MEASURED_W * weight));

  // The datum never moves. `disc` drops it for panels where one rule reads better.
  if (o.style !== 'disc') rule(mask, n, Math.round(n * DATUM_X), wDatum);

  // Idle means nothing is being measured: the datum stands alone.
  if (o.verdict !== 'idle') {
    // At zero burn the measured rule touches the datum; it slides left as burn rises,
    // and past 100% it runs off the edge, which is the right feeling for a limit passed.
    const x0 = Math.round(n * MEASURED_X0 * (1 - clamp(o.utilization, 0, 140) / 100));
    rule(mask, n, x0, wMeasured);
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
      if (mask[my * n + Math.floor(x / scale)] === 0) continue;
      const i = (y * px + x) * 4;
      buf[i] = rgb[0]!;
      buf[i + 1] = rgb[1]!;
      buf[i + 2] = rgb[2]!;
      buf[i + 3] = 255;
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

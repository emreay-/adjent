/**
 * Tray glyph rendering.
 *
 * The glyph is the brand mark: a solid plate with two rules knocked out of it
 * at a 1:2 slope — a heavy one for the measured burn, a dash-dot one for the
 * datum it is measured against. Geometry is specified on a 64-unit plate in
 * brand/assets/adjent-mark.svg; this file expresses the same numbers in a
 * rasteriser so the desktop package stays dependency-free.
 *
 * Windows fixes the tray slot at 16 *logical* px, so "bigger" is really two
 * things: render at a high scaleFactor so the glyph is crisp instead of
 * blurry on HiDPI, and use a coarser cut of the mark so the knockout does not
 * close up. Both are settings-driven.
 *
 * Drawn by hand into an RGBA buffer with 4× supersampling — no canvas
 * dependency, and the antialiasing is what makes the rules readable at 16px.
 */
import type { NativeImage } from 'electron';
import type { TrayStyle } from '@adjent/core' with { 'resolution-mode': 'import' };

export const VERDICT_RGB: Record<string, [number, number, number]> = {
  'on-pace': [0x0c, 0xa3, 0x0c],
  ahead: [0xfa, 0xb2, 0x19],
  over: [0xd0, 0x3b, 0x3b],
  idle: [0x86, 0x93, 0xa0],
};

const SS = 4; // supersampling factor

/** The plate is specified on a 64-unit square; every constant below is in those units. */
const PLATE = 64;
/** Rules run at a 1:2 slope. Unit direction along a rule, and its normal. */
const INV_SQRT5 = 1 / Math.sqrt(5);
const DIR: readonly [number, number] = [INV_SQRT5, -2 * INV_SQRT5];
const NORM: readonly [number, number] = [2 * INV_SQRT5, INV_SQRT5];
/** Both rules pass through y = 76, below the plate, so neither has a visible end. */
const RULE_Y = 76;
/** The datum never moves; the measured rule slides across the plate as burn rises. */
const DATUM_X = 34;
const MEASURED_X0 = 20;
const MEASURED_TRAVEL = 0.32;

/**
 * Coarse cut (tray sizes) and fine cut (32px and up), interpolated by size.
 *
 * The dash-dot is the first thing to fail as the plate shrinks: below 32px the
 * marks land on two or three pixels and read as dirt on the glyph rather than
 * as a datum. So the tray cut keeps the second rule and drops its dashes — the
 * weight difference still says which rule is the reference — and the dash-dot
 * returns at brand sizes where it can be drawn properly.
 */
const DASH_MIN_PX = 32;
const COARSE = { solid: 9, datum: 5 };
const FINE = { solid: 8, datum: 4 };
const DASH = [12, 4, 2, 4] as const;

export interface TrayIconOptions {
  utilization: number;
  verdict: string;
  /** `ring` knocks out both rules; `disc` keeps only the measured rule, for cluttered panels. */
  style: TrayStyle;
  /** Scales rule weight. 0.28 is the drawn weight; below that the rules thin, above they fatten. */
  thickness: number;
  /** Logical size in px (16 is the Windows tray slot; 22 suits most Linux panels). */
  logicalSize: number;
  /** Device pixels per logical px — 2 or 3 keeps it sharp on HiDPI. */
  scaleFactor: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Returns the raw RGBA buffer plus its pixel dimensions. Kept free of the
 * electron import so it is unit-testable; the caller wraps it in nativeImage.
 */
export function renderTrayBuffer(o: TrayIconOptions): { buf: Buffer; px: number } {
  const px = Math.max(8, Math.round(o.logicalSize * o.scaleFactor));
  const hi = px * SS;
  const buf = Buffer.alloc(px * px * 4);
  const rgb = VERDICT_RGB[o.verdict] ?? VERDICT_RGB['idle']!;

  // At tray sizes the rules would silt up, so take the coarse cut; above 32px the fine one.
  const t = clamp((o.logicalSize - 16) / (DASH_MIN_PX - 16), 0, 1);
  const weight = clamp(o.thickness / 0.28, 0.7, 1.6);
  const wSolid = lerp(COARSE.solid, FINE.solid, t) * weight;
  const wDatum = lerp(COARSE.datum, FINE.datum, t) * weight;
  const dashed = o.logicalSize >= DASH_MIN_PX;
  const period = DASH.reduce((a, b) => a + b, 0);

  // Idle means nothing is being measured: the datum stands alone.
  const measured = o.verdict !== 'idle';
  const measuredX = MEASURED_X0 - MEASURED_TRAVEL * clamp(o.utilization, 0, 140);
  // Perpendicular offsets of each rule from the plate origin.
  const kSolid = NORM[0] * measuredX + NORM[1] * RULE_Y;
  const kDatum = NORM[0] * DATUM_X + NORM[1] * RULE_Y;
  // `disc` drops the datum, leaving one heavier rule.
  const withDatum = o.style !== 'disc';

  const cov = new Float32Array(px * px);
  const per = SS * SS;

  for (let y = 0; y < hi; y++) {
    const v = ((y + 0.5) / hi) * PLATE;
    for (let x = 0; x < hi; x++) {
      const u = ((x + 0.5) / hi) * PLATE;
      const k = NORM[0] * u + NORM[1] * v;

      if (measured && Math.abs(k - kSolid) <= wSolid / 2) continue;

      if (withDatum && Math.abs(k - kDatum) <= wDatum / 2) {
        if (!dashed) continue;
        // Position along the datum, wrapped into one dash-dot period.
        const s = DIR[0] * (u - DATUM_X) + DIR[1] * (v - RULE_Y);
        const m = ((s % period) + period) % period;
        if (m < DASH[0] || (m >= DASH[0] + DASH[1] && m < DASH[0] + DASH[1] + DASH[2])) continue;
      }

      const idx = Math.floor(y / SS) * px + Math.floor(x / SS);
      cov[idx] = (cov[idx] as number) + 1;
    }
  }

  for (let i = 0; i < px * px; i++) {
    const a = (cov[i] as number) / per;
    if (a === 0) continue;
    const o4 = i * 4;
    buf[o4] = rgb[0]!;
    buf[o4 + 1] = rgb[1]!;
    buf[o4 + 2] = rgb[2]!;
    buf[o4 + 3] = Math.round(a * 255);
  }
  return { buf, px };
}

export function makeTrayIcon(
  nativeImage: { createFromBuffer(b: Buffer, o: { width: number; height: number; scaleFactor: number }): NativeImage },
  o: TrayIconOptions,
): NativeImage {
  const { buf, px } = renderTrayBuffer(o);
  return nativeImage.createFromBuffer(buf, { width: px, height: px, scaleFactor: o.scaleFactor });
}

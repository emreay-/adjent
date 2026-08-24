/**
 * Tray glyph rendering.
 *
 * Three styles, chosen in settings: the robot head (default), the gauge ring,
 * and the A-mark. Each is the vector master in brand/assets/tray drawn again
 * for the pixel grid — not the master scaled down, which is what fails at 16px:
 * an antialiased diagonal becomes a smear and a one-pixel detail becomes dirt.
 *
 * Everything here is rows, columns and integer circle tests, with hard edges
 * and no antialiasing. Proportions are expressed as fractions of the grid so a
 * 16px Windows slot and a 22px Linux panel both land on whole pixels, and
 * device pixels are an integer upscale of that grid rather than a resample.
 *
 * The verdict colours the whole glyph rather than an accent on it, and `over`
 * inverts — a light glyph on a solid red plate. Orange and red are the worst
 * pair for the commonest colour-blindness, so that state differs in form as
 * well as hue, and stays legible with colour removed.
 */
import type { NativeImage } from 'electron';
import type { TrayStyle } from '@adjent/core' with { 'resolution-mode': 'import' };

export const VERDICT_RGB: Record<string, [number, number, number]> = {
  'on-pace': [0x0c, 0xa3, 0x0c],
  ahead: [0xff, 0x8f, 0x00],
  over: [0xb3, 0x18, 0x1f],
  idle: [0x86, 0x93, 0xa0],
};

const INK: [number, number, number] = [0x13, 0x1a, 0x22];
const EYE: [number, number, number] = [0x6f, 0xef, 0xef];
const WHITE: [number, number, number] = [0xff, 0xff, 0xff];

/** Mask levels, resolved to colours per state at paint time. */
const EMPTY = 0;
const PLATE = 1;
const BODY = 2;
const DARK = 3;
const EYES = 4;
const LIGHT = 5;

export interface TrayIconOptions {
  /** Vendor-reported utilization of the binding limit, 0..100+. Reserved for the ring sweep. */
  utilization: number;
  /** Where utilization would be if the window were burned evenly. */
  pace?: number;
  verdict: string;
  /** Which of the three glyphs to draw. */
  style: TrayStyle;
  /** Retained for settings compatibility; the pixel grid fixes weights. */
  thickness?: number;
  /** Logical size in px (16 is the Windows tray slot; 22 suits most Linux panels). */
  logicalSize: number;
  /** Device pixels per logical px — 2 or 3 keeps it sharp on HiDPI. */
  scaleFactor: number;
}

/** A grid of level values, with helpers that clip to it. */
class Grid {
  readonly m: Uint8Array;
  readonly n: number;
  constructor(n: number) {
    this.n = n;
    this.m = new Uint8Array(n * n);
  }
  set(x: number, y: number, v: number): void {
    if (x >= 0 && x < this.n && y >= 0 && y < this.n) this.m[y * this.n + x] = v;
  }
  box(x0: number, y0: number, w: number, h: number, v: number): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, v);
  }
  /** Filled rectangle with the corners cut back, so a plate reads as a rounded tile. */
  plate(v: number): void {
    const n = this.n;
    const r = Math.max(1, Math.round(n * 0.2));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x < r ? r - x : x >= n - r ? x - (n - 1 - r) : 0;
        const dy = y < r ? r - y : y >= n - r ? y - (n - 1 - r) : 0;
        if (dx * dx + dy * dy > r * r) continue;
        this.set(x, y, v);
      }
    }
  }
  /** Rectangle with cut-back corners — hard-edged, no antialiasing. */
  roundedBox(x0: number, y0: number, w: number, h: number, r: number, v: number): void {
    const rad = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x < rad ? rad - x : x >= w - rad ? x - (w - 1 - rad) : 0;
        const dy = y < rad ? rad - y : y >= h - rad ? y - (h - 1 - rad) : 0;
        if (dx * dx + dy * dy > rad * rad) continue;
        this.set(x0 + x, y0 + y, v);
      }
    }
  }
  /** A band of ring between two radii, limited to an angular span. */
  annulus(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number, v: number): void {
    for (let y = Math.floor(cy - rOut); y <= Math.ceil(cy + rOut); y++) {
      for (let x = Math.floor(cx - rOut); x <= Math.ceil(cx + rOut); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < rIn || d > rOut) continue;
        let a = (Math.atan2(cy - y, x - cx) * 180) / Math.PI;
        if (a < 0) a += 360;
        if (a > a0 || a < a1) continue;
        this.set(x, y, v);
      }
    }
  }
  /** A 1px line from the centre outwards, for the needle. */
  ray(cx: number, cy: number, r0: number, r1: number, deg: number, v: number): void {
    const th = (deg * Math.PI) / 180;
    for (let r = r0; r <= r1; r += 0.4) {
      this.set(Math.round(cx + r * Math.cos(th)), Math.round(cy - r * Math.sin(th)), v);
    }
  }
}

/**
 * Shapes draw into a frame rather than the whole grid: when `over` inverts onto
 * a plate, the glyph insets so the red reads as a field around it rather than
 * as a hairline border.
 */
interface Frame {
  x: number;
  y: number;
  s: number;
}
const frameFor = (n: number, inverted: boolean): Frame => {
  const inset = inverted ? Math.round(n * 0.14) : 0;
  return { x: inset, y: inset, s: n - 2 * inset };
};

function robot(g: Grid, f: Frame, body: number): void {
  const P = (k: number): number => Math.round(f.s * k);
  const pad = Math.max(1, P(0.125));
  const cx = f.x + (f.s - 1) / 2;

  // Ear pods need about two pixels each side before they stop being noise.
  if (f.s >= 24) {
    const pw = Math.max(2, P(0.07));
    const ph = Math.max(3, P(0.2));
    g.box(f.x, f.y + P(0.42), pw, ph, body);
    g.box(f.x + f.s - pw, f.y + P(0.42), pw, ph, body);
  }

  const stem = Math.max(1, P(0.06));
  g.box(Math.round(cx - stem / 2), f.y, Math.max(1, stem), pad, body); // antenna
  g.roundedBox(f.x + pad, f.y + pad, f.s - 2 * pad, f.s - 2 * pad, P(0.14), body); // head

  // The forehead gauge only earns its pixels once the band is at least two rows.
  if (f.s >= 28) {
    const gy = f.y + P(0.5);
    g.annulus(cx, gy, P(0.2), P(0.29), 140, 40, DARK);
    if (f.s >= 40) g.ray(cx, gy, P(0.05), P(0.31), 36, LIGHT);
  }

  const vx = P(0.1875);
  g.roundedBox(f.x + vx, f.y + P(0.46), f.s - 2 * vx, Math.max(2, P(0.3)), P(0.08), DARK);
  const eye = Math.max(1, P(0.11));
  g.box(f.x + P(0.31), f.y + P(0.57), eye, eye, EYES);
  g.box(f.x + P(0.58), f.y + P(0.57), eye, eye, EYES);
}

function ring(g: Grid, f: Frame, body: number): void {
  const cx = f.x + (f.s - 1) / 2;
  const cy = f.y + (f.s - 1) / 2;
  const rOut = f.s * 0.47;
  const rIn = f.s * 0.3;
  for (let y = f.y; y < f.y + f.s; y++) {
    for (let x = f.x; x < f.x + f.s; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rIn) g.set(x, y, DARK);
      else if (d <= rOut) g.set(x, y, body);
    }
  }
  g.ray(cx, cy, 0, rIn * 0.8, 55, LIGHT);
}

function amark(g: Grid, f: Frame, body: number): void {
  const P = (k: number): number => Math.round(f.s * k);
  const cx = f.x + (f.s - 1) / 2;
  const top = f.y + P(0.0625);
  const bottom = f.y + f.s - 1 - P(0.0625);
  const half = Math.max(1, Math.floor(P(0.1875) / 2));
  const spread = f.s * 0.4;
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / Math.max(1, bottom - top);
    for (const lx of [cx - t * spread, cx + t * spread]) {
      for (let i = -half; i <= half; i++) g.set(Math.round(lx) + i, y, body);
    }
  }
  // The gauge recess in the letter's opening, with a needle in it.
  const ry = bottom - Math.max(2, P(0.25));
  g.box(Math.round(cx) - P(0.1875), ry, 2 * P(0.1875), bottom - ry, DARK);
  g.ray(cx, bottom - 1, 0, Math.max(2, P(0.22)), 60, LIGHT);
}

const SHAPES: Record<string, (g: Grid, f: Frame, body: number) => void> = {
  robot,
  ring,
  'a-mark': amark,
};

/** The glyph as a logical-resolution level mask — the whole design lives here. */
export function renderTrayMask(o: TrayIconOptions): { mask: Uint8Array; n: number } {
  // Author at the resolution the display actually gives us. Upscaling a 16px
  // grid onto a 2x panel wastes half the pixels and keeps the glyph coarse;
  // drawing at 32 or 48 is what lets the gauge and the pods exist at all.
  const n = Math.max(8, Math.round(o.logicalSize * Math.max(1, o.scaleFactor)));
  const g = new Grid(n);
  const inverted = o.verdict === 'over';
  if (inverted) g.plate(PLATE);
  (SHAPES[o.style] ?? robot)(g, frameFor(n, inverted), inverted ? LIGHT : BODY);
  return { mask: g.m, n };
}

/**
 * Returns the raw RGBA buffer plus its pixel dimensions. Kept free of the
 * electron import so it is unit-testable; the caller wraps it in nativeImage.
 */
export function renderTrayBuffer(o: TrayIconOptions): { buf: Buffer; px: number } {
  const { mask, n } = renderTrayMask(o);
  const size = n;
  const buf = Buffer.alloc(size * size * 4);
  const verdict = VERDICT_RGB[o.verdict] ?? VERDICT_RGB['idle']!;
  const inverted = o.verdict === 'over';

  const colour = (v: number): [number, number, number] | null => {
    switch (v) {
      case PLATE:
        return verdict;
      case BODY:
        return verdict;
      case DARK:
        return INK;
      case EYES:
        return EYE;
      case LIGHT:
        return inverted ? WHITE : WHITE;
      default:
        return null;
    }
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = mask[y * n + x]!;
      if (v === EMPTY) continue;
      const c = colour(v);
      if (!c) continue;
      const i = (y * size + x) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = 255;
    }
  }
  return { buf, px: size };
}

export function makeTrayIcon(
  nativeImage: { createFromBuffer(b: Buffer, o: { width: number; height: number; scaleFactor: number }): NativeImage },
  o: TrayIconOptions,
): NativeImage {
  const { buf, px: size } = renderTrayBuffer(o);
  return nativeImage.createFromBuffer(buf, {
    width: size,
    height: size,
    scaleFactor: Math.max(1, Math.round(o.scaleFactor)),
  });
}

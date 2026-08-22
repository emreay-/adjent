/**
 * Tray glyph rendering.
 *
 * Windows fixes the tray slot at 16 *logical* px, so "bigger" is really two
 * things: render at a high scaleFactor so the glyph is crisp instead of
 * blurry on HiDPI, and use more of the slot (thicker ring, larger radius).
 * Both are settings-driven.
 *
 * Drawn by hand into an RGBA buffer with 4× supersampling — no canvas
 * dependency, and the antialiasing is what makes a 16px arc readable.
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

export interface TrayIconOptions {
  utilization: number;
  verdict: string;
  style: TrayStyle;
  /** Ring thickness as a fraction of radius. */
  thickness: number;
  /** Logical size in px (16 is the Windows tray slot; 22 suits most Linux panels). */
  logicalSize: number;
  /** Device pixels per logical px — 2 or 3 keeps it sharp on HiDPI. */
  scaleFactor: number;
}

/**
 * Returns the raw RGBA buffer plus its pixel dimensions. Kept free of the
 * electron import so it is unit-testable; the caller wraps it in nativeImage.
 */
export function renderTrayBuffer(o: TrayIconOptions): { buf: Buffer; px: number } {
  const px = Math.max(8, Math.round(o.logicalSize * o.scaleFactor));
  const hi = px * SS;
  const buf = Buffer.alloc(px * px * 4);
  const rgb = VERDICT_RGB[o.verdict] ?? VERDICT_RGB['idle']!;

  const c = (hi - 1) / 2;
  // Use nearly the whole slot: a 1-device-pixel margin, no more.
  const rOuter = hi / 2 - SS * o.scaleFactor * 0.5;
  const rInner = o.style === 'disc' ? 0 : rOuter * (1 - Math.min(0.5, Math.max(0.18, o.thickness)));
  const sweep = (Math.max(0, Math.min(100, o.utilization)) / 100) * 2 * Math.PI;

  // Accumulate coverage of "filled arc" and "track" separately, then compose.
  const covFill = new Float32Array(px * px);
  const covTrack = new Float32Array(px * px);

  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      if (dist > rOuter || dist < rInner) continue;
      let ang = Math.atan2(dx, -dy); // 0 at 12 o'clock, clockwise
      if (ang < 0) ang += 2 * Math.PI;
      const idx = Math.floor(y / SS) * px + Math.floor(x / SS);
      if (ang <= sweep) covFill[idx] = (covFill[idx] as number) + 1;
      else covTrack[idx] = (covTrack[idx] as number) + 1;
    }
  }

  const per = SS * SS;
  for (let i = 0; i < px * px; i++) {
    const f = (covFill[i] as number) / per;
    const t = (covTrack[i] as number) / per;
    if (f === 0 && t === 0) continue;
    // Filled portion at full alpha; unfilled track as a faint guide.
    const alpha = Math.min(1, f + t * 0.28);
    const o4 = i * 4;
    buf[o4] = rgb[0]!;
    buf[o4 + 1] = rgb[1]!;
    buf[o4 + 2] = rgb[2]!;
    buf[o4 + 3] = Math.round(alpha * 255);
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

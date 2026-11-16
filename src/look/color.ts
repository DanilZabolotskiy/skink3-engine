// Colour math: sRGB hex <-> HSV, CIE L*, and the derived tones the automatic
// light needs. HSV is the working space of the look rules ("too much saturation
// and little black"); L* is what the role bands are measured in.

import { angleDiffDeg, clamp01 } from '../core/math.ts';

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Hsv {
  /** Hue in degrees, 0..360. */
  readonly h: number;
  /** Saturation, 0..1. */
  readonly s: number;
  /** Value, 0..1. */
  readonly v: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: string): boolean {
  return HEX.test(value);
}

export function parseHex(hex: string): Rgb {
  if (!HEX.test(hex)) throw new Error(`invalid colour "${hex}": expected #RRGGBB`);
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function hex2(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
}

export function toHex(c: Rgb): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function rgbToHsv(c: Rgb): Hsv {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(c: Hsv): Rgb {
  const h = ((c.h % 360) + 360) % 360;
  const s = clamp01(c.s);
  const v = clamp01(c.v);
  const k = (n: number): number => {
    const x = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return { r: k(5) * 255, g: k(3) * 255, b: k(1) * 255 };
}

/** A colour from hue (degrees), saturation and value (0..1), as #RRGGBB. */
export function hsv(h: number, s: number, v: number): string {
  return toHex(hsvToRgb({ h, s, v }));
}

export function hexToHsv(hex: string): Hsv {
  return rgbToHsv(parseHex(hex));
}

/** CIE L* (0..100) of an sRGB colour. */
export function lightness(hex: string): number {
  const c = parseHex(hex);
  const lin = (u: number): number => {
    const x = u / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** `rgba(...)` string of a hex colour at the given opacity. */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  return `rgba(${c.r},${c.g},${c.b},${clamp01(alpha).toFixed(4)})`;
}

/** Linear blend of two colours in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

/** Moves a hue toward a target hue by at most `maxDeg` degrees along the short way. */
function hueToward(h: number, target: number, maxDeg: number): number {
  const d = angleDiffDeg(h, target);
  const step = Math.max(-maxDeg, Math.min(maxDeg, d));
  return (h + step + 360) % 360;
}

/**
 * The hues the automatic light leans to when a palette says nothing about it
 * (`tones`): shadows toward this hue, lit tones toward that one. They are the
 * lean the engine was built with, kept so that a palette which does not name
 * its own draws as it always did. A palette replaces them, or turns the lean
 * off, with `tones`.
 */
export const SHADOW_HUE = 262;
export const HIGHLIGHT_HUE = 52;

/**
 * The shadow tone of a colour: darker, more saturated, its hue leaning toward
 * `toward` (degrees; null: it keeps its hue). `depth` 1 is the normal
 * crescent; 2 is a stacked, deeper shadow.
 */
export function shadowTone(hex: string, depth = 1, toward: number | null = SHADOW_HUE): string {
  const c = hexToHsv(hex);
  return toHex(hsvToRgb({
    h: toward === null ? c.h : hueToward(c.h, toward, 14 * depth),
    s: clamp01(c.s * 1.12 + 0.08 * depth),
    v: c.v * 0.6 ** depth,
  }));
}

/**
 * The lit tone of a colour: lighter, less saturated, its hue leaning toward
 * `toward` (degrees; null: it keeps its hue). `amount` 0..1 sets how far it
 * goes toward white.
 */
export function lightTone(hex: string, amount = 0.4, toward: number | null = HIGHLIGHT_HUE): string {
  const c = hexToHsv(hex);
  return toHex(hsvToRgb({
    h: toward === null ? c.h : hueToward(c.h, toward, 16 * amount),
    s: clamp01(c.s * (1 - 0.55 * amount)),
    v: c.v + (1 - c.v) * amount,
  }));
}

/** Share of its saturation a colour loses at full atmospheric perspective. */
export const ATMOSPHERE_DESATURATION = 0.6;

/**
 * Atmospheric perspective on one colour: it loses saturation and moves toward
 * the atmosphere colour. `amount` 0 leaves it alone, 1 turns it into the
 * atmosphere colour. Far things thus end up paler and closer to one tone.
 *
 * The blend runs around the colour wheel (hue along the short way, saturation
 * and value straight), not through the middle of it: a warm colour fading into
 * a cool atmosphere never passes through gray.
 */
export function atmosphereTone(hex: string, atmosphere: string, amount: number): string {
  if (amount <= 0) return hex;
  const a = clamp01(amount);
  const c = hexToHsv(hex);
  const to = hexToHsv(atmosphere);
  // A colour without saturation has no hue of its own; it takes the atmosphere's.
  const h = c.s < 1e-6 ? to.h : c.h + angleDiffDeg(c.h, to.h) * a;
  const pale = c.s * (1 - ATMOSPHERE_DESATURATION * a);
  return toHex(hsvToRgb({ h, s: pale + (to.s - pale) * a, v: c.v + (to.v - c.v) * a }));
}

/**
 * A colour `t` of the way from one colour to another, round the colour wheel:
 * hue along the short way, saturation and value straight, so a change of
 * colour never passes through gray. A colour without saturation has no hue of
 * its own and takes the other's. At 0 it is `a` itself, at 1 `b` itself.
 */
export function blendAround(a: string, b: string, t: number): string {
  if (t <= 0 || a === b) return a;
  if (t >= 1) return b;
  const from = hexToHsv(a);
  const to = hexToHsv(b);
  const h = from.s < 1e-6 ? to.h : to.s < 1e-6 ? from.h : from.h + angleDiffDeg(from.h, to.h) * t;
  return toHex(hsvToRgb({ h, s: from.s + (to.s - from.s) * t, v: from.v + (to.v - from.v) * t }));
}

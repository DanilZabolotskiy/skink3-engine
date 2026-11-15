// A palette organised by role, and a validator for the measured laws of the look:
// dark without gray, dark hues mostly indigo to violet, saturated shadows, accents
// in warm/cool pairs. Scenes refer to colours as "role.name" and never by value.

import { angleDiffDeg } from '../core/math.ts';
import { hexToHsv, isHex, lightness } from './color.ts';

export const ROLES = ['deep', 'dark', 'mid', 'accent', 'light'] as const;
export type Role = (typeof ROLES)[number];

/** A colour of the shot's palette: role and name, e.g. "mid.violet". */
export type ColorRef = `${Role}.${string}`;

export interface PaletteSpec {
  /** Deep background tones, L* below 12. */
  readonly deep: Readonly<Record<string, string>>;
  /** Dark tones, L* 12 to 30. */
  readonly dark: Readonly<Record<string, string>>;
  /** Mid tones, L* 30 to 60. */
  readonly mid: Readonly<Record<string, string>>;
  /** Accents: saturation above 0.6 and value above 0.7. */
  readonly accent: Readonly<Record<string, string>>;
  /** Lights, L* above 85. */
  readonly light: Readonly<Record<string, string>>;
  /** Warm/cool accent pairs, by accent name: [warm, cool]. */
  readonly pairs: readonly (readonly [string, string])[];
}

export interface Palette {
  readonly spec: PaletteSpec;
  /** Every colour by reference. */
  readonly colors: ReadonlyMap<string, string>;
}

export class PaletteError extends Error {}

const NAME = /^[a-z][a-zA-Z0-9]*$/;

/** Builds a palette. Throws on malformed input; the look laws are checked by `checkPalette`. */
export function definePalette(spec: PaletteSpec): Palette {
  const colors = new Map<string, string>();
  for (const role of ROLES) {
    const group = spec[role];
    if (!group || typeof group !== 'object') throw new PaletteError(`palette: role "${role}" is missing`);
    const names = Object.keys(group);
    if (names.length === 0) throw new PaletteError(`palette: role "${role}" has no colours`);
    for (const name of names) {
      const value = group[name]!;
      if (!NAME.test(name)) throw new PaletteError(`palette: colour name "${role}.${name}" must match ${NAME}`);
      if (typeof value !== 'string' || !isHex(value)) {
        throw new PaletteError(`palette: "${role}.${name}" must be a #RRGGBB colour, got ${JSON.stringify(value)}`);
      }
      colors.set(`${role}.${name}`, value.toUpperCase());
    }
  }
  for (const pair of spec.pairs ?? []) {
    for (const name of pair) {
      if (!colors.has(`accent.${name}`)) {
        throw new PaletteError(`palette: pair refers to "accent.${name}", which is not defined`);
      }
    }
  }
  return { spec, colors };
}

/** The colour behind a reference; throws with the list of valid names if it is unknown. */
export function resolveColor(palette: Palette, ref: string): string {
  const hex = palette.colors.get(ref);
  if (!hex) {
    throw new PaletteError(
      `unknown colour "${ref}": colours are palette references such as ${[...palette.colors.keys()].slice(0, 4).join(', ')} ` +
        `(available: ${[...palette.colors.keys()].join(', ')})`,
    );
  }
  return hex;
}

/** The numbers behind the laws. They come from measurement; see docs/PRINCIPLES.md. */
export const PALETTE_LAWS = {
  deepMaxL: 12,
  darkMaxL: 30,
  midMaxL: 60,
  lightMinL: 85,
  accentMinS: 0.6,
  accentMinV: 0.7,
  /** Each deep and dark colour must be at least this saturated. */
  darkMinS: 0.5,
  /** Mean saturation of the deep and dark colours. */
  darkMeanS: 0.7,
  /** Mid tones must stay clear of gray. */
  midMinS: 0.3,
  /** Hue band the deep and dark colours mostly sit in. */
  darkHue: [210, 300] as const,
  /** Share of the deep and dark colours that must be inside the band. */
  darkHueShare: 0.66,
  /** Warm hues: red to yellow. Cool hues: green-cyan to blue. */
  warmHue: [330, 75] as const,
  coolHue: [150, 270] as const,
  /** A pair must be at least this far apart in hue. */
  pairMinHueDistance: 90,
} as const;

export interface PaletteIssue {
  readonly law: 'role-lightness' | 'no-gray' | 'saturated-shadows' | 'dark-hue' | 'accent' | 'accent-pairs';
  readonly ref: string | null;
  readonly message: string;
}

function hueIn(h: number, band: readonly [number, number]): boolean {
  return band[0] <= band[1] ? h >= band[0] && h <= band[1] : h >= band[0] || h <= band[1];
}

/** Checks a palette against the laws. An empty result means it passes. */
export function checkPalette(palette: Palette): PaletteIssue[] {
  const L = PALETTE_LAWS;
  const issues: PaletteIssue[] = [];
  const add = (law: PaletteIssue['law'], ref: string | null, message: string): void => {
    issues.push({ law, ref, message });
  };
  const fmt = (x: number): string => x.toFixed(2);

  const darks: { ref: string; s: number; h: number }[] = [];
  for (const [ref, hex] of palette.colors) {
    const role = ref.slice(0, ref.indexOf('.')) as Role;
    const l = lightness(hex);
    const { h, s, v } = hexToHsv(hex);
    switch (role) {
      case 'deep':
        if (l >= L.deepMaxL) add('role-lightness', ref, `${ref} ${hex}: L* ${l.toFixed(1)} is not below ${L.deepMaxL}`);
        break;
      case 'dark':
        if (l < L.deepMaxL || l >= L.darkMaxL) add('role-lightness', ref, `${ref} ${hex}: L* ${l.toFixed(1)} is outside ${L.deepMaxL}..${L.darkMaxL}`);
        break;
      case 'mid':
        if (l < L.darkMaxL || l >= L.midMaxL) add('role-lightness', ref, `${ref} ${hex}: L* ${l.toFixed(1)} is outside ${L.darkMaxL}..${L.midMaxL}`);
        if (s < L.midMinS) add('no-gray', ref, `${ref} ${hex}: saturation ${fmt(s)} is below ${L.midMinS}`);
        break;
      case 'accent':
        if (s <= L.accentMinS || v <= L.accentMinV) {
          add('accent', ref, `${ref} ${hex}: an accent needs saturation above ${L.accentMinS} and value above ${L.accentMinV}, got S ${fmt(s)}, V ${fmt(v)}`);
        }
        break;
      case 'light':
        if (l <= L.lightMinL) add('role-lightness', ref, `${ref} ${hex}: L* ${l.toFixed(1)} is not above ${L.lightMinL}`);
        break;
    }
    if (role === 'deep' || role === 'dark') {
      darks.push({ ref, s, h });
      if (s < L.darkMinS) add('no-gray', ref, `${ref} ${hex}: saturation ${fmt(s)} is below ${L.darkMinS}; darks must not be gray`);
    }
  }

  if (darks.length > 0) {
    const meanS = darks.reduce((a, d) => a + d.s, 0) / darks.length;
    if (meanS < L.darkMeanS) {
      add('saturated-shadows', null, `mean saturation of deep and dark colours is ${fmt(meanS)}, below ${L.darkMeanS}`);
    }
    const inBand = darks.filter((d) => hueIn(d.h, L.darkHue)).length / darks.length;
    if (inBand < L.darkHueShare) {
      add('dark-hue', null, `only ${Math.round(inBand * 100)} % of deep and dark colours have a hue in ${L.darkHue[0]}..${L.darkHue[1]} deg (need ${Math.round(L.darkHueShare * 100)} %)`);
    }
  }

  if (palette.spec.pairs.length === 0) {
    add('accent-pairs', null, 'the palette declares no warm/cool accent pair');
  }
  for (const [warm, cool] of palette.spec.pairs) {
    const hw = hexToHsv(palette.colors.get(`accent.${warm}`)!).h;
    const hc = hexToHsv(palette.colors.get(`accent.${cool}`)!).h;
    if (!hueIn(hw, L.warmHue)) add('accent-pairs', `accent.${warm}`, `accent.${warm}: hue ${hw.toFixed(0)} deg is not warm (${L.warmHue[0]}..${L.warmHue[1]})`);
    if (!hueIn(hc, L.coolHue)) add('accent-pairs', `accent.${cool}`, `accent.${cool}: hue ${hc.toFixed(0)} deg is not cool (${L.coolHue[0]}..${L.coolHue[1]})`);
    if (Math.abs(angleDiffDeg(hw, hc)) < L.pairMinHueDistance) {
      add('accent-pairs', null, `pair ${warm}/${cool}: hues are less than ${L.pairMinHueDistance} deg apart`);
    }
  }
  return issues;
}

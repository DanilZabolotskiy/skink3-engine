// A palette organised by role. Scenes refer to colours as "role.name" and never
// by value.
//
// Colour belongs to the production. The engine has no rule about what a
// palette may hold: a role is a name, and any colour may stand under it. A
// production may declare rules of its own in its palette (`rules`), for a
// channel or a series; `checkPalette` holds the palette to those and to
// nothing else.

import { angleDiffDeg } from '../core/math.ts';
import { hexToHsv, HIGHLIGHT_HUE, isHex, lightness, SHADOW_HUE } from './color.ts';

export const ROLES = ['deep', 'dark', 'mid', 'accent', 'light'] as const;
export type Role = (typeof ROLES)[number];

/** A colour of the shot's palette: role and name, e.g. "mid.violet". */
export type ColorRef = `${Role}.${string}`;

/** A band of hue in degrees, clockwise from the first to the second; it may pass 360 (for example [330, 75]). */
export type HueBand = readonly [number, number];

/**
 * One rule a production sets for its palette. A rule names the roles whose
 * colours it holds (all of them when left out) and one thing to hold them to:
 *
 *   lightness        the CIE L* of every colour, within [min, max] (0..100)
 *   saturation       the HSV saturation of every colour, within [min, max] (0..1)
 *   value            the HSV value of every colour, within [min, max] (0..1)
 *   meanSaturation   the mean saturation of those colours together, within [min, max]
 *   hue              a band of hue; with `share`, the share of those colours that lie in it:
 *                    a number is the least share, [min, max] a least and a most (left out: all of them)
 *   pairs            the pairs the palette declares: how many at least, the band of hue of the first and of the
 *                    second colour of each, and how far apart the two are at least, in degrees
 */
export interface PaletteRule {
  /** What the rule is called in a message; left out, the thing it holds. */
  readonly name?: string;
  readonly roles?: readonly Role[];
  readonly lightness?: readonly [number, number];
  readonly saturation?: readonly [number, number];
  readonly value?: readonly [number, number];
  readonly meanSaturation?: readonly [number, number];
  readonly hue?: HueBand;
  readonly share?: number | readonly [number, number];
  readonly pairs?: { readonly atLeast?: number; readonly first?: HueBand; readonly second?: HueBand; readonly apart?: number };
}

/**
 * The hues the automatic light leans to: the shadow tones of a shape toward
 * `shadowHue`, its lit tones (rim, highlight, glow, pulse) toward
 * `highlightHue`, in degrees. null: that tone keeps the hue of the colour it
 * is derived from. What is left out keeps the default lean of the engine.
 */
export interface PaletteTones {
  readonly shadowHue?: number | null;
  readonly highlightHue?: number | null;
}

export interface PaletteSpec {
  /** The five roles. A role is a name to refer to colours by: the engine reads no lightness and no hue into it. */
  readonly deep: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
  readonly mid: Readonly<Record<string, string>>;
  readonly accent: Readonly<Record<string, string>>;
  readonly light: Readonly<Record<string, string>>;
  /** Pairs of accents, by accent name, for a rule of pairs to hold. Left out: none. */
  readonly pairs?: readonly (readonly [string, string])[];
  /** The rules of the production for this palette. Left out: none, and nothing about its colours is checked. */
  readonly rules?: readonly PaletteRule[];
  /** The hues the automatic light leans to. */
  readonly tones?: PaletteTones;
}

/** The hues the tones of a shot lean to, resolved: a hue in degrees, or null for no lean. */
export interface ToneHues {
  readonly shadow: number | null;
  readonly highlight: number | null;
}

/** The hues the automatic light leans to with this palette: what its `tones` say, and the engine's default lean for what they leave out. */
export function toneHues(palette: Palette): ToneHues {
  const tones = palette.spec.tones;
  return {
    shadow: tones?.shadowHue === undefined ? SHADOW_HUE : tones.shadowHue,
    highlight: tones?.highlightHue === undefined ? HIGHLIGHT_HUE : tones.highlightHue,
  };
}

export interface Palette {
  readonly spec: PaletteSpec;
  /** Every colour by reference. */
  readonly colors: ReadonlyMap<string, string>;
}

export class PaletteError extends Error {}

const NAME = /^[a-z][a-zA-Z0-9]*$/;

const MEASURES = ['lightness', 'saturation', 'value', 'meanSaturation', 'hue', 'pairs'] as const;
type Measure = (typeof MEASURES)[number];

const measureOf = (rule: PaletteRule): Measure => MEASURES.find((m) => rule[m] !== undefined)!;

function range(where: string, value: unknown, min: number, max: number): void {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)) || value[0] < min || value[1] > max || value[0] > value[1]) {
    throw new PaletteError(`${where} must be [min, max] within ${min}..${max}, got ${JSON.stringify(value)}`);
  }
}

function band(where: string, value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && v >= 0 && v <= 360)) {
    throw new PaletteError(`${where} must be a band of hue [from, to] in degrees, 0..360, got ${JSON.stringify(value)}`);
  }
}

function only(where: string, value: object, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PaletteError(`${where}: unknown option "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function checkRule(rule: PaletteRule, i: number): void {
  const w = `palette: rules[${i}]`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new PaletteError(`${w} must be a rule such as { roles: ['deep'], lightness: [0, 15] }`);
  only(w, rule, ['name', 'roles', 'share', ...MEASURES]);
  const given = MEASURES.filter((m) => rule[m] !== undefined);
  if (given.length !== 1) throw new PaletteError(`${w} must hold one of ${MEASURES.join(', ')}; it has ${given.length === 0 ? 'none' : given.join(' and ')}`);
  if (rule.name !== undefined && (typeof rule.name !== 'string' || rule.name.trim().length === 0)) throw new PaletteError(`${w}: name must be a few words, got ${JSON.stringify(rule.name)}`);
  if (rule.roles !== undefined) {
    if (!Array.isArray(rule.roles) || rule.roles.length === 0 || !rule.roles.every((r) => (ROLES as readonly string[]).includes(r))) {
      throw new PaletteError(`${w}: roles must be a list of ${ROLES.join(', ')}; got ${JSON.stringify(rule.roles)}`);
    }
    if (rule.pairs !== undefined) throw new PaletteError(`${w}: a rule of pairs holds the pairs of the palette and takes no roles`);
  }
  if (rule.share !== undefined && rule.hue === undefined) throw new PaletteError(`${w}: share goes with hue: the share of the colours that lie in the band`);
  if (rule.lightness !== undefined) range(`${w}: lightness`, rule.lightness, 0, 100);
  if (rule.saturation !== undefined) range(`${w}: saturation`, rule.saturation, 0, 1);
  if (rule.value !== undefined) range(`${w}: value`, rule.value, 0, 1);
  if (rule.meanSaturation !== undefined) range(`${w}: meanSaturation`, rule.meanSaturation, 0, 1);
  if (rule.hue !== undefined) {
    band(`${w}: hue`, rule.hue);
    if (rule.share !== undefined) {
      if (typeof rule.share === 'number') range(`${w}: share`, [rule.share, 1], 0, 1);
      else range(`${w}: share`, rule.share, 0, 1);
    }
  }
  if (rule.pairs !== undefined) {
    const p = rule.pairs;
    if (!p || typeof p !== 'object') throw new PaletteError(`${w}: pairs must be { atLeast?, first?, second?, apart? }`);
    only(`${w} pairs`, p, ['atLeast', 'first', 'second', 'apart']);
    if (p.atLeast !== undefined && !(Number.isInteger(p.atLeast) && p.atLeast >= 0)) throw new PaletteError(`${w}: pairs.atLeast must be a whole number, got ${JSON.stringify(p.atLeast)}`);
    if (p.first !== undefined) band(`${w}: pairs.first`, p.first);
    if (p.second !== undefined) band(`${w}: pairs.second`, p.second);
    if (p.apart !== undefined && !(typeof p.apart === 'number' && p.apart >= 0 && p.apart <= 180)) throw new PaletteError(`${w}: pairs.apart must be degrees, 0..180, got ${JSON.stringify(p.apart)}`);
  }
}

/** Builds a palette. Throws on malformed input; the rules it declares are held by `checkPalette`. */
export function definePalette(spec: PaletteSpec): Palette {
  if (!spec || typeof spec !== 'object') throw new PaletteError('palette: give the colours by role, e.g. { deep: { night: "#RRGGBB" }, ... }');
  only('palette', spec, [...ROLES, 'pairs', 'rules', 'tones']);
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
  if (spec.rules !== undefined) {
    if (!Array.isArray(spec.rules)) throw new PaletteError('palette: rules must be a list of rules');
    spec.rules.forEach(checkRule);
  }
  if (spec.tones !== undefined) {
    if (!spec.tones || typeof spec.tones !== 'object') throw new PaletteError('palette: tones must be { shadowHue?, highlightHue? }');
    only('palette: tones', spec.tones, ['shadowHue', 'highlightHue']);
    for (const name of ['shadowHue', 'highlightHue'] as const) {
      const hue = spec.tones[name];
      if (hue !== undefined && hue !== null && !(typeof hue === 'number' && hue >= 0 && hue <= 360)) {
        throw new PaletteError(`palette: tones.${name} must be a hue in degrees, 0..360, or null for none; got ${JSON.stringify(hue)}`);
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

export interface PaletteIssue {
  /** The rule that is broken: its name, or the thing it holds. */
  readonly rule: string;
  /** The colour it is broken by, or null when it is broken by several together. */
  readonly ref: string | null;
  readonly message: string;
}

function hueIn(h: number, b: HueBand): boolean {
  return b[0] <= b[1] ? h >= b[0] && h <= b[1] : h >= b[0] || h <= b[1];
}

/**
 * Holds a palette to the rules it declares. An empty result means it keeps
 * them all; a palette that declares none is not checked for anything.
 */
export function checkPalette(palette: Palette): PaletteIssue[] {
  const issues: PaletteIssue[] = [];
  const fmt = (x: number): string => x.toFixed(2);
  for (const rule of palette.spec.rules ?? []) {
    const measure = measureOf(rule);
    const label = rule.name ?? measure;
    const add = (ref: string | null, message: string): void => {
      issues.push({ rule: label, ref, message });
    };
    if (rule.pairs !== undefined) {
      const pairs = palette.spec.pairs ?? [];
      const p = rule.pairs;
      if (p.atLeast !== undefined && pairs.length < p.atLeast) add(null, `the palette declares ${pairs.length} pair(s) of accents, fewer than ${p.atLeast}`);
      for (const [a, b] of pairs) {
        const ha = hexToHsv(palette.colors.get(`accent.${a}`)!).h;
        const hb = hexToHsv(palette.colors.get(`accent.${b}`)!).h;
        if (p.first !== undefined && !hueIn(ha, p.first)) add(`accent.${a}`, `pair ${a}/${b}: accent.${a} has a hue of ${ha.toFixed(0)} deg, outside ${p.first[0]}..${p.first[1]}`);
        if (p.second !== undefined && !hueIn(hb, p.second)) add(`accent.${b}`, `pair ${a}/${b}: accent.${b} has a hue of ${hb.toFixed(0)} deg, outside ${p.second[0]}..${p.second[1]}`);
        if (p.apart !== undefined && Math.abs(angleDiffDeg(ha, hb)) < p.apart) add(null, `pair ${a}/${b}: the two hues are ${Math.abs(angleDiffDeg(ha, hb)).toFixed(0)} deg apart, less than ${p.apart}`);
      }
      continue;
    }
    const roles = rule.roles ?? ROLES;
    const held = [...palette.colors].filter(([ref]) => (roles as readonly string[]).includes(ref.slice(0, ref.indexOf('.'))));
    const of = `the colours of ${roles.join(', ')}`;
    if (rule.lightness !== undefined) {
      for (const [ref, hex] of held) {
        const l = lightness(hex);
        if (l < rule.lightness[0] || l > rule.lightness[1]) add(ref, `${ref} ${hex}: L* ${l.toFixed(1)} is outside ${rule.lightness[0]}..${rule.lightness[1]}`);
      }
    } else if (rule.saturation !== undefined) {
      for (const [ref, hex] of held) {
        const { s } = hexToHsv(hex);
        if (s < rule.saturation[0] || s > rule.saturation[1]) add(ref, `${ref} ${hex}: saturation ${fmt(s)} is outside ${rule.saturation[0]}..${rule.saturation[1]}`);
      }
    } else if (rule.value !== undefined) {
      for (const [ref, hex] of held) {
        const { v } = hexToHsv(hex);
        if (v < rule.value[0] || v > rule.value[1]) add(ref, `${ref} ${hex}: value ${fmt(v)} is outside ${rule.value[0]}..${rule.value[1]}`);
      }
    } else if (rule.meanSaturation !== undefined && held.length > 0) {
      const mean = held.reduce((a, [, hex]) => a + hexToHsv(hex).s, 0) / held.length;
      if (mean < rule.meanSaturation[0] || mean > rule.meanSaturation[1]) add(null, `the mean saturation of ${of} is ${fmt(mean)}, outside ${rule.meanSaturation[0]}..${rule.meanSaturation[1]}`);
    } else if (rule.hue !== undefined && held.length > 0) {
      const [least, most] = rule.share === undefined ? [1, 1] : typeof rule.share === 'number' ? [rule.share, 1] : rule.share;
      const inBand = held.filter(([, hex]) => hueIn(hexToHsv(hex).h, rule.hue!)).length / held.length;
      if (inBand < least - 1e-9 || inBand > most + 1e-9) {
        add(null, `${Math.round(inBand * 100)} % of ${of} have a hue in ${rule.hue[0]}..${rule.hue[1]} deg, outside ${Math.round(least * 100)}..${Math.round(most * 100)} %`);
      }
    }
  }
  return issues;
}

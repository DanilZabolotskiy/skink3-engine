import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  backgroundTo,
  bakeShot,
  checkPalette,
  circle,
  compileShot,
  definePalette,
  evaluate,
  frameRaw,
  heightFor,
  hexToHsv,
  hsv,
  layer,
  PaletteError,
  resolveColor,
  runChecks,
  shot,
  type Key,
  type Palette,
  type PaletteRule,
  type PaletteSpec,
  type ShotSpec,
} from '../src/index.ts';
import { HIGHLIGHT_HUE, lightTone, SHADOW_HUE, shadowTone } from '../src/look/color.ts';
import { toneHues } from '../src/look/palette.ts';

// Colour belongs to the production: the engine holds a palette to the rules the palette declares, and to nothing else.

/** A palette no law of old would have let through: gray and orange darks, dull accents, no pair, no role where it "belongs". */
const FREE: PaletteSpec = {
  deep: { slate: hsv(0, 0, 0.18), rust: hsv(18, 0.9, 0.3) },
  dark: { ash: hsv(40, 0.05, 0.45), wine: hsv(350, 0.8, 0.4), paper: hsv(50, 0.2, 0.98) },
  mid: { fog: hsv(0, 0, 0.6) },
  accent: { dull: hsv(200, 0.2, 0.5), amber: hsv(40, 0.86, 0.99), aqua: hsv(176, 0.72, 0.93) },
  light: { coal: hsv(240, 0.5, 0.1) },
};

const WIDTH = 480;

function make(palette: Palette, timeline: Key[] = [], outer: 'deep.rust' | 'deep.slate' = 'deep.rust'): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 3,
    seed: 2,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.slate', outer },
    atmosphere: 'mid.fog',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'ball', r: 200, fill: 'accent.amber' })] })],
    timeline,
  });
}

async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const o = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
}

async function hash(spec: ShotSpec, frame = 0): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

const hueOf = (rgb: readonly number[]): number => hexToHsv(`#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`).h;

test('palette: without rules nothing about its colours is checked, and a shot with it passes the checks', async () => {
  const palette = definePalette(FREE);
  assert.deepEqual(checkPalette(palette), []);
  const c = compileShot(make(palette));
  const report = runChecks(c, await bakeShot(c));
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  // A role is a name: any colour may stand under it, and is found by its reference.
  assert.equal(resolveColor(palette, 'light.coal'), hsv(240, 0.5, 0.1));
  assert.equal(resolveColor(palette, 'dark.paper'), hsv(50, 0.2, 0.98));
});

test('palette: every kind of rule a production declares is held, and a palette that keeps it is clean', () => {
  const issues = (rules: PaletteRule[], spec: PaletteSpec = FREE): string[] => checkPalette(definePalette({ ...spec, rules })).map((i) => `${i.rule}: ${i.message}`);
  // Lightness, saturation and value of every colour of the roles it names.
  assert.deepEqual(issues([{ roles: ['deep'], lightness: [0, 40] }]), []);
  const dark = issues([{ name: 'dark is dark', roles: ['dark'], lightness: [10, 50] }]);
  assert.equal(dark.length, 1);
  assert.match(dark[0]!, /^dark is dark: dark\.paper #[0-9A-F]{6}: L\* \d+\.\d is outside 10\.\.50$/);
  assert.deepEqual(issues([{ roles: ['deep', 'dark'], saturation: [0.5, 1] }]).map((m) => m.slice(0, m.indexOf(' #'))), ['saturation: deep.slate', 'saturation: dark.ash', 'saturation: dark.paper']);
  assert.match(issues([{ roles: ['accent'], value: [0.7, 1] }])[0]!, /^value: accent\.dull #[0-9A-F]{6}: value 0\.50 is outside 0\.7\.\.1$/);
  assert.deepEqual(issues([{ roles: ['accent'], value: [0.4, 1] }]), []);
  // The mean saturation of several colours together.
  assert.match(issues([{ roles: ['deep', 'dark'], meanSaturation: [0.7, 1] }])[0]!, /^meanSaturation: the mean saturation of the colours of deep, dark is 0\.\d\d, outside 0\.7\.\.1$/);
  assert.deepEqual(issues([{ roles: ['deep', 'dark'], meanSaturation: [0.2, 1] }]), []);
  // A band of hue, and the share of the colours that lie in it: all of them, a least share, or a least and a most.
  assert.match(issues([{ roles: ['deep', 'dark'], hue: [210, 300], share: 0.66 }])[0]!, /^hue: 0 % of the colours of deep, dark have a hue in 210\.\.300 deg, outside 66\.\.100 %$/);
  assert.deepEqual(issues([{ roles: ['accent'], hue: [30, 210] }]), [], 'every accent lies in the band');
  assert.equal(issues([{ roles: ['accent'], hue: [30, 100] }]).length, 1, 'without a share: all of them');
  // "Never one hue": no more than half of the colours of a role in one band; a band may pass 360.
  assert.match(issues([{ name: 'not all warm', roles: ['deep', 'dark'], hue: [330, 75], share: [0, 0.5] }])[0]!, /^not all warm: 100 % of the colours of deep, dark have a hue in 330\.\.75 deg, outside 0\.\.50 %$/);
  assert.deepEqual(issues([{ roles: ['accent'], hue: [330, 75], share: [0, 0.5] }]), []);
  // The pairs a palette declares.
  assert.match(issues([{ pairs: { atLeast: 1 } }])[0]!, /^pairs: the palette declares 0 pair\(s\) of accents, fewer than 1$/);
  const paired: PaletteSpec = { ...FREE, pairs: [['amber', 'aqua'], ['aqua', 'dull']] };
  assert.deepEqual(issues([{ pairs: { atLeast: 2, first: [0, 360], apart: 20 } }], paired), []);
  assert.deepEqual(issues([{ name: 'warm with cool', pairs: { first: [330, 75], second: [150, 270], apart: 90 } }], paired), [
    'warm with cool: pair aqua/dull: accent.aqua has a hue of 176 deg, outside 330..75',
    'warm with cool: pair aqua/dull: the two hues are 25 deg apart, less than 90',
  ]);
  // An issue names the colour that breaks its rule, or no colour when several do together.
  const found = checkPalette(definePalette({ ...FREE, rules: [{ roles: ['mid'], saturation: [0.3, 1] }, { roles: ['deep'], meanSaturation: [0.9, 1] }] }));
  assert.deepEqual(found.map((i) => [i.rule, i.ref]), [['saturation', 'mid.fog'], ['meanSaturation', null]]);
});

test('palette: a shot is held to the rules of its palette by the checks, and a rule that cannot be read is refused', async () => {
  const c = compileShot(make(definePalette({ ...FREE, rules: [{ name: 'no gray', roles: ['mid'], saturation: [0.3, 1] }] })));
  const report = runChecks(c, await bakeShot(c));
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map((i) => [i.check, i.severity]), [['palette', 'error']]);
  assert.match(report.issues[0]!.message, /^no gray: mid\.fog #999999: saturation 0\.00 is outside 0\.3\.\.1$/);

  const bad = (extra: object, message: RegExp): void => {
    assert.throws(() => definePalette({ ...FREE, ...extra } as never), (e: unknown) => e instanceof PaletteError && message.test(e.message), String(message));
  };
  bad({ rules: [{ roles: ['deep'] }] }, /rules\[0\] must hold one of lightness, saturation, value, meanSaturation, hue, pairs; it has none/);
  bad({ rules: [{ roles: ['deep'], lightness: [0, 10], saturation: [0, 1] }] }, /it has lightness and saturation/);
  bad({ rules: [{ roles: ['deep'], lightnes: [0, 10] }] }, /rules\[0\]: unknown option "lightnes" \(allowed: name, roles, share, lightness, /);
  bad({ rules: [{ roles: ['shadow'], lightness: [0, 10] }] }, /roles must be a list of deep, dark, mid, accent, light/);
  bad({ rules: [{ roles: ['deep'], lightness: [10, 0] }] }, /lightness must be \[min, max\] within 0\.\.100/);
  bad({ rules: [{ roles: ['deep'], saturation: [0, 2] }] }, /saturation must be \[min, max\] within 0\.\.1/);
  bad({ rules: [{ roles: ['deep'], lightness: [0, 10], share: 0.5 }] }, /share goes with hue/);
  bad({ rules: [{ roles: ['deep'], hue: [0, 400] }] }, /hue must be a band of hue \[from, to\] in degrees, 0\.\.360/);
  bad({ rules: [{ roles: ['deep'], hue: [0, 90], share: 1.5 }] }, /share must be \[min, max\] within 0\.\.1/);
  bad({ rules: [{ roles: ['accent'], pairs: { atLeast: 1 } }] }, /a rule of pairs holds the pairs of the palette and takes no roles/);
  bad({ rules: [{ pairs: { atleast: 1 } }] }, /pairs: unknown option "atleast" \(allowed: atLeast, first, second, apart\)/);
  bad({ rules: 'none' }, /rules must be a list of rules/);
  bad({ tones: { shadowHue: 400 } }, /tones\.shadowHue must be a hue in degrees, 0\.\.360, or null for none/);
  bad({ tones: { shadow: 20 } }, /tones: unknown option "shadow" \(allowed: shadowHue, highlightHue\)/);
  bad({ laws: {} }, /palette: unknown option "laws" \(allowed: deep, dark, mid, accent, light, pairs, rules, tones\)/);
});

test('palette: the hues the light leans to are the palette\'s to set; one that says nothing draws as it always did', async () => {
  // The default lean, when a palette names none: the one the engine was built with.
  const base = hsv(40, 0.86, 0.99);
  assert.deepEqual(toneHues(definePalette(FREE)), { shadow: SHADOW_HUE, highlight: HIGHLIGHT_HUE });
  assert.equal(shadowTone(base, 1), shadowTone(base, 1, SHADOW_HUE));
  assert.equal(lightTone(base, 0.4), lightTone(base, 0.4, HIGHLIGHT_HUE));
  assert.deepEqual(toneHues(definePalette({ ...FREE, tones: { shadowHue: 20 } })), { shadow: 20, highlight: HIGHLIGHT_HUE });
  assert.deepEqual(toneHues(definePalette({ ...FREE, tones: { shadowHue: null, highlightHue: null } })), { shadow: null, highlight: null });
  // Without a lean a tone keeps the hue of its colour; with one it leans that way.
  assert.ok(Math.abs(hexToHsv(shadowTone(base, 1, null)).h - 40) < 1 && Math.abs(hexToHsv(lightTone(base, 0.7, null)).h - 40) < 1);
  assert.ok(hexToHsv(shadowTone(base, 1, 0)).h < 30 && hexToHsv(shadowTone(base, 1, 120)).h > 50);

  // In the picture: the shadow crescent of a lit ball, on the side away from the light (the light comes from the top left).
  const silent = make(definePalette(FREE));
  const named = make(definePalette({ ...FREE, tones: { shadowHue: SHADOW_HUE, highlightHue: HIGHLIGHT_HUE } }));
  const none = make(definePalette({ ...FREE, tones: { shadowHue: null, highlightHue: null } }));
  const green = make(definePalette({ ...FREE, tones: { shadowHue: 120 } }));
  assert.equal(await hash(silent), await hash(named), 'a palette that names the default lean draws what one that names nothing draws');
  assert.notEqual(await hash(silent), await hash(none));
  // The scene hash stands for the picture: the same for those two, another with another lean, and the rules of a palette are no part of it.
  assert.equal(compileShot(silent).sceneHash, compileShot(named).sceneHash);
  assert.notEqual(compileShot(silent).sceneHash, compileShot(none).sceneHash);
  assert.notEqual(compileShot(none).sceneHash, compileShot(green).sceneHash);
  assert.equal(compileShot(make(definePalette({ ...FREE, rules: [{ roles: ['deep'], lightness: [0, 100] }] }))).sceneHash, compileShot(silent).sceneHash);
  const shadow = async (spec: ShotSpec): Promise<number> => hueOf(await pixel(spec, 0, 130, 130));
  assert.ok(Math.abs((await shadow(none)) - 40) < 2, `without a lean the shadow keeps the hue of the ball: ${await shadow(none)}`);
  assert.ok((await shadow(silent)) < 36, `the default lean turns it toward red and violet: ${await shadow(silent)}`);
  assert.ok((await shadow(green)) > 46, `a lean toward green turns it the other way: ${await shadow(green)}`);
  assert.deepEqual(await pixel(green, 0, 0, 0), await pixel(silent, 0, 0, 0), 'the colour of the ball itself is the palette\'s, whatever the lean');
});

test('palette: a variant is the base with some colours replaced; a shot draws with the one it is given, and backgroundTo resolves against it', async () => {
  // The recipe of the guide: nothing but definePalette and the spec of the base.
  const series = definePalette({ ...FREE, rules: [{ name: 'accents are vivid', roles: ['accent'], saturation: [0.15, 1] }], tones: { shadowHue: 300 } });
  const dawn = definePalette({ ...series.spec, deep: { ...series.spec.deep, slate: hsv(214, 0.7, 0.3) }, mid: { ...series.spec.mid, fog: hsv(18, 0.6, 0.8) }, tones: { shadowHue: 20 } });
  // Every reference of the base resolves in the variant; what it does not replace is the colour of the base.
  assert.deepEqual([...dawn.colors.keys()], [...series.colors.keys()]);
  assert.equal(resolveColor(dawn, 'deep.slate'), hsv(214, 0.7, 0.3));
  assert.equal(resolveColor(dawn, 'deep.rust'), resolveColor(series, 'deep.rust'));
  // It carries the rules of the base, and its own tones.
  assert.deepEqual(dawn.spec.rules, series.spec.rules);
  assert.deepEqual(checkPalette(dawn), []);
  assert.equal(checkPalette(definePalette({ ...dawn.spec, accent: { ...dawn.spec.accent, dull: hsv(0, 0, 0.5) } })).length, 1, 'a variant is held to the rules of the series');
  assert.deepEqual(toneHues(dawn), { shadow: 20, highlight: HIGHLIGHT_HUE });

  // The same shot with each palette: the sky is the colour of the palette it names.
  const rgb = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= 2);
  assert.ok(near(await pixel(make(series, [], 'deep.slate'), 0, 0, -450), rgb(resolveColor(series, 'deep.slate'))));
  assert.ok(near(await pixel(make(dawn, [], 'deep.slate'), 0, 0, -450), rgb(hsv(214, 0.7, 0.3))));
  assert.notEqual(await hash(make(series)), await hash(make(dawn)));
  // A background key names colours of the palette of its shot.
  const keyed = compileShot(make(dawn, [backgroundTo({ at: 1, dur: 1, inner: 'mid.fog' })]));
  assert.equal(evaluate(keyed, await bakeShot(keyed), 150, 'en').background!.inner, hsv(18, 0.6, 0.8));
});

test('sources: no colour is written into the engine outside its review pictures', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  // What draws for a reviewer and never into a frame of a video: graphs, trails, close-ups, the sound sheet, the captions of a sheet.
  const overlays = new Set(['review/graph.ts', 'review/trail.ts', 'review/physics-pictures.ts', 'audio/sheet.ts', 'render/sheet.ts']);
  const literal = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d|\bhsv\(\s*\d/;
  const found: string[] = [];
  for (const file of walk(src)) {
    const rel = file.slice(src.length + 1).replaceAll('\\', '/');
    if (overlays.has(rel)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        // The one mask of the renderer: black with an alpha, drawn with "destination-out", which takes glow away and adds no colour.
        if (rel === 'render/draw.ts' && code.includes('rgba(0,0,0,${')) return;
        if (literal.test(code)) found.push(`${rel}:${i + 1}: ${code.slice(0, 80)}`);
      });
  }
  assert.deepEqual(found, [], 'a colour in engine code: take it from the palette or from the scene');
});

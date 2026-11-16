import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  backgroundTo,
  bakeShot,
  circle,
  colourDistance,
  compileShot,
  CONTRAST_FINDING_KINDS,
  fadeTo,
  formatReport,
  frameRaw,
  group,
  intended,
  label,
  layer,
  moveTo,
  rect,
  resolveColor,
  reviewContrast,
  runChecks,
  scaleTo,
  SceneError,
  shot,
  stroke,
  text,
  type ColorRef,
  type ContrastFinding,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// The contrast review: a named node must stand out from what lies behind it. Off unless a shot asks for it.

/** The two thresholds of these tests: in lightness, and in colour. They are a production's to choose; the engine has none. */
const ASKED = { lightness: 10, colour: 18 };

type Contrast = NonNullable<Parameters<typeof shot>[0]['contrast']>;

function make(nodes: LayerSpec['nodes'], contrast?: Contrast, timeline: Key[] = [], extra: object = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 4,
    seed: 2,
    palette,
    strings: { en: { word: 'Word' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
    ...(contrast ? { contrast } : {}),
    ...extra,
  });
}

/** A wide ground in the lower half of the frame, and a disc that lies on it. */
const ground = (fill: ColorRef = 'dark.indigo'): ReturnType<typeof rect> => rect({ id: 'ground', at: [0, 300], w: 1700, h: 420, fill, lit: false, backdrop: true });
const disc = (id: string, fill: ColorRef, at: [number, number] = [0, 300], extra: object = {}): ReturnType<typeof circle> => circle({ id, at, r: 80, fill, lit: false, ...extra });

async function findings(spec: ShotSpec): Promise<ContrastFinding[]> {
  const c = compileShot(spec);
  const report = reviewContrast(c, await bakeShot(c));
  assert.ok(report, 'the shot asks for the review');
  return [...report.findings];
}

const brief = (list: readonly ContrastFinding[]): string[] => list.map((f) => `${f.subject} ${f.part} against ${f.against}`).sort();

test('contrast: the colours of these tests are as far apart as the tests take them to be', () => {
  const d = (a: ColorRef, b: ColorRef): { lightness: number; colour: number } => colourDistance(resolveColor(palette, a), resolveColor(palette, b));
  const blends = (a: ColorRef, b: ColorRef): boolean => d(a, b).lightness < ASKED.lightness && d(a, b).colour < ASKED.colour;
  assert.deepEqual(d('dark.indigo', 'dark.indigo'), { lightness: 0, colour: 0 });
  assert.ok(blends('dark.plum', 'dark.indigo') && blends('dark.haze', 'dark.indigo'), 'two neighbours in lightness and in hue');
  assert.ok(!blends('dark.navy', 'dark.indigo') && d('dark.navy', 'dark.indigo').lightness < 3, 'one lightness, another hue: the hue alone tells them apart');
  assert.ok(!blends('mid.violet', 'dark.indigo') && d('mid.violet', 'dark.indigo').lightness > 20, 'another lightness');
  assert.ok(d('accent.amber', 'dark.indigo').colour > 100 && d('light.cream', 'deep.night').lightness > 80);
  assert.deepEqual(CONTRAST_FINDING_KINDS, ['low-contrast']);
});

test('contrast: it is off unless the shot asks for it, and asking changes neither the picture nor the bake', async () => {
  const nodes = [ground(), disc('hero', 'dark.indigo')];
  const plain = compileShot(make(nodes));
  const asked = compileShot(make(nodes, { nodes: ['hero'], ...ASKED }));
  assert.equal('contrast' in plain.spec, false, 'a shot that does not ask is the data it was');
  const bake = await bakeShot(plain);
  assert.equal(reviewContrast(plain, bake), null);
  const report = runChecks(plain, bake, undefined, { motion: true, physics: true, contrast: true });
  assert.equal(report.contrast, null);
  assert.ok(!formatReport(report).includes('contrast'), 'and its checks say nothing of contrast');
  assert.equal(runChecks(asked, await bakeShot(asked)).contrast, null, 'the checks run the review only when they are asked to');
  // The same bake, the same frame.
  assert.equal(asked.sceneHash, plain.sceneHash);
  const sha = async (c: typeof plain): Promise<string> => createHash('sha256').update(await frameRaw(c, bake, 60, { width: 480, lang: 'en', gpu: false })).digest('hex');
  assert.equal(await sha(asked), await sha(plain));
  // The defaults of what the engine may default: how much of the outline, and for how long. The thresholds have none.
  assert.deepEqual(asked.spec.contrast, { nodes: ['hero'], lightness: 10, colour: 18, edge: 0.5, seconds: 0.5 });
});

test('contrast: a node in the colour of its ground is found; one that differs in lightness, or in hue alone, is clean', async () => {
  // The planted defect: an indigo disc on an indigo ground. Beside it an amber one.
  const found = await findings(make([ground(), disc('hero', 'dark.indigo', [-300, 300]), disc('ball', 'accent.amber', [300, 300])], { nodes: ['hero', 'ball'], ...ASKED }));
  assert.deepEqual(brief(found), ['hero outline against ground']);
  const f = found[0]!;
  assert.deepEqual([f.kind, f.from, f.to, f.value, f.threshold, f.lightness, f.colour], ['low-contrast', 0, 239, 1, 0.5, 0, 0]);
  assert.equal(f.own, resolveColor(palette, 'dark.indigo'));
  assert.match(f.detail, /^100 % of its outline blends into "ground": #[0-9A-F]{6} on #[0-9A-F]{6} differ by 0\.0 in lightness \(asked: 10\) and by 0\.0 in colour \(asked: 18\), from 0\.00 s to 3\.98 s \(worst at frame 0\)$/);
  // Close in lightness and in hue: found. The numbers of the finding are the differences of the two colours.
  const plum = await findings(make([ground(), disc('hero', 'dark.plum')], { nodes: ['hero'], ...ASKED }));
  assert.deepEqual(brief(plum), ['hero outline against ground']);
  const d = colourDistance(resolveColor(palette, 'dark.plum'), resolveColor(palette, 'dark.indigo'));
  assert.ok(Math.abs(plum[0]!.lightness - d.lightness) < 0.06 && Math.abs(plum[0]!.colour - d.colour) < 0.06);
  // The sound scenes: another lightness; one lightness and another hue; and every node of a busy scene.
  assert.deepEqual(await findings(make([ground(), disc('hero', 'mid.violet')], { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(await findings(make([ground(), disc('hero', 'dark.navy')], { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(await findings(make([ground(), disc('a', 'accent.amber', [-500, 300]), disc('b', 'accent.aqua', [0, 300]), disc('c', 'light.cream', [500, 300])], { nodes: ['a', 'b', 'c', 'ground'], ...ASKED })), []);
  // The thresholds are the shot's: with stricter ones the hue of navy is no longer enough, with laxer ones plum passes.
  assert.deepEqual(brief(await findings(make([ground(), disc('hero', 'dark.navy')], { nodes: ['hero'], lightness: 10, colour: 30 }))), ['hero outline against ground']);
  assert.deepEqual(await findings(make([ground(), disc('hero', 'dark.plum')], { nodes: ['hero'], lightness: 2, colour: 18 })), []);
});

test('contrast: what lies behind is what is seen there: the background, a far layer in its haze, the topmost of several things', async () => {
  // In the sky, away from the ground: against the background.
  assert.deepEqual(brief(await findings(make([ground(), disc('hero', 'deep.night', [0, -300])], { nodes: ['hero'], ...ASKED }))), ['hero outline against (background)']);
  assert.deepEqual(await findings(make([ground(), disc('hero', 'dark.indigo', [0, -300])], { nodes: ['hero'], ...ASKED })), [], 'indigo on the night sky stands out');
  // A background that turns into the colour of the node: found from the moment it has.
  const turning = await findings(make([disc('hero', 'dark.indigo', [0, 0])], { nodes: ['hero'], ...ASKED }, [backgroundTo({ at: 1, dur: 1, inner: 'dark.indigo', outer: 'dark.indigo' })]));
  assert.equal(turning.length, 1);
  assert.ok(turning[0]!.from > 80 && turning[0]!.from <= 120 && turning[0]!.to === 239 && turning[0]!.against === '(background)', JSON.stringify(turning[0]));
  // Something drawn between the node and its ground is what the node is seen against there.
  const plate = rect({ id: 'plate', at: [0, 300], w: 400, h: 300, fill: 'light.cream', lit: false });
  assert.deepEqual(await findings(make([ground(), plate, disc('hero', 'dark.indigo')], { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(brief(await findings(make([ground(), plate, disc('hero', 'light.cream')], { nodes: ['hero'], ...ASKED }))), ['hero outline against plate']);
  // A far layer is seen in its haze: a shape that is far enough takes the colour of the atmosphere, whatever its own.
  const far = shot({
    id: 'tiny', seconds: 2, seed: 2, palette, strings: { en: {} }, background: { inner: 'mid.mist', outer: 'mid.mist' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'far', depth: 3, tint: 1, nodes: [disc('hill', 'accent.amber', [0, 0])] }), layer({ id: 'stage', depth: 0, nodes: [disc('near', 'accent.amber', [500, 0])] })],
    contrast: { nodes: ['hill', 'near'], ...ASKED },
  });
  assert.deepEqual(brief(await findings(far)), ['hill outline against (background)']);
});

test('contrast: it takes enough of the outline, for long enough, and only what is seen', async () => {
  // Half of the disc on its own colour, half over the sky: half of its outline blends.
  const half = [ground(), disc('hero', 'dark.indigo', [0, 90])];
  const share = (await findings(make(half, { nodes: ['hero'], ...ASKED, edge: 0.3 })))[0]!.value;
  assert.ok(share > 0.4 && share < 0.6, `about half: ${share}`);
  assert.deepEqual(await findings(make(half, { nodes: ['hero'], ...ASKED, edge: 0.7 })), []);
  // It crosses its ground in a third of a second: too short to be a finding by default, found when asked for less.
  const crossing = [rect({ id: 'ground', at: [0, 0], w: 200, h: 900, fill: 'dark.indigo', lit: false }), disc('hero', 'dark.indigo', [-600, 0], { r: 40 })];
  const dash = [moveTo('hero', { at: 1, to: [600, 0], dur: 2.2, profile: 'steady', arc: 0 })];
  assert.deepEqual(await findings(make(crossing, { nodes: ['hero'], ...ASKED }, dash)), []);
  const brief2 = await findings(make(crossing, { nodes: ['hero'], ...ASKED, seconds: 0.1 }, dash));
  assert.equal(brief2.length, 1);
  assert.ok(brief2[0]!.from > 100 && brief2[0]!.to < 160, `${brief2[0]!.from}-${brief2[0]!.to}`);
  // It arrives on its ground and stays: found from then on.
  const arriving = await findings(make([ground(), disc('hero', 'dark.indigo', [0, -300])], { nodes: ['hero'], ...ASKED }, [moveTo('hero', { at: 1, to: [0, 300], dur: 1, profile: 'ease', arc: 0 })]));
  assert.ok(arriving.length === 1 && arriving[0]!.from > 60 && arriving[0]!.from < 125 && arriving[0]!.to === 239, JSON.stringify(arriving.map((f) => [f.from, f.to])));
  // Wholly under something drawn after it, or faded away, it is not seen and not judged.
  const cover = rect({ id: 'cover', at: [0, 300], w: 400, h: 400, fill: 'light.cream', lit: false });
  assert.deepEqual(await findings(make([ground(), disc('hero', 'dark.indigo'), cover], { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(await findings(make([ground(), disc('hero', 'dark.indigo', [0, 300], { opacity: 0 })], { nodes: ['hero'], ...ASKED })), []);
  // A node that is faint shows its ground through itself: an amber disc at a tenth of its opacity blends.
  const faint = await findings(make([ground(), disc('hero', 'accent.amber')], { nodes: ['hero'], ...ASKED }, [fadeTo('hero', { at: 1, to: 0.06, dur: 0.5 })]));
  assert.ok(faint.length === 1 && faint[0]!.from >= 60 && faint[0]!.against === 'ground', JSON.stringify(faint.map((f) => [f.from, f.against])));
});

test('contrast: it follows what is drawn: a bar grown along one axis, a thing clipped to a window, a content with a level', async () => {
  // A bar on a wall of its own colour. Grown to eight times its height it stands out of the wall above and below.
  const wall = rect({ id: 'wall', at: [0, 0], w: 600, h: 300, fill: 'dark.indigo', lit: false });
  const bar = rect({ id: 'bar', at: [0, 0], w: 100, h: 100, radius: 0, fill: 'dark.indigo', lit: false });
  const grown = [scaleTo('bar', { at: 1, to: [1, 8], dur: 0.5, overshoot: 0 })];
  assert.deepEqual((await findings(make([wall, bar], { nodes: ['bar'], ...ASKED }))).map((f) => [f.from, f.to, f.value]), [[0, 239, 1]]);
  const tall = await findings(make([wall, bar], { nodes: ['bar'], ...ASKED }, grown));
  assert.ok(tall.length === 1 && tall[0]!.from === 0 && tall[0]!.to < 100, `it blends only until it has grown: ${JSON.stringify(tall.map((f) => [f.from, f.to]))}`);
  const part = await findings(make([wall, bar], { nodes: ['bar'], ...ASKED, edge: 0.1 }, [scaleTo('bar', { at: -1, to: [1, 8], dur: 0.5, overshoot: 0 })]));
  assert.ok(part.length === 1 && part[0]!.value > 0.1 && part[0]!.value < 0.5, `grown, only the part of its sides that is on the wall blends: ${part[0]?.value}`);
  // Clipped to a window: outside it the thing is not drawn and not judged; inside it is judged as it is seen.
  const windowed = (at: [number, number]): LayerSpec['nodes'] => [ground(), rect({ id: 'window', at, w: 300, h: 300, fill: 'light.cream', opacity: 0 }), disc('hero', 'dark.indigo', [0, 300], { clipTo: 'window' })];
  assert.deepEqual(await findings(make(windowed([0, -300]), { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(brief(await findings(make(windowed([0, 300]), { nodes: ['hero'], ...ASKED }))), ['hero outline against ground']);
  // A content that is half full is drawn below its surface only: above it the thing is seen against what is farther back.
  const filled = (level: number): LayerSpec['nodes'] => [ground(), rect({ id: 'drink', at: [0, 300], w: 400, h: 400, radius: 0, fill: 'light.cream', lit: false, level }), disc('hero', 'dark.indigo', [0, 190], { r: 50 })];
  assert.deepEqual(await findings(make(filled(1), { nodes: ['hero'], ...ASKED })), []);
  assert.deepEqual(brief(await findings(make(filled(0.4), { nodes: ['hero'], ...ASKED }))), ['hero outline against ground']);
});

test('contrast: a line, the letters of a text and a label are held too', async () => {
  // A line in the colour of the ground it lies on, and one that stands out.
  const lines = [ground(), stroke({ id: 'lost', points: [[-600, 250], [600, 250]], color: 'dark.plum', width: 8 }), stroke({ id: 'seen', points: [[-600, 350], [600, 350]], color: 'accent.amber', width: 8 })];
  assert.deepEqual(brief(await findings(make(lines, { nodes: ['lost', 'seen'], ...ASKED }))), ['lost line against ground']);
  // Letters: against what lies under them, or against their own box.
  const words = (ink: ColorRef, box?: ColorRef): LayerSpec['nodes'] => [ground(), text({ id: 'word', text: 'word', ink, at: [0, 300], size: 80, ...(box ? { box } : {}) })];
  assert.deepEqual(brief(await findings(make(words('dark.haze'), { nodes: ['word'], ...ASKED }))), ['word letters against ground']);
  assert.deepEqual(await findings(make(words('light.cream'), { nodes: ['word'], ...ASKED })), []);
  assert.deepEqual(await findings(make(words('dark.haze', 'light.cream'), { nodes: ['word'], ...ASKED })), [], 'on a box of its own the ground does not matter');
  // Cream on mint: one lightness, hues a third of the wheel apart but pale. A production that asks for more colour finds it.
  assert.deepEqual(await findings(make(words('light.cream', 'light.mint'), { nodes: ['word'], ...ASKED })), []);
  assert.deepEqual(brief(await findings(make(words('light.cream', 'light.mint'), { nodes: ['word'], lightness: 10, colour: 40 }))), ['word letters against (its own box)']);
  // A label: its box against what is round it, and its letters against its box.
  const tagged = (fill: ColorRef, ink: ColorRef): LayerSpec['nodes'] => [rect({ id: 'ground', at: [0, 0], w: 1800, h: 1000, fill: 'dark.indigo', lit: false, backdrop: true }), group({ id: 'spot', at: [0, 200] }), label({ id: 'tag', text: 'word', target: 'spot', fill, ink })];
  assert.deepEqual(await findings(make(tagged('light.cream', 'deep.night'), { nodes: ['tag'], ...ASKED })), []);
  assert.deepEqual(brief(await findings(make(tagged('dark.plum', 'light.cream'), { nodes: ['tag'], ...ASKED }))), ['tag outline against ground']);
  assert.deepEqual(brief(await findings(make(tagged('light.cream', 'light.mint'), { nodes: ['tag'], lightness: 10, colour: 40 }))), ['tag letters against (its own box)']);
});

test('contrast: the checks show it, an intended exception is honoured, and what a shot may not ask is refused', async () => {
  const nodes = [ground(), disc('hero', 'dark.indigo', [-300, 300]), disc('ghost', 'dark.plum', [300, 300])];
  const c = compileShot(make(nodes, { nodes: ['hero', 'ghost'], ...ASKED }, [], { intended: [intended('ghost', 'low-contrast', 'it is a ghost'), intended('hero', 'low-contrast', 'not at this time', { from: 10, to: 12 })] }));
  const bake = await bakeShot(c);
  const report = runChecks(c, bake, undefined, { contrast: true });
  assert.equal(report.ok, true, 'findings of a review are warnings');
  assert.deepEqual(brief(report.contrast!.findings), ['hero outline against ground']);
  assert.deepEqual(report.contrast!.honoured.map((h) => [h.nodes, h.reason, h.findings.length]), [[['ghost'], 'it is a ghost', 1]]);
  assert.deepEqual(report.contrast!.unused.map((u) => u.reason), ['not at this time']);
  const textReport = formatReport(report);
  assert.match(textReport, /\ncontrast: 1 warning\(s\) \(2 node\(s\) held: lightness 10, colour 18\); intended exceptions: 1 honoured \(1 finding\(s\) left out\), 1 unused\n {2}~ warning: low-contrast on "hero" at f0-239: 100 % of its outline blends into "ground"/);
  assert.match(textReport, /~ intended, unused: low-contrast on hero: "not at this time" matches no finding/);
  assert.match(textReport, /checks passed with 1 warning\(s\)$/);
  // A clean shot says so in one line.
  const clean = compileShot(make([ground(), disc('hero', 'accent.amber')], { nodes: ['hero'], ...ASKED }));
  assert.match(formatReport(runChecks(clean, await bakeShot(clean), undefined, { contrast: true })), /\ncontrast: ok \(1 node\(s\) held: lightness 10, colour 18\)\nchecks passed$/);
  // The motion review does not take the exception for one of its own.
  assert.deepEqual(runChecks(c, bake, undefined, { motion: true }).motion!.unused, []);

  const refused = (contrast: object, message: RegExp, extra: LayerSpec['nodes'] = []): void => {
    assert.throws(() => make([...nodes, ...extra], contrast as Contrast), (e: unknown) => (e instanceof SceneError || e instanceof Error) && message.test((e as Error).message), String(message));
  };
  refused({ nodes: ['hero'] }, /contrast: give both thresholds, lightness and colour: the least differences that are enough\. The engine has none of its own/);
  refused({ nodes: [], ...ASKED }, /contrast: nodes must be a non-empty list of the ids of the nodes to hold/);
  refused({ nodes: ['hero'], ...ASKED, hue: 20 }, /contrast: unknown option "hue" \(allowed: nodes, lightness, colour, edge, seconds\)/);
  refused({ nodes: ['hero'], lightness: 120, colour: 10 }, /lightness must be a number in 0\.\.100/);
  refused({ nodes: ['nobody'], ...ASKED }, /contrast names "nobody", which does not exist/);
  refused({ nodes: ['pair'], ...ASKED }, /contrast names group "pair"; it holds shapes, strokes, texts and labels: name the shapes that are in the group/, [group({ id: 'pair' })]);
});

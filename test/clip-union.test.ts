import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, fillRings, frameRaw, group, layer, rect, region, reviewMotion, shot, type SceneNode, type ShotSpec, type Vec2 } from '../src/index.ts';

// A clip to several shapes (clipTo: a list of ids): what is clipped is drawn inside the union of their outlines, by
// one mask of them all. So a coast too long for one flat fill, cut into tiles of fewer points each, still clips as one
// outline, with no seam where two tiles meet. It is opt-in: a clip to one shape is made as it always was.

const WIDTH = 480;

const square = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function make(masks: SceneNode[], clipTo: string | string[]): ShotSpec {
  return shot({
    id: 'union', seconds: 1, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'map', depth: 0, nodes: [...masks, rect({ id: 'sheet', w: 1800, h: 1000, radius: 0, fill: 'light.cream', lit: false, clipTo })] })],
    timeline: [],
  });
}

async function raw(spec: ShotSpec): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
}

/** The red channel of a frame at a point of the layer (its middle at the middle of the frame). */
function at(frame: Buffer, x: number, y: number): number {
  const height = frame.length / 4 / WIDTH;
  const k = WIDTH / 1920;
  return frame[(Math.round(height / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]!;
}

test('clip union: what it refuses', () => {
  assert.throws(() => rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: [] }), /clipTo: a list of 1 to 64 ids of shapes/);
  assert.throws(() => rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: ['a', 'b', 'a'] }), /clipTo names the shape "a" twice/);
  assert.throws(() => rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: Array.from({ length: 65 }, (_, k) => `t${k}`) }), /clipTo: a list of 1 to 64/);
  assert.throws(() => rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: ['a', '1b'] }), /id must be a string of letters/);
  const a = fillRings({ id: 'a', rings: [square(-400, -300, 0, 300)], fill: 'deep.night' });
  assert.throws(() => compileShot(make([a], ['a', 'nowhere'])), /clipTo refers to "nowhere", which does not exist/);
  assert.throws(() => compileShot(make([a, circle({ id: 'dot', r: 10, fill: 'mid.jade' })], ['a', 'sheet'])), /cannot be clipped to itself/);
  assert.throws(() => compileShot(make([a, circle({ id: 'soft', r: 100, fill: 'mid.jade', soft: 20 })], ['a', 'soft'])), /"soft" is soft: a union is drawn with a sharp edge/);
  assert.throws(() => compileShot(make([a, rect({ id: 'jar', w: 100, h: 100, fill: 'mid.jade', level: { at: 0.5 } })], ['a', 'jar'])), /"jar" is a content with a level/);
});

test('clip union: drawn inside the union of its shapes, with no seam where two meet', async () => {
  const left = fillRings({ id: 'left', rings: [square(-400, -300, 0, 300)], fill: 'deep.night', opacity: 0 });
  const right = fillRings({ id: 'right', rings: [square(0, -300, 400, 300)], fill: 'deep.night', opacity: 0 });
  const whole = fillRings({ id: 'whole', rings: [square(-400, -300, 400, 300)], fill: 'deep.night', opacity: 0, clipMask: true });
  const halves = await raw(make([left, right], ['left', 'right']));
  const one = await raw(make([whole], 'whole'));
  let most = 0;
  for (let i = 0; i < halves.length; i++) most = Math.max(most, Math.abs(halves[i]! - one[i]!));
  assert.ok(most <= 2, `the two halves clip as the whole does, but for ${most} levels`);
  assert.ok(at(halves, -200, 0) > 200 && at(halves, 200, 0) > 200 && at(halves, 0, 0) > 200, 'inside both halves and on their seam');
  assert.ok(at(halves, -600, 0) < 60 && at(halves, 0, 400) < 60, 'outside the union');
  // Two shapes apart, of any kind: inside each, and not between them.
  const disc = circle({ id: 'disc', at: [-500, 0], r: 150, fill: 'deep.night', opacity: 0 });
  const isle = region({ id: 'isle', points: [[300, -150], [600, -100], [550, 200], [350, 150]], smooth: 0, fill: 'deep.night', lit: false, opacity: 0 });
  const apart = await raw(make([disc, isle], ['disc', 'isle']));
  assert.ok(at(apart, -500, 0) > 200 && at(apart, 450, 0) > 200);
  assert.ok(at(apart, 0, 0) < 60 && at(apart, -500, 250) < 60);
  // Inside a group, with what else is clipped to the same shapes beside it.
  const grouped = compileShot(make([left, right, group({ id: 'g', clipTo: ['left', 'right'], children: [circle({ id: 'c', r: 40, fill: 'mid.jade' })] })], ['left', 'right']));
  assert.deepEqual(grouped.nodes.find((n) => n.id === 'g')!.clipAlso, [grouped.byId.get('right')!.index]);
  // The motion review takes a node clipped to a union as there inside any of its shapes.
  assert.ok(reviewMotion(grouped, await bakeShot(grouped)).report.findings.every((f) => f.subject !== 'c'));
});

test('clip union: opt-in: a clip to one shape is the data it was, and a list of one is that clip', async () => {
  const one = rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: 'a' });
  assert.equal('clipAlso' in one, false);
  assert.deepEqual(rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: ['a'] }), one);
  assert.deepEqual(rect({ id: 'r', w: 10, h: 10, fill: 'mid.jade', clipTo: ['a', 'b'] }), { ...one, clipAlso: ['b'] });
  const left = fillRings({ id: 'left', rings: [square(-400, -300, 0, 300)], fill: 'deep.night', opacity: 0 });
  const c = compileShot(make([left], 'left'));
  assert.deepEqual(c.nodes.find((n) => n.id === 'sheet')!.clipAlso, []);
  assert.deepEqual(await raw(make([left], ['left'])), await raw(make([left], 'left')));
});

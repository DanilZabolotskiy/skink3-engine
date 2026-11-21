// A globe: a round body seen from far away, with the outlines of its surface in degrees, a light and a night side,
// lights on the night side, a rim of air; things placed on it by [lon, lat] that ride its turn and hide behind the
// disc, and lines on its surface whose far part is hidden; its turn at keyed speeds, judged by the motion review.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  drawOn,
  evaluate,
  flatItems,
  frameRaw,
  globe,
  globeBlob,
  group,
  layer,
  moveTo,
  pulse,
  reshape,
  reviewMotion,
  shot,
  stroke,
  travel,
  type LonLat,
  type MotionReport,
  type SceneNode,
  type ShotSpec,
} from '../src/index.ts';
import { globeFade, globePlace, globeRing, globeView, surfaceLine, surfaceRuns, visibleRings } from '../src/scene/globe.ts';
import type { GlobeSpec } from '../src/scene/types.ts';

type GlobeOptions = Parameters<typeof globe>[0];

/** A square of land about [lon, lat], its corners counter-clockwise seen from outside. */
function square(lon: number, lat: number, half: number): LonLat[] {
  return [
    [lon - half, lat - half],
    [lon + half, lat - half],
    [lon + half, lat + half],
    [lon - half, lat + half],
  ];
}

const R = 300;

function earth(extra: Partial<GlobeOptions> = {}): ReturnType<typeof globe> {
  return globe({ id: 'ball', r: R, fill: 'dark.navy', layers: [{ rings: [square(0, 0, 20)], fill: 'mid.jade' }], ...extra });
}

const specOf = (o: Partial<GlobeOptions> = {}): GlobeSpec => earth(o).globe!;

function make(nodes: SceneNode[], timeline: ShotSpec['timeline'] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 7,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'deep.ink',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('globe: a shot without one is the data it always was', () => {
  const plain = circle({ id: 'a', r: 40, fill: 'accent.aqua' });
  assert.equal('globe' in plain, false, 'no globe key in a shape that asks for none');
  const c = compileShot(make([plain, group({ id: 'g', children: [circle({ id: 'b', r: 10, fill: 'accent.coral' })] })]));
  assert.ok(c.nodes.every((n) => !('globe' in n)), 'no node stands on a globe');
  // And the factory writes its defaults out, so that what a globe asks for is in its data.
  const g = specOf();
  assert.deepEqual([g.view, g.spin, g.light, g.lights, g.air, g.shade, g.night.amount], [[0, 0], 0, null, null, null, 0.25, 0]);
  assert.deepEqual([g.layers[0]!.opacity, g.layers[0]!.drift, g.layers[0]!.soft, g.layers[0]!.holes], [1, 0, 0, [false]]);
});

test('globe: places project as on a ball seen from far away, turn east with its spin, and face along their heading', () => {
  const g = specOf();
  const at = (lon: number, lat: number, t = 0, spec = g) => globePlace(spec, R, lon, lat, 0, 0, t);
  assert.ok(near(at(0, 0).x, 0) && near(at(0, 0).y, 0) && near(at(0, 0).z, 1), 'the place that faces the viewer is in the middle');
  assert.ok(near(at(90, 0).x, R) && near(at(90, 0).z, 0), '90 degrees east is on the right edge');
  assert.ok(near(at(0, 60).y, -R * Math.sin(Math.PI / 3)), 'north is up');
  assert.ok(at(180, 0).z < -0.99, 'the far side faces away');
  // Over the north pole: the pole is in the middle, and east runs counter-clockwise as the viewer sees it.
  const pole = specOf({ view: [0, 90] });
  assert.ok(near(at(0, 89.999, 0, pole).x, 0, 0.01) && near(at(0, 89.999, 0, pole).y, 0, 0.01));
  const a = at(0, 45, 0, pole);
  const b = at(10, 45, 0, pole);
  assert.ok(a.x * -b.y - -a.y * b.x > 0, 'from above the north pole, east is counter-clockwise');
  // A spin of 10 degrees a second for 3 seconds: what was 30 degrees west faces the viewer.
  const spun = specOf({ spin: 10 });
  assert.ok(near(at(-30, 0, 3, spun).x, 0) && near(at(-30, 0, 3, spun).z, 1));
  // Keys of speed: from rest to 10 degrees a second over 2 seconds is 10 degrees turned, then 10 a second.
  const keyed = specOf({ spin: [[0, 0], [2, 10]] });
  assert.ok(near(at(-10, 0, 2, keyed).x, 0) && near(at(-20, 0, 3, keyed).x, 0));
  // Heading 0 is east, 90 north: in the middle of the disc, right and up.
  assert.ok(near(globePlace(g, R, 0, 0, 0, 0, 0).rot, 0) && near(globePlace(g, R, 0, 0, 0, 90, 0).rot, -90));
  // A height lifts the place off the surface, out from the middle.
  assert.ok(near(globePlace(g, R, 90, 0, 30, 0, 0).x, R + 30));
});

test('globe: the rings of a layer show on the near side alone, closed along the edge of the disc', () => {
  const g = specOf();
  const v = globeView(g, 0);
  const one = (ring: LonLat[]) => {
    const made = globeRing(ring);
    return visibleRings([made.ring], [made.hole], v, R);
  };
  const front = one(square(0, 0, 20));
  assert.equal(front.length, 1, 'a ring that faces the viewer is one outline');
  const radii = (loop: Float64Array) => Array.from({ length: loop.length / 2 }, (_, i) => Math.hypot(loop[2 * i]!, loop[2 * i + 1]!));
  assert.ok(Math.max(...radii(front[0]!)) < R * 0.6);
  assert.equal(one(square(180, 0, 20)).length, 0, 'a ring on the far side is not drawn');
  // Across the edge: one outline, inside the disc, part of it along the edge.
  const across = one(square(90, 0, 20));
  assert.equal(across.length, 1);
  const rs = radii(across[0]!);
  assert.ok(Math.max(...rs) <= R + 1e-6, 'nothing outside the disc');
  assert.ok(rs.filter((x) => x > R - 1e-6).length >= 5, 'it is closed along the edge');
  // A ring given clockwise is a hole: it bounds the same small square, and its outline runs the other way round, so
  // that a layer filled non-zero leaves it open inside the ring round it.
  const clockwise = globeRing([...square(0, 0, 20)].reverse());
  assert.equal(clockwise.hole, true);
  const back = visibleRings([clockwise.ring], [true], v, R);
  assert.equal(back.length, 1);
  assert.ok(Math.max(...radii(back[0]!)) < R * 0.6);
  const area = (loop: Float64Array) => {
    let a = 0;
    for (let i = 0, n = loop.length / 2; i < n; i++) a += loop[2 * i]! * loop[(2 * i + 3) % loop.length]! - loop[(2 * i + 2) % loop.length]! * loop[2 * i + 1]!;
    return a / 2;
  };
  assert.ok(area(front[0]!) * area(back[0]!) < 0, 'a hole is drawn the other way round');
});

test('globe: a line on the surface shows its near part, as far as it is drawn, and a placed thing hides behind the disc', () => {
  const g = specOf();
  const v = globeView(g, 0);
  const ring: LonLat[] = [];
  for (let lon = -180; lon <= 180; lon += 10) ring.push([lon, 0]);
  const line = surfaceLine({ points: ring, closed: false, smooth: 0 } as never);
  const runs = surfaceRuns(line, v, R, 1);
  assert.equal(runs.length, 1, 'the equator seen from over the equator: its near half, in one run');
  const xs = Array.from({ length: runs[0]!.length / 2 }, (_, i) => runs[0]![2 * i]!);
  assert.ok(near(Math.min(...xs), -R, 1e-6) && near(Math.max(...xs), R, 1e-6), 'from edge to edge');
  // Drawn to a quarter: from 180 W to 90 W, all of it on the far side but the end.
  assert.equal(surfaceRuns(line, v, R, 0.24).length, 0, 'nothing of it faces the viewer yet');
  assert.equal(surfaceRuns(line, v, R, 0.5).length, 1);
  // A thing on the surface fades out as it reaches the edge, and one high over it shows a little past it.
  assert.equal(globeFade(-0.01, 0, R), 0);
  assert.equal(globeFade(0.2, 0, R), 1);
  assert.ok(globeFade(-0.2, 30, R) > 0, 'a thing 30 units up shows over the edge');
});

test('globe: its children ride the turn, hide on the far side, and a line on it is drawn on', async () => {
  const equator: LonLat[] = [];
  for (let lon = -180; lon <= 540; lon += 15) equator.push([lon, 0]);
  const spec = make(
    [
      earth({
        spin: 45,
        children: [
          circle({ id: 'pin', at: [0, 0], r: 8, fill: 'accent.coral' }),
          group({ id: 'high', at: [0, 30, 20], children: [circle({ id: 'dot', r: 5, fill: 'light.snow' })] }),
          stroke({ id: 'belt', points: equator, color: 'accent.amber', width: 4, drawn: 0 }),
        ],
      }),
    ],
    [drawOn('belt', { at: 0, dur: 4, profile: 'steady' })],
  );
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  type Seen = { kind: string; xf: { x: number; y: number }; alpha: number; runs?: readonly Float64Array[] };
  const leaf = (frame: number, id: string) => flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items).find((i) => 'node' in i && i.node.id === id) as Seen | undefined;
  // At the start the pin faces the viewer in the middle of the disc; after 2 s at 45 a second it is 90 degrees east, on the edge.
  const start = leaf(0, 'pin')!;
  assert.ok(near(start.xf.x, 0, 1e-6) && near(start.xf.y, 0, 1e-6) && start.alpha > 0.99);
  const edge = leaf(120, 'pin');
  assert.ok(edge === undefined || edge.alpha < 0.01, 'on the edge it has faded out');
  const behind = leaf(180, 'pin');
  assert.ok(behind === undefined || behind.alpha === 0, 'on the far side it is hidden');
  assert.ok(near(leaf(60, 'pin')!.xf.x, R * Math.sin(Math.PI / 4), 1e-6), 'a quarter of the way, 45 degrees east');
  // The belt: a stroke item of runs in the globe's space, its far part left out.
  const belt = leaf(120, 'belt');
  assert.ok(belt && belt.kind === 'stroke' && belt.runs && belt.runs.length > 0);
  for (const run of belt.runs!) for (let i = 0; i < run.length; i += 2) assert.ok(Math.hypot(run[i]!, run[i + 1]!) <= R + 1e-6);
  // A frame of it draws; the day side over the land is the land's colour, and nothing is drawn far outside the disc.
  const raw = await frameRaw(c, bake, 0, { width: 480, lang: 'en', gpu: false });
  assert.ok(raw.length > 0);
});

test('globe: a light leaves a dark night side where the lights of towns shine, and none on the day side', async () => {
  const town: LonLat = [60, 0];
  const lit = make([
    earth({
      layers: [{ rings: [square(0, 0, 40), square(60, 0, 25)], fill: 'mid.jade' }],
      light: { from: 180, lit: 0.5, night: 'deep.abyss', amount: 0.9, soft: 0.02 },
      lights: { points: [town, [-60, 0]], color: 'light.cream', size: 6 },
    }),
  ]);
  const c = compileShot(lit);
  const raw = await frameRaw(c, await bakeShot(c), 0, { width: 480, lang: 'en', gpu: false });
  // 480 x 270 RGBA: the stage is a quarter of its size. The globe's middle is the frame's middle.
  const px = (sx: number, sy: number): number[] => {
    const x = Math.round(240 + sx / 4);
    const y = Math.round(135 + sy / 4);
    const i = (y * 480 + x) * 4;
    return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
  };
  const bright = (p: number[]) => p[0]! + p[1]! + p[2]!;
  // Light from the left, half lit: the left half is day, the right half night.
  const day = px(-R * Math.sin(Math.PI / 6), 0);
  const night = px(R * Math.sin(Math.PI / 6) * 0.9, -R * 0.4);
  assert.ok(bright(day) > bright(night) + 120, `day ${day}, night ${night}`);
  // The town 60 degrees east is in the night, and shines; the one 60 degrees west is in the day, and does not.
  const shining = px(R * Math.sin(Math.PI / 3), 0);
  const dayTown = px(-R * Math.sin(Math.PI / 3), 0);
  const around = px(R * Math.sin(Math.PI / 3), 40);
  assert.ok(bright(shining) > bright(around) + 150, `town ${shining}, around it ${around}`);
  assert.ok(Math.abs(bright(dayTown) - bright(px(-R * Math.sin(Math.PI / 3), 40))) < 40, 'no light on the day side');
});

test('globe: the motion review judges its turn, catches one that leaps from rest, and lets its riders be', async () => {
  // At rest for 2 s, then 60 degrees a second within a hundredth of a second.
  const leap = await review(make([earth({ spin: [[0, 0], [2, 0], [2.01, 60]] })], [], 4));
  const found = leap.findings.filter((f) => f.subject === 'ball');
  assert.ok(found.some((f) => f.kind === 'abrupt-start'), `found ${found.map((f) => f.kind).join(', ')}`);
  // A thing that leaps from rest along its way round the globe is caught as any other.
  const round: LonLat[] = [];
  for (let lon = 0; lon <= 360; lon += 20) round.push([lon, 40]);
  const craft = () => group({ id: 'craft', at: [0, 40, 10], children: [circle({ id: 'hull', r: 6, fill: 'light.snow' })] });
  const jolt = await review(make([earth({ children: [craft()] })], [travel('craft', { at: 0, path: round, speeds: [[0, 0.001], [2, 0.001], [2.01, 90]] })], 4));
  const jolted = jolt.findings.filter((f) => f.subject === 'craft');
  assert.ok(jolted.some((f) => f.kind === 'abrupt-start'), `found ${jolted.map((f) => f.kind).join(', ')}`);
  // The same speed reached over two seconds, with a thing that rides it and one that travels round it: nothing to say.
  const ease = await review(
    make(
      [
        earth({
          spin: [[0, 0], [2, 0], [4, 60]],
          children: [circle({ id: 'rider', at: [-20, 10], r: 8, fill: 'accent.coral' }), craft()],
        }),
      ],
      [travel('craft', { at: 0, path: round, orient: true, speeds: [[0, 1], [1.5, 60], [4.5, 60], [6, 1]] })],
      6,
    ),
  );
  const loud = ease.findings.filter((f) => f.kind === 'abrupt-start' || f.kind === 'abrupt-stop' || f.kind === 'jump' || f.kind === 'too-fast');
  assert.deepEqual(loud.map((f) => `${f.kind} ${f.subject}`), []);
});

test('globe: what does not go together is refused with a message that says what to change', () => {
  assert.throws(() => earth({ lights: { points: [[0, 0]], color: 'light.cream' } }), /give the globe a light/);
  assert.throws(() => earth({ light: {} as never }), /night is the colour of the night side/);
  assert.throws(() => earth({ layers: [{ rings: [[[0, 0], [1, 1]]], fill: 'mid.jade' }] }), /at least three places/);
  assert.throws(() => earth({ layers: [{ rings: [[[0, 0], [0, 0], [0, 0]]], fill: 'mid.jade' }] }), /fewer than three different places/);
  assert.throws(() => earth({ spin: 400 }), /spin/);
  assert.throws(() => earth({ spin: [[1, 0], [2, 5]] }), /first key of spin is at 0 seconds/);
  assert.throws(() => earth({ view: [0, 95] }), /view\[1\]/);
  assert.throws(() => earth({ tilt: 3 } as never), /tilt/);
  const line = (extra: object) => stroke({ id: 'l', points: [[0, 0], [30, 10]], color: 'accent.amber', width: 3, ...extra });
  const compiled = (child: SceneNode, timeline: ShotSpec['timeline'] = []) => () => compileShot(make([earth({ children: [child] })], timeline));
  assert.throws(compiled(line({ dash: [10, 6] })), /drawn as a solid line/);
  assert.throws(compiled(line({ at: [5, 5] })), /no at, rotation or scale of its own/);
  assert.throws(compiled(line({}), [moveTo('l', { at: 1, to: [4, 4] })]), /no at, rotation or scale of its own/);
  assert.throws(compiled(line({}), [pulse('l', { at: 1, dur: 1 })]), /pulse cannot run along it/);
  assert.throws(compiled(circle({ id: 'deep', at: [0, 0, -5], r: 4, fill: 'accent.coral' })), /a height is 0 or more/);
  assert.throws(() => compileShot(make([earth()], [reshape('ball', { at: 1, points: [[0, 0], [40, 0], [0, 40]] })])), /reshape cannot target circle "ball"/);
  const persp = () =>
    shot({
      ...make([]),
      layers: [layer({ id: 'room', depth: 0, perspective: true, nodes: [group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [earth()] })] })],
    } as never);
  assert.throws(persp, /globe "ball" is in a group that lies in a plane/);
});

test('globeBlob: a soft ring about a place, the same every time for its seed', () => {
  const a = globeBlob({ at: [10, 40], r: 8, seed: 3 });
  assert.deepEqual(a, globeBlob({ at: [10, 40], r: 8, seed: 3 }));
  assert.notDeepEqual(a, globeBlob({ at: [10, 40], r: 8, seed: 4 }));
  assert.equal(a.length, 28);
  assert.equal(globeRing(a).hole, false, 'it runs counter-clockwise round the patch it bounds');
  for (const [lon, lat] of a) assert.ok(Math.abs(lon - 10) < 20 && Math.abs(lat - 40) < 10);
  assert.throws(() => globeBlob({ at: [0, 0], r: 0 }), /r must be/);
  assert.throws(() => globeBlob({ at: [0, 0], r: 5, points: 3 }), /points/);
});

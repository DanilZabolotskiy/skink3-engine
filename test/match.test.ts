import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, frameRaw, heightFor, layer, matchPoints, popIn, rampProgress, reachedAt, rect, region, reshape, shot, stroke, type Key, type LayerSpec, type ShotSpec, type Vec2 } from '../src/index.ts';

// Two outlines of any number of points made to match for a reshape, and the moment the growing outline reaches a place.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 6): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** True where the pixel at a place of the stage has the colour of the region (bright, and red). */
async function filled(spec: ShotSpec, frame: number, x: number, y: number): Promise<boolean> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]! > 150;
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const samePoints = (a: readonly Vec2[], b: readonly Vec2[], eps = 1e-6): boolean => a.length === b.length && a.every((p, i) => near(p[0], b[i]![0], eps) && near(p[1], b[i]![1], eps));
/** The sum of the squares of the ways the points go: what the match keeps least. */
const ways = (a: readonly Vec2[], b: readonly Vec2[]): number => a.reduce((sum, p, i) => sum + (b[i]![0] - p[0]) ** 2 + (b[i]![1] - p[1]) ** 2, 0);

/** A square about the middle, clockwise from its top-left corner. */
const square = (half: number): Vec2[] => [[-half, -half], [half, -half], [half, half], [-half, half]];
/** A small yard of five corners, and a ragged ground of eleven round it: nothing in common but the place. */
const YARD: Vec2[] = [[-60, -50], [40, -70], [80, 10], [10, 60], [-70, 30]];
const GROUND: Vec2[] = [[-300, -120], [-120, -230], [60, -180], [240, -240], [330, -60], [260, 80], [320, 200], [90, 170], [-80, 250], [-250, 160], [-340, 20]];

test('matchPoints: two outlines come back with as many points, equal shares of their own length apart', () => {
  const [a, b] = matchPoints(square(100), square(300), { points: 8 });
  // Eight points of a square from its first corner: the corners and the middles of the sides.
  assert.ok(samePoints(a, [[-100, -100], [0, -100], [100, -100], [100, 0], [100, 100], [0, 100], [-100, 100], [-100, 0]]), JSON.stringify(a));
  assert.ok(samePoints(b, a.map(([x, y]) => [x * 3, y * 3] as Vec2)), JSON.stringify(b));
  // Unless given, as many points as the outline with more has, and 24 at least.
  assert.equal(matchPoints(YARD, GROUND)[0].length, 24);
  assert.equal(matchPoints(YARD, GROUND)[1].length, 24);
  const long = Array.from({ length: 40 }, (_, i) => [Math.cos((i * Math.PI) / 20) * 90, Math.sin((i * Math.PI) / 20) * 90] as Vec2);
  assert.equal(matchPoints(YARD, long)[0].length, 40);
  // The arguments are left as they were.
  assert.deepEqual(YARD[0], [-60, -50]);
  assert.equal(GROUND.length, 11);
});

test('matchPoints: neither the place a closed outline starts from nor the way round it is given matters', () => {
  const [a, b] = matchPoints(square(100), square(300), { points: 16 });
  // The second square from another corner, and the other way round.
  const turned: Vec2[] = [[300, 300], [300, -300], [-300, -300], [-300, 300]];
  const [a2, b2] = matchPoints(square(100), turned, { points: 16 });
  assert.ok(samePoints(a2, a) && samePoints(b2, b), 'the same match');
  // The first outline given the other way round is read backwards from its first point.
  const [a3, b3] = matchPoints([[-100, -100], [-100, 100], [100, 100], [100, -100]], turned, { points: 16 });
  assert.ok(samePoints(a3, a) && samePoints(b3, b), 'the same match again');
  // No other start of the second outline gives the points less way to go.
  const [yard, ground] = matchPoints(YARD, GROUND, { points: 48 });
  for (let shift = 1; shift < 48; shift++) {
    const other = ground.map((_, i) => ground[(i + shift) % 48]!);
    assert.ok(ways(yard, ground) <= ways(yard, other) + 1e-6, `shift ${shift}`);
  }
});

test('matchPoints: lines that are not closed are matched from their first points to their last', () => {
  const [a, b] = matchPoints([[0, 0], [100, 0]], [[0, 50], [50, 100], [100, 50]], { points: 5, closed: false });
  assert.ok(samePoints(a, [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]]), JSON.stringify(a));
  assert.ok(samePoints(b, [[0, 50], [25, 75], [50, 100], [75, 75], [100, 50]]), JSON.stringify(b));
});

test('matchPoints: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, message, String(message));
  };
  bad(() => matchPoints(YARD, GROUND, { count: 30 } as never), /matchPoints: unknown option "count" \(allowed: points, closed\)/);
  bad(() => matchPoints(YARD, [[0, 0], [1, 1]]), /matchPoints: the second outline must be a list of at least 3 points \[x, y\]/);
  bad(() => matchPoints([[0, 0], [1, Number.NaN], [2, 2]], GROUND), /matchPoints: the first outline\[1\] must be a point \[x, y\] of two finite numbers/);
  bad(() => matchPoints(YARD, GROUND, { points: 4001 }), /matchPoints: points must be a whole number in 3\.\.4000, got 4001/);
  bad(() => matchPoints(YARD, GROUND, { points: 2.5 }), /matchPoints: points must be a whole number in 3\.\.4000/);
  bad(() => matchPoints(YARD, [[0, 0], [50, 50], [100, 100]]), /matchPoints: a closed outline must enclose an area; for lines, give closed: false/);
  bad(() => matchPoints(YARD, GROUND, { closed: 1 } as never), /matchPoints: closed must be true or false/);
});

test('matchPoints: a region takes the matched outlines and reshapes from the one to the other', async () => {
  const [yard, ground] = matchPoints(YARD, GROUND, { points: 60 });
  const spec = make(
    [region({ id: 'town', fill: 'accent.pink', lit: false, points: yard, smooth: 0 }), stroke({ id: 'edge', points: yard, closed: true, smooth: 0, color: 'accent.aqua', width: 4 })],
    [reshape('town', { at: 1, dur: 2, points: ground }), reshape('edge', { at: 1, dur: 2, points: ground })],
  );
  // A place between the two outlines is bare before the change and filled after it.
  assert.equal(await filled(spec, 30, 200, 0), false);
  assert.equal(await filled(spec, 240, 200, 0), true);
  assert.equal(await filled(spec, 240, 0, 0), true);
});

test('reachedAt: the share of the reshape at which the outline first holds a place', () => {
  const from = square(100);
  const to = square(500);
  // The edge runs from 100 to 500: it is at 300 half way. With a profile that is the same at both ends, that is half the time.
  assert.ok(near(reachedAt(from, to, [300, 0], { profile: 'steady' })!, 0.5, 1e-4));
  assert.ok(near(reachedAt(from, to, [300, 0])!, 0.5, 1e-4));
  assert.ok(near(reachedAt(from, to, [0, -200], { profile: 'steady' })!, 0.25, 1e-4));
  // With any profile, it is the moment at which the profile has come as far as the edge had to go.
  for (const [profile, a, b] of [['ease', 0.3, 0.3], ['in', 0.3, 0], ['out', 0, 0.3]] as const) {
    const share = reachedAt(from, to, [0, -200], { profile })!;
    assert.ok(near(rampProgress(share, a, b), 0.25, 1e-4), `${profile}: ${share}`);
  }
  assert.ok(reachedAt(from, to, [0, -200], { profile: 'in' })! > reachedAt(from, to, [0, -200], { profile: 'out' })!);
  assert.ok(near(rampProgress(reachedAt(from, to, [0, -200], { ramp: 0.5 })!, 0.5, 0.5), 0.25, 1e-4));
  // What the first outline holds is there from the start; what the last does not hold never is.
  assert.equal(reachedAt(from, to, [20, -30]), 0);
  assert.equal(reachedAt(from, to, [520, 0]), undefined);
  // A place farther out is reached later.
  assert.ok(reachedAt(from, to, [450, 0])! > reachedAt(from, to, [200, 0])!);
});

test('reachedAt: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, message, String(message));
  };
  bad(() => reachedAt(YARD, GROUND, [0, 0]), /reachedAt: the two outlines must have as many points \(5 and 11\); matchPoints\(from, to\) makes them so/);
  bad(() => reachedAt(square(1), square(2), [0, 0], { dur: 2 } as never), /reachedAt: unknown option "dur" \(allowed: profile, ramp\)/);
  bad(() => reachedAt(square(1), square(2), [0, 0], { profile: 'settle' } as never), /reachedAt: profile must be one of ease, steady, in, out/);
  bad(() => reachedAt(square(1), square(2), [0, 0], { profile: 'steady', ramp: 0.2 }), /reachedAt: ramp applies to the profiles ease, in and out/);
  bad(() => reachedAt(square(1), square(2), [0, 0], { ramp: 0.7 }), /reachedAt: ramp must be a number in 0\.02\.\.0\.5/);
  bad(() => reachedAt(square(1), square(2), [0] as never), /reachedAt: the place\[0\] must be a point \[x, y\] of two finite numbers/);
});

test('reachedAt: a thing that appears at that moment appears as the edge of the region passes it', async () => {
  const [yard, ground] = matchPoints(YARD, GROUND, { points: 60 });
  const key = { at: 1, dur: 3 };
  const place: Vec2 = [200, 40];
  const share = reachedAt(yard, ground, place)!;
  assert.ok(share > 0.2 && share < 0.9, String(share));
  const at = key.at + key.dur * share;
  const spec = make(
    [region({ id: 'town', fill: 'accent.pink', lit: false, points: yard, smooth: 0 }), rect({ id: 'house', at: [place[0], place[1] - 300], w: 20, h: 20, fill: 'accent.aqua', lit: false })],
    [reshape('town', { ...key, points: ground }), popIn('house', { at })],
  );
  // The region does not hold the place a fifth of a second before that moment, and holds it a fifth of a second after.
  const frame = Math.round(at * 60);
  assert.equal(await filled(spec, frame - 12, place[0], place[1]), false);
  assert.equal(await filled(spec, frame + 12, place[0], place[1]), true);
});

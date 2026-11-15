import assert from 'node:assert/strict';
import { test } from 'node:test';
import demo from '../examples/demo/scene.ts';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeHash,
  bakeShot,
  capsule,
  circle,
  compileShot,
  emitter,
  evaluate,
  group,
  label,
  layer,
  layoutText,
  moveTo,
  popIn,
  rect,
  runChecks,
  shot,
  type Key,
  type LayerSpec,
  type StringTables,
} from '../src/index.ts';
import { checkTextFit } from '../src/checks/textfit.ts';
import { bakeFile, parseBake, serializeBake } from '../src/physics/cache.ts';
import { sizeOverLife } from '../src/physics/particles.ts';
import { simulateRigid } from '../src/physics/rigid.ts';
import { circleShape, rectShape } from '../src/shape/geometry.ts';
import { PHYSICS_DEFAULTS } from '../src/scene/build.ts';
import { checkStrings, isStringKey, resolveString } from '../src/text/strings.ts';
import { labelGeometry } from '../src/text/label.ts';
import { engineVersion, physicsVersion } from '../src/version.ts';

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], strings: StringTables = { en: { 'label.a': 'A' } }, seed = 1): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 3,
    seed,
    palette,
    strings,
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

test('rigid bodies: a released body falls, lands softly and rests; the contact is recorded', async () => {
  const floorY = 300;
  const r = await simulateRigid(
    [
      { id: 'floor', shape: rectShape(600, 40, 10), x: 0, y: floorY, rot: 0, scale: 1, body: { kind: 'fixed' } },
      { id: 'ball', shape: circleShape(30), x: 0, y: -100, rot: 0, scale: 1, body: { kind: 'dynamic', release: 0.5 } },
    ],
    PHYSICS_DEFAULTS,
    300,
  );
  const y = (f: number): number => r.poses[(f * 2 + 1) * 3 + 1]!;
  assert.equal(y(0), -100);
  assert.equal(y(29), -100, 'holds its place until the release');
  assert.ok(y(45) > -100, 'falls after the release');
  const rest = floorY - 20 - 30;
  assert.ok(Math.abs(y(299) - rest) < 1.5, `rests on the floor (y ${y(299)}, expected about ${rest})`);
  let top = Infinity;
  for (let f = 0; f < 300; f++) top = Math.min(top, y(f));
  assert.equal(top, -100, 'never rises above its start');
  // Soft landing: after the first impact it never bounces higher than a small fraction of the drop.
  const impact = r.events[0]!;
  assert.ok(impact, 'a contact event was recorded');
  assert.deepEqual([impact.a, impact.b].sort(), ['ball', 'floor']);
  assert.ok(impact.impulse > 0.1, `impulse ${impact.impulse}`);
  assert.ok(Math.abs(impact.y - (floorY - 20)) < 4 && Math.abs(impact.x) < 4, 'contact point is on the floor under the ball');
  let bounce = Infinity;
  for (let f = impact.frame + 1; f < 300; f++) bounce = Math.min(bounce, y(f));
  assert.ok(rest - bounce < 40, `the bounce is small (${rest - bounce} units)`);
  // The same input gives the same output, bit for bit.
  const again = await simulateRigid(
    [
      { id: 'floor', shape: rectShape(600, 40, 10), x: 0, y: floorY, rot: 0, scale: 1, body: { kind: 'fixed' } },
      { id: 'ball', shape: circleShape(30), x: 0, y: -100, rot: 0, scale: 1, body: { kind: 'dynamic', release: 0.5 } },
    ],
    PHYSICS_DEFAULTS,
    300,
  );
  assert.deepEqual(Buffer.from(again.poses.buffer), Buffer.from(r.poses.buffer));
  assert.deepEqual(again.events, r.events);
});

test('bake: springs lag and settle, particles are stored, the bake is reproducible', async () => {
  const s = make(
    [
      group({
        id: 'g',
        at: [-200, 0],
        children: [
          circle({ id: 'sat', at: [60, 0], r: 8, fill: 'light.cream', follow: 'springy' }),
          capsule({ id: 'stick', at: [0, -30], rotation: -90, length: 60, r: 5, origin: 'start', fill: 'mid.jade', sway: 'springy' }),
        ],
      }),
      rect({ id: 'floor', at: [300, 300], w: 400, h: 30, fill: 'dark.indigo', body: { kind: 'fixed' } }),
      circle({ id: 'ball', at: [300, 0], r: 25, fill: 'accent.coral', body: { kind: 'dynamic', release: 0.2 } }),
      emitter({ id: 'dust', onContact: { count: 6, minImpulse: 0.05 }, colors: ['light.cream'], size: [2, 4], life: [0.3, 0.5] }),
      emitter({ id: 'trail', attach: 'sat', rate: 60, colors: ['accent.aqua', 'accent.pink'], size: 3, life: 0.4, speed: 0 }),
    ],
    [moveTo('g', { at: 0.5, to: [200, 0], dur: 0.8, anticipation: 0, overshoot: 0, arc: 0 })],
  );
  const c = compileShot(s);
  const bake = await bakeShot(c);
  assert.equal(bake.header.frames, 180);
  assert.deepEqual(bake.header.springs, ['sat', 'stick']);
  assert.equal(bake.header.engine, engineVersion());
  assert.equal(bake.header.physics, physicsVersion());

  // The satellite starts at rest, lags during the move, overshoots after it, and settles.
  const satX = (f: number): number => bake.springX(0, f);
  assert.ok(Math.abs(satX(0) - -140) < 1e-3);
  // Early in the move (an ease-out without overshoot) the satellite trails behind its rest place.
  const u = (36 / 60 - 0.5) / 0.8;
  const rest36 = -200 + 400 * (1 - (1 - u) ** 3) + 60;
  assert.ok(satX(36) < rest36 - 10, `lags behind during the move (${satX(36)} vs rest ${rest36})`);
  let maxX = -Infinity;
  for (let f = 0; f < 180; f++) maxX = Math.max(maxX, satX(f));
  assert.ok(maxX > 262, `overshoots its rest place (${maxX})`);
  assert.ok(Math.abs(satX(179) - 260) < 1.5, `settles (${satX(179)})`);
  // The stick sways: its angle leaves the rest angle during the move and returns to it.
  const stickRot = (f: number): number => {
    const item = evaluate(c, bake, f, 'en').layers[0]!.items.find((i) => i.kind === 'shape' && i.node.id === 'stick');
    return item && item.kind === 'shape' ? item.xf.rot : NaN;
  };
  assert.ok(Math.abs(stickRot(0) + Math.PI / 2) < 1e-6);
  let swing = 0;
  for (let f = 30; f < 120; f++) swing = Math.max(swing, Math.abs(stickRot(f) + Math.PI / 2));
  assert.ok(swing > 0.15, `the stick swings (${swing} rad)`);
  assert.ok(Math.abs(stickRot(179) + Math.PI / 2) < 0.03, 'and comes back to rest');

  // Contact -> particles; the trail emitter rides on the satellite.
  assert.ok(bake.header.events.length >= 1);
  const hit = bake.header.events[0]!;
  assert.equal(bake.particlesAt(0, hit.frame).length, 0);
  assert.equal(bake.particlesAt(0, hit.frame + 2).length / 4, 6, 'six particles per contact');
  const trail = bake.particlesAt(1, 90);
  assert.ok(trail.length / 4 > 10);
  for (let i = 0; i < trail.length; i += 4) assert.ok(trail[i + 3] === 0 || trail[i + 3] === 1, 'colour index in range');

  // Reproducible in the same process, and through a store/load round trip.
  const second = await bakeShot(compileShot(s));
  assert.equal(bakeHash(second), bakeHash(bake));
  const loaded = parseBake(serializeBake(bake));
  assert.equal(bakeHash(loaded), bakeHash(bake));
  assert.deepEqual(loaded.header, bake.header);
  assert.throws(() => parseBake(new Uint8Array(40)), /not a bake cache file/);
  assert.throws(() => bake.bodyX(0, 999), RangeError);
});

test('bake cache key: engine version, physics version, scene hash and seed', () => {
  const key = { engine: 'e1', physics: 'p1', sceneHash: 'abc', seed: 1 };
  const base = bakeFile('cache', 'tiny', key);
  assert.match(base.replaceAll('\\', '/'), /^cache\/tiny-[0-9a-f]{16}\.bake$/);
  for (const other of [{ ...key, engine: 'e2' }, { ...key, physics: 'p2' }, { ...key, sceneHash: 'abd' }, { ...key, seed: 2 }]) {
    assert.notEqual(bakeFile('cache', 'tiny', other), base);
  }
  assert.match(engineVersion(), /^\d+\.\d+\.\d+\+[0-9a-f]{16}$/);
  assert.match(physicsVersion(), /^@dimforge\/rapier2d-deterministic-compat@\d+\.\d+\.\d+$/);
});

test('a different seed gives a different bake', async () => {
  const nodes = (): LayerSpec['nodes'] => [emitter({ id: 'e', rate: 40, colors: ['accent.aqua'], size: [2, 5], life: [0.5, 1] })];
  const a = await bakeShot(compileShot(make(nodes(), [], undefined, 1)));
  const b = await bakeShot(compileShot(make(nodes(), [], undefined, 2)));
  assert.notEqual(bakeHash(a), bakeHash(b));
  assert.ok(a.particles.length > 0);
});

test('particles: size over life starts and ends at nothing', () => {
  assert.equal(sizeOverLife(0), 0);
  assert.equal(sizeOverLife(1), 0);
  assert.equal(sizeOverLife(0.3), 1);
  assert.ok(sizeOverLife(0.05) > 0 && sizeOverLife(0.05) < 1);
  assert.ok(sizeOverLife(0.9) > 0 && sizeOverLife(0.9) < 0.3);
});

test('strings: keys, lookups and table checks', () => {
  assert.ok(isStringKey('label.core') && isStringKey('title') && isStringKey('a.b-c_d2'));
  assert.ok(!isStringKey('Hello world') && !isStringKey('Label') && !isStringKey('a..b') && !isStringKey(''));
  const tables = { en: { a: 'A', b: 'B' }, xx: { a: 'A much longer A', b: ' ' } };
  assert.equal(resolveString(tables, 'xx', 'a'), 'A much longer A');
  assert.throws(() => resolveString(tables, 'de', 'a'), /no string table for language "de"/);
  assert.throws(() => resolveString(tables, 'en', 'c'), /"c" is missing in language "en"/);
  assert.deepEqual(checkStrings(tables, ['a', 'b', 'c']).map((i) => `${i.lang}:${i.key}`), ['en:c', 'xx:b', 'xx:c']);
});

test('text layout: wraps, balances, shrinks, and reports what cannot fit', () => {
  const style = { size: 40, minSize: 24, weight: 800, maxWidth: 360, maxLines: 3 };
  const short = layoutText('Source', style);
  assert.deepEqual(short.lines, ['Source']);
  assert.equal(short.size, 40);
  assert.ok(!short.overflow && short.width > 60 && short.width < 200);

  const long = layoutText('The place where every single one of the signals begins', style);
  assert.ok(!long.overflow);
  assert.ok(long.lines.length === 3 && long.size <= 40 && long.size >= 24);
  assert.equal(long.lines.join(' '), 'The place where every single one of the signals begins');
  for (const w of long.widths) assert.ok(w <= 360 + 1e-6);
  assert.ok(Math.min(...long.widths) > 0.55 * Math.max(...long.widths), 'lines are balanced');

  const word = layoutText('Pneumonoultramicroscopicsilicovolcanoconiosis', style);
  assert.ok(word.overflow && /wider than/.test(word.overflowReason!));
  const many = layoutText('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', style);
  assert.ok(many.overflow && /lines/.test(many.overflowReason!));
  assert.ok(layoutText('  ', style).overflow);

  // The label box grows with its text and the tail points away from it.
  const g1 = labelGeometry(short, 'top');
  const g3 = labelGeometry(long, 'top');
  assert.ok(g3.box.h > g1.box.h * 1.8 && g3.box.w > g1.box.w);
  assert.ok(g1.box.y + g1.box.h < 0, 'a "top" label sits above its tip');
  assert.ok(labelGeometry(short, 'right').box.x > 0 && labelGeometry(short, 'bottom').box.y > 0 && labelGeometry(short, 'left').box.x < 0);
  assert.ok(g1.path.contains(0, -4), 'the tail reaches the tip');
});

test('text-fit check: the demo fits in every language, and breakage is caught', async () => {
  const c = compileShot(demo);
  const bake = await bakeShot(c);
  const report = runChecks(c, bake);
  assert.deepEqual(report.languages, ['en', 'x-long']);
  assert.deepEqual(report.issues, []);
  const long = report.labels.filter((l) => l.lang === 'x-long');
  const en = report.labels.filter((l) => l.lang === 'en');
  assert.ok(long.every((l) => l.lines >= 2) && en.every((l) => l.lines === 1), 'the pseudo-locale wraps, English does not');

  // Overflow, off-frame and overlap, each provoked on purpose.
  const mk = (strings: StringTables, extra: LayerSpec['nodes'] = [], at: [number, number] = [0, 0]): ReturnType<typeof shot> =>
    make(
      [
        circle({ id: 'a', at, r: 40, fill: 'accent.amber' }),
        label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', maxWidth: 200, maxLines: 2 }),
        ...extra,
      ],
      [popIn('la', { at: 0.2 })],
      strings,
    );
  const kinds = async (s: ReturnType<typeof shot>): Promise<string[]> => {
    const cc = compileShot(s);
    return checkTextFit(cc, await bakeShot(cc), Object.keys(s.strings)).issues.map((i) => `${i.lang}:${i.kind}`);
  };
  assert.deepEqual(await kinds(mk({ en: { 'label.a': 'Fine' } })), []);
  assert.deepEqual(await kinds(mk({ en: { 'label.a': 'Fine' }, xx: { 'label.a': 'This one is far too long to fit in two short lines of a small label' } })), ['xx:overflow']);
  assert.deepEqual(await kinds(mk({ en: { 'label.a': 'Fine' } }, [], [0, -500])), ['en:off-frame']);
  assert.deepEqual(
    await kinds(
      mk({ en: { 'label.a': 'Fine' } }, [
        circle({ id: 'b', at: [60, 0], r: 40, fill: 'accent.aqua' }),
        label({ id: 'lb', text: 'label.a', target: 'b', fill: 'light.cream', ink: 'deep.night' }),
      ]),
    ),
    ['en:overlap'],
  );
});

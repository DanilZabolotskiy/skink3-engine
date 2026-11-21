import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileShot,
  distTo,
  flecks,
  group,
  houses,
  inside,
  locator,
  logRoad,
  oval,
  parcels,
  patches,
  scatter,
  smoothLine,
  trees,
  water,
  woods,
  type SceneNode,
  type Vec2,
  type Vec3,
} from '../src/index.ts';
import { dark, differing, draw, make, refused } from './fixtures/bodies.ts';

// The dressings of a map: water, woods, trees, the ground's flecks, fields, houses, a road of logs and a locator, and
// the geometry that places them. They draw only what the scene gives, in its colours, and the same options always
// give the same nodes.

const SQUARE: Vec2[] = [[-400, -300], [400, -300], [400, 300], [-400, 300]];
const POND: Vec2[] = [[-120, -80], [120, -80], [120, 80], [-120, 80]];

/** Every node of a list and of its children, depth first. */
function all(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((n) => [n, ...all(((n as { children?: SceneNode[] }).children ?? []) as SceneNode[])]);
}

/** The colours a list of nodes names. */
function colours(nodes: readonly SceneNode[]): Set<string> {
  const out = new Set<string>();
  for (const n of all(nodes)) {
    const o = n as unknown as Record<string, unknown>;
    for (const key of ['fill', 'color', 'side']) if (typeof o[key] === 'string') out.add(o[key] as string);
    const cast = (o.cast as { color?: string } | undefined)?.color;
    if (cast) out.add(cast);
  }
  return out;
}

test('map geometry: inside, distTo, oval and smoothLine', () => {
  assert.equal(inside([0, 0], SQUARE), true);
  assert.equal(inside([500, 0], SQUARE), false);
  assert.equal(distTo([0, 0], [SQUARE]), 300);
  assert.equal(distTo([0, 0], [SQUARE, POND]), 80);
  const o = oval(100, 50, 90, 24);
  assert.equal(o.length, 24);
  // Turned a quarter: 100 down, 50 across.
  assert.ok(o.every(([x, y]) => Math.abs(x) <= 50.1 && Math.abs(y) <= 100.1));
  assert.ok(o.some(([, y]) => y === 100));
  const line = smoothLine([[0, 0], [100, 0], [100, 100]], 10);
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line[line.length - 1], [100, 100]);
  for (let i = 1; i < line.length; i++) assert.ok(Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]) < 16);
  assert.ok(refused(() => smoothLine([[0, 0], [1e6, 0]], 0.001), /more than/));
});

test('scatter: places inside the outline and out of what it avoids, seeded, turned on request', () => {
  const at = scatter({ within: SQUARE, avoid: [POND], step: 40, seed: 5 });
  assert.ok(at.length > 250 && at.length < 330, `${at.length} places`);
  assert.ok(at.every((p) => inside(p, SQUARE) && !inside(p, POND)));
  assert.deepEqual(scatter({ within: SQUARE, avoid: [POND], step: 40, seed: 5 }), at);
  assert.notDeepEqual(scatter({ within: SQUARE, avoid: [POND], step: 40, seed: 6 }), at);
  const turned = scatter({ within: SQUARE, step: 40, seed: 5, jitter: 0, turn: 30 });
  // Neighbours along a row lie 30 degrees off the x axis.
  const [a, b] = [turned[0]!, turned[1]!];
  assert.ok(Math.abs((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI - 30) < 1);
  const boxed = scatter({ within: SQUARE, step: 40, seed: 5, bounds: [0, 0, 400, 300] });
  assert.ok(boxed.every(([x, y]) => x >= 0 && y >= 0));
  assert.ok(refused(() => scatter({ within: SQUARE, step: 0, seed: 1 }), /step must be a number/));
  assert.ok(refused(() => scatter({ within: SQUARE, step: 0.5, seed: 1 }), /larger step/));
  assert.ok(refused(() => scatter({ within: SQUARE, step: 10, seed: 1, spread: 2 } as never), /unknown option "spread"/));
});

test('patches: about the share asked of the cells hold a patch, the same for the same seed', () => {
  const mask = patches({ cell: 100, share: 0.4, r: 30, seed: 2 });
  let held = 0;
  for (let i = 0; i < 400; i++) {
    const [x, y] = [(i % 20) * 100 + 50, Math.floor(i / 20) * 100 + 50];
    // The middle of a patch lies within 20 units of the middle of its cell, and its radius is 30 or more.
    if (mask([x, y])) held++;
  }
  assert.ok(held > 120 && held < 200, `${held} of 400 cells`);
  const again = patches({ cell: 100, share: 0.4, r: 30, seed: 2 });
  for (let i = 0; i < 200; i++) assert.equal(again([i * 37.3, i * 11.9]), mask([i * 37.3, i * 11.9]));
  assert.equal(patches({ cell: 100, share: 0, r: 30 })([50, 50]), false);
});

test('water: a body with shallows, sheen, ripples and a shore, all in the colours given and clipped to it', () => {
  const nodes = water({ id: 'lake', rings: [SQUARE, POND.map(([x, y]) => [x + 600, y] as Vec2)], fill: 'mid.ocean', shallow: 'mid.jade', glint: 'light.snow', band: 10, sheen: [[0, 0, 200, 80]], ripples: { step: 90, len: 30, seed: 3 } });
  const ids = all(nodes).map((n) => n.id);
  assert.deepEqual(ids.slice(0, 2), ['lake', 'lake1']);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual([...colours(nodes)].sort(), ['light.snow', 'mid.jade', 'mid.ocean']);
  const ripples = nodes.filter((n) => n.id.startsWith('lake-ripple'));
  assert.ok(ripples.length > 20, `${ripples.length} ripples`);
  // Each ripple drifts on its own and is cut at the shore.
  for (const r of ripples) {
    assert.ok((r as { idle?: unknown }).idle);
    assert.equal(((r as unknown as { children: SceneNode[] }).children[0] as { clipTo?: string }).clipTo, 'lake');
  }
  // Shores given as open lines: they are strokes that do not close, clipped to the main body.
  const open = water({ id: 'sea', rings: [SQUARE], shores: [[[-400, -300], [400, -300]]], fill: 'mid.ocean', shallow: 'mid.jade', glint: 'light.snow', band: 10 });
  const shore = all(open).find((n) => n.id === 'sea-shore0') as unknown as { closed?: boolean };
  assert.notEqual(shore.closed, true);
  assert.ok(refused(() => water({ id: 'w', rings: [], fill: 'mid.ocean', shallow: 'mid.jade', glint: 'light.snow', band: 4 }), /at least one outline/));
});

test('woods, trees and houses: bodies drawn far to near, casting shadows only in the colour the scene gives', () => {
  const wood = woods({ id: 'wood', within: [SQUARE], avoid: [POND], step: 30, r: 12, seed: 1, crowns: ['mid.jade', 'dark.navy'], under: 'deep.ink' });
  const crowns = wood[wood.length - 1] as unknown as { sort?: string; cast?: unknown; children: SceneNode[] };
  assert.equal(crowns.sort, 'depth');
  assert.equal(crowns.cast, undefined, 'no shadow without its colour');
  assert.ok(crowns.children.length > 300);
  assert.deepEqual([...colours(wood)].sort(), ['dark.navy', 'deep.ink', 'mid.jade']);
  const shaded = woods({ id: 'wood', within: [SQUARE], step: 30, r: 12, seed: 1, crowns: ['mid.jade'], shadow: 'deep.abyss' });
  assert.equal((shaded[0] as unknown as { cast: { color: string } }).cast.color, 'deep.abyss');
  const keep = (p: Vec2): boolean => distTo(p, [POND]) < 60;
  const row = trees({ id: 'row', bounds: [-400, -300, 400, 300], avoid: [POND], step: 20, r: 6, seed: 4, crowns: ['mid.jade'], keep, shadow: 'deep.abyss' }) as unknown as { children: { at: Vec2 }[] };
  assert.ok(row.children.length > 20);
  assert.ok(row.children.every((c) => distTo(c.at, [POND]) < 60 && !inside(c.at, POND)));
  const town = houses({ id: 'town', within: SQUARE, avoid: [POND], step: 24, turn: 12, seed: 2, roofs: ['accent.coral', 'mid.rose'], side: 'dark.plum', rise: 8 }) as unknown as { children: { at: Vec2; roof?: { kind: string } }[] };
  assert.ok(town.children.length > 200);
  assert.ok(town.children.every((h) => h.roof?.kind === 'hip' && !inside(h.at, POND)));
  // Every fourth row and every fifth column is left for a street: fewer houses than places.
  const plain = houses({ id: 'town', within: SQUARE, step: 24, seed: 2, roofs: ['accent.coral'], side: 'dark.plum', rise: 8, street: 1000 }) as unknown as { children: unknown[] };
  assert.ok(plain.children.length > town.children.length * 1.3);
  assert.ok(refused(() => houses({ id: 't', within: SQUARE, step: 24, seed: 2, roofs: ['accent.coral'], side: 'dark.plum', rise: 8, street: 1 }), /street must be/));
  // Roofs on request: steeper by the house's shorter side, gabled or of both kinds, with a contrast; the houses the same.
  type House = { at: Vec2; fill: string; rise: number; shape: { points: Vec2[] }; roof: { kind: string; height: number; contrast?: number } };
  const town2 = (roof?: object): House[] => (houses({ id: 'town', within: SQUARE, step: 24, seed: 2, roofs: ['accent.coral', 'mid.rose'], side: 'dark.plum', rise: 8, ...(roof ? { roof } : {}) }) as unknown as { children: House[] }).children;
  const plainRoofs = town2();
  // Without the option a roof is what it always was: hipped, 0.6 of the walls high, and no more keys.
  assert.ok(plainRoofs.every((h) => JSON.stringify(Object.keys(h.roof)) === '["kind","height"]' && h.roof.height === Math.round(h.rise * 0.6 * 10) / 10 + 0));
  const mixed = town2({ kind: 'mixed', pitch: 0.45, contrast: 1.5 });
  assert.equal(mixed.length, plainRoofs.length);
  assert.ok(mixed.every((h, i) => h.at[0] === plainRoofs[i]!.at[0] && h.at[1] === plainRoofs[i]!.at[1] && h.fill === plainRoofs[i]!.fill), 'the same houses in the same colours');
  const kinds = new Set(mixed.map((h) => h.roof.kind));
  assert.deepEqual([...kinds].sort(), ['gable', 'hip']);
  const share = mixed.filter((h) => h.roof.kind === 'gable').length / mixed.length;
  assert.ok(share > 0.35 && share < 0.65, `${share} gabled`);
  assert.ok(mixed.every((h) => h.roof.contrast === 1.5));
  const side = (h: House): number => Math.min(...[0, 1].map((k) => Math.max(...h.shape.points.map((p) => p[k]!)) - Math.min(...h.shape.points.map((p) => p[k]!))));
  assert.ok(mixed.every((h) => Math.abs(h.roof.height - 0.45 * side(h)) <= 0.051), 'a pitch of the shorter side');
  assert.ok(town2({ kind: 'gable' }).every((h) => h.roof.kind === 'gable'));
  assert.ok(plainRoofs.every((h) => h.roof.kind === 'hip' && h.roof.contrast === undefined));
  assert.ok(refused(() => town2({ kind: 'dome' }), /roof.kind must be 'hip', 'gable' or 'mixed'/));
  assert.ok(refused(() => town2({ pitch: 0.4, slope: 1 }), /slope/));
  assert.ok(refused(() => woods({ id: 'w', within: [SQUARE], step: 30, r: 10, seed: 1, crowns: [] }), /at least one palette reference/));
});

test('parcels and flecks: whole parcels inside the outline; flecks over their box', () => {
  const fields = parcels({ id: 'fields', within: SQUARE, avoid: [POND], step: 60, turn: 20, seed: 9, fills: ['mid.jade', 'mid.mist'], rows: 'dark.navy' }) as unknown as { opacity: number; children: { at: Vec2; shape: { points: Vec2[] }; rotation: number; children: unknown[] }[] };
  assert.ok(fields.children.length > 30);
  for (const p of fields.children) {
    const t = (p.rotation * Math.PI) / 180;
    for (const [u, v] of p.shape.points) {
      const c: Vec2 = [p.at[0] + u * Math.cos(t) - v * Math.sin(t), p.at[1] + u * Math.sin(t) + v * Math.cos(t)];
      // Its cell lies whole inside; the parcel, a little smaller, may be turned a few degrees off the lattice.
      assert.ok(inside(c, SQUARE) || distTo(c, [SQUARE]) < 3, 'a parcel lies whole inside the outline');
    }
  }
  assert.ok(fields.children.some((p) => p.children.length === 4), 'some parcels are striped');
  const bare = parcels({ id: 'f', within: SQUARE, step: 60, seed: 9, fills: ['mid.jade'] }) as unknown as { children: { children: unknown[] }[] };
  assert.ok(bare.children.every((p) => p.children.length === 0), 'none striped without rows');
  const ground = flecks({ id: 'flecks', bounds: [-400, -300, 400, 300], avoid: [POND], step: 25, len: 10, seed: 1, colors: ['light.snow', 'deep.ink'] }) as unknown as { children: { points: Vec2[]; color: string }[] };
  assert.ok(ground.children.length > 600);
  assert.deepEqual([...new Set(ground.children.map((c) => c.color))].sort(), ['deep.ink', 'light.snow']);
});

test('logRoad and locator: logs across the road at their step; the locator in the colours given', () => {
  const path = smoothLine([[-300, 0], [0, -60], [300, 0]], 5);
  const road = logRoad({ id: 'road', path, width: 20, step: 12, bed: 'dark.plum', log: 'mid.rose', rail: 'light.cream' });
  assert.deepEqual(road.map((n) => n.id), ['road', 'road-logs', 'road-rail0', 'road-rail1']);
  const logs = (road[1] as unknown as { children: { at: Vec2 }[] }).children;
  // The path is about 612 long, its points 5 apart: a log at the first point 12 or more past the last log.
  assert.ok(logs.length > 35 && logs.length < 52, `${logs.length} logs`);
  // The plain road is what it always was: the options left out, nothing changes.
  assert.equal(JSON.stringify(road), JSON.stringify(logRoad({ id: 'road', path, width: 20, step: 12, bed: 'dark.plum', log: 'mid.rose', rail: 'light.cream' })));
  // A corduroy road: round lit logs side by side at an even step, a little out of line, in the colours given; no rails.
  const corduroy = logRoad({ id: 'road', path, width: 20, step: 6, bed: 'dark.plum', log: ['mid.rose', 'accent.coral'], round: true, share: 0.9, jitter: 0.5, seed: 3, rails: false });
  assert.deepEqual(corduroy.map((n) => n.id), ['road', 'road-logs']);
  const round = (corduroy[1] as unknown as { children: { at: Vec2; shape: { kind: string; r: number; length: number }; lit: boolean; fill: string; rotation: number }[] }).children;
  assert.ok(round.every((l) => l.shape.kind === 'capsule' && l.lit && Math.abs(l.shape.r - 2.7) < 0.06));
  assert.deepEqual([...new Set(round.map((l) => l.fill))].sort(), ['accent.coral', 'mid.rose']);
  const gaps = round.slice(1).map((l, i) => Math.hypot(l.at[0] - round[i]!.at[0], l.at[1] - round[i]!.at[1]));
  assert.ok(gaps.every((g) => g > 4.5 && g < 7.5), `logs ${Math.min(...gaps)} to ${Math.max(...gaps)} apart`);
  assert.ok(new Set(round.map((l) => l.shape.length)).size > 10, 'logs of different lengths');
  assert.equal(JSON.stringify(corduroy), JSON.stringify(logRoad({ id: 'road', path, width: 20, step: 6, bed: 'dark.plum', log: ['mid.rose', 'accent.coral'], round: true, share: 0.9, jitter: 0.5, seed: 3, rails: false })));
  assert.notEqual(JSON.stringify(corduroy), JSON.stringify(logRoad({ id: 'road', path, width: 20, step: 6, bed: 'dark.plum', log: ['mid.rose', 'accent.coral'], round: true, share: 0.9, jitter: 0.5, seed: 4, rails: false })));
  assert.ok(refused(() => logRoad({ id: 'road', path, width: 20, step: 6, bed: 'dark.plum', log: 'mid.rose' }), /rail is the colour of the rails/));
  assert.ok(refused(() => logRoad({ id: 'road', path, width: 20, step: 6, bed: 'dark.plum', log: 'mid.rose', rail: 'light.cream', round: 1 as never }), /round must be true or false/));
  const inset = locator({ id: 'where', at: [700, -380], w: 300, h: 200, land: [oval(80, 60).map(([x, y]) => [x + 700, y - 380] as Vec2)], spot: [700, -380], sea: 'dark.navy', landFill: 'mid.mist', frame: 'light.cream', mark: 'accent.coral' });
  assert.deepEqual(inset.map((n) => n.id), ['where-border', 'where-panel', 'where-land0', 'where-halo', 'where-spot']);
  const shaded = locator({ id: 'where', at: [0, 0], w: 300, h: 200, land: [], spot: [0, 0], sea: 'dark.navy', landFill: 'mid.mist', frame: 'light.cream', mark: 'accent.coral', shadow: 'deep.abyss' });
  assert.equal(shaded[0]!.id, 'where-shadow');
});

test('map dressings: the same options give the same nodes, and they compile and draw on a floor seen at a tilt', async () => {
  const dress = (seed: number): SceneNode[] => [
    ...water({ id: 'lake', rings: [POND], fill: 'mid.ocean', shallow: 'mid.jade', glint: 'light.snow', band: 8, ripples: { step: 50, len: 20, seed } }),
    ...woods({ id: 'wood', within: [[[-400, -300], [-150, -300], [-150, 300], [-400, 300]]], step: 26, r: 10, seed, crowns: ['mid.jade', 'dark.navy'], shadow: 'deep.abyss' }),
    houses({ id: 'town', within: [[150, -300], [400, -300], [400, 300], [150, 300]], step: 22, seed, roofs: ['accent.coral'], side: 'dark.plum', rise: 8, shadow: 'deep.abyss' }),
    flecks({ id: 'flecks', bounds: [-400, -300, 400, 300], step: 40, len: 10, seed, colors: ['light.snow'] }),
  ];
  assert.equal(JSON.stringify(dress(1)), JSON.stringify(dress(1)));
  assert.notEqual(JSON.stringify(dress(1)), JSON.stringify(dress(2)));
  const floor = (nodes: SceneNode[]): SceneNode => group({ id: 'floor', at: [0, 0, 0] as Vec3, plane: 'floor', children: nodes });
  const spec = make([floor(dress(1))], [], { perspective: { aim: [0, 0, 0] as Vec3, distance: 1600, tilt: 50 } });
  compileShot(spec);
  const raw = await draw(spec);
  const again = await draw(make([floor(dress(1))], [], { perspective: { aim: [0, 0, 0] as Vec3, distance: 1600, tilt: 50 } }));
  assert.equal(differing(raw, again), 0, 'the same frame, pixel for pixel');
  // The ground of the shot shows round the floor, and the water's ripples are drawn on it.
  let lit = 0;
  for (let i = 0; i < raw.length; i += 4) if (!dark([raw[i]!, raw[i + 1]!, raw[i + 2]!])) lit++;
  assert.ok(lit > 10_000, `${lit} pixels drawn`);
});

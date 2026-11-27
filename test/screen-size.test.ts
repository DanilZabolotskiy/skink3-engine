import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, computeWorld, group, layer, popIn, posesFromBake, reviewMotion, shot, travel, zoomTo, type GroupNode, type Key, type ShotSpec } from '../src/index.ts';
import { screenHeld } from '../src/scene/evaluate.ts';

// A symbol of a map that keeps a size on screen (a group with `screen`): its size has a floor and a cap in units of
// the frame, whatever the zoom of the camera and the perspective at its place. It is opt-in: a group without it is
// drawn at the size its parents and the camera give it.

const boat = (screen?: GroupNode['screen'], at: [number, number] = [0, 0]): GroupNode =>
  group({ id: 'boat', at, ...(screen ? { screen } : {}), children: [circle({ id: 'hull', r: 10, fill: 'accent.coral', lit: false })] });

function make(node: GroupNode, timeline: Key[] = [], o: { persp?: boolean; seconds?: number } = {}): ShotSpec {
  return shot({
    id: 'tiny', seconds: o.seconds ?? 4, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [o.persp
      ? layer({ id: 'map', depth: 0, perspective: { aim: [0, 0, 0], distance: 1500, lens: 1200, tilt: 60, turn: 0 }, nodes: [group({ id: 'floor', plane: 'floor', children: [node] })] })
      : layer({ id: 'map', depth: 0, nodes: [node] })],
    timeline,
  });
}

/** How large the boat (20 units across) is drawn on the frame at a frame: its world scale times the zoom of its layer. */
async function onScreen(spec: ShotSpec, frame: number): Promise<number> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const zoom = (await import('../src/camera/camera.ts')).layerView((await import('../src/camera/camera.ts')).cameraAt(c.spec.camera, c.cameraNoise, frame, c.frames, c.cameraTrack), 1).zoom;
  const { newPlaces } = await import('../src/scene/evaluate.ts');
  const world = computeWorld(c, frame, posesFromBake(bake), c.spatial ? newPlaces(c) : undefined);
  return 20 * world[c.byId.get('boat')!.index]!.scale * zoom;
}

test('screen: what it refuses', () => {
  assert.throws(() => boat({ size: 20 }), /screen needs least, most or both/);
  assert.throws(() => boat({ size: 20, least: 40, most: 30 }), /screen\.least \(40\) is above screen\.most \(30\)/);
  assert.throws(() => boat({ size: 0, least: 10 }), /screen\.size must be a number in 0\.01\.\.1000000/);
  assert.throws(() => boat({ size: 20, least: 10, far: 2 } as never), /unknown option "far"/);
  assert.throws(() => group({ id: 'floor', plane: 'floor', screen: { size: 20, least: 10 } }), /a group that lies in a plane is the map; give screen to a group inside it/);
});

test('screen: opt-in: a group without it is drawn at the size its parents and the camera give it', async () => {
  assert.equal('screen' in boat(), false);
  const out = zoomTo({ at: 0.5, to: 0.25, dur: 1 });
  assert.ok(Math.abs((await onScreen(make(boat(), [out]), 200)) - 5) < 1e-6, 'a quarter of its size at a quarter of the zoom');
});

test('screen: it keeps its least size through a zoom out, its most through a zoom in, and its own size between them', async () => {
  const held = boat({ size: 20, least: 12, most: 40 });
  // Between least and most it is drawn at its own size, within a few thousandths (the limits are smooth).
  assert.ok(Math.abs((await onScreen(make(held), 0)) - 20) < 0.25);
  // A zoom out to a quarter: 5 on screen without the hold, about 12 with it.
  const out = await onScreen(make(held, [zoomTo({ at: 0.5, to: 0.25, dur: 1 })]), 200);
  assert.ok(out >= 12 && out < 12.5, `${out}`);
  // A zoom in to four times: 80 without the hold, about 40 with it.
  const near = await onScreen(make(held, [zoomTo({ at: 0.5, to: 4, dur: 1 })]), 200);
  assert.ok(near <= 40 && near > 38, `${near}`);
  // It eases into its hold: no kink in its size through the zoom.
  for (const [s, l] of [[1, 12], [12, 12], [100, 12]] as const) assert.ok(screenHeld(s, l) >= Math.max(s, l) && screenHeld(s, l) < Math.max(s, l) * 1.13);
  // Far away in a plane of a perspective layer it is held as well.
  const far = await onScreen(make(boat({ size: 20, least: 14 }, [0, -2600]), [], { persp: true }), 0);
  const plain = await onScreen(make(boat(undefined, [0, -2600]), [], { persp: true }), 0);
  assert.ok(plain < 10 && far >= 14 && far < 16, `${plain} ${far}`);
});

test('screen: its own keys still scale it: it pops in from nothing', async () => {
  const spec = make(boat({ size: 20, least: 30 }), [popIn('boat', { at: 1 })]);
  assert.equal(await onScreen(spec, 30), 0);
  assert.ok((await onScreen(spec, 180)) >= 30);
});

test('screen: the motion review judges a symbol at the size it is drawn, and its hold is the camera\'s', async () => {
  const findings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.subject === 'boat').map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // A boat of 20 units crosses a map seen at a fifth of its size, 8 px a frame: 4 px across, it strobes.
  const sail = (screen?: GroupNode['screen']): ShotSpec => make(boat(screen, [-2400, 0]), [zoomTo({ at: -1, to: 0.2, dur: 0.5 }), travel('boat', { at: 0, path: [[-2400, 0], [2400, 0]], dur: 2, profile: 'steady' })], { seconds: 2 });
  assert.deepEqual(await findings(sail()), ['too-fast boat position']);
  // Held at 40 px on screen, the same way at the same speed is a fifth of its size a frame: the sound scene.
  assert.deepEqual(await findings(sail({ size: 20, least: 40 })), []);
  // The planted defect: held at 12 px, it still runs more than half of that a frame.
  assert.deepEqual(await findings(sail({ size: 20, least: 12 })), ['too-fast boat position']);
  // Through a steady zoom out its size is held: that change is the camera's, not a scale of its own.
  assert.deepEqual(await findings(make(boat({ size: 20, least: 12 }), [zoomTo({ at: 0.5, to: 0.2, dur: 2, profile: 'steady' })])), []);
});

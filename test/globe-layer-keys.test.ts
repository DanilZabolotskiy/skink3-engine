import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  cut,
  evaluate,
  fadeTo,
  fillTo,
  flatItems,
  frameRaw,
  globe,
  globeBlob,
  heightFor,
  intended,
  layer,
  moveTo,
  reviewMotion,
  sceneEvents,
  shot,
  type Key,
  type ShapeItem,
  type ShotSpec,
} from '../src/index.ts';

// Keys on a layer of a globe: a layer with an id takes fadeTo and fillTo, as a shape does, so that one patch of the
// surface brightens and dims again while the globe holds or turns. It is opt-in: a globe whose layers have no keys is
// the globe it was.

const WIDTH = 480;

/** Three patches that face the viewer at the start, and one on the far side. */
const PATCHES: Record<string, [number, number]> = { 'patch-a': [-35, 15], 'patch-b': [5, -12], 'patch-c': [38, 18], 'patch-far': [180, 0] };

function make(timeline: Key[], o: { ids?: boolean; spin?: number; seconds?: number; intended?: ShotSpec['intended'] } = {}): ShotSpec {
  const ids = o.ids ?? true;
  return shot({
    id: 'banded',
    seconds: o.seconds ?? 4,
    seed: 2,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [
          globe({
            id: 'world',
            r: 400,
            fill: 'dark.navy',
            spin: o.spin ?? 0,
            layers: Object.entries(PATCHES).map(([id, at], k) => ({ ...(ids ? { id } : {}), rings: [globeBlob({ at, r: 14, seed: k + 1 })], fill: 'mid.jade' })),
          }),
          circle({ id: 'buoy', at: [700, 300], r: 40, fill: 'accent.coral', idle: { amp: 10, period: 2 } }),
        ],
      }),
    ],
    timeline,
    ...(o.intended ? { intended: o.intended } : {}),
  });
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

const hash = async (spec: ShotSpec, frame: number): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

/** The colour of the frame at the middle of a patch that faces the viewer (an orthographic view of [lon, lat] from [0, 0]). */
async function at(spec: ShotSpec, frame: number, patch: string): Promise<[number, number, number]> {
  const [lon, lat] = PATCHES[patch]!;
  const D = Math.PI / 180;
  const x = 400 * Math.cos(lat * D) * Math.sin(lon * D);
  const y = -400 * Math.sin(lat * D);
  const r = await raw(spec, frame);
  const k = WIDTH / 1920;
  const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [r[i]!, r[i + 1]!, r[i + 2]!];
}

async function findings(spec: ShotSpec): Promise<string[]> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
}

test('globe layer keys: a layer takes an id; what is refused', () => {
  assert.doesNotThrow(() => make([fadeTo('patch-a', { at: 1, to: 0.5 }), fillTo('patch-b', { at: 1, to: 'accent.amber' })]));
  // An id is unique in the shot, and of the form of a node's id.
  const twice = (layers: object[]) => () => compileShot({ ...make([]), layers: [layer({ id: 'stage', depth: 0, nodes: [globe({ id: 'g', r: 100, fill: 'dark.navy', layers: layers as never }), circle({ id: 'dot', r: 10, fill: 'mid.jade' })] })] });
  const ring = [globeBlob({ at: [0, 0], r: 10 })];
  assert.throws(twice([{ id: 'dot', rings: ring, fill: 'mid.jade' }]), /duplicate id "dot" \(a layer of the globe "g"\)/);
  assert.throws(twice([{ id: 'band', rings: ring, fill: 'mid.jade' }, { id: 'band', rings: ring, fill: 'mid.rose' }]), /duplicate id "band"/);
  assert.throws(twice([{ id: '9band', rings: ring, fill: 'mid.jade' }]), /layers\[0\]: id must be a string of letters/);
  // A layer is keyed in its opacity and its fill alone, and makes no sound.
  assert.throws(() => make([moveTo('patch-a', { at: 1, to: [0, 0] })]), /moveTo cannot target "patch-a": it is a layer of the globe "world", which takes fadeTo and fillTo/);
  assert.throws(() => make([fadeTo('patch-a', { at: 1, to: 0.5, sound: 'tick' })]), /fades a layer of the globe "world", which makes no event to sound/);
  assert.throws(() => make([fillTo('patch-a', { at: 9, to: 'accent.amber' })]), /fillTo\("patch-a"\) starts at 9 s, after the shot ends/);
  assert.throws(() => make([fillTo('patch-a', { at: 1, to: 'accent.nope' })]), /fillTo\("patch-a"\) at 1 s: to/);
  // An intended exception may name a layer.
  assert.doesNotThrow(() => make([fadeTo('patch-a', { at: 1, to: 0.5 })], { intended: [intended('patch-a', 'jump', 'meant')] }));
});

test('globe layer keys: opt-in: a globe without keyed layers is the data and the picture it was', async () => {
  const plain = compileShot(make([], { ids: false }));
  const named = compileShot(make([]));
  assert.equal('globeLayers' in plain.byId.get('world')!, false);
  assert.equal('globeLayers' in named.byId.get('world')!, false, 'an id alone keys nothing');
  assert.equal('id' in (plain.byId.get('world')!.node as unknown as { globe: { layers: object[] } }).globe.layers[0]!, false);
  for (const frame of [0, 120]) assert.equal(await hash(make([]), frame), await hash(make([], { ids: false }), frame), `frame ${frame}`);
  // A keyed globe is that picture before its first key, and its unkeyed layers are drawn as they were throughout.
  const keyed = make([fillTo('patch-a', { at: 2, to: 'accent.amber', dur: 1 })]);
  assert.equal(await hash(keyed, 60), await hash(make([]), 60));
  assert.deepEqual(await at(keyed, 200, 'patch-b'), await at(make([]), 200, 'patch-b'));
});

test('globe layer keys: fillTo and fadeTo run on a layer, key after key, and the picture follows', async () => {
  const spec = make([
    fillTo('patch-a', { at: 0.5, to: 'accent.amber', dur: 0.6 }),
    fillTo('patch-a', { at: 1.5, to: 'mid.jade', dur: 0.6 }),
    fadeTo('patch-b', { at: 0.5, to: 0, dur: 0.6 }),
    fadeTo('patch-b', { at: 1.5, to: 1, dur: 0.6 }),
  ]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const layersAt = (frame: number) => (flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items).find((i) => i.node.id === 'world') as ShapeItem).globeLayers!;
  const amber = palette.colors.get('accent.amber');
  assert.equal(layersAt(0)[0]!.fill, c.byId.get('world')!.colors['globe.layer0']);
  assert.equal(layersAt(72)[0]!.fill.toLowerCase(), String(amber).toLowerCase());
  assert.equal(layersAt(72)[1]!.opacity, 0);
  assert.equal(layersAt(150)[1]!.opacity, 1);
  assert.equal(layersAt(72)[2], null, 'a layer without keys is drawn as it was given');
  // In the picture: the first patch turns warm and back; the second is gone and back.
  const [green, warm, back] = [await at(spec, 0, 'patch-a'), await at(spec, 72, 'patch-a'), await at(spec, 150, 'patch-a')];
  assert.ok(warm[0] > green[0] + 60, `${green} ${warm}`);
  assert.deepEqual(back, green);
  // Faded out, the second patch shows the sea of the disc under it.
  const [land, gone] = [await at(spec, 0, 'patch-b'), await at(spec, 72, 'patch-b')];
  assert.ok(Math.abs(gone[1] - land[1]) > 30 && gone[2] > gone[1], `${land} ${gone}`);
  // A key on a layer makes no event of the sound track; the buoy's idle wander is none either.
  assert.deepEqual(sceneEvents(c, bake), []);
});

test('globe layer keys: the motion review judges a layer as a shape\'s opacity and fill, while it is seen', async () => {
  // The sound scene: eased keys of a second or less, in turn.
  assert.deepEqual(await findings(make([fillTo('patch-a', { at: 0.5, to: 'accent.amber', dur: 0.8 }), fadeTo('patch-c', { at: 1.5, to: 0.2, dur: 0.6 })])), []);
  // The planted defects: a fill and a fade squeezed into three frames pop.
  const pops = await findings(make([fillTo('patch-a', { at: 1, to: 'accent.amber', dur: 0.05 }), fadeTo('patch-b', { at: 1, to: 0, dur: 0.05 })]));
  assert.ok(pops.includes('jump patch-a fill') && pops.includes('jump patch-b opacity'), pops.join('; '));
  // What happens on the far side of the globe is not seen.
  assert.deepEqual(await findings(make([fillTo('patch-far', { at: 1, to: 'accent.amber', dur: 0.05 })])), []);
  // What is meant is not reported; a fade of no time at a cut is the cut.
  assert.deepEqual(await findings(make([fadeTo('patch-b', { at: 1, to: 0, dur: 0.05 })], { intended: [intended('patch-b', 'jump', 'it goes out')] })), []);
  assert.deepEqual(await findings(make([cut({ at: 1 }), fadeTo('patch-b', { at: 1, to: 0, dur: 0 })])), []);
});

test('globe layer keys: a layer that changes keeps its part of the frame alive', async () => {
  // A globe that holds for seven seconds, with nothing else: the frame is a hold. With a layer that brightens and dims
  // in turn it is not, where the globe is.
  const still = (timeline: Key[]): ShotSpec => ({ ...make(timeline, { seconds: 7 }), layers: [layer({ id: 'stage', depth: 0, nodes: [(make([]).layers[0]!.nodes[0]!)] })] });
  const dead = (await findings(still([]))).filter((f) => f.startsWith('dead-area'));
  assert.ok(dead.includes('dead-area (frame) hold'), dead.join('; '));
  const keys: Key[] = [];
  for (let t = 0.2; t < 7; t += 1.4) keys.push(fillTo('patch-a', { at: t, to: 'accent.amber', dur: 0.6 }), fillTo('patch-a', { at: t + 0.7, to: 'mid.jade', dur: 0.6 }));
  const alive = (await findings(still(keys))).filter((f) => f.startsWith('dead-area'));
  assert.ok(!alive.includes('dead-area (frame) hold'), alive.join('; '));
});

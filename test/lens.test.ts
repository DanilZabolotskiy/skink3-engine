import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, evaluate, frameRaw, group, intended, layer, lens, moveTo, rect, reviewMotion, shot, type ShapeNode, type ShotSpec } from '../src/index.ts';
import { resolveColor } from '../src/index.ts';

// A magnifier inset (lens): a circle or a rounded rect in a layer of the frame that shows, inside its outline, the
// frame as drawn up to another layer, enlarged about the place of a node of that layer, with a ring round it and a
// leader to the place. It is opt-in: a shot without one is the shot it was.

const WIDTH = 480;
const K = WIDTH / 1920;

function make(o: { loupe?: ShapeNode | null; mapExtra?: object; frameDepth?: number; sampled?: boolean; dotMove?: boolean; intended?: ShotSpec['intended']; seconds?: number } = {}): ShotSpec {
  const loupe = o.loupe === undefined ? lens({ id: 'loupe', of: 'map', look: 'dot', zoom: 4, r: 160, at: [-560, -200], fill: 'light.cream', width: 12 }) : o.loupe;
  const map = [rect({ id: 'sea', w: 4000, h: 3000, fill: 'dark.navy', lit: false }), circle({ id: 'dot', at: [500, 200], r: 12, fill: 'accent.coral', lit: false })];
  return shot({
    id: 'tiny', seconds: o.seconds ?? 2, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({ id: 'map', depth: 0, nodes: o.sampled ? [group({ id: 'set', children: map })] : map, ...(o.sampled ? { sampledBackdrop: { group: 'set', frames: [] } } : {}), ...o.mapExtra }),
      layer({ id: 'frame', depth: o.frameDepth ?? -0.2, parallax: 0, blur: 0, tint: 0, nodes: loupe ? [loupe] : [] }),
    ],
    timeline: o.dotMove ? [moveTo('dot', { at: 0.2, to: [500, -600], dur: 0.25, profile: 'steady' })] : [],
    ...(o.intended ? { intended: o.intended } : {}),
  });
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

const rgb = (ref: string): [number, number, number] => {
  const hex = resolveColor(palette, ref);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
};

/** The pixels of a colour (within a few levels) inside a box of the stage, [x0, y0, x1, y1] from the frame's top-left. */
function count(r: Buffer, colour: [number, number, number], box: [number, number, number, number]): number {
  let n = 0;
  const h = r.length / 4 / WIDTH;
  for (let y = Math.max(0, Math.floor(box[1] * K)); y < Math.min(h, Math.ceil(box[3] * K)); y++) {
    for (let x = Math.max(0, Math.floor(box[0] * K)); x < Math.min(WIDTH, Math.ceil(box[2] * K)); x++) {
      const o = (y * WIDTH + x) * 4;
      if (Math.abs(r[o]! - colour[0]) + Math.abs(r[o + 1]! - colour[1]) + Math.abs(r[o + 2]! - colour[2]) < 12) n++;
    }
  }
  return n;
}

test('lens: what it refuses', () => {
  const bad = (o: object, message: RegExp): void => assert.throws(() => lens({ id: 'l', of: 'map', look: 'dot', zoom: 3, fill: 'light.cream', ...o } as never), message);
  bad({ r: 100, w: 100, h: 80 }, /a lens is a circle \(r\) or a rounded rect \(w, h, radius\)/);
  bad({}, /a lens is a circle \(r\) or a rounded rect \(w, h, radius\)/);
  bad({ r: 100, radius: 8 }, /radius is the corner of a rounded rect/);
  bad({ r: 100, zoom: 1 }, /zoom must be a number in 1\.25\.\.64/);
  bad({ r: 100, glow: 1 }, /unknown option "glow"/);
  const loupe = (o: object): ShapeNode => lens({ id: 'loupe', of: 'map', look: 'dot', zoom: 3, r: 100, fill: 'light.cream', ...o } as never);
  assert.throws(() => make({ loupe: loupe({ of: 'sky' }) }), /lens "loupe" shows the layer "sky", which is not a layer of the shot/);
  assert.throws(() => make({ loupe: loupe({ of: 'frame' }) }), /lens "loupe" shows its own layer/);
  assert.throws(() => make({ loupe: loupe({ look: 'nobody' }) }), /lens "loupe" looks at "nobody", which is not a node of the shot/);
  assert.throws(() => make({ loupe: loupe({ look: 'loupe' }) }), /lens "loupe" looks at "loupe": that is a placed node .* of the layer "map"/);
  assert.throws(() => make({ frameDepth: 0.5 }), /lies in the layer "frame", which is drawn before "map": the lens would be drawn under what it shows/);
  // A lens draws the frame again at every frame: it is no part of a sampled picture.
  assert.throws(() => shot({ ...make(), layers: [make().layers[0]!, layer({ id: 'frame', depth: -0.2, parallax: 0, nodes: [group({ id: 'set', children: [loupe({})] })], sampledBackdrop: { group: 'set', frames: [] } })] } as never), /"loupe" is a lens, which draws the frame again at every frame: list it outside the sampled group/);
});

test('lens: opt-in: a shot without one has none, and draws as it did', async () => {
  const c = compileShot(make({ loupe: null }));
  assert.equal('lenses' in c, false);
  const state = evaluate(c, await bakeShot(c), 10, 'en');
  assert.ok(state.layers.every((l) => l.items.every((i) => !('lens' in i))));
  // A lens changes nothing outside its outline and its leader: the far corner of the frame is the same.
  const with_ = await raw(make(), 10);
  const without = await raw(make({ loupe: null }), 10);
  assert.equal(count(with_, rgb('dark.navy'), [1500, 900, 1920, 1080]), count(without, rgb('dark.navy'), [1500, 900, 1920, 1080]));
});

test('lens: it shows the place it looks at, enlarged, inside its outline, with a ring and a leader', async () => {
  const r = await raw(make(), 10);
  const coral = rgb('accent.coral');
  // The dot on the map: a disc of 12 units. In the lens, four times as wide: a disc of 48 units, all but its rim.
  const onMap = count(r, coral, [960 + 500 - 30, 540 + 200 - 30, 960 + 500 + 30, 540 + 200 + 30]);
  const inLens = count(r, coral, [960 - 560 - 160, 540 - 200 - 160, 960 - 560 + 160, 540 - 200 + 160]);
  const disc = Math.PI * (48 * K) ** 2;
  assert.ok(onMap > 5 && onMap < 0.1 * disc, `${onMap}`);
  assert.ok(inLens > 0.8 * disc && inLens < 1.05 * disc, `${onMap} on the map, ${inLens} in the lens, a disc of ${disc.toFixed(0)}`);
  // The ring round the lens, in its fill.
  const cream = rgb('light.cream');
  assert.ok(count(r, cream, [960 - 560 - 170, 540 - 200 - 170, 960 - 560 + 170, 540 - 200 + 170]) > 30);
  // The leader: between the lens and the place, along the line that joins them, the ring's colour.
  assert.ok(count(r, cream, [960 - 100, 540 - 60, 960 + 100, 540 + 40]) > 3);
  // A rounded rect for a lens, without a leader.
  const square = await raw(make({ loupe: lens({ id: 'loupe', of: 'map', look: 'dot', zoom: 4, w: 320, h: 240, radius: 24, at: [-560, -200], fill: 'light.cream', width: 12, leader: false }) }), 10);
  assert.ok(count(square, coral, [960 - 560 - 160, 540 - 200 - 120, 960 - 560 + 160, 540 - 200 + 120]) > 0.8 * disc);
  assert.equal(count(square, cream, [960 - 100, 540 - 60, 960 + 100, 540 + 40]), 0);
  // A layer whose backdrop is a sampled picture is shown as it is drawn, not as that picture enlarged.
  const sampled = await raw(make({ sampled: true }), 10);
  const inSampled = count(sampled, coral, [960 - 560 - 160, 540 - 200 - 160, 960 - 560 + 160, 540 - 200 + 160]);
  assert.ok(inSampled > 0.8 * disc && inSampled < 1.05 * disc, `${inSampled}`);
});

test('lens: the motion review judges the picture in it: a slow follow is clean, a slide that strobes is found, an intended one is not', async () => {
  const findings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.channel === 'lens').map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // The sound scene: the dot does not move; the lens holds still on it.
  assert.deepEqual(await findings(make()), []);
  // The planted defect: the dot runs 800 units in a quarter of a second, 53 units a frame: four times that in the lens,
  // two thirds of its width each frame.
  assert.deepEqual(await findings(make({ dotMove: true })), ['too-fast loupe lens']);
  assert.deepEqual(await findings(make({ dotMove: true, intended: [intended('loupe', 'too-fast', 'a dash across')] })), []);
});

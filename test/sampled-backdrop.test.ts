import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ImageData } from 'skia-canvas';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot, cameraTo, compileShot, drive, evaluate, frameRaw, group, layer, perspectiveTo, rect, rendererInfo, shot,
  type ColorRef, type Key, type LayerSpec,
} from '../src/index.ts';
import { glowView, sampledFrame } from '../src/render/backdrop.ts';
import type { Item } from '../src/scene/evaluate.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { renderChunk } from '../src/render/parallel.ts';

const land = (id: string, x: number, fill: ColorRef, w = 320) => rect({ id, at: [x, 0], fill, w, h: 320, lit: false });
const nodes = [land('under', -100, 'mid.mist', 900),
  group({ id: 'terrain', opacity: 0.6, children: [land('tile', 0, 'accent.amber')] }),
  land('over', 140, 'accent.aqua', 90)];
const tileMove = drive('tile', { dur: 1.99, samples: { at: [[-360, 0], [0, 0], [360, 0]] } });
const opts = { width: 240, gpu: false, lang: 'en' };
function scene(sampledBackdrop?: LayerSpec['sampledBackdrop'], changes: Key[] = [], perspective = false, contents = nodes) {
  return shot({ id: 'sample', seconds: 2, seed: 3, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'map', depth: 0, nodes: contents, sampledBackdrop, ...(perspective ? { perspective: true } : {}) })],
    timeline: [tileMove, ...changes] });
}
const schedule = { group: 'terrain', frames: [26, 74] };

test('an opt-in layer keeps original indices, painter order and live content at every output frame', async () => {
  const stock = compileShot(scene());
  assert.equal('sampledBackdrop' in stock.layers[0]!.spec, false);
  assert.equal('sampledBackdrops' in stock, false);
  const c = compileShot(scene(schedule));
  assert.deepEqual(c.sampledBackdrops![0]!.frames, [0, 26, 74, 119]);
  const b = await bakeShot(c), sb = await bakeShot(stock);
  assert.equal(evaluate(c, b, 50, 'en').layers[0]!.items.length, evaluate(stock, sb, 50, 'en').layers[0]!.items.length);
  const raw = (f: number) => frameRaw(c, b, f, opts);
  const original = (f: number) => frameRaw(stock, sb, f, opts);
  for (const f of [0, 26, 74, 119]) {
    const a = await raw(f), ref = await original(f);
    const delta = a.reduce((worst, v, i) => Math.max(worst, Math.abs(v - ref[i]!)), 0);
    const at = a.findIndex((v, i) => Math.abs(v - ref[i]!) === delta) & ~3;
    assert.ok(delta <= 1, `anchor ${f}, maximum error ${delta} at byte ${at}: ${a.subarray(at,at+4).join('/')} vs ${ref.subarray(at,at+4).join('/')}`);
  }
  const a = await raw(26), mid = await raw(50), z = await raw(74), ref = await original(50);
  assert.notDeepEqual(mid, ref, 'the moving child is sampled on this held view');
  // The live foreground crosses the sampled group. Another pixel has a live shape behind the translucent image.
  for (const x of [140, -192, 0]) {
    const offset = (68 * opts.width + Math.round(opts.width / 2 + x * opts.width / 1920)) * 4;
    for (let i = offset; i < offset + 4; i++) assert.ok(Math.abs(mid[i]! - (a[i]! + z[i]!) / 2) <= 1);
  }
  await raw(119);
  assert.deepEqual(await raw(50), mid, 'seeking back through different cached pairs preserves the bytes');
  const fresh = compileShot(scene(schedule));
  assert.deepEqual(await frameRaw(fresh, await bakeShot(fresh), 50, opts), mid, 'a cold chunk starting mid-interval agrees');
  await assert.rejects(raw(120), /outside the shot/);
  await assert.rejects(frameRaw(c, sb, 50, opts), /bake does not belong/);
});

test('moving camera, perspective and driven group placement use the ordinary renderer until the view holds', async () => {
  const changes: Key[][] = [
    [cameraTo({ at: 0.5, dur: 0.2, to: [120, 0] }), cameraTo({ at: 0.7, dur: 0.2, to: [0, 0] })],
    [perspectiveTo('map', { at: 0.5, dur: 0.2, turn: 20 }), perspectiveTo('map', { at: 0.7, dur: 0.2, turn: 0 })],
    [drive('terrain', { at: 0.5, dur: 0.4, samples: { at: [[0, 0], [160, 0], [0, 0]] } })],
  ];
  for (const [i, timeline] of changes.entries()) {
    const stock = compileShot(scene(undefined, timeline, i === 1));
    const c = compileShot(scene(schedule, timeline, i === 1));
    const b = await bakeShot(c), sb = await bakeShot(stock);
    for (const f of [27, 30, 42, 53, 54, 73]) {
      assert.deepEqual(await frameRaw(c, b, f, opts), await frameRaw(stock, sb, f, opts), 'exact through a move and return');
    }
    for (const f of [13, 96]) {
      assert.notDeepEqual(await frameRaw(c, b, f, opts), await frameRaw(stock, sb, f, opts), 'the holds are sampled');
    }
  }
});

test('a cold still captures only the last anchor, and a pair survives a boundary seek', async () => {
  const c = compileShot(scene(schedule)), b = await bakeShot(c);
  const requests: number[] = [];
  const image = new ImageData(1, 1);
  const get = (f: number) => sampledFrame(c, b, f, opts, (_, frame) => { requests.push(frame); return image; });
  get(119);
  assert.deepEqual(requests, [119]);
  get(96); get(74); get(51); get(26);
  assert.deepEqual(requests, [119, 74, 26]);
  assert.equal(get(26).live.activeNodes?.length, c.nodes.length - 1);
});

test('encoded chunk input agrees with cold stills across an anchor on CPU and GPU', { skip: !ffmpegAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-backdrop-'));
  try {
    for (const gpu of [false, true]) {
      if (gpu && rendererInfo(true).renderer !== 'GPU') continue;
      const opts = { width: 240, lang: 'en', gpu };
      const reference: string[] = [];
      for (let f = 24; f < 29; f++) {
        const c = compileShot(scene(schedule));
        const raw = await frameRaw(c, await bakeShot(c), f, opts);
        reference.push(`${f} ${createHash('sha256').update(raw).digest('hex')}`);
      }
      for (const from of [24, 26, 27]) {
        const c = compileShot(scene(schedule));
        const out = join(dir, `chunk-${gpu}-${from}.mp4`);
        const hashesFile = `${out}.txt`;
        await renderChunk(c, await bakeShot(c), { ...opts, encoder: 'x264', from, to: 29, out, hashesFile });
        assert.deepEqual(readFileSync(hashesFile, 'utf8').trim().split(/\r?\n/), reference.slice(from - 24));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('an invalid schedule or a group with external compositing or node dependencies is refused', () => {
  for (const frames of [[3, 2], [5, 5], [-1], [120], [0.5], [NaN]]) {
    assert.throws(() => compileShot(scene({ group: 'terrain', frames })), /strictly increasing integers/);
  }
  assert.throws(() => compileShot(scene({ group: 'tile', frames: [] })), /top-level group/);
  for (const option of [{ glow: 0.3 }, { cover: true }, { clipTo: 'under' }]) {
    const tile = rect({ id: 'tile', fill: 'mid.mist', w: 100, h: 100, ...option });
    assert.throws(() => compileShot(scene(schedule, [], false, [nodes[0]!, group({ id: 'terrain', children: [tile] })])),
      /glow, a pulse, a cover or heat haze|reference across/);
  }
  assert.throws(() => compileShot(scene(schedule, [], false, [...nodes,
    rect({ id: 'live', fill: 'mid.mist', w: 100, h: 100, clipTo: 'tile' })])), /reference across/);
});

test('a sampled group keeps moving halos live through a clip and a foreground cover', async () => {
  const base = rect({ id: 'tile', fill: 'mid.mist', w: 20, h: 20, opacity: 0 });
  const clip = rect({ id: 'mask', fill: 'mid.mist', w: 1000, h: 500, opacity: 0 });
  const front = rect({ id: 'front', at: [400, 10], fill: 'dark.indigo', w: 70, h: 170, cover: true });
  const move = drive('lamp', { dur: 1.99, samples: { at: [[-320, 0], [320, 0], [-320, 0]] } });
  const render = async (sampled: boolean, glow: number, f: number) => {
    const lamp = rect({ id: 'lamp', fill: 'accent.amber', w: 60, h: 60, glow, lit: false, clipTo: 'mask' });
    const contents = [group({ id: 'terrain', opacity: 0.7, children: [base, clip, lamp] }), front];
    const option = sampled ? { group: 'terrain', frames: [], liveGlow: true } : undefined;
    const c = compileShot(scene(option, [move], false, contents));
    return frameRaw(c, await bakeShot(c), f, opts);
  };
  const stock = await render(false, 1, 60), sampled = await render(true, 1, 60), dark = await render(true, 0, 60);
  // This box surrounds the lamp at its live midpoint. Its body appears at the other end of the stage in the sampled picture.
  let light = 0, maximumError = 0;
  for (let y = 52; y <= 80; y++) for (let x = 149; x <= 176; x++) {
    if (x >= 155 && x <= 165 && y >= 61 && y <= 74) continue;
    const offset = (y * opts.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const i = offset + channel;
      light += Math.max(0, sampled[i]! - dark[i]!);
      maximumError = Math.max(maximumError, Math.abs(sampled[i]! - stock[i]!));
    }
  }
  assert.ok(light > 1000, `the live midpoint contributes ${light} light levels`);
  assert.ok(maximumError <= 2, `the visible halo and cover have at most two levels of rounding (${maximumError})`);
  const anchor = await render(true, 1, 0), native = await render(false, 1, 0);
  const maximum = anchor.reduce((worst, value, i) => Math.max(worst, Math.abs(value - native[i]!)), 0);
  assert.ok(maximum <= 2, `the concrete body is painted once at its anchor (${maximum})`);
  assert.throws(() => compileShot(scene({ ...schedule, liveGlow: 1 } as never)), /liveGlow must be a boolean/);
});

test('the halo-only evaluation keeps original clip and parent indices, and soft masks use the full view', () => {
  for (const soft of [undefined, 12]) {
    const mask = rect({ id: 'mask', fill: 'mid.mist', w: 100, h: 100, soft });
    const lamp = rect({ id: 'lamp', fill: 'accent.amber', w: 40, h: 40, glow: 1, clipTo: 'mask' });
    const contents = [group({ id: 'terrain', children: [land('tile', -70, 'accent.aqua'), mask, lamp] })];
    const c = compileShot(scene({ ...schedule, liveGlow: true }, [], false, contents));
    const view = glowView(c, c.sampledBackdrops![0]!);
    if (soft) assert.equal(view, c);
    else {
      assert.deepEqual(view.activeNodes?.map(n => n.id), ['terrain', 'mask', 'lamp']);
      assert.equal(view.nodes[view.byId.get('lamp')!.clipIndex], c.byId.get('mask'));
    }
  }
});

test('a glowing shape follows the live clip geometry of a moving sibling subtree', async () => {
  const mask = rect({ id: 'mask', fill: 'mid.mist', w: 120, h: 90, at: [20, 0], opacity: 0 });
  const holder = group({ id: 'carrier', children: [mask] });
  const lamp = rect({ id: 'lamp', fill: 'accent.amber', w: 300, h: 120, glow: 1, clipTo: 'mask' });
  const contents = [group({ id: 'terrain', children: [land('tile', 0, 'accent.aqua'), holder, lamp] })];
  const move = drive('carrier', { dur: 1.99, samples: { at: [[-100, 0], [100, 0], [-100, 0]] } });
  const c = compileShot(scene({ ...schedule, liveGlow: true }, [move], false, contents));
  const view = glowView(c, c.sampledBackdrops![0]!);
  assert.notEqual(view, c);
  assert.deepEqual(view.activeNodes?.map(n => n.id), ['terrain', 'carrier', 'mask', 'lamp']);
  const bake = await bakeShot(c);
  const clipForLamp = (items: readonly Item[]) => {
    const clip = items.find(item => item.kind === 'clip' && item.node.id === 'mask');
    assert.ok(clip?.kind === 'clip');
    assert.ok(clip.items.some(item => item.node.id === 'lamp'));
    return clip;
  };
  const positions: number[] = [];
  for (const f of [0, 25, 60, 95, 119]) {
    const expected = clipForLamp(evaluate(c, bake, f, 'en').layers[0]!.items);
    const actual = clipForLamp(evaluate(view, bake, f, 'en').layers[0]!.items);
    assert.deepEqual(actual, expected);
    positions.push(actual.xf.x);
  }
  assert.ok(Math.max(...positions) - Math.min(...positions) > 190);
});

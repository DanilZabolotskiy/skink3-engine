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
import { sampledFrame } from '../src/render/backdrop.ts';
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

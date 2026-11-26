import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  defaultTint,
  emitter,
  evaluate,
  fadeTo,
  flatItems,
  frameRaw,
  group,
  heightFor,
  label,
  layer,
  link,
  moveTo,
  popIn,
  popOut,
  pulse,
  rect,
  scaleTo,
  shot,
  type Item,
  type Key,
  type LayerSpec,
} from '../src/index.ts';
import { atmosphereTone, hexToHsv, hsv, lightness, parseHex } from '../src/look/color.ts';
import { buildOpacityTrack, buildScaleTrack, sampleOpacity, sampleScale } from '../src/motion/tracks.ts';

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extraLayers: LayerSpec[] = []): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 3,
    seed: 1,
    palette,
    strings: { en: { 'label.a': 'A' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [...extraLayers, layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

test('scaleTo: lasting, overshoots and settles, chains from wherever the scale is', () => {
  const t = buildScaleTrack('a', [], [], [], [scaleTo('a', { at: 1, to: 2, dur: 1, overshoot: 0.2 }), scaleTo('a', { at: 3, to: 0.5, dur: 1, overshoot: 0.2 })]);
  assert.equal(sampleScale(t, 0.5), 1);
  assert.equal(sampleScale(t, 2), 2);
  assert.equal(sampleScale(t, 2.99), 2, 'it lasts');
  assert.equal(sampleScale(t, 9), 0.5);
  let peak = 0;
  let low = Infinity;
  let prev = 1;
  let maxStep = 0;
  for (let i = 0; i <= 3000; i++) {
    const v = sampleScale(t, 1 + i / 1000);
    assert.ok(v > 0, 'a size never passes through zero');
    peak = Math.max(peak, v);
    low = Math.min(low, v);
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(peak > 2.2 && peak < 2.4, `grows past the new size (${peak})`);
  // Sizes change as ratios: from 2 to 0.5 with 20 % overshoot bottoms out at 2 * 0.25 ** 1.2.
  assert.ok(Math.abs(low - 2 * 0.25 ** 1.2) < 0.01, `shrinks past the new size (${low})`);
  assert.ok(maxStep < 0.01, 'continuous');

  // A scaleTo that starts while another is under way takes over from the size reached.
  const cut = buildScaleTrack('a', [], [], [], [scaleTo('a', { at: 1, to: 3, dur: 2, overshoot: 0 }), scaleTo('a', { at: 1.5, to: 1, dur: 1, overshoot: 0 })]);
  const before = sampleScale(cut, 1.4999);
  assert.ok(before > 1.2 && before < 3);
  assert.ok(Math.abs(sampleScale(cut, 1.5001) - before) < 0.01, 'no jump at the hand-over');
  assert.equal(sampleScale(cut, 3), 1);
});

test('scaleTo composes with popIn, popOut and bump', () => {
  const t = buildScaleTrack(
    'a',
    [popIn('a', { at: 0.5, dur: 0.5 })],
    [popOut('a', { at: 4, dur: 0.5 })],
    [{ at: 2.5, amount: 0.2 }],
    [scaleTo('a', { at: 1.5, to: 1.5, dur: 0.5 })],
  );
  assert.equal(sampleScale(t, 0.2), 0, 'hidden before the popIn');
  assert.equal(sampleScale(t, 1.2), 1);
  assert.equal(sampleScale(t, 2.4), 1.5);
  const bumped = sampleScale(t, 2.56);
  assert.ok(bumped > 1.5 * 1.15 && bumped < 1.5 * 1.22, `the bump multiplies the grown size (${bumped})`);
  assert.equal(sampleScale(t, 3.5), 1.5);
  assert.equal(sampleScale(t, 5), 0, 'popOut still hides it');
});

test('a pulse that arrives bumps a node that has been scaled', () => {
  const s = make(
    [
      link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze' }),
      circle({ id: 'a', r: 30, at: [-200, 0], fill: 'accent.amber' }),
      circle({ id: 'b', r: 30, at: [200, 0], fill: 'accent.aqua' }),
    ],
    [scaleTo('b', { at: 0.2, to: 1.4, dur: 0.4 }), pulse('l', { at: 1, dur: 0.5, bump: 0.2 })],
  );
  const c = compileShot(s);
  const track = c.byId.get('b')!.scale!;
  assert.equal(sampleScale(track, 1.4), 1.4);
  assert.ok(sampleScale(track, 1.56) > 1.4 * 1.15, 'the arrival bump plays on top of the new size');
  assert.equal(sampleScale(track, 2.5), 1.4);
});

test('fadeTo: chains from the opacity reached, stays within 0..1', () => {
  const t = buildOpacityTrack(0.2, [fadeTo('a', { at: 1, to: 1, dur: 1 }), fadeTo('a', { at: 3, to: 0, dur: 0.5 })]);
  assert.equal(sampleOpacity(t, 0), 0.2);
  assert.ok(Math.abs(sampleOpacity(t, 1.5) - 0.6) < 1e-9);
  assert.equal(sampleOpacity(t, 2.5), 1);
  assert.equal(sampleOpacity(t, 4), 0);
  for (let i = 0; i <= 400; i++) {
    const v = sampleOpacity(t, i / 100);
    assert.ok(v >= 0 && v <= 1);
  }
  const cut = buildOpacityTrack(0, [fadeTo('a', { at: 0, to: 1, dur: 2 }), fadeTo('a', { at: 1, to: 0, dur: 1 })]);
  assert.ok(Math.abs(sampleOpacity(cut, 0.9999) - sampleOpacity(cut, 1.0001)) < 0.01);
  assert.equal(sampleOpacity(cut, 2.5), 0);
});

test('scaleTo and fadeTo are validated', () => {
  const a = (): ReturnType<typeof circle> => circle({ id: 'a', r: 20, fill: 'accent.amber' });
  assert.throws(() => scaleTo('a', { at: 1, to: 0 }), /to must be/);
  assert.throws(() => fadeTo('a', { at: 1, to: 1.5 }), /to must be/);
  assert.throws(() => make([a()], [scaleTo('zz', { at: 1, to: 2 })]), /targets "zz", which does not exist/);
  assert.throws(
    () => make([rect({ id: 'b', w: 40, h: 40, fill: 'mid.violet', body: { kind: 'fixed' } })], [scaleTo('b', { at: 1, to: 2 })]),
    /size of a rigid body is fixed/,
  );
  // An emitter has no size to scale; it fades its particles as one picture (test/emitter-fade.test.ts).
  assert.throws(
    () => make([emitter({ id: 'e', rate: 5, colors: ['accent.aqua'], size: 3, life: 1 })], [scaleTo('e', { at: 1, to: 2 })]),
    /scaleTo cannot target emitter "e"/,
  );
  assert.throws(() => make([a(), link({ id: 'l', from: 'a', to: 'a2', color: 'dark.haze' }), circle({ id: 'a2', r: 5, fill: 'accent.aqua' })], [scaleTo('l', { at: 1, to: 2 })]), /scaleTo cannot target link "l"/);
  // Links and labels can fade; a rigid body can fade too (only its size is fixed).
  assert.doesNotThrow(() =>
    make(
      [
        link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze', opacity: 0.5 }),
        a(),
        rect({ id: 'b', w: 40, h: 40, at: [200, 0], fill: 'mid.violet', body: { kind: 'fixed' } }),
        label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', opacity: 0 }),
      ],
      [fadeTo('l', { at: 1, to: 1 }), fadeTo('b', { at: 1, to: 0.3 }), fadeTo('la', { at: 1, to: 1 }), scaleTo('la', { at: 1, to: 1.2 })],
    ),
  );
});

test('opacity combines down the tree: groups nest, alpha multiplies, links follow their nodes', async () => {
  const s = make(
    [
      link({ id: 'l', from: 'p', to: 'q', color: 'dark.haze' }),
      group({
        id: 'p',
        at: [-200, 0],
        opacity: 0.5,
        children: [
          circle({ id: 'body', r: 60, fill: 'mid.jade' }),
          circle({ id: 'spot', r: 20, at: [10, 0], fill: 'accent.pink', opacity: 0.5 }),
          circle({ id: 'gone', r: 20, at: [0, 30], fill: 'accent.aqua', opacity: 0, children: [circle({ id: 'gone-child', r: 5, fill: 'light.cream' })] }),
        ],
      }),
      circle({ id: 'q', r: 30, at: [200, 0], fill: 'accent.amber' }),
    ],
    [fadeTo('q', { at: 1, to: 0, dur: 1 })],
  );
  const c = compileShot(s);
  const bake = await bakeShot(c);
  const shape = (items: readonly Item[]): string[] =>
    items.map((i) => (i.kind === 'group' ? `${i.node.id}@${i.opacity}[${shape(i.items).join(' ')}]` : i.node.id));
  const at0 = evaluate(c, bake, 0, 'en').layers[0]!.items;
  // The link takes the fainter of its two nodes (0.5); the group holds its subtree; an invisible node takes its children with it.
  assert.deepEqual(shape(at0), ['l@0.5[l]', 'p@0.5[body spot@0.5[spot]]', 'q']);
  const leaves = flatItems(at0);
  const alpha = (id: string): number => {
    const leaf = leaves.find((i) => i.node.id === id);
    return leaf && 'alpha' in leaf ? leaf.alpha : NaN;
  };
  assert.equal(alpha('body'), 0.5);
  assert.equal(alpha('spot'), 0.25, 'opacity multiplies down the tree');
  assert.equal(alpha('q'), 1);
  assert.equal(alpha('l'), 0.5);
  // Half-way through q's fade the link fades with it; once q is gone, so is the link.
  const mid = flatItems(evaluate(c, bake, 90, 'en').layers[0]!.items);
  const linkMid = mid.find((i) => i.node.id === 'l');
  assert.ok(linkMid && 'alpha' in linkMid && Math.abs(linkMid.alpha - 0.5) < 1e-9);
  const end = flatItems(evaluate(c, bake, 150, 'en').layers[0]!.items).map((i) => i.node.id);
  assert.deepEqual(end, ['body', 'spot']);
});

test('render: a faded node fades as one picture, with its light, children and glow', async () => {
  const width = 480;
  const scene = (opacity: number, glow: number): ReturnType<typeof shot> =>
    make([
      group({
        id: 'g',
        opacity,
        children: [
          circle({ id: 'body', r: 150, fill: 'accent.aqua', glow }),
          // A child that overlaps its parent: it must not show the parent through itself.
          circle({ id: 'spot', r: 70, at: [40, 0], fill: 'accent.coral' }),
        ],
      }),
    ]);
  const raw = async (opacity: number, glow: number): Promise<Buffer> => {
    const c = compileShot(scene(opacity, glow));
    return frameRaw(c, await bakeShot(c), 30, { width, lang: 'en', gpu: false });
  };
  const px = (buf: Buffer, x: number, y: number): number[] => {
    const o = (Math.round(y) * width + Math.round(x)) * 4;
    return [buf[o]!, buf[o + 1]!, buf[o + 2]!];
  };
  const k = width / 1920;
  const at = (sx: number, sy: number): [number, number] => [(960 + sx) * k, (540 + sy) * k];

  const [full, half, none] = [await raw(1, 0), await raw(0.5, 0), await raw(0, 0)];
  // Lit body, shadow crescent of the body, the overlapping child, and plain background.
  for (const [sx, sy] of [[-80, -40], [95, 95], [40, 0], [60, 20], [400, 300]] as const) {
    const [x, y] = at(sx, sy);
    const a = px(full, x, y);
    const b = px(none, x, y);
    const h = px(half, x, y);
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(Math.abs(h[ch]! - (a[ch]! + b[ch]!) / 2) <= 2, `at ${sx},${sy} channel ${ch}: ${h[ch]} is the mean of ${a[ch]} and ${b[ch]}`);
    }
  }
  // The child is opaque inside the group: at full opacity it is its own colour, not a blend with the body.
  const child = px(full, ...at(40, 0));
  assert.ok(child[0]! > 200 && child[2]! < 120, `the child covers its parent (${child})`);

  // Glow: the halo outside the shape and the lift of the background fade with the node.
  const [glowFull, glowHalf] = [await raw(1, 1), await raw(0.5, 1)];
  const [hx, hy] = at(-175, 0);
  const lift = (buf: Buffer): number => px(buf, hx, hy)[1]! - px(none, hx, hy)[1]!;
  assert.ok(lift(glowFull) > 12, `a halo is there (${lift(glowFull)})`);
  assert.ok(Math.abs(lift(glowHalf) - lift(glowFull) / 2) <= 3, `half the opacity, half the halo (${lift(glowHalf)} vs ${lift(glowFull)})`);
});

test('atmospheric perspective: far layers are paler, less saturated and close to one tone', async () => {
  assert.equal(defaultTint(0), 0);
  assert.equal(defaultTint(-0.5), 0);
  assert.ok(Math.abs(defaultTint(1) - 0.55) < 0.01);
  assert.ok(defaultTint(2) > defaultTint(1) && defaultTint(50) <= 0.9);

  const atmosphere = hsv(250, 0.46, 0.74);
  const colours = [hsv(176, 0.72, 0.93), hsv(324, 0.72, 0.76), hsv(40, 0.86, 0.99), hsv(258, 0.8, 0.5)];
  assert.equal(atmosphereTone(colours[0]!, atmosphere, 0), colours[0]);
  assert.equal(atmosphereTone(colours[0]!, atmosphere, 1), atmosphere);
  const spread = (list: string[]): number => {
    const hs = list.map((c) => hexToHsv(c));
    return Math.max(...hs.map((c) => c.v * c.s)) - Math.min(...hs.map((c) => c.v * c.s));
  };
  const distance = (a: string, b: string): number => {
    const [x, y] = [parseHex(a), parseHex(b)];
    return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
  };
  const far = colours.map((c) => atmosphereTone(c, atmosphere, 0.55));
  assert.ok(lightness(atmosphereTone(hsv(258, 0.8, 0.5), atmosphere, 0.55)) > lightness(hsv(258, 0.8, 0.5)) + 10, 'a dark colour gets lighter with distance');
  for (let i = 0; i < colours.length; i++) {
    const before = hexToHsv(colours[i]!);
    const after = hexToHsv(far[i]!);
    if (before.s > 0.5) assert.ok(after.s < before.s - 0.15, `less saturated (${before.s} -> ${after.s})`);
    assert.ok(after.s >= 0.4, `but never gray (${after.s})`);
    assert.ok(distance(far[i]!, atmosphere) < distance(colours[i]!, atmosphere) * 0.6, 'closer to the atmosphere colour');
  }
  assert.ok(spread(far) < spread(colours) * 0.6, 'closer to one tone');

  // In a render: the same shape on a far layer is paler than on the focus plane.
  const width = 480;
  const farLayer = layer({ id: 'far', depth: 1, blur: 0, parallax: 1, nodes: [circle({ id: 'f', r: 150, at: [-300, 0], fill: 'accent.coral', lit: false })] });
  const c = compileShot(make([circle({ id: 'n', r: 150, at: [300, 0], fill: 'accent.coral', lit: false })], [], [farLayer]));
  const raw = await frameRaw(c, await bakeShot(c), 0, { width, lang: 'en', gpu: false });
  const px = (sx: number): { r: number; g: number; b: number } => {
    const o = (Math.round((heightFor(width) / 2)) * width + Math.round((960 + sx) * (width / 1920))) * 4;
    return { r: raw[o]!, g: raw[o + 1]!, b: raw[o + 2]! };
  };
  const sat = (p: { r: number; g: number; b: number }): number => (Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)) / Math.max(p.r, p.g, p.b);
  assert.ok(sat(px(-300)) < sat(px(300)) - 0.2, `the far one is paler (${sat(px(-300))} vs ${sat(px(300))})`);
});

test('pulses are tapered: bright and wide at the head, fading toward the tail', async () => {
  const width = 960;
  const s = make(
    [
      link({ id: 'l', from: 'a', to: 'b', color: 'dark.navy', pulseColor: 'light.cream', bend: 0, width: 16, gap: 0 }),
      circle({ id: 'a', r: 20, at: [-700, 0], fill: 'dark.indigo', lit: false }),
      circle({ id: 'b', r: 20, at: [700, 0], fill: 'dark.indigo', lit: false }),
    ],
    [pulse('l', { at: 0, dur: 2, bump: 0 }), moveTo('a', { at: 2.5, to: [-700, 0], dur: 0.2 })],
  );
  const c = compileShot(s);
  const bake = await bakeShot(c);
  const state = evaluate(c, bake, 60, 'en');
  const item = flatItems(state.layers[0]!.items).find((i) => i.kind === 'link');
  assert.ok(item && item.kind === 'link' && item.pulses.length === 1);
  const { head, tail } = item.pulses[0]!;
  assert.ok(head > tail && tail > 0);
  const raw = await frameRaw(c, bake, 60, { width, lang: 'en', gpu: false });
  const k = width / 1920;
  const x0 = -680;
  const x1 = 680;
  const lum = (u: number, dy: number): number => {
    const x = Math.round((960 + x0 + (x1 - x0) * u) * k);
    const y = Math.round((540 + dy) * k);
    const o = (y * width + x) * 4;
    return raw[o]! + raw[o + 1]! + raw[o + 2]!;
  };
  const span = head - tail;
  const nearHead = lum(head - span * 0.1, 0);
  const middle = lum(head - span * 0.5, 0);
  const nearTail = lum(tail + span * 0.08, 0);
  const plain = lum(tail - 0.05, 0);
  assert.ok(nearHead > middle + 60 && middle > nearTail + 40, `brightness falls from head to tail (${nearHead}, ${middle}, ${nearTail})`);
  assert.ok(nearTail - plain < 90, `the tail fades into the link (${nearTail} vs ${plain})`);
  // Wider at the head than at the tail: off the centre line the body is lit near the head only.
  assert.ok(lum(head - span * 0.1, 9) > lum(tail + span * 0.15, 9) + 60, 'the body narrows toward the tail');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  cameraTo,
  checkTextFit,
  circle,
  compileShot,
  evaluate,
  fadeTo,
  flatItems,
  frameRaw,
  group,
  heightFor,
  label,
  layer,
  moveTo,
  popIn,
  rect,
  reviewMotion,
  SceneError,
  sceneEvents,
  shot,
  text,
  turnTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// Free-standing text: a title, a caption, words on a card. No pointer.

const WIDTH = 960;
const STRINGS = {
  en: { 'title.main': 'Title', 'note.long': 'A much longer line of words that has to wrap somewhere', 'word.a': 'Alpha', 'label.a': 'A label' },
  'x-long': { 'title.main': 'A considerably longer title', 'note.long': 'An even longer line of words that certainly has to wrap in more than one place', 'word.a': 'Alphabetical', 'label.a': 'A longer label' },
};

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: LayerSpec[] = [], seconds = 3): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: STRINGS,
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes }), ...extra],
    timeline,
  });
}

/** The box, in stage units, round the pixels of a colour that is bright in one channel: the ink of a text, or its box. */
async function inkBox(spec: ShotSpec, frame = 0, lang = 'en', bright: (r: number, g: number, b: number) => boolean = (r, g, b) => r > 200 && g > 200 && b > 120): Promise<{ x0: number; y0: number; x1: number; y1: number; n: number }> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang, gpu: false });
  const h = heightFor(WIDTH);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4;
      if (!bright(raw[o]!, raw[o + 1]!, raw[o + 2]!)) continue;
      n++;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const k = 1920 / WIDTH;
  return { x0: x0 * k - 960, y0: y0 * k - 540, x1: (x1 + 1) * k - 960, y1: (y1 + 1) * k - 540, n };
}

async function itemOf(spec: ShotSpec, seconds: number, id: string, lang = 'en') {
  const c = compileShot(spec);
  const state = evaluate(c, await bakeShot(c), Math.round(seconds * 60), lang);
  for (const l of state.layers) {
    const hit = flatItems(l.items).find((i) => i.kind === 'text' && i.node.id === id);
    if (hit && hit.kind === 'text') return { item: hit, view: l.view };
  }
  return undefined;
}

const T = { id: 't', text: 'title.main', ink: 'light.cream' } as const;

test('text: a block of lines from a string key, with the defaults of a label and no pointer', async () => {
  const node = text(T);
  assert.deepEqual(
    [node.type, node.text, node.size, node.minSize, node.maxWidth, node.maxLines, node.weight, node.align, node.box, node.opacity, node.at, node.rotation, node.scale],
    ['text', 'title.main', 38, 24, 600, 3, 800, 'center', null, 1, [0, 0], 0, 1],
  );
  assert.deepEqual([node.clipTo, node.sound], [undefined, undefined]);
  // It is drawn: ink round its place, as high as its capitals.
  const box = await inkBox(make([text({ ...T, at: [100, -200], size: 80 })]));
  assert.ok(box.n > 200 && Math.abs((box.x0 + box.x1) / 2 - 100) < 6 && Math.abs((box.y0 + box.y1) / 2 + 200) < 8, JSON.stringify(box));
  assert.ok(box.y1 - box.y0 > 50 && box.y1 - box.y0 < 80, `${box.y1 - box.y0} units high`);
  // The string of the language that is rendered: a longer one is wider.
  const long = await inkBox(make([text({ ...T, at: [100, -200], size: 80, maxWidth: 1600 })]), 0, 'x-long');
  assert.ok(long.x1 - long.x0 > 2 * (box.x1 - box.x0));

  // A long string wraps, balances, and shrinks when it has to, as in a label.
  const wrapped = (await itemOf(make([text({ id: 't', text: 'note.long', ink: 'light.cream', maxWidth: 400 })]), 0, 't'))!.item;
  assert.ok(wrapped.layout.lines.length === 3 && wrapped.layout.size === 38 && !wrapped.layout.overflow, `${wrapped.layout.lines.length} lines at ${wrapped.layout.size}`);
  const shrunk = (await itemOf(make([text({ id: 't', text: 'note.long', ink: 'light.cream', maxWidth: 400, maxLines: 2 })]), 0, 't'))!.item;
  assert.ok(shrunk.layout.lines.length === 2 && shrunk.layout.size < 38 && !shrunk.layout.overflow);
  // The weight of the letters shows: bolder letters cover more.
  const light = await inkBox(make([text({ ...T, size: 120, weight: 300 })]));
  const heavy = await inkBox(make([text({ ...T, size: 120, weight: 900 })]));
  assert.ok(heavy.n > light.n * 1.3, `${heavy.n} against ${light.n}`);
});

test('text: align sets where its place is in the block; a box lies round the lines', async () => {
  const at = async (align: 'left' | 'center' | 'right'): Promise<{ x0: number; x1: number }> => inkBox(make([text({ ...T, at: [100, 0], size: 80, align })]));
  const [left, center, right] = [await at('left'), await at('center'), await at('right')];
  assert.ok(Math.abs(left.x0 - 100) < 10, `the lines start at its place: ${left.x0}`);
  assert.ok(Math.abs((center.x0 + center.x1) / 2 - 100) < 6);
  assert.ok(Math.abs(right.x1 - 100) < 10, `the lines end at its place: ${right.x1}`);
  // Two lines of different length: set to the left they start together, to the right they end together.
  const lines = async (align: 'left' | 'right') => (await itemOf(make([text({ id: 't', text: 'note.long', ink: 'light.cream', maxWidth: 420, align })]), 0, 't'))!.item;
  const l = await lines('left');
  const widths = l.layout.widths;
  assert.ok(Math.max(...widths) - Math.min(...widths) > 5, 'lines of different length');
  assert.ok(l.block.lines.every((line, i) => Math.abs(line.x - widths[i]! / 2) < 1e-9));
  const r = await lines('right');
  assert.ok(r.block.lines.every((line, i) => Math.abs(line.x + widths[i]! / 2) < 1e-9));
  // Up and down the block is centred on its place.
  assert.ok(Math.abs(l.block.box.y + l.block.box.h / 2) < 1e-9);

  // A box: a rounded field of its colour round the lines, wider than they are.
  const pink = (r0: number, g: number, b: number): boolean => r0 > 200 && g < 140 && b > 120;
  const boxed = make([text({ ...T, at: [100, 0], size: 80, box: 'accent.pink', ink: 'deep.abyss' })]);
  const field = await inkBox(boxed, 0, 'en', pink);
  const plain = (await itemOf(make([text({ ...T, at: [100, 0], size: 80 })]), 0, 't'))!.item.block.box;
  const inBox = (await itemOf(boxed, 0, 't'))!.item.block;
  assert.ok(inBox.path !== null && inBox.box.w > plain.w + 80 && inBox.box.h > plain.h + 50);
  assert.ok(Math.abs(field.x1 - field.x0 - inBox.box.w) < 6 && Math.abs(field.y1 - field.y0 - inBox.box.h) < 6, `${field.x1 - field.x0} x ${field.y1 - field.y0}`);
  assert.ok(Math.abs((field.x0 + field.x1) / 2 - 100) < 6 && Math.abs((field.y0 + field.y1) / 2) < 6);
});

test('text: it is placed like a shape: on a shape it moves, turns and grows with it; in a layer without parallax it belongs to the frame', async () => {
  // A word on a card: the card's place, turn and size are the word's.
  const card = make([rect({ id: 'card', at: [200, 100], w: 300, h: 200, rotation: 90, scale: 2, fill: 'dark.indigo', children: [text({ id: 't', text: 'word.a', ink: 'light.cream', at: [0, 20] })] })]);
  const onCard = (await itemOf(card, 0, 't'))!.item;
  assert.deepEqual([Math.round(onCard.xf.x), Math.round(onCard.xf.y), Math.round((onCard.xf.rot * 180) / Math.PI), onCard.xf.scale], [160, 100, 90, 2]);
  // Turned a quarter, its ink is higher than it is wide.
  const upright = await inkBox(make([text({ ...T, size: 100 })]));
  const turned = await inkBox(make([text({ ...T, size: 100, rotation: 90 })]));
  assert.ok(upright.x1 - upright.x0 > upright.y1 - upright.y0 && turned.y1 - turned.y0 > turned.x1 - turned.x0);
  // It takes the intents of a placed node.
  const moved = make([text(T)], [popIn('t', { at: 0.5 }), moveTo('t', { at: 1, to: [300, 0], dur: 0.5, profile: 'ease' }), turnTo('t', { at: 1.5, to: 45, dur: 0.5, overshoot: 0 }), fadeTo('t', { at: 2, to: 0.5, dur: 0.5 })]);
  assert.equal(await itemOf(moved, 0.2, 't'), undefined, 'hidden before it pops in');
  const last = (await itemOf(moved, 2.9, 't'))!.item;
  assert.deepEqual([last.xf.x, Math.round((last.xf.rot * 180) / Math.PI), last.alpha, last.grown], [300, 45, 0.5, 1]);
  // In a group, and with a group.
  const grouped = make([group({ id: 'g', at: [-100, 0], children: [text({ ...T, at: [50, 0] })] })], [moveTo('g', { at: 0, to: [100, 0], dur: 1, profile: 'ease' })]);
  assert.equal((await itemOf(grouped, 2, 't'))!.item.xf.x, 150);

  // The frame's own layer: parallax 0. The camera zooms and moves the stage, and leaves the title where it is.
  const frame = layer({ id: 'frame', depth: 0, parallax: 0, nodes: [text({ id: 'title', text: 'title.main', ink: 'light.cream', at: [0, -400] })] });
  const zoomed = make([circle({ id: 'dot', r: 40, fill: 'accent.aqua' })], [cameraTo({ at: 0.5, zoom: 3, to: [200, 100], dur: 1 })], [frame]);
  const before = (await itemOf(zoomed, 0, 'title'))!;
  const after = (await itemOf(zoomed, 2, 'title'))!;
  assert.deepEqual(after.view, before.view);
  assert.deepEqual(after.view, { zoom: 1, tx: 960, ty: 540 });
  const c = compileShot(zoomed);
  assert.equal(evaluate(c, await bakeShot(c), 120, 'en').layers[0]!.view.zoom, 3, 'while the stage is three times as large');
});

test('text: the text-fit check holds it: a string that does not fit, a text off the frame, two that overlap', async () => {
  const issues = async (nodes: LayerSpec['nodes'], timeline: Key[] = []): Promise<string[]> => {
    const c = compileShot(make(nodes, timeline));
    return checkTextFit(c, await bakeShot(c), ['en', 'x-long']).issues.map((i) => `${i.lang}:${i.kind}:${i.severity}`);
  };
  assert.deepEqual(await issues([text(T)]), [], 'a title in the middle of the frame is fine in both languages');
  // A string that does not fit its lines is an error, in the language it is too long in.
  const tight = await issues([text({ id: 't', text: 'note.long', ink: 'light.cream', maxWidth: 260, maxLines: 2, minSize: 30 })]);
  assert.ok(tight.includes('x-long:overflow:error'), tight.join(', '));
  // Off the frame while it is shown: an error. Turned, its upright box counts.
  assert.deepEqual(await issues([text({ ...T, at: [900, 0], align: 'left', size: 60 })]), ['en:off-frame:error', 'x-long:off-frame:error']);
  assert.deepEqual(await issues([text({ ...T, at: [0, 430], size: 60, rotation: 90, maxWidth: 1600 })]), ['x-long:off-frame:error']);
  assert.deepEqual(await issues([text({ ...T, at: [1500, 0] })], [popIn('t', { at: 2.9 })]), [], 'not while it is hidden');
  // Two texts on each other, or a text on a label: an error.
  assert.deepEqual(await issues([text(T), text({ id: 'u', text: 'word.a', ink: 'light.cream', at: [10, 10] })]), ['en:overlap:error', 'x-long:overlap:error']);
  const pointed = [circle({ id: 'c', at: [0, 200], r: 30, fill: 'accent.aqua' }), label({ id: 'l', text: 'label.a', target: 'c', fill: 'light.cream', ink: 'deep.abyss' }), text({ id: 't', text: 'word.a', ink: 'light.cream', at: [0, 120] })];
  assert.deepEqual(await issues(pointed), ['en:overlap:error', 'x-long:overlap:error']);
  // Lying on a shape is what a text is for: no warning.
  assert.deepEqual(await issues([rect({ id: 'card', w: 500, h: 300, fill: 'dark.indigo', children: [text(T)] })]), []);
  const c = compileShot(make([text({ ...T, at: [900, 0], align: 'left', size: 60 })]));
  const messages = checkTextFit(c, await bakeShot(c), ['en']).issues.map((i) => i.message);
  assert.match(messages[0]!, /^text "t" \[en\]: leaves the frame by \d+ units at frame 0 \(0\.00 s\)$/);
  const stats = checkTextFit(c, await bakeShot(c), ['en']).stats;
  assert.deepEqual([stats[0]!.what, stats[0]!.label, stats[0]!.lines, stats[0]!.size], ['text', 't', 1, 60]);
});

test('text fit compares separate text layers and checks bake identity for a text-free shot', async () => {
  const spec = make([circle({ id: 'decoration', r: 40, fill: 'accent.aqua' })], [], [
    layer({ id: 'title', depth: 0, nodes: [text(T)] }),
    layer({ id: 'caption', depth: 0, nodes: [text({ ...T, id: 'u' })] }),
  ]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const fit = checkTextFit(c, bake, ['en']);
  assert.deepEqual(fit.issues.map((i) => [i.kind, i.message]), [['overlap', 'texts "t" and "u" [en]: overlap at frame 0 (0.00 s)']]);
  assert.deepEqual(fit.stats.map((s) => s.label), ['t', 'u']);
  const empty = compileShot(make([circle({ id: 'dot', r: 10, fill: 'accent.aqua' })]));
  assert.deepEqual(checkTextFit(empty, await bakeShot(empty), ['en']), { issues: [], stats: [] });
  assert.throws(() => checkTextFit(empty, bake, ['en']), /bake does not belong/);
});

test('text: what it refuses, and that it is opt-in', async () => {
  const bad = (make0: () => unknown, message: RegExp): void => {
    assert.throws(make0, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => text({ ...T, colour: 'light.cream' } as never), /text\("t"\): unknown option "colour" \(allowed: id, text, ink, at,/);
  bad(() => text({ ...T, text: 'Hello there' }), /text must be a string-table key such as "title.main", got "Hello there"\. On-screen text never appears in scene code/);
  bad(() => text({ ...T, ink: '#ffffff' as never }), /ink must be a palette reference/);
  bad(() => text({ ...T, align: 'middle' as never }), /align must be left, center or right, got "middle"/);
  bad(() => text({ ...T, weight: 50 }), /weight must be a number in 200\.\.1000/);
  bad(() => text({ ...T, target: 'c' } as never), /unknown option "target"/);
  bad(() => make([text({ ...T, text: 'title.none' })]), /text "t":.*title\.none/);
  bad(() => make([text({ ...T, box: 'accent.none' as never })]), /text "t" box/);
  assert.ok(SceneError);

  // A shot without a text has nothing of it in its data; the display list of a shot with one names it.
  const plain = make([circle({ id: 'c', r: 30, fill: 'accent.aqua' }), label({ id: 'l', text: 'label.a', target: 'c', fill: 'light.cream', ink: 'deep.abyss' })]);
  assert.ok(!JSON.stringify(plain).includes('"text","') && !JSON.stringify(plain).includes('align'));
  // Its popIn is the event of a label: a text appears.
  const c = compileShot(make([text({ ...T, sound: 'card' })], [popIn('t', { at: 0.5 })]));
  const events = sceneEvents(c, await bakeShot(c));
  assert.deepEqual(events.map((e) => [e.kind, e.node, e.key, e.frame, e.seen]), [['label', 't', 'card', 30, true]]);
  // The motion review knows a text as a node: one speed from rest to rest is found, an eased move is not.
  const flagged = async (profile: 'steady' | 'ease'): Promise<string[]> => {
    const cs = compileShot(make([text({ ...T, size: 60 })], [moveTo('t', { at: 0.5, to: [0, 300], dur: 1.5, profile, arc: 0 })]));
    return reviewMotion(cs, await bakeShot(cs)).report.findings.filter((f) => f.subject === 't').map((f) => f.kind);
  };
  assert.deepEqual(await flagged('ease'), []);
  assert.ok((await flagged('steady')).some((kind) => kind === 'mechanical' || kind === 'abrupt-start'), (await flagged('steady')).join(', '));
});

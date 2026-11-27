import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Path2D } from 'skia-canvas';
import { palette } from '../examples/demo/palette.ts';
import { DEG, vrot } from '../src/core/math.ts';
import { bakeShot, compileShot, evaluate, flatItems, frameRaw, heightFor, layer, rect, shot, type ShotSpec } from '../src/index.ts';
import { LIGHT_PROPORTIONS, lightVector, litParts } from '../src/look/light.ts';
import { capsuleShape, circleShape, rectShape, regionShape, shapeExtent, type ShapeSpec } from '../src/shape/geometry.ts';
import { CRESCENT_NUDGES, CRESCENT_TOLERANCE, crescentArea, crescentPath, crescentPaths, pathArea, shapePath, shiftPath, soundCrescent, subtractPath, withPathDifference } from '../src/shape/path.ts';
import { drawFrame } from '../src/render/frame.ts';

// A lit shape is shaded with crescents: the shape minus the shape shifted. The path difference of the drawing
// library is wrong at some offsets (it returns the whole shape, a part of it cut straight across, both outlines,
// or nothing), and a shape drawn with such a part flashes for a frame. Every crescent is therefore held against
// the area it must have, and taken again with the shift turned a little when it is not sound.

/** The four shifts of the lit parts of a shape, along the light: shadow, deep shadow, rim (the other way), rim light. */
function shiftsOf(spec: ShapeSpec): number[] {
  const size = shapeExtent(spec).inner;
  const P = LIGHT_PROPORTIONS;
  return [size * P.shadowShift, size * P.deepShadowShift, -size * P.rimShift, size * P.rimLightShift];
}

const PARTS = ['shadow', 'deepShadow', 'rim', 'rimLight'] as const;
const LIGHT = lightVector({ from: 'top-left' });
/** A card: what the defect was first seen on. */
const CARD = rectShape(240, 120, 12);

/** Every offset of a turning shape at which the path difference of the library is not the crescent, as "degrees part". */
function wrongOffsets(spec: ShapeSpec, from: number, to: number, step: number): { deg: number; part: number }[] {
  const base = shapePath(spec);
  const shifts = shiftsOf(spec);
  const out: { deg: number; part: number }[] = [];
  for (let k = Math.round(from / step); k * step <= to; k++) {
    const deg = k * step;
    const l = vrot(LIGHT, -deg * DEG);
    shifts.forEach((s, part) => {
      if (!soundCrescent(base, subtractPath(base, shiftPath(base, l[0] * s, l[1] * s)), l[0] * s, l[1] * s)) out.push({ deg, part });
    });
  }
  return out;
}

test('crescent: the area of a path, and the area a crescent must have, are worked out without a path operation', () => {
  const near = (a: number, b: number, share: number): boolean => Math.abs(a - b) <= share * b;
  // Areas: curves are measured in short straight steps.
  assert.ok(near(pathArea(shapePath(circleShape(50))), Math.PI * 2500, 0.005));
  assert.ok(near(pathArea(shapePath(rectShape(200, 80, 0))), 16000, 1e-9));
  assert.ok(near(pathArea(shapePath(capsuleShape(160, 20))), 120 * 40 + Math.PI * 400, 0.005));
  // Two outlines in one path count twice, whichever way each runs.
  const twice = shapePath(rectShape(200, 80, 0)).union(shiftPath(shapePath(rectShape(200, 80, 0)), 500, 0));
  assert.ok(near(pathArea(twice), 32000, 1e-9));

  // A rectangle minus itself moved along its long side is a strip as wide as the move; moved along a diagonal, an L.
  const box = shapePath(rectShape(200, 80, 0));
  assert.ok(near(crescentArea(box, 10, 0), 800, 0.01), `${crescentArea(box, 10, 0)}`);
  assert.ok(near(crescentArea(box, -10, 0), 800, 0.01));
  assert.ok(near(crescentArea(box, 6, 8), 6 * 80 + 8 * 200 - 48, 0.01), `${crescentArea(box, 6, 8)}`);
  // Moved by more than its own width, nothing is taken off.
  assert.ok(near(crescentArea(box, 500, 0), 16000, 0.01));
  // A circle: the lune that its own shifted copy leaves.
  const lune = (r: number, d: number): number => Math.PI * r * r - (2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d));
  assert.ok(near(crescentArea(shapePath(circleShape(50)), 15, 0), lune(50, 15), 0.01), `${crescentArea(shapePath(circleShape(50)), 15, 0)} against ${lune(50, 15)}`);
  // A concave outline: the notch gets a piece of its own. Moved down by 10, a strip under the top edge and one under each slope of the notch.
  const notch = shapePath(regionShape([[-200, -100], [200, -100], [200, 100], [40, 100], [0, 20], [-40, 100], [-200, 100]], 0));
  assert.ok(near(crescentArea(notch, 0, 10), 400 * 10, 0.01), `${crescentArea(notch, 0, 10)}`);
  assert.ok(near(crescentArea(notch, 0, -10), 320 * 10 + 80 * 10, 0.02), `${crescentArea(notch, 0, -10)}`);
  // No move, no crescent.
  assert.equal(crescentArea(box, 0, 0), 0);

  // A sound difference has the area that was worked out, to within a fraction of the tolerance.
  for (const spec of [CARD, circleShape(50), capsuleShape(160, 20), regionShape([[-200, -100], [200, -100], [200, 100], [40, 100], [0, 20], [-40, 100], [-200, 100]], 0)]) {
    const base = shapePath(spec);
    for (const deg of [0, 17, 45, 101, 180, 263]) {
      const l = vrot(LIGHT, -deg * DEG);
      for (const s of shiftsOf(spec)) {
        const part = subtractPath(base, shiftPath(base, l[0] * s, l[1] * s));
        const want = crescentArea(base, l[0] * s, l[1] * s);
        assert.ok(Math.abs(pathArea(part) - want) < 0.02 * want, `${spec.kind} at ${deg} deg, shift ${s}: ${pathArea(part)} against ${want}`);
      }
    }
  }
});

test('crescent: a card that turns passes offsets at which the path difference is wrong; its lit parts are sound at every one', () => {
  // The planted defect is the library's own: turned through half a circle in steps of a twentieth of a degree,
  // the card meets offsets at which the plain difference is not the crescent.
  const wrong = wrongOffsets(CARD, 0, 180, 0.05);
  assert.ok(wrong.length > 0, 'the path difference of the library is wrong at some offset of this sweep (if the library has been repaired, the check has nothing left to catch: say so here)');
  const base = shapePath(CARD);
  const shifts = shiftsOf(CARD);
  for (const { deg, part } of wrong) {
    const l = vrot(LIGHT, -deg * DEG);
    const s = shifts[part]!;
    const raw = subtractPath(base, shiftPath(base, l[0] * s, l[1] * s));
    const want = crescentArea(base, l[0] * s, l[1] * s);
    // A wrong one is not a little off: it is the whole card, a part of it, twice the card, or nothing.
    assert.ok(Math.abs(pathArea(raw) - want) > 0.25 * want, `${PARTS[part]} at ${deg} deg: ${pathArea(raw)} against ${want}`);
    // The lit parts of the shape at that offset: sound, and the size of the ones a step before and after.
    const parts = litParts(CARD, l);
    const got = parts[PARTS[part]!];
    assert.ok(soundCrescent(base, got, l[0] * s, l[1] * s), `${PARTS[part]} at ${deg} deg is repaired`);
    for (const side of [-0.05, 0.05]) {
      const n = vrot(LIGHT, -(deg + side) * DEG);
      const beside = crescentArea(base, n[0] * s, n[1] * s);
      assert.ok(Math.abs(pathArea(got) - beside) < 0.02 * beside, `${PARTS[part]} at ${deg} deg is the size of the one at ${deg + side} deg`);
    }
    // It lies where the crescent lies: in the card, and not in the shifted card.
    const b = base.bounds;
    let off = 0;
    let inCrescent = 0;
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 30; j++) {
        const x = b.left + ((i + 0.5) / 60) * b.width;
        const y = b.top + ((j + 0.5) / 30) * b.height;
        const want2 = base.contains(x, y) && !base.contains(x - l[0] * s, y - l[1] * s);
        if (want2) inCrescent++;
        if (got.contains(x, y) !== want2) off++;
      }
    }
    assert.ok(off <= Math.max(2, 0.1 * inCrescent), `${PARTS[part]} at ${deg} deg: ${off} of ${inCrescent} points of the crescent on the wrong side`);
  }
  // And through the whole sweep every part of the card is sound, the repaired ones and the others alike.
  for (let k = 0; k * 0.05 <= 180; k++) {
    const l = vrot(LIGHT, -k * 0.05 * DEG);
    const parts = crescentPaths(base, l[0], l[1], shifts);
    parts.forEach((p, i) => assert.ok(soundCrescent(base, p, l[0] * shifts[i]!, l[1] * shifts[i]!), `${PARTS[i]} at ${k * 0.05} deg`));
  }
});

test('crescent: a sound difference is returned as it is; a wrong one is never returned', () => {
  const base = shapePath(CARD);
  const shifts = shiftsOf(CARD);
  // Sound: the very path the plain difference gives, edge for edge.
  const l = vrot(LIGHT, -17 * DEG);
  for (const s of shifts) {
    assert.deepEqual(crescentPath(base, l[0] * s, l[1] * s).edges, subtractPath(base, shiftPath(base, l[0] * s, l[1] * s)).edges);
  }
  assert.deepEqual(
    crescentPaths(base, l[0], l[1], shifts).map((p) => p.edges),
    shifts.map((s) => subtractPath(base, shiftPath(base, l[0] * s, l[1] * s)).edges),
  );
  // Wrong: with its nudges the crescent is the one a tenth of a degree aside; without any it is empty, not the wrong part.
  const wrong = wrongOffsets(CARD, 0, 180, 0.05)[0]!;
  const w = vrot(LIGHT, -wrong.deg * DEG);
  const s = shifts[wrong.part]!;
  const repaired = crescentPath(base, w[0] * s, w[1] * s);
  assert.ok(soundCrescent(base, repaired, w[0] * s, w[1] * s));
  const aside = (deg: number): Path2D => {
    const n = vrot([w[0] * s, w[1] * s], deg * DEG);
    return subtractPath(base, shiftPath(base, n[0], n[1]));
  };
  assert.ok(CRESCENT_NUDGES.some((deg) => JSON.stringify(aside(deg).edges) === JSON.stringify(repaired.edges)), 'the crescent of one of the nudges');
  assert.ok(Math.abs(CRESCENT_NUDGES[0]!) <= 0.1 && CRESCENT_NUDGES.every((deg) => Math.abs(deg) <= 0.5), 'nudges of a fraction of a degree, the nearest first');
  const bare = crescentPath(base, w[0] * s, w[1] * s, []);
  assert.equal(pathArea(bare), 0);
  assert.equal(bare.edges.length, 0);
});

test('crescent: an outline the area cannot be worked out for keeps its crescents', () => {
  // 300 thin bars side by side: finer than the lines the area is added up on, and crossed 600 times by a line across them.
  const bars = new Path2D();
  for (let i = 0; i < 300; i++) bars.rect(i * 10, 0, 1, 80);
  // Moved down by 8, every bar keeps a cap of 1 x 8 at its top.
  const down = subtractPath(bars, shiftPath(bars, 0, 8));
  const truth = 300 * 8;
  assert.ok(Math.abs(pathArea(down) - truth) < 0.01 * truth, `${pathArea(down)} against ${truth}`);
  // The working-out on its lines is off here by more than the tolerance, so this sound difference does not pass...
  assert.ok(Math.abs(crescentArea(bars, 0, 8) - truth) > CRESCENT_TOLERANCE * truth, `${crescentArea(bars, 0, 8)}`);
  assert.equal(soundCrescent(bars, down, 0, 8), false);
  // ... and neither do the differences a hair aside. It is like them, so it is kept as it is: nothing vanishes.
  assert.deepEqual(crescentPath(bars, 0, 8, [0.00001, -0.00001]).edges, down.edges);
  // With the nudges of the engine the crescent is that one or one a fraction of a degree aside: every cap is there, and no bar is filled.
  const kept = crescentPath(bars, 0, 8);
  for (const i of [0, 1, 77, 150, 299]) {
    assert.ok(kept.contains(i * 10 + 0.5, 4), `the cap of bar ${i}`);
    assert.ok(!kept.contains(i * 10 + 0.5, 40), `the middle of bar ${i}`);
  }
  // Without a nudge there is nothing to hold it against: empty, rather than a part that may be wrong.
  assert.equal(pathArea(crescentPath(bars, 0, 8, [])), 0);

  // Across the bars the outline cannot be measured at all, and nothing is held against the difference.
  assert.equal(crescentArea(bars, 8, 0), 0);
  const across = subtractPath(bars, shiftPath(bars, 8, 0));
  assert.equal(soundCrescent(bars, across, 8, 0), true);
  assert.deepEqual(crescentPath(bars, 8, 0).edges, across.edges);
});

test('crescent: a lit card drawn at an offset where the difference is wrong looks like the card a step before and after', async () => {
  // The frame of the defect: the card at the first rotation of the sweep at which a part of it is wrong.
  const wrong = wrongOffsets(CARD, 0, 180, 0.05);
  const at = wrong.find((x) => x.part <= 1) ?? wrong[0]!;
  const card = (deg: number): ShotSpec =>
    shot({
      id: 'tiny',
      seconds: 0.1,
      seed: 3,
      palette,
      strings: { en: {} },
      background: { inner: 'deep.night', outer: 'deep.night' },
      atmosphere: 'mid.mist',
      vignette: 0,
      light: { from: 'top-left' },
      camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
      layers: [layer({ id: 'stage', depth: 0, nodes: [rect({ id: 'card', w: 240, h: 120, radius: 12, fill: 'light.cream', rotation: deg })] })],
    });
  const W = 960;
  const H = heightFor(W);
  const frame = async (deg: number): Promise<Uint8Array> => {
    const c = compileShot(card(deg));
    return frameRaw(c, await bakeShot(c), 0, { width: W, lang: 'en', gpu: false });
  };
  // The shot draws its card with the light of the sweep: the plain difference is wrong in this very frame.
  const c = compileShot(card(at.deg));
  const item = flatItems(evaluate(c, await bakeShot(c), 0, 'en').layers[0]!.items).find((i) => i.kind === 'shape')!;
  const l = vrot(c.light, -item.xf.rot);
  const s = shiftsOf(CARD)[at.part]!;
  const base = shapePath(CARD);
  assert.equal(soundCrescent(base, subtractPath(base, shiftPath(base, l[0] * s, l[1] * s)), l[0] * s, l[1] * s), false, `the plain difference is wrong at ${at.deg} deg`);

  const [before, here, after] = [await frame(at.deg - 0.05), await frame(at.deg), await frame(at.deg + 0.05)];
  /** Pixels that differ clearly between two frames: by more than a tenth of the range in a channel. */
  const differ = (a: Uint8Array, b: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
      if (Math.abs(a[i]! - b[i]!) > 25 || Math.abs(a[i + 1]! - b[i + 1]!) > 25 || Math.abs(a[i + 2]! - b[i + 2]!) > 25) n++;
    }
    return n;
  };
  // The card is 120 x 60 px here: 7200 pixels. Drawn with a wrong part, most of them change for that frame.
  const turn = differ(before, after);
  assert.ok(turn < 80, `two cards a tenth of a degree apart differ on ${turn} pixels`);
  assert.ok(differ(before, here) < 80 && differ(here, after) < 80, `the frame differs from the one before on ${differ(before, here)} pixels and from the one after on ${differ(here, after)}`);
});

test('crescent: a path difference that throws is a wrong one: a nudge stands in, or the crescent is empty, and the frame is drawn', async () => {
  const failed = (): never => {
    throw new Error('path operation failed');
  };
  const base = shapePath(CARD);
  const [ux, uy] = LIGHT;
  const shifts = shiftsOf(CARD);
  const plain = crescentPaths(base, ux, uy, shifts);
  // The first difference of each shift, straight along the light, throws; the nudged ones do not. Each crescent is a
  // nudged one, of the area it must have.
  const along = (moved: Path2D): boolean => {
    const dx = moved.bounds.left - base.bounds.left;
    const dy = moved.bounds.top - base.bounds.top;
    return Math.abs(dx * uy - dy * ux) < 1e-6 * Math.hypot(dx, dy);
  };
  let thrown = 0;
  const firstThrows = withPathDifference((a, b) => (along(b) ? (thrown++, failed()) : a.difference(b)), () => crescentPaths(base, ux, uy, shifts));
  assert.equal(thrown, shifts.length, 'the first difference of every shift threw');
  shifts.forEach((s, i) => {
    const want = crescentArea(base, ux * s, uy * s);
    assert.ok(Math.abs(pathArea(firstThrows[i]!) - want) <= CRESCENT_TOLERANCE * want, `${PARTS[i]}: ${pathArea(firstThrows[i]!)} against ${want}`);
  });
  // Every difference throws: every crescent is empty, and nothing is thrown out of the lit parts.
  const allThrow = withPathDifference(failed, () => crescentPaths(base, ux, uy, shifts));
  for (const part of allThrow) assert.equal(pathArea(part), 0);
  assert.equal(pathArea(withPathDifference(failed, () => crescentPath(base, 0, 0))), 0);
  // What it refuses to swallow: any other error is thrown on.
  assert.throws(() => withPathDifference(() => { throw new TypeError('not a path'); }, () => crescentPaths(base, ux, uy, shifts)), /not a path/);
  // Unchanged without a throw: the same crescents as the library's own difference gives.
  const again = crescentPaths(base, ux, uy, shifts);
  plain.forEach((part, i) => assert.equal(pathArea(again[i]!), pathArea(part)));

  // A lit shape whose differences all throw is drawn without its shading, and the frame is made.
  const spec = shot({
    id: 'tiny', seconds: 0.1, seed: 3, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' }, atmosphere: 'mid.mist', vignette: 0, light: { from: 'top-left' },
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes: [rect({ id: 'card', w: 240, h: 120, radius: 12, fill: 'light.cream', rotation: 7 })] })],
  });
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const drawn = withPathDifference(failed, () => drawFrame(c, bake, 0, { width: 480, lang: 'en', gpu: false }));
  drawn.dispose();
});

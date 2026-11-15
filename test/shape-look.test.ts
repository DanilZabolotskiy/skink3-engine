import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette as demoPalette } from '../examples/demo/palette.ts';
import { hexToHsv, hsv, lightness, lightTone, mix, parseHex, shadowTone, toHex, withAlpha } from '../src/look/color.ts';
import { lightVector, litParts } from '../src/look/light.ts';
import { checkPalette, definePalette, PaletteError, resolveColor, type PaletteSpec } from '../src/look/palette.ts';
import {
  blobShape,
  capsuleShape,
  circleShape,
  insetConvex,
  isConvex,
  outline,
  polygonShape,
  reach,
  rectShape,
  regularPolygonShape,
  scaleShape,
  ShapeError,
  shapeExtent,
  type ShapeSpec,
} from '../src/shape/geometry.ts';
import { shapePath, shiftPath, subtractPath } from '../src/shape/path.ts';

const SHAPES: Record<string, ShapeSpec> = {
  circle: circleShape(50),
  capsule: capsuleShape(160, 20),
  stick: capsuleShape(160, 20, 'start'),
  square: rectShape(100, 100, 18),
  triangle: regularPolygonShape(3, 60, 10),
  blob: blobShape(70, { seed: 9 }),
};

test('shapes: outlines are closed, evenly spaced and inside the extent', () => {
  for (const [name, spec] of Object.entries(SHAPES)) {
    const pts = outline(spec, 96);
    assert.equal(pts.length, 96, name);
    const ext = shapeExtent(spec);
    const steps: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      steps.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
      const d = Math.hypot(a[0] - ext.center[0], a[1] - ext.center[1]);
      assert.ok(d <= ext.outer * 1.01 && d >= ext.inner * 0.99, `${name}: point within extent`);
    }
    const mean = steps.reduce((x, y) => x + y, 0) / steps.length;
    assert.ok(Math.max(...steps) < mean * 1.6, `${name}: even spacing`);
  }
});

test('shapes: paths match the geometry', () => {
  const c = shapePath(SHAPES['circle']!).bounds;
  assert.ok(Math.abs(c.width - 100) < 0.01 && Math.abs(c.left + 50) < 0.01);
  const cap = shapePath(SHAPES['capsule']!).bounds;
  assert.ok(Math.abs(cap.width - 160) < 0.01 && Math.abs(cap.height - 40) < 0.01);
  const stick = shapePath(SHAPES['stick']!).bounds;
  assert.ok(Math.abs(stick.left + 20) < 0.01 && Math.abs(stick.right - 140) < 0.01, 'a start-origin capsule pivots on its first cap');
  const sq = shapePath(SHAPES['square']!).bounds;
  assert.ok(Math.abs(sq.width - 100) < 0.01 && Math.abs(sq.height - 100) < 0.01);
  // The same spec object always gives the same path object (cache), and a crescent is smaller than the shape.
  assert.equal(shapePath(SHAPES['circle']!), shapePath(SHAPES['circle']!));
  const crescent = subtractPath(shapePath(SHAPES['circle']!), shiftPath(shapePath(SHAPES['circle']!), -20, -20));
  assert.ok(crescent.bounds.width < 100 && crescent.bounds.width > 20);
});

test('shapes: invalid input is rejected with a reason', () => {
  assert.throws(() => circleShape(0), ShapeError);
  assert.throws(() => capsuleShape(10, 20), /at least 2 \* r/);
  assert.throws(() => polygonShape([[0, 0], [100, 0], [50, 20], [100, 100], [0, 100]], 4), /convex/);
  assert.throws(() => rectShape(100, 40, 30), /radius/);
  assert.throws(() => regularPolygonShape(2, 50, 5), /sides/);
  assert.throws(() => blobShape(50, { wobble: 0.9 }), /wobble/);
  assert.throws(() => regularPolygonShape(3, 30, 20), /too large/);
});

test('shapes: inset, convexity, reach and scale', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
  assert.deepEqual(insetConvex(square, 2).map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [[2, 2], [8, 2], [8, 8], [2, 8]]);
  assert.ok(isConvex(square));
  assert.ok(!isConvex([[0, 0], [10, 0], [5, 2], [10, 10], [0, 10]]));
  assert.equal(reach(SHAPES['circle']!, [1, 0]), 50);
  assert.ok(Math.abs(reach(SHAPES['capsule']!, [1, 0]) - 80) < 0.5);
  assert.ok(Math.abs(reach(SHAPES['capsule']!, [0, 1]) - 20) < 0.5);
  assert.ok(Math.abs(reach(SHAPES['stick']!, [-1, 0]) - 20) < 0.5);
  const big = scaleShape(SHAPES['square']!, 2);
  assert.ok(Math.abs(shapeExtent(big).outer - 2 * shapeExtent(SHAPES['square']!).outer) < 1e-6);
  // A blob is a pure function of its seed.
  assert.deepEqual(outline(blobShape(70, { seed: 9 }), 16), outline(SHAPES['blob']!, 16));
  assert.notDeepEqual(outline(blobShape(70, { seed: 10 }), 16), outline(SHAPES['blob']!, 16));
});

test('colour: conversions and derived tones', () => {
  assert.equal(toHex(parseHex('#1a2B3c')), '#1A2B3C');
  assert.equal(hsv(0, 1, 1), '#FF0000');
  assert.equal(hsv(240, 1, 0.5), '#000080');
  const back = hexToHsv(hsv(205, 0.6, 0.7));
  assert.ok(Math.abs(back.h - 205) < 1 && Math.abs(back.s - 0.6) < 0.01 && Math.abs(back.v - 0.7) < 0.01);
  assert.ok(lightness('#000000') === 0 && Math.abs(lightness('#FFFFFF') - 100) < 0.01);
  assert.ok(Math.abs(lightness('#777777') - 50) < 1);
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(withAlpha('#FF8000', 0.5), 'rgba(255,128,0,0.5000)');
  assert.throws(() => parseHex('red'));

  // Shadows are darker and more saturated; highlights are lighter and less saturated; both shift hue.
  for (const base of [hsv(40, 0.8, 0.95), hsv(176, 0.7, 0.9), hsv(324, 0.7, 0.76)]) {
    const b = hexToHsv(base);
    const s1 = hexToHsv(shadowTone(base, 1));
    const s2 = hexToHsv(shadowTone(base, 2));
    const l = hexToHsv(lightTone(base, 0.4));
    assert.ok(s1.v < b.v && s2.v < s1.v, 'shadows get darker');
    assert.ok(s1.s >= b.s, 'shadows do not lose saturation');
    assert.ok(l.v > b.v && l.s < b.s, 'highlights are lighter and paler');
    assert.notEqual(Math.round(s1.h), Math.round(b.h));
    assert.ok(s1.s >= 0.12 && l.s >= 0.12, 'no derived tone is gray');
  }
});

test('light: crescents sit on the correct side', () => {
  assert.deepEqual(lightVector({ from: 'right' }), [1, 0]);
  const tl = lightVector({ from: 'top-left' });
  assert.ok(tl[0] < 0 && tl[1] < 0);
  assert.ok(Math.abs(lightVector({ from: -90 })[1] + 1) < 1e-9);
  assert.throws(() => lightVector({ from: 'above' as never }));

  for (const [name, spec] of Object.entries(SHAPES)) {
    const ext = shapeExtent(spec);
    const parts = litParts(spec, tl);
    // The outline points nearest to and farthest from the light, moved a little inside the shape.
    const pts = outline(spec, 192);
    const toward = (p: readonly [number, number]): number => (p[0] - ext.center[0]) * tl[0] + (p[1] - ext.center[1]) * tl[1];
    const lit = pts.reduce((a, p) => (toward(p) > toward(a) ? p : a));
    const dark = pts.reduce((a, p) => (toward(p) < toward(a) ? p : a));
    const inward = (p: readonly [number, number], d: number): [number, number] => {
      const dx = ext.center[0] - p[0];
      const dy = ext.center[1] - p[1];
      const l = Math.hypot(dx, dy);
      return [p[0] + (dx / l) * d, p[1] + (dy / l) * d];
    };
    const nearDark = inward(dark, ext.inner * 0.04);
    const nearLit = inward(lit, ext.inner * 0.03);
    // Light from the top-left: the shadow is on the far side, the rim on the near side.
    assert.ok(parts.shadow.contains(nearDark[0], nearDark[1]), `${name}: shadow on the side away from the light`);
    assert.ok(parts.deepShadow.contains(nearDark[0], nearDark[1]), `${name}: deep shadow stacked on it`);
    assert.ok(!parts.shadow.contains(nearLit[0], nearLit[1]), `${name}: no shadow on the lit side`);
    assert.ok(parts.rim.contains(nearLit[0], nearLit[1]), `${name}: rim on the side toward the light`);
    assert.ok(!parts.rim.contains(nearDark[0], nearDark[1]), `${name}: no rim on the dark side`);
    assert.ok(!parts.shadow.contains(ext.center[0], ext.center[1]), `${name}: the middle keeps the base colour`);
    const hb = parts.highlight.bounds;
    assert.ok(toward([(hb.left + hb.right) / 2, (hb.top + hb.bottom) / 2]) > 0, `${name}: highlight toward the light`);
    assert.equal(litParts(spec, tl), parts, 'cached for the same light');
  }
});

const GOOD: PaletteSpec = {
  deep: { a: hsv(250, 0.9, 0.12) },
  dark: { a: hsv(258, 0.8, 0.5), b: hsv(230, 0.74, 0.46) },
  mid: { a: hsv(266, 0.68, 0.84) },
  accent: { warm: hsv(40, 0.86, 0.99), cool: hsv(176, 0.72, 0.93) },
  light: { a: hsv(52, 0.34, 0.99) },
  pairs: [['warm', 'cool']],
};

test('palette: the demo palette obeys the laws', () => {
  assert.deepEqual(checkPalette(demoPalette), []);
  assert.deepEqual(checkPalette(definePalette(GOOD)), []);
});

test('palette: every law is enforced', () => {
  const laws = (spec: PaletteSpec): string[] => checkPalette(definePalette(spec)).map((i) => i.law);
  // Gray darks.
  assert.ok(laws({ ...GOOD, dark: { a: hsv(258, 0.2, 0.5), b: hsv(230, 0.74, 0.46) } }).includes('no-gray'));
  // Darks that are saturated one by one but too pale on average.
  assert.ok(laws({ ...GOOD, deep: { a: hsv(250, 0.55, 0.12) }, dark: { a: hsv(258, 0.55, 0.5), b: hsv(230, 0.55, 0.46) } }).includes('saturated-shadows'));
  // Dark hues outside blue..violet.
  assert.ok(laws({ ...GOOD, deep: { a: hsv(120, 0.9, 0.12) }, dark: { a: hsv(20, 0.8, 0.4), b: hsv(230, 0.74, 0.46) } }).includes('dark-hue'));
  // A colour in the wrong lightness band.
  assert.ok(laws({ ...GOOD, deep: { a: hsv(250, 0.9, 0.6) } }).includes('role-lightness'));
  assert.ok(laws({ ...GOOD, light: { a: hsv(52, 0.34, 0.6) } }).includes('role-lightness'));
  // A dull accent.
  assert.ok(laws({ ...GOOD, accent: { warm: hsv(40, 0.4, 0.99), cool: hsv(176, 0.72, 0.93) } }).includes('accent'));
  // Pairs: missing, two warm colours, colours too close.
  assert.ok(laws({ ...GOOD, pairs: [] }).includes('accent-pairs'));
  assert.ok(laws({ ...GOOD, accent: { warm: hsv(40, 0.86, 0.99), cool: hsv(20, 0.8, 0.95) } }).includes('accent-pairs'));
  // Gray mid tone.
  assert.ok(laws({ ...GOOD, mid: { a: hsv(266, 0.1, 0.6) } }).includes('no-gray'));
});

test('palette: malformed input and unknown references fail loudly', () => {
  assert.throws(() => definePalette({ ...GOOD, deep: { a: 'navy' } }), PaletteError);
  assert.throws(() => definePalette({ ...GOOD, deep: {} }), /no colours/);
  assert.throws(() => definePalette({ ...GOOD, pairs: [['warm', 'nope']] }), /not defined/);
  assert.throws(() => definePalette({ ...GOOD, mid: { 'Bad-Name': hsv(266, 0.68, 0.84) } }), /must match/);
  const p = definePalette(GOOD);
  assert.equal(resolveColor(p, 'accent.warm'), hsv(40, 0.86, 0.99));
  assert.throws(() => resolveColor(p, 'accent.hot'), /available: .*accent\.warm/);
  assert.throws(() => resolveColor(p, '#FF0000'), /unknown colour/);
});

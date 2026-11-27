import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relief, type ShapeNode } from '../src/index.ts';

// A relief's heights smoothed (smooth): a coarse grid seen close shows its cells as steps of light; a bell a few
// cells wide over its heights rounds them off. It is opt-in: a relief without it keeps the heights it was given.

const COLS = 21;
const ROWS = 15;

function field(values: number[], extra: { smooth?: number } = {}): ShapeNode {
  return relief({ id: 'hills', w: 1000, h: 700, heights: { cols: COLS, rows: ROWS, values }, vertical: 1, dark: 'deep.night', bright: 'light.cream', ...extra });
}

const spike = Array.from({ length: COLS * ROWS }, (_, i) => (i === 7 * COLS + 10 ? 900 : 100));
const flat = new Array<number>(COLS * ROWS).fill(250);

test('relief smooth: what it refuses', () => {
  assert.throws(() => field(spike, { smooth: -1 }), /smooth must be a number in 0\.\.16/);
  assert.throws(() => field(spike, { smooth: 17 }), /smooth must be a number in 0\.\.16/);
  assert.throws(() => field(spike, { smooth: '2' as never }), /smooth must be a number in 0\.\.16/);
});

test('relief smooth: it spreads a lone spike over its neighbours and keeps the volume, and a level field stays level', () => {
  const smoothed = field(spike, { smooth: 2 }).relief!.heights;
  const peak = smoothed[7 * COLS + 10]!;
  assert.ok(peak < 300 && peak > 100, `the spike is now ${peak.toFixed(1)}`);
  assert.ok(smoothed[7 * COLS + 12]! > 100.5, 'its neighbour two cells away rose');
  // Far from the edges, the bell moves height around and adds none.
  const sum = (v: ArrayLike<number>): number => Array.from(v).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(smoothed) - sum(spike)) < 1, `${sum(smoothed)} against ${sum(spike)}`);
  for (const v of field(flat, { smooth: 5 }).relief!.heights) assert.ok(Math.abs(v - 250) < 1e-3);
});

test('relief smooth: opt-in: without it, and at 0, the heights are those given', () => {
  assert.deepEqual(Array.from(field(spike).relief!.heights), spike);
  assert.deepEqual(Array.from(field(spike, { smooth: 0 }).relief!.heights), spike);
  assert.deepEqual(field(spike, { smooth: 0 }).relief, field(spike).relief);
});

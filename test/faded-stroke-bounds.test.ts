import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeShot, compileShot, evaluate, stroke } from '../src/index.ts';
import { fadedStrokeOutside } from '../src/render/frame.ts';
import type { GroupItem } from '../src/scene/evaluate.ts';
import { make } from './fixtures/bodies.ts';

const identity = { m11: 1, m12: 0, m14: 0, m21: 0, m22: 1, m24: 0, m41: 0, m42: 0, m44: 1 };
const line = (id: string, points: Parameters<typeof stroke>[0]['points'], extra: Partial<Parameters<typeof stroke>[0]> = {}) =>
  stroke({ id, points, color: 'light.snow', width: 4, opacity: 0.25, ...extra });

test('a faded straight stroke is only left out when its entire round stroke lies beyond the actual canvas', async () => {
  const compiled = compileShot(make([
    line('left', [[-80, 20], [-40, 20]]),
    line('across', [[-80, 35], [20, 35]]),
    line('edge', [[-5, 35], [-3, 35]]),
    line('wide', [[-20, 20], [-20, 60]], { width: 48 }),
    line('right', [[120, 20], [130, 20]]),
    line('below', [[5, 120], [15, 120]]),
    line('above', [[5, -80], [15, -70]]),
    line('dashed', [[-80, 60], [-40, 60]], { dash: [7, 10] }),
    line('glowing', [[-80, 70], [-40, 70]], { glow: 0.5 }),
    line('rotated', [[-80, 80], [-40, 80]], { rotation: 10 }),
    line('curved', [[-80, 90], [-50, 95], [-40, 85]]),
  ]));
  const state = evaluate(compiled, await bakeShot(compiled), 0, 'en');
  const groups = new Map(state.layers[0]!.items.filter((item): item is GroupItem => item.kind === 'group').map((item) => [item.node.id, item]));
  const left = groups.get('left')!;
  const off = (id: string): boolean => fadedStrokeOutside(groups.get(id)!, identity, 100, 100);
  for (const id of ['left', 'right', 'below', 'above']) assert.ok(off(id), id);
  for (const id of ['across', 'edge', 'wide', 'dashed', 'glowing', 'rotated', 'curved']) assert.ok(!off(id), id);
  assert.ok(!fadedStrokeOutside({ ...left, soft: 10 }, identity, 100, 100));
  assert.ok(!fadedStrokeOutside(groups.get('right')!, identity, 140, 100), 'the right stroke lies in the padding');
  assert.ok(!fadedStrokeOutside(left, { ...identity, m41: 90 }, 100, 100), 'the active transform moves the left stroke on screen');
  assert.ok(fadedStrokeOutside(left, { ...identity, m14: -0.01 }, 100, 100), 'a safe perspective still leaves it outside');
  assert.ok(!fadedStrokeOutside(left, { ...identity, m14: 0.013 }, 100, 100), 'the stroke crosses the eye plane');
  assert.ok(!fadedStrokeOutside(left, { ...identity, m44: 0.125 }, 100, 100), 'roundoff could reach the near-eye guard');
});

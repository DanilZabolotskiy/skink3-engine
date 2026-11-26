import { highest, upright } from '../shape/solid.ts';
import { itemShape, type ShapeItem } from '../scene/evaluate.ts';
import type { ShapeSpec } from '../shape/geometry.ts';
import type { PlaneCanvas } from './plane.ts';
type Extent = readonly [number, number, number, number];
const extents = new WeakMap<ShapeSpec, Extent | null>();

/** A rounded polygon and a circle stay inside these bounds. Other shapes keep their ordinary drawing. */
function bounds(shape: ShapeSpec): Extent | null {
  const known = extents.get(shape);
  if (known !== undefined) return known;
  let result: Extent | null = null;
  if (shape.kind === 'circle') result = [-shape.r, -shape.r, shape.r, shape.r];
  else if (shape.kind === 'polygon' && shape.smooth === undefined && !shape.rings) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const p of shape.points) {
      left = Math.min(left, p[0]);
      top = Math.min(top, p[1]);
      right = Math.max(right, p[0]);
      bottom = Math.max(bottom, p[1]);
    }
    result = [left, top, right, bottom];
  }
  extents.set(shape, result);
  return result;
}

/** The projected corners of a front-facing box bound every point of its walls and roof. Keep boxes near the eye or the edge. */
export function outsideShape(item: ShapeItem, plane: PlaneCanvas): boolean {
  const node = item.node.node,
    foot = item.foot;
  if (
    node.type !== 'shape' ||
    (!node.roof && !node.backdrop) ||
    node.globe ||
    node.stands ||
    item.shape ||
    node.relief ||
    node.lit ||
    node.glow ||
    item.upon ||
    item.level ||
    foot?.tall
  )
    return false;
  const rect = bounds(itemShape(item));
  if (!rect) return false;
  const m = plane.transform(),
    { xf } = item,
    cs = Math.cos(xf.rot) * xf.scale,
    sn = Math.sin(xf.rot) * xf.scale;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const z = foot ? Math.min(highest(foot), foot.h + (node.roof?.height ?? 0)) : 0;
  if (foot && !(foot.uh > z)) return false;
  for (let k = 0; k < (foot ? 8 : 4); k++) {
    const x = rect[k & 1 ? 2 : 0],
      y = rect[k & 2 ? 3 : 1];
    const [px, py] = foot ? upright(foot, x, y, k & 4 ? z : 0) : [x, y];
    const u = xf.x + px * cs - py * sn,
      v = xf.y + px * sn + py * cs,
      w = m.m14 * u + m.m24 * v + m.m44;
    const absU = Math.abs(xf.x) + Math.abs(px * cs) + Math.abs(py * sn);
    const absV = Math.abs(xf.y) + Math.abs(px * sn) + Math.abs(py * cs);
    const margin = 2 ** -14 * (1 + Math.abs(m.m14) * absU + Math.abs(m.m24) * absV + Math.abs(m.m44));
    if (!(w - margin >= 0.125)) return false;
    const sx = (m.m11 * u + m.m21 * v + m.m41) / w,
      sy = (m.m12 * u + m.m22 * v + m.m42) / w;
    if (!Number.isFinite(sx + sy)) return false;
    const errorX =
      (2 ** -14 * (1 + Math.abs(m.m11) * absU + Math.abs(m.m21) * absV + Math.abs(m.m41)) + Math.abs(sx) * margin) /
      (w - margin);
    const errorY =
      (2 ** -14 * (1 + Math.abs(m.m12) * absU + Math.abs(m.m22) * absV + Math.abs(m.m42)) + Math.abs(sy) * margin) /
      (w - margin);
    left = Math.min(left, sx - errorX);
    right = Math.max(right, sx + errorX);
    top = Math.min(top, sy - errorY);
    bottom = Math.max(bottom, sy + errorY);
  }
  return right < -8 || bottom < -8 || left > plane.raw.canvas.width + 8 || top > plane.raw.canvas.height + 8;
}

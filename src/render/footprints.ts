import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { mix } from '../look/color.ts';
import { xfApply, type Vec2 } from '../core/math.ts';
import { itemFill, itemShape, type Foot, type Item, type ShapeItem } from '../scene/evaluate.ts';
import { highest, upright } from '../shape/solid.ts';
import type { Paint } from './draw.ts';
import { planeCanvas } from './plane.ts';

interface Face {
  points: Vec2[];
  color: string;
}
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Two pitched slopes and the visible sides of a small rectangular building. Its roof ridge has its true height. */
function facets(item: ShapeItem, foot: Foot, paint: Paint): Face[] | null {
  const node = item.node.node,
    shape = itemShape(item);
  if (
    node.type !== 'shape' ||
    shape.kind !== 'polygon' ||
    shape.points.length !== 4 ||
    shape.radius ||
    shape.smooth ||
    !node.roof ||
    (node.roof.kind !== 'hip' && node.roof.kind !== 'gable') ||
    node.roof.ridge !== undefined ||
    foot.tall ||
    foot.uh <= 0
  )
    return null;
  const p = shape.points;
  const [a, b, c, d] = p as readonly [Vec2, Vec2, Vec2, Vec2];
  if (a[1] !== b[1] || b[0] !== c[0] || c[1] !== d[1] || d[0] !== a[0] || b[0] <= a[0] || d[1] <= a[1]) return null;
  const [w, h] = [b[0] - a[0], d[1] - a[1]];
  const along = w >= h,
    inset = node.roof.kind === 'hip' ? Math.min(w, h) / 2 : 0;
  const ridgeA = along ? midpoint(d, a) : midpoint(a, b),
    ridgeB = along ? midpoint(b, c) : midpoint(c, d);
  const z = Math.min(foot.h + node.roof.height, highest(foot));
  if (z < 0) return null;
  const r0 = upright(foot, ridgeA[0] + (along ? inset : 0), ridgeA[1] + (along ? 0 : inset), z);
  const r1 = upright(foot, ridgeB[0] - (along ? inset : 0), ridgeB[1] - (along ? 0 : inset), z);
  const fill = itemFill(item),
    base = paint.tone('base', fill),
    shadow = mix(base, paint.tone('shadow1', fill), Math.min(1, 0.58 * (node.roof.contrast ?? 1)));
  const light = paint.light,
    cs = Math.cos(item.xf.rot),
    sn = Math.sin(item.xf.rot);
  const side = [light[0] * cs + light[1] * sn, -light[0] * sn + light[1] * cs];
  const sides: Face[] = [];
  const put = (pts: Vec2[], color: string): void => {
    let area = 0;
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j]!,
        b = pts[(j + 1) % pts.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (area > 0) sides.push({ points: pts.map((v) => xfApply(item.xf, v)), color });
  };
  const wall = item.node.colors['side'] ? paint.tone('base', item.node.colors['side']) : shadow;
  for (let i = 0; i < 4; i++) {
    const start = p[i]!,
      end = p[(i + 1) % 4]!;
    const low = (v: Vec2): Vec2 => [v[0] * foot.k + foot.x, v[1] * foot.k + foot.y];
    put([low(start), low(end), end, start], wall);
  }
  const opposite = along ? side[1]! : side[0]!;
  if (along) {
    put([a, b, r1, r0], opposite < 0 ? base : shadow);
    put([r0, r1, c, d], opposite < 0 ? shadow : base);
    put([b, c, r1], node.roof.kind === 'gable' ? wall : base);
    put([d, a, r0], node.roof.kind === 'gable' ? wall : shadow);
  } else {
    put([a, r0, r1, d], opposite < 0 ? base : shadow);
    put([r0, b, c, r1], opposite < 0 ? shadow : base);
    put([a, b, r0], node.roof.kind === 'gable' ? wall : shadow);
    put([c, d, r1], node.roof.kind === 'gable' ? wall : base);
  }
  return sides;
}

/** Group only disjoint, opaque silhouettes. A screen overlap flushes all earlier paints before the new building. */
export function drawFootprints(ctx: CanvasRenderingContext2D, items: readonly Item[], start: number, paint: Paint): number {
  const plane = planeCanvas(ctx);
  if (!plane) return 0;
  const m = plane.transform(),
    paths = new Map<string, Path2D>(),
    boxes: Box[] = [];
  const flush = (): void => {
    for (const [color, path] of paths) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
    paths.clear();
    boxes.length = 0;
  };
  let i = start;
  for (; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== 'shape' || !item.detail?.facet) break;
    const faces = facets(item, item.detail.facet, paint);
    if (!faces?.length) break;
    const box: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    let valid = true;
    for (const face of faces)
      for (const [u, v] of face.points) {
        const w = m.m14 * u + m.m24 * v + m.m44;
        if (w < 0.125) {
          valid = false;
          break;
        }
        const x = (m.m11 * u + m.m21 * v + m.m41) / w,
          y = (m.m12 * u + m.m22 * v + m.m42) / w;
        box.left = Math.min(box.left, x - 1);
        box.right = Math.max(box.right, x + 1);
        box.top = Math.min(box.top, y - 1);
        box.bottom = Math.max(box.bottom, y + 1);
      }
    if (!valid) break;
    if (box.right < -2 || box.left > ctx.canvas.width + 2 || box.bottom < -2 || box.top > ctx.canvas.height + 2) continue;
    if (
      boxes.length >= 48 ||
      boxes.some((p) => p.left <= box.right && box.left <= p.right && p.top <= box.bottom && box.top <= p.bottom)
    )
      flush();
    boxes.push(box);
    for (const { color, points } of faces) {
      let path = paths.get(color);
      if (!path) {
        path = new Path2D();
        paths.set(color, path);
      }
      const a = points[0]!;
      path.moveTo(a[0], a[1]);
      for (let k = 1; k < points.length; k++) path.lineTo(points[k]![0], points[k]![1]);
      path.closePath();
    }
  }
  flush();
  return i - start;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circle, compileShot, fillRings, group, pathHeightAt, perspectiveTo, polygon, rect, region, relief, travel, type LayerSpec, type ShapeItem, type Vec2, type Vec3 } from '../src/index.ts';
import { containsPoint, outlineOf } from '../src/shape/geometry.ts';
import { at, dark, differing, draw, items, make, refused, type Rgb } from './fixtures/bodies.ts';

// What a map seen in perspective needs: clips to long coasts, soft groups kept inside them, bodies taller than the
// camera is high, depth haze, relief from a grid of heights, paths with heights, and shapes that stand up.

/** A perspective layer whose camera looks at the middle of the stage, `tilt` degrees over the ground. */
const seen = (tilt: number, distance = 1600): object => ({ perspective: { aim: [0, 0, 0] as Vec3, distance, tilt } });

/** A floor through the middle of the space, with what lies on it. */
const floor = (children: LayerSpec['nodes'], extra: object = {}): ReturnType<typeof group> => group({ id: 'floor', plane: 'floor', children, ...extra });

test('flat contours preserve gaps and opposite-winding holes', async () => {
  const ring = (x: number, r: number): Vec2[] => [[x-r,-r],[x+r,-r],[x+r,r],[x-r,r]];
  const mask = fillRings({ id: 'patches', fill: 'light.snow', rings: [ring(-200,100), ring(-200,40).reverse(), ring(200,100)] });
  const pixels = await draw(make([mask]));
  for (const x of [-200, 0, 500]) assert.ok(dark(at(pixels, x, 0)));
  for (const x of [-270, 200]) assert.ok(!dark(at(pixels, x, 0)));
  const outline = outlineOf(mask.shape);
  for (const x of [-200, 0, 500]) assert.equal(containsPoint(outline,x,0),false);
  for (const x of [-270, 200]) assert.equal(containsPoint(outline,x,0),true);
  const partial=fillRings({id:'overlap',fill:'light.snow',rings:[ring(0,100),ring(60,100)]});
  assert.equal(containsPoint(outlineOf(partial.shape),30,0),true);
  assert.throws(() => fillRings({id:'bad',fill:'light.snow',rings:[[[0,0],[4,0]]]}), /three points/);
});

test('grounded contours follow the same moving camera and terrain as individual footprints', async () => {
  const values=Array.from({length:25},(_,i)=>60+14*(i%5)+6*Math.floor(i/5));
  const terrain=relief({id:'ground',w:1200,h:1000,heights:{cols:5,rows:5,values},dark:'deep.abyss',bright:'light.snow'});
  const rings:Vec2[][]=[[[-280,-120],[-80,-120],[-80,140],[-280,140]],[[70,-180],[280,-180],[230,160],[70,160]]];
  const keys=[perspectiveTo('stage',{at:0,aim:[110,-45,0],dur:1})];
  const scene=(nodes:LayerSpec['nodes'])=>make([floor([terrain,...nodes],{ground:'ground'})],keys,seen(42));
  const compound=scene([fillRings({id:'patches',rings,fill:'light.snow'})]);
  const individual=scene(rings.map((points,i)=>region({id:'patch'+i,points,smooth:0,fill:'light.snow',lit:false})));
  for(const frame of [0,23,59]) {
    const first=await draw(compound,frame),second=await draw(individual,frame);
    let error=0;for(let i=0;i<first.length;i+=4)if(Math.abs(first[i]!-second[i]!)>16)error++;
    assert.ok(error<250,`frame ${frame}: ${error} pixels outside edge tolerance`);
  }
});

test('coarse terrain samples retain projection, clipping and the default description', async () => {
  const options = { id:'field', w:900, h:650, heights:{cols:2,rows:2,values:[20,20,20,20]}, dark:'deep.abyss', bright:'light.snow', tints:[[0,'light.snow'],[50,'light.snow']] } as const;
  assert.deepEqual(relief({...options,samplePixels:1}), relief(options));
  assert.throws(() => relief({...options,samplePixels:3 as 2}), /samplePixels/);
  for (const samplePixels of [1,2,4] as const) {
    const shape = region({id:'mask',points:[[-250,-200],[250,-200],[250,200],[-250,200]],smooth:0,fill:'deep.abyss',lit:false});
    const spec = make([floor([shape,relief({...options,clipTo:'mask',samplePixels})])],[],seen(45));
    const pixels=await draw(spec);
    assert.ok(!dark(at(pixels,0,0)) && dark(at(pixels,600,0)));
    assert.equal(differing(pixels,await draw(spec)),0);
  }
});

/** A wavy island of n points, about 2 * 520 units across: an outline of the kind skia fails to clip to. */
function island(n: number, scale = 1): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = (520 + 40 * Math.sin(a * 7) + 12 * Math.sin(a * 53)) * scale;
    return [Math.round(Math.cos(a) * r * 1.4 * 10) / 10, Math.round(Math.sin(a) * r * 10) / 10] as Vec2;
  });
}

const white = (p: Rgb): boolean => p[0] > 225 && p[1] > 225 && p[2] > 225;
const coral = (p: Rgb): boolean => p[0] > 200 && p[1] < 140 && p[2] < 140;
const aqua = (p: Rgb): boolean => p[0] < 120 && p[1] > 200 && p[2] > 180;

/**
 * The land east of a wavy coast that runs north to south through the middle, n points long, closed far to the east:
 * an outline skia drops without a word when it is asked to clip to it.
 */
function coast(n: number): Vec2[] {
  const line = Array.from({ length: n }, (_, i) => {
    const y = -6000 + (12000 * i) / (n - 1);
    return [Math.round((150 * Math.sin(y / 260) + 40 * Math.sin(y / 37)) * 10) / 10, Math.round(y * 10) / 10] as Vec2;
  });
  return [...line, [6000, 6000], [6000, -6000]];
}

test('maps: what is clipped to a long outline with clipMask stays inside it, in a plane and on a flat layer', async () => {
  const band = (points: Vec2[]): LayerSpec['nodes'] => [
    region({ id: 'land', points, fill: 'mid.ocean', lit: false, clipMask: true }),
    rect({ id: 'band', w: 30000, h: 80, radius: 0, fill: 'light.snow', lit: false, clipTo: 'land' }),
  ];
  for (const n of [400, 2000]) {
    // Seen from straight above, a place of the plane is that place on screen; tilted, so is a place on its middle line.
    for (const tilt of [90, 50]) {
      const raw = await draw(make([floor(band(coast(n)))], [], seen(tilt)));
      assert.ok(white(at(raw, 400, 0)) && white(at(raw, 800, 0)), `${n} points, ${tilt} degrees: the band on the land`);
      assert.ok(dark(at(raw, -400, 0)) && dark(at(raw, -800, 0)), `${n} points, ${tilt} degrees: and not off its coast`);
    }
    const isle = await draw(make([floor(band(island(n)))], [], seen(50)));
    assert.ok(white(at(isle, 0, 0)) && dark(at(isle, 860, 0)), `${n} points, an island`);
  }
  const flat = await draw(make(band(coast(2000))));
  assert.ok(white(at(flat, 400, 0)) && dark(at(flat, -400, 0)), 'on a flat layer');
});

test('maps: the blur of a soft group clipped to a long outline with clipMask stays inside it', async () => {
  const spec = make(
    [
      floor([
        region({ id: 'land', points: coast(2000), fill: 'mid.ocean', lit: false, clipMask: true }),
        group({ id: 'woods', soft: 40, clipTo: 'land', children: [rect({ id: 'wood', w: 1800, h: 160, radius: 0, fill: 'accent.coral', lit: false })] }),
      ]),
    ],
    [],
    seen(90),
  );
  const raw = await draw(spec);
  assert.ok(coral(at(raw, 400, 0)), 'the soft band on the land');
  for (const x of [-250, -400, -800]) assert.ok(dark(at(raw, x, 0)), `nothing of it off the coast at ${x}`);
});

test('maps: a tall group draws a body taller than the camera is high whole; without tall it is held under the camera', async () => {
  // The camera 14 degrees over the floor, 1600 away: it is about 387 units over it.
  const tower = (tall: boolean): ReturnType<typeof make> =>
    make([floor([circle({ id: 't', r: 40, fill: 'light.snow', side: 'accent.coral', lit: false, rise: 700 })], tall ? { tall: true } : {})], [], seen(14));
  const held = (await items(tower(false))).find((i) => i.node.id === 't') as ShapeItem;
  const whole = (await items(tower(true))).find((i) => i.node.id === 't') as ShapeItem;
  assert.equal(held.foot?.lift, undefined, 'without tall nothing is lifted');
  assert.ok(whole.foot?.lift, 'with tall the body is drawn through its lift');
  // Drawn whole, its side reaches higher on screen than the held one's.
  const top = (raw: Uint8Array): number => {
    for (let y = -540; y < 0; y += 2) if (coral(at(raw, 0, y)) || white(at(raw, 0, y))) return y;
    return 0;
  };
  const [low, high] = [top(await draw(tower(false))), top(await draw(tower(true)))];
  assert.ok(high < low - 40, `the tall body reaches ${high}, the held one ${low}`);
  // tall is for a plane, and a group without it is the data it always was.
  assert.ok(refused(() => group({ id: 'g', tall: true, children: [] }), /tall is for a group that lies in a plane/));
  assert.ok(!('tall' in floor([])));
});

test('maps: fog turns the far ground toward its colour by distance, and leaves the near ground as it is', async () => {
  const ground = [rect({ id: 'ground', w: 20000, h: 20000, radius: 0, fill: 'light.snow', lit: false })];
  const fog = { color: 'accent.aqua', near: 1700, far: 4000 } as const;
  const clear = await draw(make([floor(ground)], [], seen(25)));
  const foggy = await draw(make([floor(ground, { fog })], [], seen(25)));
  // The middle of the stage is 1600 away: nearer than near, untouched; the lower half nearer still.
  assert.deepEqual(at(foggy, 0, 0), at(clear, 0, 0));
  assert.deepEqual(at(foggy, 0, 200), at(clear, 0, 200));
  // Up the screen the ground is farther: it turns toward aqua, and more so the farther it is.
  const [mid, far] = [at(foggy, 0, -200), at(foggy, 0, -280)];
  assert.ok(white(at(clear, 0, -280)), 'without fog the far ground is white');
  assert.ok(mid[0] < 225 && far[0] < mid[0] - 20 && far[1] > 230, `toward aqua: ${mid}, then ${far}`);
  // Nothing of it past the horizon, where nothing of the plane is drawn: from 10 degrees up it is 282 units up.
  const sky = [at(await draw(make([floor(ground)], [], seen(10))), 0, -400), at(await draw(make([floor(ground, { fog })], [], seen(10))), 0, -400)];
  assert.ok(dark(sky[0]!));
  assert.deepEqual(sky[1], sky[0]);
  // What it refuses, and a group without it is the data it always was.
  assert.ok(refused(() => group({ id: 'g', fog, children: [] }), /fog is for a group that lies in a plane/));
  assert.ok(refused(() => floor([], { fog: { color: 'accent.aqua', near: 3000, far: 2000 } }), /must lie beyond fog\.near/));
  assert.ok(refused(() => floor([], { fog: { near: 1, far: 2 } }), /fog needs a color/));
  assert.ok(!('fog' in floor([])));
});

test('maps: relief shades the slopes turned to the light and from it, smoothly at any size', async () => {
  // A ramp: its heights rise to the right, so its slope faces left, toward a light from the top left.
  const ramp = (rising: 1 | -1, extra: object = {}): ReturnType<typeof relief> =>
    relief({ id: 'r', w: 800, h: 400, heights: { cols: 4, rows: 2, values: [0, 1, 2, 3, 0, 1, 2, 3].map((v) => v * 100 * rising) }, vertical: 1.5, dark: 'deep.abyss', bright: 'light.snow', ...extra });
  const ground = rect({ id: 'g', w: 1000, h: 600, radius: 0, fill: 'mid.ocean', lit: false });
  const plain = await draw(make([ground]));
  const lit = await draw(make([ground, ramp(1)]));
  const shaded = await draw(make([ground, ramp(-1)]));
  const sum = (p: Rgb): number => p[0] + p[1] + p[2];
  assert.ok(sum(at(lit, 0, 0)) > sum(at(plain, 0, 0)) + 60, 'a slope turned to the light is brighter than the ground');
  assert.ok(sum(at(shaded, 0, 0)) < sum(at(plain, 0, 0)) - 60, 'one turned from it darker');
  assert.deepEqual(at(lit, 450, 0), at(plain, 450, 0), 'nothing past its rect');
  // With tints the ground takes the colour of its height; a flat field is its tint alone.
  const level = relief({ id: 'r', w: 800, h: 400, heights: { cols: 2, rows: 2, values: [50, 50, 50, 50] }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'accent.coral'], [100, 'accent.aqua']] });
  const tinted = at(await draw(make([level])), 0, 0);
  const coralRgb = at(await draw(make([rect({ id: 'c', w: 800, h: 400, fill: 'accent.coral', lit: false })])), 0, 0);
  const aquaRgb = at(await draw(make([rect({ id: 'a', w: 800, h: 400, fill: 'accent.aqua', lit: false })])), 0, 0);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(tinted[k]! - (coralRgb[k]! + aquaRgb[k]!) / 2) <= 2, `half-way between the tints: ${tinted}`);
  // A few points stretched across the frame are read along smooth curves: no step from one pixel to the next.
  const hills = relief({ id: 'h', w: 1800, h: 1000, heights: { cols: 5, rows: 4, values: [0, 80, 10, 90, 0, 40, 0, 70, 20, 60, 90, 10, 50, 0, 30, 0, 60, 20, 80, 10] }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'mid.jade'], [90, 'light.cream']] });
  const raw = await draw(make([hills]));
  let most = 0;
  for (let x = -880; x < 880; x += 2) {
    const [a, b] = [at(raw, x, 37), at(raw, x + 2, 37)];
    most = Math.max(most, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }
  assert.ok(most <= 6, `the most a channel changes from a pixel to the next: ${most}`);
  // The same frame twice is the same.
  assert.equal(differing(raw, await draw(make([hills]))), 0);
  // What it refuses.
  const g = { w: 100, h: 100, dark: 'deep.abyss', bright: 'light.snow' } as const;
  assert.ok(refused(() => relief({ id: 'x', ...g, heights: { cols: 3, rows: 2, values: [1, 2, 3] } }), /must hold cols \* rows = 6 heights/));
  assert.ok(refused(() => relief({ id: 'x', ...g, heights: { cols: 2, rows: 2, values: [1, 2, 3, 4] }, tints: [[10, 'accent.aqua'], [5, 'accent.coral']] }), /from the lowest height up/));
  assert.ok(refused(() => relief({ id: 'x', ...g, heights: { cols: 2, rows: 2, values: [1, 2, 3, NaN] } }), /not a finite number/));
});

test('maps: relief lies on a plane and is clipped like any shape', async () => {
  const values = Array.from({ length: 16 * 16 }, (_, i) => 60 * Math.sin((i % 16) / 2.5) * Math.cos(Math.floor(i / 16) / 3));
  const hills = (extra: object = {}): ReturnType<typeof relief> => relief({ id: 'h', w: 1200, h: 1200, heights: { cols: 16, rows: 16, values }, dark: 'deep.abyss', bright: 'light.snow', tints: [[-60, 'mid.jade'], [60, 'light.cream']], ...extra });
  const land = region({ id: 'land', points: island(2000, 0.5), fill: 'mid.ocean', lit: false, clipMask: true });
  const raw = await draw(make([floor([land, hills({ clipTo: 'land' })])], [], seen(90)));
  assert.ok(!dark(at(raw, 0, 0)) && dark(at(raw, 500, 0)), 'drawn inside the land and not past it');
  // Tilted, its far half is drawn smaller than its near half.
  const tilted = await draw(make([floor([hills()])], [], seen(40)));
  const span = (y: number): number => {
    let n = 0;
    for (let x = -950; x <= 950; x += 2) if (!dark(at(tilted, x, y))) n++;
    return n;
  };
  assert.ok(span(-150) < span(150) - 10, `far ${span(-150)}, near ${span(150)}`);
});

test('maps: a path with heights runs that high: over a plane the node is drawn up there; on a flat layer up the screen', async () => {
  const spec = { points: [[0, 0], [100, 0], [200, 0]] as Vec2[], closed: false, smooth: 1, heights: [0, 50, 0] };
  assert.equal(pathHeightAt(spec, 0), 0);
  assert.ok(Math.abs(pathHeightAt(spec, 100) - 50) < 1e-6, 'at its points it is as high as they say');
  assert.ok(pathHeightAt(spec, 50) > 0 && pathHeightAt(spec, 50) < 50);
  assert.equal(pathHeightAt(spec, 400), 0, 'held at its end');
  assert.equal(pathHeightAt({ points: spec.points, closed: false, smooth: 1 }, 100), 0, 'a path without heights lies on the ground');

  const way: Vec3[] = [[-300, 0, 0], [0, 0, 200], [300, 0, 0]];
  const flatWay = way.map((p) => [p[0], p[1]] as Vec2);
  const boat = (id: string): ReturnType<typeof circle> => circle({ id, at: [-300, 0], r: 20, fill: 'accent.coral', lit: false });
  const timeline = [travel('up', { at: 0, path: way, dur: 2, profile: 'steady' }), travel('down', { at: 0, path: flatWay, dur: 2, profile: 'steady' })];
  const middle = async (extra: object, nodes: LayerSpec['nodes']): Promise<{ up: ShapeItem; down: ShapeItem }> => {
    const list = await items(make(nodes, timeline, extra), 60);
    return { up: list.find((i) => i.node.id === 'up') as ShapeItem, down: list.find((i) => i.node.id === 'down') as ShapeItem };
  };
  // On a flat layer: 200 units up the screen at the top of the path.
  const flat = await middle({}, [boat('up'), boat('down')]);
  assert.ok(Math.abs(flat.up.xf.x - flat.down.xf.x) < 1e-6 && Math.abs(flat.down.xf.y - flat.up.xf.y - 200) < 1e-6, `${flat.up.xf.y} against ${flat.down.xf.y}`);
  // Over a tilted plane: up the screen and larger, as the top of a body that high is.
  const plane = await middle(seen(40), [floor([group({ id: 'g', sort: 'depth', children: [boat('up'), boat('down')] })])]);
  assert.ok(plane.up.xf.y < plane.down.xf.y - 40 && plane.up.xf.scale > plane.down.xf.scale, `${plane.up.xf.y}, ${plane.up.xf.scale} against ${plane.down.xf.y}, ${plane.down.xf.scale}`);
  // A path's points are all of one kind; a shot without heights compiles as it always did.
  assert.ok(refused(() => travel('up', { at: 0, path: [[0, 0], [1, 1, 1]] as never, dur: 1 }), /path\[1\] must be \[x, y\]/));
  assert.equal(compileShot(make([boat('down')], [timeline[1]!])).nodes.some((n) => n.pos?.lifts), false);
});

test('maps: a shape that stands rises from its plane as a sail does; flat it lies on it', async () => {
  const sail = (stands: boolean): ReturnType<typeof polygon> => polygon({ id: 's', points: [[-40, 0], [40, 0], [0, -100]], fill: 'accent.aqua', lit: false, ...(stands ? { stands: true } : {}) });
  // From 20 degrees over the floor, a flat triangle 100 deep is about 34 high on screen; standing, about 94.
  const flat = await draw(make([floor([sail(false)])], [], seen(20)));
  const up = await draw(make([floor([sail(true)])], [], seen(20)));
  assert.ok(aqua(at(up, 0, -5)) && aqua(at(up, 0, -70)) && dark(at(up, 0, -110)), 'standing: up to its tip');
  assert.ok(aqua(at(flat, 0, -5)) && dark(at(flat, 0, -70)), 'lying: foreshortened');
  assert.ok(dark(at(up, 0, 10)), 'nothing of it below its place');
  // Turned with its rotation, it is seen edge-on and thin.
  const edge = await draw(make([floor([polygon({ id: 's', points: [[-40, 0], [40, 0], [0, -100]], fill: 'accent.aqua', lit: false, stands: true, rotation: 90 })])], [], seen(20)));
  let wide = 0;
  for (let x = -60; x <= 60; x++) if (aqua(at(edge, x, -40))) wide++;
  assert.ok(wide <= 6, `edge-on it is ${wide} wide`);
  assert.ok(refused(() => polygon({ id: 's', points: [[0, 0], [1, 0], [0, 1]], fill: 'accent.aqua', stands: true, rise: 10 }), /stands/));
  assert.ok(!('stands' in sail(false)));
});

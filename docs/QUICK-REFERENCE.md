# Quick reference for scene authors

What a scene can use; open SCENES.md or a review document only at an indexed section. What neither has is not built.

- After `/**/`: defaults.
- Units: a 1920 x 1080 stage, origin centred, y down; `[x, y]` in the parent's space; seconds, 60 fps; degrees clockwise, 0 right.

## A scene module

```ts
import { circle, definePalette, hsv, layer, moveTo, popIn, Rng, shot } from 'skink3-engine';

const palette = definePalette({ deep: { night: hsv(250, 0.9, 0.2) }, dark: { indigo: hsv(258, 0.8, 0.5) }, mid: { mist: hsv(250, 0.5, 0.7) }, accent: { amber: hsv(40, 0.9, 1) }, light: { cream: hsv(52, 0.3, 1) } });
new Rng(7, 'scatter').range(-800, 800); // seeded by both; also int, pick, shuffle, next, sign, gauss, stream
const scene = shot({
  id: 'minimal', seconds: 4, seed: 1, palette, strings: { en: { 'label.dot': 'A dot' } },
  background: { inner: 'dark.indigo', outer: 'deep.night' }, atmosphere: 'mid.mist',
  layers: [layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.amber' })] })],
  timeline: [popIn('dot', { at: 0.3 }), moveTo('dot', { at: 1.2, to: [260, -40] })],
});
export default scene;
```

- Colours: palette references; on-screen text: keys of `strings`, in every language; random numbers: `Rng`. A mistake or unknown option is refused with the fix.
- A palette brings `rules` (held by `check`; the engine has none), `tones`, variants.

## Shot, camera, layers

```ts
shot({ ...scene, /**/ light: { from: 'top-left' }, vignette: 0.5, camera: { at: [0, 0], drift: { speed: 0.5, heading: 0, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 }, focus: { far: 6, near: 60 } } });
shot({ ...scene, camera: { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 } } });
cameraTo({ at: 2, zoom: 1.6, to: [200, 0], /**/ dur: 1.2, profile: 'ease' }); // zoom, to, or both
zoomTo({ at: 6, to: 1.15, /**/ dur: 3, profile: 'ease' }); // zoom alone
backgroundTo({ at: 3, inner: 'deep.night', /**/ dur: 2, profile: 'ease' }); // + outer, center, radius, atmosphere, vignette
layer({ id: 'far', depth: 1.5, nodes: [] }); // + blur, parallax, tint
layer({ id: 'room', depth: 0, nodes: [], perspective: { aim: [0, 0, 0], distance: 1600, tilt: 0, turn: 0 } }); // or true: a space, z away, with its camera; + lens
perspectiveTo('room', { at: 2, tilt: 50, /**/ dur: 1.6, profile: 'ease' }); // + aim, distance (a dolly), turn, lens (a zoom)
```

- `drift.speed`: units/frame along `heading` (norm 0.3-0.7 px). `wander`: units; `period`: s; `focus`: blur per unit of depth.
- A `path` replaces `at`, `drift.speed`, `drift.heading`: with `speed` (units/frame) it loops a closed one (`loopPoints(center, r | [rx, ry])`), else covers it once.
- Keys chain. `cameraTo`: `zoom` times the authored view, `to` its final aim; path and drift wait. Under `zoomTo` they run on.
- `depth` 0: the focus plane; above 0 farther (less parallax, blurred, tinted to `atmosphere`), below (to -0.9) nearer. Drawn farthest first, nodes as listed, children after parents.
- A listed node's `depth` (larger: behind) orders any layer. In a perspective layer listed nodes take `at: [x, y, z]`, face the camera; `region`, `stroke`: `points` of three; a `group` with `plane` lies in it; near over far; behind the camera: cut.

## Nodes

```ts
circle({ id: 'c', fill: 'mid.mist', r: 90, /**/ at: [0, 0], rotation: 0, scale: 1, opacity: 1, lit: true, glow: 0, children: [] });
capsule({ id: 'arm', fill: 'mid.mist', length: 46, r: 8, /**/ origin: 'center' }); // tip to tip
polygon({ id: 'hex', fill: 'mid.mist', sides: 6, r: 50, /**/ radius: 8 }); // 0.16 r; or points: [[x, y], ...], radius: 0
rect({ id: 'tray', fill: 'mid.mist', w: 240, h: 50, /**/ radius: 11 }); // 0.22 of the short side
blob({ id: 'buddy', fill: 'mid.mist', r: 50, /**/ points: 9, wobble: 0.14, seed: 1 });
region({ id: 'isle', fill: 'mid.mist', points: [[-200, 0], [0, -120], [200, 0], [0, 40]], /**/ smooth: 1 }); // free-form, no body; <=600 points, lit: false <=4000
group({ id: 'face', /**/ upright: false, children: [] }); // + at, rotation, scale, opacity; upright: not turned by its parent; plane: 'floor' | 'wall' | 'side' | { x, y }, back, tall, fog
link({ id: 'wire', from: 'hex', to: 'buddy', color: 'mid.mist', /**/ pulseColor: 'mid.mist', bend: 0.12, width: 7, glow: 0 });
stroke({ id: 'route', points: [[-300, 0], [0, -80], [300, 0]], color: 'mid.mist', /**/ width: 7, closed: false, smooth: 1, glow: 0 }); // + dash: [dash, gap] (0: dots), drawn, pulseColor, least (on screen), at, rotation, scale
label({ id: 'note', text: 'label.dot', target: 'c', fill: 'light.cream', ink: 'deep.night', /**/ side: 'top', size: 38, maxWidth: 420, maxLines: 3 }); // + runInk: '2.0 · [Aug 2026]': runs in that ink
text({ id: 'title', text: 'label.dot', ink: 'light.cream', /**/ size: 38, maxWidth: 600, maxLines: 3, weight: 800, align: 'center' }); // + box: a colour, count, runInk, at, rotation, scale
circle({ id: 'hut', fill: 'mid.mist', r: 50, rise: 70, roof: { kind: 'cone', height: 40 }, openings: { width: 12, height: 34 } }); // or 'gable', 'hip' (+ ridge; region: run), 'dome'; + contrast; + step, rows, shape: 'arch', sill, inset, color (walls too)
group({ id: 'town', sort: 'depth', cast: { color: 'deep.night' }, detail: { min: 10 } }); // far to near; shadows (+ opacity, length, dir, soft, over: 'flat'), plain under min px
eye({ id: 'pupil', r: 13, white: 'light.cream', pupil: 'deep.night', lookAt: 'hex', /**/ blink: true, open: 1 }); // + at, scale, opacity
```

- Shapes take `circle`'s options and, opt-in, `rimLight`, `idle: { amp, period }`, `follow`, `body`, `cover`, `backdrop`, `clipTo`, `level`, `highlight: false`, `lift` (0..1 of the glow's), `soft` (a blurred edge; groups too), `rise` (a body that high; + `side`; strokes too), `stands` (a sail). `relief`: hills. All but `region` are convex; a `group` composes them.
- `stroke`: `smooth: 0`: straight lines; `arcPoints(center, r, from, to)`: an arc or a ring (degrees).
- `label`: its tail points at `target`'s edge on `side`; text wraps, then shrinks, never cut. `text`: free-standing; a shape's child lies on it; in a `parallax: 0` layer, the frame's.

## Springs and rigid bodies

```ts
capsule({ id: 'tail', fill: 'mid.mist', length: 46, r: 8, origin: 'start', sway: 'springy' }); // swings about its first end; or 'heavy', 'light', 'viscous'
circle({ id: 'moon', fill: 'light.cream', r: 9, follow: { f: 2.4, z: 0.26, r: 0 } }); // Hz, damping, response: its position lags; also groups, labels
rect({ id: 'floor', fill: 'mid.mist', at: [0, 400], w: 600, h: 36, body: { kind: 'fixed' } });
circle({ id: 'ball', fill: 'mid.mist', r: 30, body: { kind: 'dynamic', release: 2, velocity: [0, 0], spin: 0, density: 1, appear: 'always' } }); // from velocity on: defaults
shot({ ...scene, /**/ physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 } });
```

A dynamic body waits, touching nothing, till `release` (s, from -`prewarm`), then only physics moves it. `velocity`: units/s; `spin`: deg/s; `appear: 'release'`: undrawn till then.

## Motion and timing

```ts
moveTo('dot', { at: 1.2, to: [260, -40], /**/ dur: 1.1, anticipation: 0.08, overshoot: 0.07, arc: 0.12 }); // shares of the distance. Or arrive: when it first reaches `to`
hop('buddy', { at: 4, to: [610, 130], /**/ dur: 0.6, height: 80 }); // a parabola; or land:
travel('bead', { at: -1, path: [[-900, -260], [-300, 150]], speed: 250, /**/ profile: 'steady', closed: false, orient: false, only: false }); // speed: units/s, or dur, or speeds: [[s, speed], ...]; + roll: wheel radius; [x, y, h]: heights
turnTo('hex', { at: 2, to: 90, /**/ dur: 0.8, overshoot: 0.1 }); // absolute degrees. + profile: no overshoot ('steady': a spin); for to: speed (deg/s) or speeds; about: 'x' | 'y': a plane group's hinge
scaleTo('hex', { at: 3, to: 1.5, /**/ dur: 0.6, overshoot: 0.15 }); // times the authored size; it lasts. to: [sx, sy], pivot: its own axes. + profile: no overshoot
fadeTo('hex', { at: 4, to: 0.3, /**/ dur: 0.5 });
fillTo('hex', { at: 5, to: 'accent.amber', /**/ dur: 0.6, profile: 'ease' });
popIn('c', { at: 0.3, /**/ dur: 0.55, overshoot: 0.18 }); // hidden before at
popOut('c', { at: 3, /**/ dur: 0.35 });
bump('c', { at: 2, /**/ amount: 0.14 }); // a kick of the size, 0.7 s
squash('buddy', { at: 5, /**/ amount: -0.22, dur: 0.6, pivot: [0, 0] }); // lower and wider about pivot
countTo('total', { at: 2, to: 1500, /**/ dur: 1, profile: 'ease' }); // a text with count: 0 and "{n}" in its string; + ratio: true
levelTo('drink', { at: 2, to: 0.8, /**/ dur: 1.5, profile: 'ease' }); // 0 empty, 1 full
riseTo('hex', { at: 6, to: 40, /**/ dur: 0.8, profile: 'ease' });
hazeTo('air', { at: 2, to: 6, /**/ dur: 1.5, profile: 'ease' });
drawOn('wire', { at: 1, /**/ dur: 0.6 }); // hidden before at. A stroke: + to (a share), profile, ramp
solidTo('route', { at: 5, /**/ to: 1, dur: 0.6 }); // closes the gaps of its dashes
bendTo('wire', { at: 3, to: 0, /**/ dur: 0.8, overshoot: 0.25 }); // taut (0), or it sags
widthTo('wire', { at: 4, to: 20, /**/ dur: 0.6, overshoot: 0.15 }); // a link's or stroke's width
reshape('isle', { at: 2, points: [[-200, 0], [0, -60], [200, 0], [0, 90]], /**/ dur: 1.2, profile: 'ease' }); // a region or a stroke, point for point; + smooth; matchPoints, reachedAt: any two outlines
drive('dot', { dur: 4, by: (t) => ({ at: [200 * t, 0] }), /**/ at: 0 }); // a function of time: at, rotation, scale, opacity, depth, points; or samples: { at: [...] }
pulse('wire', { at: 2, /**/ dur: 0.7, bump: 0.14 }); // bumps the far node at at + dur. A stroke: + from, to (shares), profile, length, node
openTo('pupil', { at: 1, to: 1, /**/ dur: 0.3, overshoot: 0.12 }); // lids: 1 open, 0 shut
blink('pupil', { at: 3 });
stagger(['a', 'b'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })); // + order: 'reverse', 'center-out', 'edges-in'
```

- A negative `at` (to -600): under way at frame 0.
- No key is anchored to a word: take `at` from word times; `arrive`, `land`, `at + dur` are exact.
- `profile`: `'settle'` (`moveTo` only): back away, shoot past, settle. `'ease'`: rest to rest. `'steady'`: one speed. `'in'`, `'out'`: one eased end (`ramp`: its share of `dur`, 0.3).

## Effects

```ts
emitter({ id: 'fizz', colors: ['mid.mist'], size: [4, 8], life: 4, rate: 9, sizing: 'steady', clipTo: 'drink', /**/ area: [0, 0], prewarm: 0, direction: -90, spread: 360, speed: [20, 60], gravity: [0, 0], drag: 0.8 });
rect({ id: 'drink', fill: 'mid.mist', w: 264, h: 344, level: { at: 0.1, wave: { amp: 5, length: 160, speed: 40 } } });
rect({ id: 'air', fill: 'mid.mist', w: 800, h: 500, opacity: 0, haze: { amount: 3 } }); // what is drawn before it wavers; + scale 40, speed 30, direction -90
```

- An emitter needs `rate` (/s), `bursts: [{ at, count }]` or `onContact: { count, minImpulse }`. `size` (radius), `life` (s), `speed` (units/s): a number or `[min, max]`. `sizing`: `'steady'` or `'spark'` (shrinks away). Also `at`, `from`, `until`, `attach`, `turbulence`, `core`, `glow`, `streak` (s of way as a tail).
- `cover`: hides the glow drawn before it. `backdrop`: labels may lie on it. `clipTo`: only inside that shape, fading at a `soft` edge; a coast: `clipMask` on it. `level` (or 0..1): fills from the bottom, `wave` ripples it, children ride it.

## Sound

```ts
circle({ id: 'marble', fill: 'mid.mist', r: 30, sound: 'marble' }); // the node's voice: the bank's sound "marble.<kind>", or "marble"
popIn('c', { at: 1, sound: false }); // any intent: false mutes it, a key names its start's sound
sfx('chime', { at: 6, /**/ gain: 1 }); // by hand, as on a word; + node: panned to it
```

Only what is seen sounds.

## Command line

```
npx skink3 <command> <scene.ts> [options]
check   palette, strings, glyphs, text fit; reviews in short [--bank bank.json]
bake    [--force]
still   frames as PNG --frame n[,n] | --time s[,s] [--hash]
strip   side by side --from f [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   [--cols 6] [--rows 5] [--frames n,n] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  [--workers n] [--chunk f] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion  [--pictures [--top 3]]
physics as motion
trail   ghosts --node id[,id] [--from f] [--to f] | [--time s,s] [--every k] [--space stage|screen]
graph   speed --node id | --camera [--from f] [--to f] | [--time s,s]
events  intents, contacts, bursts as JSON
sfx     the sound track, a WAV --bank bank.json [--sheet [--cols 4] [--tile 480]]
queue   render slots: SKINK3_RENDER_SLOTS (4; 0: off)
common  --lang tag (first table) --width px (1920) --cpu --out file (./out/<shot>/) --cache dir (./cache) --priority high|low
```

Commands bake as needed. `check` fails on a broken palette rule, a missing string or glyph, text that overflows, leaves the frame or overlaps, else warns. `--crop`: stage units from top-left.

## Reading the reviews

- `jump`: a teleport or pop: check its keys; change place while hidden.
- `abrupt-start`, `abrupt-stop`: no ease at that end: `'ease'`, `'in'`, `'out'`, or keep `anticipation`, `overshoot`.
- `mechanical`: one speed between two rests in view: `'ease'`, or enter or leave the frame.
- `too-fast`: over half its size per frame, it strobes: slower, larger, a `streak` (1/30 s); a haze: slower, larger `scale`.
- `spring-ringing`: swinging 2.5 s after its target stops: raise `z` or `f`.
- `spring-no-overshoot`: a bouncy spring only lags: lower `f` or `z`, or drop it.
- `dead-area`: only the camera moves for 4 s: add an `idle`, a pulse, particles, haze.
- `overlap`: bodies in each other: released inside one or poured too fast.
- `tunnelling`: through a wall or gap: thicker, overlapping walls, less load.
- `escape`: below every fixed body: widen the ground or mark it.
- `jitter`: trembling at rest: more `friction` or `angularDamping`, larger bodies.
- `unsettled`: a pile still moves at the end: pour earlier, damp more.
- `energy-spike`: speed from nowhere: bodies released in each other or a wall.
- `unseen-hit`: a bounce off an undrawn body: they collide from release on.
- `not-finite`: the simulation broke: an extreme velocity, size or spring `f`.
- `low-contrast` (with `contrast`): a node or its `run` blends in: change a colour.

Not reported: what is hidden, off the frame, behind a `cover`, outside its clip. Mark what is meant:

```ts
shot({ ...scene, contrast: { nodes: ['dot'], lightness: 18, colour: 24 } }); // off unless given; it blends below both: L*, a*b* (colourDistance(a, b)); + edge, seconds
shot({ ...scene, intended: [intended('dot', 'abrupt-start', 'it is kicked')] }); // + { from, to }: s; also '(camera)', '(perspective:room)', '(frame)', '(frame:top-left)'
```

## Index

SCENES.md: **The model in one page**; **Minimal example**; **Space, time, units**; **Colours: the palette**; **Text: string tables**; **`shot`** (camera, zoom, background keys, physics); **`layer`**; **Nodes**; **Timeline: intents**; **A perspective layer**; **Springs: secondary motion**; **Rigid bodies**; **Generating content in a scene**; **Checks**; **Motion review**, **Physics review**, **Contrast review**; **Sound**; **Command line**; **From another repository**; **Programmatic use**; **What is not there yet**.

MOTION-REVIEW.md: **The findings**, **The life of the background**, **Reading a trail**, **Reading a graph**, **Thresholds**.

PHYSICS-REVIEW.md: **The findings**, **Reading the pictures**, **Thresholds**.

## Other exports

```
constants: STAGE_W STAGE_H FPS SIM_DT SUBSTEPS ROLES CAMERA_DEFAULTS PHYSICS_DEFAULTS SPRING_PRESETS MOVE_PROFILES DEFAULT_RAMP EASINGS MOTION_FINDING_KINDS PHYSICS_FINDING_KINDS CONTRAST_FINDING_KINDS CAMERA_SUBJECT FRAME_SUBJECT FRAME_REGIONS
errors: SceneError IntentError PaletteError
functions: hexToHsv lightness mix resolveColor checkPalette ease moveTimes profilePeak rampProgress pathLength pathTable pathAt pathHeightAt frameToSeconds secondsToFrame Noise
```

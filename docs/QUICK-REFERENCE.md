# Quick reference for scene authors

- After `/**/`: defaults.
- 1920 x 1080, origin centred, y down; parent `[x,y]`, s at 60 fps; degrees clockwise, 0 right.

## A scene module

```ts
import { circle, definePalette, hsv, layer, moveTo, popIn, Rng, shot } from 'skink3-engine';

const palette = definePalette({ deep: { night: hsv(250, 0.9, 0.2) }, dark: { indigo: hsv(258, 0.8, 0.5) }, mid: { mist: hsv(250, 0.5, 0.7) }, accent: { amber: hsv(40, 0.9, 1) }, light: { cream: hsv(52, 0.3, 1) } });
new Rng(7, 'scatter').range(-800, 800); // + int, pick, shuffle, gauss, stream
const scene = shot({
  id: 'minimal', seconds: 4, seed: 1, palette, strings: { en: { 'label.dot': 'A dot' } },
  background: { inner: 'dark.indigo', outer: 'deep.night' }, atmosphere: 'mid.mist',
  layers: [layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.amber' })] })],
  timeline: [popIn('dot', { at: 0.3 }), moveTo('dot', { at: 1.2, to: [260, -40] })],
});
export default scene;
```

- Colours: palette keys; text: `strings` keys. A palette has `rules` (held by `check`), `tones`, variants.

## Shot, camera, layers

```ts
shot({ ...scene, /**/ light: { from: 'top-left' }, vignette: 0.5, camera: { at: [0, 0], drift: { speed: 0.5, heading: 0, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 }, focus: { far: 6, near: 60 } } });
shot({ ...scene, camera: { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 } } });
shot({ ...scene, camera: { drift: { speeds: [[0, 30], [4, 30], [6, 240]] } } }); // units/s; or path.speeds
cameraTo({ at: 2, zoom: 1.6, to: [200, 0], /**/ dur: 1.2, profile: 'ease' }); // zoom, to, or both
zoomTo({ at: 6, to: 1.15, /**/ dur: 3 }); // zoom alone
backgroundTo({ at: 3, inner: 'deep.night', /**/ dur: 2, profile: 'ease' }); // + outer, center, radius, atmosphere, vignette
layer({ id: 'far', depth: 1.5, nodes: [] }); // + blur, parallax, tint
layer({ id: 'room', depth: 0, nodes: [], perspective: { aim: [0, 0, 0], distance: 1600, tilt: 0, turn: 0 } }); // or true: a space, z away, with its camera; + lens
perspectiveTo('room', { at: 2, tilt: 50, /**/ dur: 1.6 }); // + aim, distance (a dolly), turn, lens (a zoom)
blurTo('far', { at: 2, to: 0, /**/ dur: 1.2 }); // a focus pull
cut({ at: 4 }); cameraTo({ at: 4, zoom: 2, dur: 0 }); // dur 0 on a cut: cameraTo, zoomTo, backgroundTo, perspectiveTo, blurTo, fadeTo
```

- `drift.speed`: units/frame along `heading` (0.3-0.7 px). `wander`: units; `period`: s; `focus`: blur per unit of depth.
- A `path` replaces `at`, `drift.speed`, `drift.heading`: a closed one with `speed` (units/frame) loops (`loopPoints(center, r | [rx, ry])`), else runs once.
- Keys chain. `cameraTo`: `zoom` times the view, `to` its aim; path and drift wait. Under `zoomTo` they run on.
- A `cut` restarts the push-in and springs; drift `speeds` may step there.
- `depth` 0: in focus; positive: far (less parallax, blurred, tinted); to -0.9: near. Far first, then list order, parents first.
- A listed node's `depth` (larger: behind) orders a layer. Perspective layer: `at: [x, y, z]`, facing the camera; `region`, `stroke`: `points` of three; a `plane` group lies in it.
- Dense maps: `sampledBackdrop: { group, frames }`.

## Nodes

```ts
circle({ id: 'c', fill: 'mid.mist', r: 90, /**/ at: [0, 0], rotation: 0, scale: 1, opacity: 1, lit: true, glow: 0, children: [] });
capsule({ id: 'arm', fill: 'mid.mist', length: 46, r: 8, /**/ origin: 'center' }); // tip to tip
polygon({ id: 'hex', fill: 'mid.mist', sides: 6, r: 50, /**/ radius: 8 }); // 0.16 r; or points: [[x, y], ...], radius: 0
rect({ id: 'tray', fill: 'mid.mist', w: 240, h: 50, /**/ radius: 11 }); // 0.22 of the short side
blob({ id: 'buddy', fill: 'mid.mist', r: 50, /**/ points: 9, wobble: 0.14, seed: 1 });
region({ id: 'isle', fill: 'mid.mist', points: [[-200, 0], [0, -120], [200, 0], [0, 40]], /**/ smooth: 1 }); // free-form, no body; <=600 points, lit: false <=4000
group({ id: 'face', /**/ upright: false, children: [] }); // upright: not turned by its parent; plane: 'floor' | 'wall' | 'side' | { x, y }, back, tall, fog, ground; screen: { size, least, most | keep }
link({ id: 'wire', from: 'hex', to: 'buddy', color: 'mid.mist', /**/ pulseColor: 'mid.mist', bend: 0.12, width: 7, glow: 0 });
stroke({ id: 'route', points: [[-300, 0], [0, -80], [300, 0]], color: 'mid.mist', /**/ width: 7, closed: false, smooth: 1, glow: 0 }); // + dash [length,gap], flow (units/s), drawn, pulseColor, least, curveSteps
label({ id: 'note', text: 'label.dot', target: 'c', fill: 'light.cream', ink: 'deep.night', /**/ side: 'top', size: 38, maxWidth: 420, maxLines: 3 }); // + count; runInk: '2.0 · [Aug 2026]': runs in that ink
text({ id: 'title', text: 'label.dot', ink: 'light.cream', /**/ size: 38, maxWidth: 600, maxLines: 3, weight: 800, align: 'center' }); // + box: a colour, count, runInk
circle({ id: 'hut', fill: 'mid.mist', r: 50, rise: 70, roof: { kind: 'cone', height: 40 }, openings: { width: 12, height: 34 } }); // or 'gable', 'hip' (+ ridge; region: run), 'dome'; + contrast, step, rows, shape: 'arch', sill, inset, color
group({ id: 'town', sort: 'depth', cast: { color: 'deep.night' }, detail: { min: 10 } }); // far to near; shadows (+ opacity, length, dir, soft, over: 'flat', ground: true), plain under min px
eye({ id: 'pupil', r: 13, white: 'light.cream', pupil: 'deep.night', lookAt: 'hex', /**/ blink: true, open: 1 }); // + reach: to 0.8 (0.4)
globe({ id: 'earth', r: 300, fill: 'dark.indigo', layers: [{ rings: [globeBlob({ at: [10, 40], r: 8 })], fill: 'mid.mist' }], light: { night: 'deep.night' }, /**/ view: [0, 0], spin: 0, shade: 0.25 }); // rings: [lon, lat]; spin: deg/s east, or keys; + lights, air
globeBlob({ at: [10, 40], r: 8, /**/ points: 28, wobble: 0.25, stretch: 1, seed: 1 }); // a cloud
lens({ id: 'loupe', of: 'map', look: 'c', zoom: 3, r: 150, fill: 'light.cream', /**/ width: 4, leader: true }); // or w, h, radius
fabric({ id: 'town', blocks: [[[0, 0], [9, 0], [9, 9]]], fills: 'mid.mist' }).node; // + squares, streets, clear, shadow, rim, detail, part
```

- Shape options: `rimLight`, `idle: { amp, period }`, `follow`, `body`, `highlight: false`, `lift`, `soft` (groups too), `rise` (+ `side`; strokes too), `stands` (a sail). `relief`: `reliefHeight`, `samplePixels`, `picture`, `backdrop`, `smooth`, `shadows: true | { color, amount, soft }`.
- `stroke`: `smooth: 0`: straight; `arcPoints(center, r, from, to)`: arc or ring (degrees).
- `globe`: layer `drift` (deg/s), `soft`, `id` (`fadeTo`, `fillTo`); `light`: `from`, `lit`, `night`. Children at `[lon, lat, height?]` ride its turn, hidden behind, heading `rotation`; a `[lon, lat]` `stroke` lies on it.
- `label`: tail at `target`'s edge on `side`; wraps, then shrinks, never cut. `text`: free-standing; a shape's child: on it; in a `parallax: 0` layer: the frame's.

## Springs and rigid bodies

```ts
capsule({ id: 'tail', fill: 'mid.mist', length: 46, r: 8, origin: 'start', sway: 'springy' }); // swings about its first end; or 'heavy', 'light', 'viscous'
circle({ id: 'moon', fill: 'light.cream', r: 9, follow: { f: 2.4, z: 0.26, r: 0 } }); // Hz, damping, response: its place lags; groups, labels too
rect({ id: 'floor', fill: 'mid.mist', at: [0, 400], w: 600, h: 36, body: { kind: 'fixed' } });
circle({ id: 'ball', fill: 'mid.mist', r: 30, body: { kind: 'dynamic', release: 2, velocity: [0, 0], spin: 0, density: 1, appear: 'always' } }); // waits till release (s); from velocity (units/s; spin: deg/s) on: defaults; appear: 'release': undrawn till then
shot({ ...scene, /**/ physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 } });
```

## Motion and timing

```ts
moveTo('dot', { at: 1.2, to: [260, -40], /**/ dur: 1.1, anticipation: 0.08, overshoot: 0.07, arc: 0.12 }); // shares of distance. arrive: when at `to`
hop('buddy', { at: 4, to: [610, 130], /**/ dur: 0.6, height: 80 }); // a parabola; or land:
travel('bead', { at: -1, path: [[-900, -260], [-300, 150]], speed: 250, /**/ profile: 'steady', closed: false, orient: false, only: false }); // units/s, or dur, or speeds: [[s, v], ...]; + roll: wheel radius; [x, y, h]: heights
turnTo('hex', { at: 2, to: 90, /**/ dur: 0.8, overshoot: 0.1 }); // degrees. + profile: no overshoot ('steady': spin); for to: speed (deg/s), speeds; about: 'x' | 'y': plane hinge
scaleTo('hex', { at: 3, to: 1.5, /**/ dur: 0.6, overshoot: 0.15 }); // times its size, lasting; to: [sx, sy], pivot: own axes; + profile: no overshoot
fadeTo('hex', { at: 4, to: 0.3, /**/ dur: 0.5 });
fillTo('hex', { at: 5, to: 'accent.amber', /**/ dur: 0.6, profile: 'ease' });
colorTo('wire', { at: 5, to: 'accent.amber' }); // a link or stroke
popIn('c', { at: 0.3, /**/ dur: 0.55, overshoot: 0.18 }); // hidden before at
popOut('c', { at: 3, /**/ dur: 0.35 });
bump('c', { at: 2, /**/ amount: 0.14 }); // a size kick, 0.7 s
squash('buddy', { at: 5, /**/ amount: -0.22, dur: 0.6, pivot: [0, 0] }); // lower and wider about pivot
countTo('total', { at: 2, to: 1500, /**/ dur: 1, profile: 'ease' }); // count: 0 or { from, decimals, grouping: false } on a text, label: "{n}"; + ratio
levelTo('drink', { at: 2, to: 0.8, /**/ dur: 1.5, profile: 'ease' }); // 0 empty, 1 full
riseTo('hex', { at: 6, to: 40, /**/ dur: 0.8 });
sunTo('hills', { at: 2, from: 45, /**/ dur: 2 }); // + high: a relief's light
hazeTo('air', { at: 2, to: 6, /**/ dur: 1.5 });
drawOn('wire', { at: 1, /**/ dur: 0.6 }); // hidden before at. Stroke: + to (a share), profile, ramp
solidTo('route', { at: 5, /**/ to: 1, dur: 0.6 }); // closes its dashes
bendTo('wire', { at: 3, to: 0, /**/ dur: 0.8, overshoot: 0.25 }); // taut (0), or it sags
widthTo('wire', { at: 4, to: 20, /**/ dur: 0.6, overshoot: 0.15 }); // a link's or stroke's width
reshape('isle', { at: 2, points: [[-200, 0], [0, -60], [200, 0], [0, 90]], /**/ dur: 1.2, profile: 'ease' }); // a region or stroke, point for point; + smooth; matchPoints, reachedAt
drive('dot', { dur: 4, by: (t) => ({ at: [200 * t, 0] }), /**/ at: 0 }); // at, rotation, scale, opacity, depth, points by time; or samples
pulse('wire', { at: 2, /**/ dur: 0.7, bump: 0.14 }); // bumps the far node at at + dur. Stroke: + from, to (shares), profile, length, node
openTo('pupil', { at: 1, to: 1, /**/ dur: 0.3, overshoot: 0.12 }); // lids: 1 open, 0 shut
blink('pupil', { at: 3 });
stagger(['a', 'b'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })); // + order: 'reverse', 'center-out', 'edges-in'
```

- Negative `at` (to -600): under way at frame 0. `arrive`, `land`, `at + dur` are exact.
- `profile`: `'settle'` (`moveTo`): back, past, settle. `'ease'`: rest to rest. `'steady'`: one speed. `'in'`, `'out'`: one eased end (`ramp`: share of `dur`, 0.3).

## Effects

```ts
emitter({ id: 'fizz', colors: ['mid.mist'], size: [4, 8], life: 4, rate: 9, sizing: 'steady', clipTo: 'drink', /**/ area: [0, 0], prewarm: 0, direction: -90, spread: 360, speed: [20, 60], gravity: [0, 0], drag: 0.8 });
rect({ id: 'drink', fill: 'mid.mist', w: 264, h: 344, level: { at: 0.1, wave: { amp: 5, length: 160, speed: 40 } } });
rect({ id: 'air', fill: 'mid.mist', w: 800, h: 500, opacity: 0, haze: { amount: 3 } }); // wavers what is drawn before; + scale 40, speed 30, direction -90
```

- An emitter needs `rate` (/s; `rateTo('fizz', { at: 2, to: 30 })`), `bursts: [{ at, count }]` or `onContact: { count, minImpulse }`. `size` (radius), `life` (s), `speed` (units/s): n or `[min, max]`. `sizing: 'spark'` shrinks, `'grow'` grows; `fade: [birth, death]`: each one's opacity; `opacity`: all (`fadeTo`). + `at`, `from`, `until`, `attach`, `turbulence`, `core`, `glow`, `streak`.
- `cover`: hides the glow drawn before it. `backdrop`: labels may cover it. `clipTo`: only inside that shape (`['a', 'b']`: their union), faded at a `soft` edge; a coast: `clipMask`. `level` (or 0..1): fills from the bottom; `wave` ripples it.

## Sound

```ts
circle({ id: 'marble', fill: 'mid.mist', r: 30, sound: 'marble' }); // its voice: bank key "marble.<kind>", or "marble"
popIn('c', { at: 1, sound: false }); // any intent: false mutes, a key names its sound
sfx('chime', { at: 6, /**/ gain: 1 }); // by hand; + node: panned to it
```

## Command line

```
npx skink3 <command> <scene.ts> [options]
check   [--bank bank.json]
bake    [--force]
still   --frame n[,n] | --time s[,s] [--hash] [--alone]
strip   --from f [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   [--cols 6] [--rows 5] [--frames n,n] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  [--workers n] [--chunk f] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--reuse-scene] [--force]
motion  [--pictures [--top 3]]
physics as motion
trail   --node id[,id] [--from f] [--to f] | [--time s,s] [--every k] [--space stage|screen]
graph   --node id | --camera [--from f] [--to f] | [--time s,s]
events  as JSON
sfx     a WAV --bank bank.json [--sheet [--cols 4] [--tile 480]]
queue   render queue status
common  --lang tag (first table) --width px (1920) --cpu --out file --cache dir
```

`--group`: shared admission (not macOS). `--crop`: units, top-left. `--alone`: ~1 s a frame.

## Reading the reviews

- `jump`: a teleport, pop or light swing (`sunTo`): check its keys; change place while hidden.
- `abrupt-start`, `abrupt-stop`: no ease at that end: `'ease'`, `'in'`, `'out'`, or `anticipation`, `overshoot`; speed keys: longer.
- `mechanical`: one speed between two rests in view: `'ease'`, or enter or leave.
- `too-fast`: over half its size per frame: slower, larger, a `streak` (1/30 s); a haze: larger `scale`; `flow`: slower; `lens`: lower `zoom`.
- `spring-ringing`: swings 2.5 s after its target stops: raise `z` or `f`. `spring-no-overshoot`: only lags: lower `f` or `z`, or drop it.
- `dead-area`: only the camera moves for 4 s: add `idle`, a pulse, particles, haze.
- `overlap`, `energy-spike`: bodies released in each other or a wall, or poured too fast. `tunnelling`: thicker walls, less load. `escape`: below all fixed bodies: widen the ground.
- `jitter`, `unsettled`: trembling at rest, a pile moving at the end: more `friction`, `angularDamping`; pour earlier. `unseen-hit`: off an undrawn body. `not-finite`: extreme velocity, size or spring `f`.
- `low-contrast` (with `contrast`): a node or its `run` blends in: recolour it.

Not reported: hidden, off frame, behind a `cover`, outside its clip, across a `cut`. Mark what is meant:

```ts
shot({ ...scene, contrast: { nodes: ['dot'], lightness: 18, colour: 24 } }); // off unless given; blends below both: L*, a*b* (colourDistance(a, b)); + edge, seconds
shot({ ...scene, intended: [intended('dot', 'abrupt-start', 'it is kicked')] }); // + { from, to }: s; also '(camera)', '(perspective:room)', '(focus:far)', '(frame)', '(frame:top-left)'
```

## Index

SCENES.md: **The model in one page**; **Minimal example**; **Space, time, units**; **Colours: the palette**; **Text: string tables**; **`shot`**; **`layer`**; **Nodes**; **Timeline: intents**; **A perspective layer**; **A globe**; **A world map**; **Springs: secondary motion**; **Rigid bodies**; **Generating content in a scene**; **Checks**; **Motion review**, **Physics review**, **Contrast review**; **Sound**; **Command line**; **From another repository**; **Programmatic use**; **What is not there yet**.

MOTION-REVIEW.md, PHYSICS-REVIEW.md: findings, pictures, thresholds.

## Other exports

```
constants: STAGE_W STAGE_H FPS SIM_DT SUBSTEPS ROLES CAMERA_DEFAULTS PHYSICS_DEFAULTS SPRING_PRESETS MOVE_PROFILES DEFAULT_RAMP EASINGS MOTION_FINDING_KINDS PHYSICS_FINDING_KINDS CONTRAST_FINDING_KINDS CAMERA_SUBJECT FRAME_SUBJECT FRAME_REGIONS
errors: SceneError IntentError PaletteError
functions: hexToHsv mix resolveColor checkPalette moveTimes profilePeak rampProgress pathLength pathTable pathAt pathHeightAt frameToSeconds secondsToFrame Noise
maps: water woods trees flecks parcels houses logRoad locator inside distTo scatter selectByCell oval smoothLine patches fillRings
```

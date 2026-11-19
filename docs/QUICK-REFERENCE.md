# Quick reference for scene authors

What a scene can use. Open [SCENES.md](SCENES.md) or a review document only at a section the index names. What is in neither is not built.

- What follows `/* = */` is a default.
- Units: a stage of 1920 x 1080, origin in the centre, y down; `[x, y]` (a `Vec2`) in the parent's space; seconds of 60 frames; degrees clockwise, 0 right.

## A scene module

```ts
import { circle, definePalette, hsv, layer, moveTo, popIn, Rng, shot } from 'skink3-engine';

const palette = definePalette({
  deep: { night: hsv(250, 0.88, 0.2), abyss: hsv(240, 0.9, 0.11) }, dark: { indigo: hsv(258, 0.8, 0.5) },
  mid: { mist: hsv(250, 0.46, 0.74) }, accent: { amber: hsv(40, 0.86, 0.99), aqua: hsv(176, 0.72, 0.93) },
  light: { cream: hsv(52, 0.34, 0.99) },
});
new Rng(7, 'scatter').range(-800, 800); // seeded by both; also int, pick, shuffle, next, sign, gauss, stream
const scene = shot({
  id: 'minimal', seconds: 4, seed: 1, palette, strings: { en: { 'label.dot': 'A dot' } },
  background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist',
  layers: [layer({ id: 'stage', depth: 0, nodes: [
    circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.aqua' }),
  ] })],
  timeline: [popIn('dot', { at: 0.3 }), moveTo('dot', { at: 1.2, to: [260, -40] })],
});
export default scene;
```

- Colours: palette references only. On-screen text: keys of `strings`, each in every language. Random numbers: `Rng` only. A mistake or unknown option is refused, with the fix.
- The engine has no colour rule: a palette brings its `rules` (held by `check`), `tones`, variants (see the index).

## Shot, camera, layers

```ts
shot({ ...scene, /* = */ light: { from: 'top-left' }, vignette: 0.5, camera: { at: [0, 0], drift: { speed: 0.5, heading: 0, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 }, focus: { far: 6, near: 60 } } });
shot({ ...scene, camera: { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 } } });
cameraTo({ at: 2, zoom: 1.6, to: [200, 0], /* = */ dur: 1.2, profile: 'ease', ramp: 0.3 }); // zoom, to, or both
zoomTo({ at: 6, to: 1.15, /* = */ dur: 3, profile: 'ease', ramp: 0.3 }); // zoom alone
backgroundTo({ at: 3, inner: 'deep.abyss', /* = */ dur: 2, profile: 'ease', ramp: 0.3 }); // + outer, center, radius, atmosphere, vignette
layer({ id: 'far', depth: 1.5, nodes: [] }); // + blur, parallax, tint
layer({ id: 'room', depth: 0, nodes: [], perspective: { aim: [0, 0, 0], distance: 1600, tilt: 0, turn: 0 } }); // or true: a space, z away, with its camera; + lens
perspectiveTo('room', { at: 2, tilt: 50, /* = */ dur: 1.6, profile: 'ease', ramp: 0.3 }); // + aim, distance (a dolly), turn, lens (a zoom)
```

- `drift.speed`: units/frame along `heading` (norm: 0.3 to 0.7 px). `wander`: units; `period`: s; `focus`: blur per unit of depth.
- A `path` replaces `at`, `drift.speed`, `drift.heading`. With `speed` (units/frame) it rounds a closed path all shot long (`loopPoints(center, r | [rx, ry])`); without, it covers it once.
- Keys chain. `cameraTo`: `zoom`: times the authored view; `to`: where it looks at the end; path and drift wait. Under `zoomTo` they run on.
- `depth` 0 is the focus plane; above 0 farther (less parallax, blurred, tinted to `atmosphere`), below 0, to -0.9, nearer. Drawn farthest first, nodes as listed, children after the parent.
- A listed node's `depth` (larger: behind) orders any layer. Perspective layer: listed nodes take `at: [x, y, z]` and face the camera, `region` and `stroke` `points` of three, a `group` with `plane` lies in the space; near over far.

## Nodes

```ts
circle({ id: 'c', fill: 'accent.aqua', r: 90, /* = */ at: [0, 0], rotation: 0, scale: 1, opacity: 1, lit: true, glow: 0, children: [] });
capsule({ id: 'arm', fill: 'accent.amber', length: 46, r: 8, /* = */ origin: 'center' }); // a stick, tip to tip
polygon({ id: 'hex', fill: 'mid.mist', sides: 6, r: 50, /* = */ radius: 8 }); // 0.16 r; or points: [[x, y], ...], radius: 0
rect({ id: 'tray', fill: 'dark.indigo', w: 240, h: 50, /* = */ radius: 11 }); // 0.22 of the short side
blob({ id: 'buddy', fill: 'accent.amber', r: 50, /* = */ points: 9, wobble: 0.14, seed: 1 });
region({ id: 'isle', fill: 'dark.indigo', points: [[-200, 0], [0, -120], [200, 0], [0, 40]], /* = */ smooth: 1 }); // free-form, concave allowed; no body
group({ id: 'face', /* = */ upright: false, children: [] }); // + at, rotation, scale, opacity; upright: no turning with its parent; plane: 'floor' | 'wall' | 'side' | { x, y }, back
link({ id: 'wire', from: 'hex', to: 'buddy', color: 'mid.mist', /* = */ pulseColor: 'mid.mist', bend: 0.12, width: 7, glow: 0 });
stroke({ id: 'route', points: [[-300, 0], [0, -80], [300, 0]], color: 'accent.amber', /* = */ width: 7, closed: false, smooth: 1, glow: 0 }); // + dash: [dash, gap] (0: dots), drawn, pulseColor, at, rotation, scale
label({ id: 'note', text: 'label.dot', target: 'c', fill: 'light.cream', ink: 'deep.night', /* = */ side: 'top', size: 38, maxWidth: 420, maxLines: 3 });
text({ id: 'title', text: 'label.dot', ink: 'light.cream', /* = */ size: 38, maxWidth: 600, maxLines: 3, weight: 800, align: 'center' }); // no pointer; + box: a colour, count, at, rotation, scale
eye({ id: 'pupil', r: 13, white: 'light.cream', pupil: 'deep.abyss', lookAt: 'hex', /* = */ blink: true, open: 1 }); // + at, scale, opacity
```

- Shapes take the options of `circle` and, opt-in, `rimLight`, `idle: { amp, period }`, `follow`, `body`, `cover`, `backdrop`, `clipTo`, `level`, `highlight: false` (no highlight stroke), `lift` (0..1 of the glow's sky lift). All but `region` are convex; a `group` composes them.
- `stroke`: `smooth: 0`: straight lines; `arcPoints(center, r, from, to)`: an arc or a ring (degrees).
- `label`: its tail points at `target`'s edge on `side`; the text wraps, then shrinks, never cut. `text`: free-standing; a child of a shape lies on it; in a `layer` with `parallax: 0` it belongs to the frame.

## Springs and rigid bodies (opt-in)

```ts
capsule({ id: 'tail', fill: 'accent.amber', length: 46, r: 8, origin: 'start', sway: 'springy' }); // it swings round its first end; or 'heavy', 'light', 'viscous'
circle({ id: 'moon', fill: 'light.cream', r: 9, follow: { f: 2.4, z: 0.26, r: 0 } }); // Hz, damping, response: its position lags; also groups, labels
rect({ id: 'floor', fill: 'dark.indigo', at: [0, 400], w: 600, h: 36, body: { kind: 'fixed' } });
circle({ id: 'ball', fill: 'accent.amber', r: 30, body: { kind: 'dynamic', release: 2, velocity: [0, 0], spin: 0, density: 1, appear: 'always' } }); // from velocity on: the defaults
shot({ ...scene, /* = */ physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 } });
```

A dynamic body waits, touching nothing, until `release` (s; down to minus `prewarm`, simulated before frame 0); then only the simulation moves it. `velocity`: units/s; `spin`: deg/s; `appear: 'release'`: undrawn until then.

## Motion and timing

```ts
moveTo('dot', { at: 1.2, to: [260, -40], /* = */ dur: 1.1, anticipation: 0.08, overshoot: 0.07, arc: 0.12 }); // shares of the distance. Or arrive: when it first reaches `to`
hop('buddy', { at: 4, to: [610, 130], /* = */ dur: 0.6, height: 80 }); // a parabola; or land:
travel('bead', { at: -1, path: [[-900, -260], [-300, 150]], speed: 250, /* = */ profile: 'steady', closed: false, orient: false, only: false }); // speed: units/s, or dur, or speeds: [[s, speed], ...]; + roll: a wheel's radius
turnTo('hex', { at: 2, to: 90, /* = */ dur: 0.8, overshoot: 0.1 }); // absolute degrees. + profile: no overshoot ('steady': a spin); instead of to: speed (deg/s) or speeds: [[s, speed], ...]; about: 'x' | 'y': a plane group's hinge
scaleTo('hex', { at: 3, to: 1.5, /* = */ dur: 0.6, overshoot: 0.15 }); // times the authored size; it lasts. to: [sx, sy], pivot: its own axes. + profile: no overshoot
fadeTo('hex', { at: 4, to: 0.3, /* = */ dur: 0.5 });
fillTo('hex', { at: 5, to: 'accent.amber', /* = */ dur: 0.6, profile: 'ease', ramp: 0.3 });
popIn('c', { at: 0.3, /* = */ dur: 0.55, overshoot: 0.18 }); // hidden before at
popOut('c', { at: 3, /* = */ dur: 0.35 });
bump('c', { at: 2, /* = */ amount: 0.14 }); // a kick of the size, 0.7 s
squash('buddy', { at: 5, /* = */ amount: -0.22, dur: 0.6, pivot: [0, 0] }); // lower and wider about pivot
countTo('total', { at: 2, to: 1500, /* = */ dur: 1, profile: 'ease' }); // a text with count: 0 and "{n}" in its string; + ratio: true
levelTo('drink', { at: 2, to: 0.8, /* = */ dur: 1.5, profile: 'ease', ramp: 0.3 }); // 0 empty, 1 full
drawOn('wire', { at: 1, /* = */ dur: 0.6 }); // hidden before at. A stroke: + to (a share), profile, ramp
solidTo('route', { at: 5, /* = */ to: 1, dur: 0.6 }); // closes the gaps of its dashes
bendTo('wire', { at: 3, to: 0, /* = */ dur: 0.8, overshoot: 0.25 }); // taut (0), or it sags
widthTo('wire', { at: 4, to: 20, /* = */ dur: 0.6, overshoot: 0.15 }); // a link or a stroke: its width
reshape('isle', { at: 2, points: [[-200, 0], [0, -60], [200, 0], [0, 90]], /* = */ dur: 1.2, profile: 'ease', ramp: 0.3 }); // a region or a stroke, point for point; + smooth; matchPoints, reachedAt: any two outlines
drive('dot', { dur: 4, by: (t) => ({ at: [200 * t, 0] }), /* = */ at: 0 }); // a function of time: at, rotation, scale, opacity, depth, points; or samples: { at: [...] }
pulse('wire', { at: 2, /* = */ dur: 0.7, bump: 0.14 }); // bumps the far node at at + dur. A stroke: + from, to (shares), profile, length, node (bumped)
openTo('pupil', { at: 1, to: 1, /* = */ dur: 0.3, overshoot: 0.12 }); // lids: 1 open, 0 shut
blink('pupil', { at: 3 });
stagger(['a', 'b'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })); // + order: 'reverse', 'center-out', 'edges-in'
```

- A negative `at` (to -600): under way at frame 0.
- No key is anchored to a word: take `at` from the word times; `arrive`, `land` and `at + dur` are exact.
- `profile`: `'settle'` (`moveTo` only) backs away, shoots past, settles: first there at 0.52 of `dur`. `'ease'`: rest to rest. `'steady'`: one speed. `'in'`, `'out'`: one eased end (`ramp`: its share of `dur`). All arrive at `at + dur`.

## Effects (opt-in)

```ts
emitter({ id: 'fizz', colors: ['accent.aqua'], size: [4, 8], life: 4, rate: 9, sizing: 'steady', clipTo: 'drink', /* = */ area: [0, 0], prewarm: 0, direction: -90, spread: 360, speed: [20, 60], gravity: [0, 0], drag: 0.8 });
rect({ id: 'drink', fill: 'mid.mist', w: 264, h: 344, level: { at: 0.1, wave: { amp: 5, length: 160, speed: 40 } } });
```

- An emitter needs `rate` (/s), `bursts: [{ at, count }]` or `onContact: { count, minImpulse }`. `size` (radius), `life` (s), `speed` (units/s): a number or `[min, max]`. `sizing`: `'steady'` or `'spark'` (shrinks away). Also `at`, `from`, `until`, `attach`, `turbulence`, `core`, `glow`.
- `cover`: glow drawn before it does not shine through. `backdrop`: labels may lie over it. `clipTo`: drawn only inside that shape. `level` (or a number, 0 to 1): it fills from the bottom, `wave` ripples it, children ride the surface.

## Sound (opt-in)

```ts
circle({ id: 'marble', fill: 'accent.amber', r: 30, sound: 'marble' }); // the node's voice: the bank's sound "marble.<kind>", or "marble"
popIn('c', { at: 1, sound: false }); // any intent: false mutes it, a key names the sound of its start
sfx('chime', { at: 6, /* = */ gain: 1 }); // placed by hand, as on a word; + node: panned to it
```

Only what is seen sounds.

## Command line

```
npx skink3 <command> <scene.ts> [options]  (in the engine: node bin/skink3.mjs)
check   palette, strings, glyphs, text fit per language; reviews in short  [--bank bank.json]
bake    [--force]
still   frames as PNG  --frame n[,n] | --time s[,s]  [--hash]
strip   frames side by side  --from f [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   a contact sheet  [--cols 6] [--rows 5] [--frames n,n] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion  [--pictures [--top 3]]
physics [--pictures [--top 3]]
trail   a ghost trail  --node id[,id] [--from f] [--to f] | [--time s,s] [--every k] [--space stage|screen]
graph   a speed graph  --node id | --camera  [--from f] [--to f] | [--time s,s]
events  the shot's intents, contacts and bursts, as JSON
sfx     the sound track, a WAV  --bank bank.json  [--sheet [--cols 4] [--tile 480]]
common  --lang tag (the first table)  --width px (1920)  --cpu  --out file  --cache dir
```

Output: `./out/<shot id>/`; cache: `./cache/`; commands bake as needed. `check` fails on a broken palette rule, a missing string, a glyph no bundled font has, a text that overflows, leaves the frame or overlaps; else it warns. `--crop`: stage units from the top-left.

## Reading the reviews

Findings and the usual fix:

- `jump`: a teleport or pop: check the keys there; change place while hidden.
- `abrupt-start`, `abrupt-stop`: no ease at that end: `'ease'`, `'in'` or `'out'`, or keep `anticipation`, `overshoot`.
- `mechanical`: one speed between two rests in view: `'ease'`, or enter and leave the frame.
- `too-fast`: over half its size per frame, it strobes: slower, or larger.
- `spring-ringing`: still swinging 2.5 s after its target stopped: raise `z` or `f`.
- `spring-no-overshoot`: a bouncy spring that only lags: lower `f` or `z`, or drop it.
- `dead-area`: nothing moves by itself for 4 s (not the camera): add an `idle`, a pulse, particles.
- `overlap`: bodies in each other: released inside one, or poured too fast.
- `tunnelling`: through a wall or gap: thicker walls that overlap, less load.
- `escape`: below every fixed body: widen the ground, or mark it.
- `jitter`: trembling at rest: more `friction` or `angularDamping`, larger bodies.
- `unsettled`: a pile still travels at the end: pour earlier, damp more.
- `energy-spike`: speed from nowhere: bodies released in each other or a wall.
- `unseen-hit`: a bounce off an undrawn body: bodies collide from their release on.
- `not-finite`: the simulation broke down: an extreme velocity, size or spring `f`.
- `low-contrast` (with `contrast`): a node blends into what is behind: change a colour.

Not reported: what is hidden, off the frame, behind a `cover` or outside its clip. Mark what is meant, with a reason:

```ts
shot({ ...scene, contrast: { nodes: ['dot'], lightness: 18, colour: 24 } }); // off unless given; it blends below both: L*, a*b* (colourDistance(a, b)); + edge, seconds
shot({ ...scene, intended: [intended('dot', 'abrupt-start', 'it is kicked', { from: 1, to: 2 })] }); // + a window; also '(camera)', '(perspective:room)', '(frame)', '(frame:top-left)'
```

## Index

SCENES.md: **The model in one page**; **Minimal example**; **Space, time, units**; **Colours: the palette** (rules, tones, variants); **Text: string tables**; **`shot`** (camera, zoom and background keys, physics); **`layer`**; **Nodes** (glow, covers, clipping, levels, line width); **Timeline: intents** (profiles, travel, reshape, colour key, drive, stagger); **A perspective layer**; **Springs: secondary motion**; **Rigid bodies**; **Generating content in a scene**; **Checks**; **Motion review**, **Physics review**, **Contrast review**; **Sound**; **Command line**; **From another repository**; **Programmatic use**; **What is not there yet**.

MOTION-REVIEW.md: **The findings**, **The life of the background**, **Reading a trail**, **Reading a graph**, **Thresholds**.

PHYSICS-REVIEW.md: **The findings**, **Reading the pictures**, **Thresholds**.

## Other exports

```
constants: STAGE_W STAGE_H FPS SIM_DT SUBSTEPS ROLES CAMERA_DEFAULTS PHYSICS_DEFAULTS SPRING_PRESETS MOVE_PROFILES DEFAULT_RAMP EASINGS MOTION_FINDING_KINDS PHYSICS_FINDING_KINDS CONTRAST_FINDING_KINDS CAMERA_SUBJECT FRAME_SUBJECT FRAME_REGIONS
errors: SceneError IntentError PaletteError
functions: hexToHsv lightness mix resolveColor checkPalette ease moveTimes profilePeak rampProgress pathLength pathTable pathAt frameToSeconds secondsToFrame Noise
```

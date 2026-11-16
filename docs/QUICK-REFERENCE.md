# Quick reference for scene authors

What a scene can use, in short. Open [SCENES.md](SCENES.md) or a review document only at the section the index below names. What is in neither is not built.

- A test runs the `ts` blocks. Options after `/* = */` may be left out: the values shown are the defaults (tested too).
- Units: a stage of 1920 x 1080, origin in the centre, y down; `[x, y]` (a `Vec2`) in the parent's space; seconds, 60 frames each; degrees clockwise, 0 right.

## A scene module

```ts
import { circle, definePalette, hsv, label, layer, moveTo, popIn, shot } from 'skink3-engine';

const palette = definePalette({
  deep: { night: hsv(250, 0.88, 0.2), abyss: hsv(240, 0.9, 0.11) }, dark: { indigo: hsv(258, 0.8, 0.5) },
  mid: { mist: hsv(250, 0.46, 0.74) }, accent: { amber: hsv(40, 0.86, 0.99), aqua: hsv(176, 0.72, 0.93) },
  light: { cream: hsv(52, 0.34, 0.99) }, pairs: [['amber', 'aqua']],
});
const scene = shot({
  id: 'minimal', seconds: 4, seed: 1, palette, strings: { en: { 'label.dot': 'A dot' } },
  background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist',
  layers: [layer({ id: 'stage', depth: 0, nodes: [
    circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.aqua' }),
    label({ id: 'tag', text: 'label.dot', target: 'dot', fill: 'light.cream', ink: 'deep.night' }),
  ] })],
  timeline: [popIn('dot', { at: 0.3 }), moveTo('dot', { at: 1.2, to: [260, -40] })],
});
export default scene;
```

Colours are palette references only, on-screen text a key of `strings` only (every key in every language), random numbers from `Rng` only. A mistake is rejected with a message that says what to change.

## Shot, camera, layers

```ts
shot({ ...scene, /* = */ light: { from: 'top-left' }, vignette: 0.5, camera: { at: [0, 0], drift: { speed: 0.5, heading: 0, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 }, focus: { far: 6, near: 60 } } });
shot({ ...scene, camera: { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 } } }); // opt-in
layer({ id: 'far', depth: 1.5, nodes: [] }); // + blur, parallax, tint
```

- `drift.speed`: units per frame along `heading`; the norm is 0.3 to 0.7 px per frame. `wander`: units; `period`: seconds; `focus`: blur per unit of depth.
- A `path` replaces `at`, `drift.speed`, `drift.heading`. With `speed` (units per frame) the camera goes round a closed path for the whole shot: an ellipse of `loopPoints(center, r | [rx, ry])` holds a subject. Without, it covers the path once.
- `depth` 0 is the focus plane; above 0 is farther (less parallax, blurred, tinted toward `atmosphere`), below 0, to -0.9, nearer. Drawn farthest first, nodes as listed, children after their parent.

## Nodes

```ts
circle({ id: 'c', fill: 'accent.aqua', r: 90, /* = */ at: [0, 0], rotation: 0, scale: 1, opacity: 1, lit: true, glow: 0, children: [] });
capsule({ id: 'arm', fill: 'accent.amber', length: 46, r: 8, /* = */ origin: 'center' }); // a stick, tip to tip
polygon({ id: 'hex', fill: 'mid.mist', sides: 6, r: 50, /* = */ radius: 8 }); // 0.16 r; or points: [[x, y], ...], radius: 0
rect({ id: 'tray', fill: 'dark.indigo', w: 240, h: 50, /* = */ radius: 11 }); // 0.22 of the short side
blob({ id: 'buddy', fill: 'accent.amber', r: 50, /* = */ points: 9, wobble: 0.14, seed: 1 });
group({ id: 'face', /* = */ upright: false, children: [] }); // + at, rotation, scale, opacity; upright: no turning with its parent
link({ id: 'wire', from: 'hex', to: 'buddy', color: 'mid.mist', /* = */ pulseColor: 'mid.mist', bend: 0.12, width: 7, glow: 0 });
label({ id: 'note', text: 'label.dot', target: 'c', fill: 'light.cream', ink: 'deep.night', /* = */ side: 'top', size: 38, maxWidth: 420, maxLines: 3 });
eye({ id: 'pupil', r: 13, white: 'light.cream', pupil: 'deep.abyss', lookAt: 'hex', /* = */ blink: true, open: 1 }); // + at, scale, opacity
```

- Shapes take the options of `circle` and, opt-in, `rimLight`, `idle: { amp, period }`, `follow`, `body`, `cover`, `backdrop`, `clipTo`, `level`. They are convex; a `group` composes them. `children` are drawn over their parent.
- `label`: the tail points at the edge of `target` on `side`; the text wraps, then shrinks, and is never cut. To place it elsewhere, point it at an empty group. List a `link` before its nodes.

## Springs and rigid bodies (opt-in)

```ts
capsule({ id: 'tail', fill: 'accent.amber', length: 46, r: 8, origin: 'start', sway: 'springy' }); // it swings round its first end; or 'heavy', 'light', 'viscous'
circle({ id: 'moon', fill: 'light.cream', r: 9, follow: { f: 2.4, z: 0.26, r: 0 } }); // Hz, damping, response: its position lags; also groups, labels
rect({ id: 'floor', fill: 'dark.indigo', at: [0, 400], w: 600, h: 36, body: { kind: 'fixed' } });
circle({ id: 'ball', fill: 'accent.amber', r: 30, body: { kind: 'dynamic', release: 2.5, velocity: [0, 0], spin: 0, density: 1, appear: 'always' } }); // from velocity on: the defaults
shot({ ...scene, /* = */ physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 } });
```

A dynamic body waits, touching nothing, until `release` (seconds; negative down to minus `prewarm`, the seconds simulated before frame 0); from then on only the simulation moves it. `velocity`: units per second; `spin`: degrees per second. `appear: 'release'`: undrawn until then. The collider is the shape itself.

## Motion and timing

```ts
moveTo('dot', { at: 1.2, to: [260, -40], /* = */ dur: 1.1, anticipation: 0.08, overshoot: 0.07, arc: 0.12 }); // shares of the distance
moveTo('dot', { arrive: 6.5, to: [0, 0] }); // arrive: instead of at:, the moment it first reaches `to`
hop('buddy', { at: 4.3, to: [610, 130], /* = */ dur: 0.6, height: 80 }); // a parabola; or land: instead of at:
travel('bead', { at: -1, path: [[-900, -260], [-300, 150]], speed: 250, /* = */ profile: 'steady', closed: false, orient: false, only: false }); // speed: units per second (or dur:); + roll: r, a wheel of that radius
turnTo('hex', { at: 2, to: 90, /* = */ dur: 0.8, overshoot: 0.1 }); // absolute degrees
scaleTo('hex', { at: 3, to: 1.5, /* = */ dur: 0.6, overshoot: 0.15 }); // times the authored size; it lasts
fadeTo('hex', { at: 4, to: 0.3, /* = */ dur: 0.5 }); // an opacity
popIn('c', { at: 0.3, /* = */ dur: 0.55, overshoot: 0.18 }); // hidden before at
popOut('c', { at: 3, /* = */ dur: 0.35 });
bump('c', { at: 2, /* = */ amount: 0.14 }); // a kick of the size, 0.7 s
squash('buddy', { at: 5, /* = */ amount: -0.22, dur: 0.6, pivot: [0, 0] }); // lower and wider about pivot
levelTo('drink', { at: 2, to: 0.8, /* = */ dur: 1.5, profile: 'ease', ramp: 0.3 }); // 0 empty, 1 full
drawOn('wire', { at: 1, /* = */ dur: 0.6 }); // hidden before at
pulse('wire', { at: 2, /* = */ dur: 0.7, bump: 0.14 }); // arrives at at + dur and bumps the far node
openTo('pupil', { at: 0.5, to: 1, /* = */ dur: 0.3, overshoot: 0.12 }); // lids: 1 open, 0 shut
blink('pupil', { at: 3 });
stagger(['a', 'b', 'c'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })); // + order: 'reverse', 'center-out', 'edges-in'
```

- A negative `at` (down to -600): the key is under way at frame 0.
- `profile`: `'settle'` (`moveTo` only) backs away, shoots past and settles: it first arrives at 0.52 of `dur` and peaks at 5.6 times the mean speed. `'ease'`: rest to rest. `'steady'`: one speed, for a flow that enters and leaves the frame. `'in'`, `'out'`: one eased end, `ramp` its share of `dur`. These arrive exactly at `at + dur`.

## Effects (opt-in)

```ts
emitter({ id: 'fizz', colors: ['accent.aqua'], size: [4, 8], life: 4, rate: 9, sizing: 'steady', clipTo: 'drink', /* = */ area: [0, 0], prewarm: 0, direction: -90, spread: 360, speed: [20, 60], gravity: [0, 0], drag: 0.8 });
rect({ id: 'drink', fill: 'mid.mist', w: 264, h: 344, level: { at: 0.1, wave: { amp: 5, length: 160, speed: 40 } }, children: [group({ id: 'surface' })] });
rect({ id: 'wall', fill: 'dark.indigo', w: 240, h: 300, cover: true, backdrop: true });
```

- An emitter needs `rate` (per second), `bursts: [{ at, count }]` or `onContact: { count, minImpulse }`. `size` (radius), `life` (seconds), `speed` (units per second): a number or `[min, max]`. `'steady'` keeps the size, `'spark'` shrinks away. Also `at`, `from`, `until`, `attach`, `turbulence`, `core`, `glow`.
- `cover`: glow drawn before it in its layer does not shine through, and the motion review does not judge what is wholly behind it. `backdrop`: labels may lie over it. `clipTo`: drawn only inside that shape's outline. `level` (also a number, 0 to 1): the shape fills from the bottom, `wave` (units; units per second) ripples it, its children ride on the surface.

## Words, subtitles, generated content

No key is anchored to a word: work out `at` from the word times of the narration; `arrive`, `land` and `at + dur` are exact.

```ts
cuesFromWords([{ w: 'Hello.', start: 0, end: 0.4 }], { /* = */ maxChars: 42, maxLines: 2, pause: 0.5 }); // subtitle cues, for formatSrt, formatVtt, formatYtt
new Rng(7, 'scatter').range(-800, 800); // seeded by both; also int, pick, shuffle, next, sign, gauss, stream
```

## Command line

```
npx skink3 <command> <scene.ts> [options]     (in the engine: node bin/skink3.mjs)
check    palette, strings, text fit in every language; both reviews in short
bake     [--force]
still    frames as PNG   --frame n[,n] | --time s[,s]   [--hash]
strip    frames side by side   --from f [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet    a contact sheet   [--cols 6] [--rows 5] [--frames n,n] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render   [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion   [--pictures [--top 3]]
physics  [--pictures [--top 3]]
trail    a ghost trail   --node id[,id] [--from f] [--to f] | [--time s,s] [--every k] [--space stage|screen]
graph    a speed graph   --node id | --camera   [--from f] [--to f] | [--time s,s]
common   --lang tag (the first table)   --width px (1920)   --cpu   --out file   --cache dir
```

Output goes to `./out/<shot id>/`, the cache to `./cache/`; every command bakes when it must. `check` fails on a palette law, a missing string, and a label that overflows, leaves the frame or overlaps another; the rest are warnings. `--crop`: stage units from the top-left corner.

## Reading the reviews

What each kind of finding (a warning) usually means, and the usual fix:

- `jump`: a teleport or a pop. Check the keys at that moment; change place while hidden.
- `abrupt-start`: no ease-in. Keep `anticipation` or `overshoot` above 0, or use `'ease'` or `'in'`.
- `abrupt-stop`: no ease-out. Use `'ease'` or `'out'`, or an overshoot.
- `mechanical`: one speed between two rests in view. Use `'ease'`, or let it enter and leave the frame.
- `too-fast`: over half its size per frame: it strobes. Slower, or larger.
- `spring-ringing`: still swinging 2.5 s after its target stopped. Raise `z` or `f`.
- `spring-no-overshoot`: a bouncy spring that only lags. Lower `f` or `z`, or drop it.
- `dead-area`: nothing moves by itself for 4 s; the camera does not count. Add an `idle`, a pulse, particles.
- `overlap`: bodies in each other. One was released inside another, or the pour is too fast.
- `tunnelling`: through a wall or a narrow gap. Thicker walls that overlap, less load.
- `escape`: it falls below every fixed body. Widen the ground, or mark it.
- `jitter`: it trembles at rest. More `friction` or `angularDamping`, larger bodies.
- `unsettled`: a pile still travels at the end. Pour earlier, more damping.
- `energy-spike`: speed from nowhere. Bodies were released inside each other or pressed into a wall.
- `unseen-hit`: a bounce off a body that is not drawn. Bodies collide from their release on.
- `not-finite`: the simulation broke down. Look for an extreme velocity, size or spring `f`.

Not reported: what is hidden, off the frame, wholly behind a `cover` or outside its clip. What is meant is marked, with its reason:

```ts
shot({ ...scene, intended: [intended('dot', 'abrupt-start', 'it is kicked away', { from: 1, to: 2 })] }); // the window is optional; subjects may be '(camera)', '(frame)', '(frame:top-left)'
```

## Index

SCENES.md: **The model in one page** (the rules the API enforces); **Minimal example** (running a scene); **Space, time, units** (where the origin is); **Colours: the palette** (its laws); **Text: string tables** (keys, languages, the font); **`shot`** (every option; the camera, its path, the physics); **`layer`** (what the depth gives); **Nodes** (every node in full; glow, covers, clipping, levels); **Timeline: intents** (every intent and rule; profiles, travel, opacity, stagger); **Springs: secondary motion** (how they behave); **Rigid bodies** (what a body can and cannot do); **Generating content in a scene** (seeded numbers); **Checks** (what fails, what warns); **Motion review**, **Physics review** (what to know when writing); **Command line** (output files); **From another repository** (depending on the engine); **Programmatic use** (a bake, a node or a frame in a test); **What is not there yet** (what to do without).

MOTION-REVIEW.md: **The findings** (each kind in full; what is not flagged), **The life of the background**, **Reading a trail**, **Reading a graph**, **Thresholds**, **What these tools cannot tell**.

PHYSICS-REVIEW.md: **The findings**, **Reading the pictures**, **Thresholds**, **What the review cannot tell**.

## Other exports

```
constants  STAGE_W STAGE_H FPS SIM_DT SUBSTEPS ROLES PALETTE_LAWS CAMERA_DEFAULTS PHYSICS_DEFAULTS SPRING_PRESETS MOVE_PROFILES
           DEFAULT_RAMP EASINGS MOTION_FINDING_KINDS PHYSICS_FINDING_KINDS CAMERA_SUBJECT FRAME_SUBJECT FRAME_REGIONS
errors     SceneError IntentError PaletteError
functions  hexToHsv lightness mix(a, b, t) resolveColor checkPalette ease(name, t) moveTimes(options) profilePeak
           rampProgress pathLength pathTable pathAt(table, distance) frameToSeconds secondsToFrame new Noise(seed, name)
```

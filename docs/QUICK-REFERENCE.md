# Quick reference for scene authors

What a scene can use, in short. Open [SCENES.md](SCENES.md) or a review document only at the section the index below names. What is in neither is not built.

- A test runs the `ts` blocks. What follows `/* = */` is a default (tested too) and may be left out.
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
cameraTo({ at: 2, zoom: 1.6, to: [200, 0], /* = */ dur: 1.2, profile: 'ease', ramp: 0.3 }); // a key of the timeline: zoom, to, or both; keys chain
layer({ id: 'far', depth: 1.5, nodes: [] }); // + blur, parallax, tint
```

- `drift.speed`: units per frame along `heading`; the norm is 0.3 to 0.7 px per frame. `wander`: units; `period`: seconds; `focus`: blur per unit of depth.
- A `path` replaces `at`, `drift.speed`, `drift.heading`. With `speed` (units per frame) the camera rounds a closed path all shot long (`loopPoints(center, r | [rx, ry])` holds a subject); without, it covers the path once.
- `cameraTo`: `zoom` is a factor of the authored view, at one apparent speed across orders of magnitude; `to` is where the camera looks at the end. Drift, wander and push-in stay on top.
- `depth` 0 is the focus plane; above 0 farther (less parallax, blurred, tinted toward `atmosphere`), below 0, to -0.9, nearer. Drawn farthest first, nodes as listed, children after their parent.

## Nodes

```ts
circle({ id: 'c', fill: 'accent.aqua', r: 90, /* = */ at: [0, 0], rotation: 0, scale: 1, opacity: 1, lit: true, glow: 0, children: [] });
capsule({ id: 'arm', fill: 'accent.amber', length: 46, r: 8, /* = */ origin: 'center' }); // a stick, tip to tip
polygon({ id: 'hex', fill: 'mid.mist', sides: 6, r: 50, /* = */ radius: 8 }); // 0.16 r; or points: [[x, y], ...], radius: 0
rect({ id: 'tray', fill: 'dark.indigo', w: 240, h: 50, /* = */ radius: 11 }); // 0.22 of the short side
blob({ id: 'buddy', fill: 'accent.amber', r: 50, /* = */ points: 9, wobble: 0.14, seed: 1 });
region({ id: 'isle', fill: 'dark.indigo', points: [[-200, 0], [0, -120], [200, 0], [0, 40]], /* = */ smooth: 1 }); // a free-form outline, concave allowed; no body
group({ id: 'face', /* = */ upright: false, children: [] }); // + at, rotation, scale, opacity; upright: no turning with its parent
link({ id: 'wire', from: 'hex', to: 'buddy', color: 'mid.mist', /* = */ pulseColor: 'mid.mist', bend: 0.12, width: 7, glow: 0 });
stroke({ id: 'route', points: [[-300, 0], [0, -80], [300, 0]], color: 'accent.amber', /* = */ width: 7, closed: false, smooth: 1, glow: 0 }); // a line; + dash: [dash, gap] (0: dots), drawn, at, rotation, scale, opacity
label({ id: 'note', text: 'label.dot', target: 'c', fill: 'light.cream', ink: 'deep.night', /* = */ side: 'top', size: 38, maxWidth: 420, maxLines: 3 });
text({ id: 'title', text: 'label.dot', ink: 'light.cream', /* = */ size: 38, maxWidth: 600, maxLines: 3, weight: 800, align: 'center' }); // no pointer; + box: a colour, count, at, rotation, scale, opacity
eye({ id: 'pupil', r: 13, white: 'light.cream', pupil: 'deep.abyss', lookAt: 'hex', /* = */ blink: true, open: 1 }); // + at, scale, opacity
```

- Shapes take the options of `circle` and, opt-in, `rimLight`, `idle: { amp, period }`, `follow`, `body`, `cover`, `backdrop`, `clipTo`, `level`. All but `region` are convex; a `group` composes them. `children` are drawn over their parent.
- `stroke`: `smooth` 0 joins the points with straight lines; `arcPoints(center, r, from, to)` gives an arc or a ring (degrees).
- `label`: its tail points at the edge of `target` on `side`; the text wraps, then shrinks, never cut. `text`: free-standing; as a child of a shape it lies on it; in a `layer` with `parallax: 0` it belongs to the frame.

## Springs and rigid bodies (opt-in)

```ts
capsule({ id: 'tail', fill: 'accent.amber', length: 46, r: 8, origin: 'start', sway: 'springy' }); // it swings round its first end; or 'heavy', 'light', 'viscous'
circle({ id: 'moon', fill: 'light.cream', r: 9, follow: { f: 2.4, z: 0.26, r: 0 } }); // Hz, damping, response: its position lags; also groups, labels
rect({ id: 'floor', fill: 'dark.indigo', at: [0, 400], w: 600, h: 36, body: { kind: 'fixed' } });
circle({ id: 'ball', fill: 'accent.amber', r: 30, body: { kind: 'dynamic', release: 2.5, velocity: [0, 0], spin: 0, density: 1, appear: 'always' } }); // from velocity on: the defaults
shot({ ...scene, /* = */ physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 } });
```

A dynamic body waits, touching nothing, until `release` (seconds; down to minus `prewarm`, the seconds simulated before frame 0); then only the simulation moves it. `velocity`: units per second; `spin`: degrees per second; `appear: 'release'`: undrawn until then. The shape is the collider.

## Motion and timing

```ts
moveTo('dot', { at: 1.2, to: [260, -40], /* = */ dur: 1.1, anticipation: 0.08, overshoot: 0.07, arc: 0.12 }); // shares of the distance
moveTo('dot', { arrive: 6.5, to: [0, 0] }); // arrive: instead of at:, the moment it first reaches `to`
hop('buddy', { at: 4.3, to: [610, 130], /* = */ dur: 0.6, height: 80 }); // a parabola; or land: instead of at:
travel('bead', { at: -1, path: [[-900, -260], [-300, 150]], speed: 250, /* = */ profile: 'steady', closed: false, orient: false, only: false }); // speed: units per second (or dur:); + roll: r, a wheel of that radius
turnTo('hex', { at: 2, to: 90, /* = */ dur: 0.8, overshoot: 0.1 }); // absolute degrees
scaleTo('hex', { at: 3, to: 1.5, /* = */ dur: 0.6, overshoot: 0.15 }); // times the authored size; it lasts. to: [sx, sy] + pivot: [x, y]: along its own axes (a bar from one end)
fadeTo('hex', { at: 4, to: 0.3, /* = */ dur: 0.5 }); // an opacity
popIn('c', { at: 0.3, /* = */ dur: 0.55, overshoot: 0.18 }); // hidden before at
popOut('c', { at: 3, /* = */ dur: 0.35 });
bump('c', { at: 2, /* = */ amount: 0.14 }); // a kick of the size, 0.7 s
squash('buddy', { at: 5, /* = */ amount: -0.22, dur: 0.6, pivot: [0, 0] }); // lower and wider about pivot
countTo('total', { at: 2, to: 1500, /* = */ dur: 1, profile: 'ease' }); // a text with count: 0 and "{n}" in its string; + ratio: true
levelTo('drink', { at: 2, to: 0.8, /* = */ dur: 1.5, profile: 'ease', ramp: 0.3 }); // 0 empty, 1 full
drawOn('wire', { at: 1, /* = */ dur: 0.6 }); // hidden before at. A stroke: + to (a share; keys chain), profile, ramp
solidTo('route', { at: 5, /* = */ to: 1, dur: 0.6 }); // closes the gaps of a dashed stroke
pulse('wire', { at: 2, /* = */ dur: 0.7, bump: 0.14 }); // arrives at at + dur and bumps the far node
openTo('pupil', { at: 0.5, to: 1, /* = */ dur: 0.3, overshoot: 0.12 }); // lids: 1 open, 0 shut
blink('pupil', { at: 3 });
stagger(['a', 'b', 'c'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })); // + order: 'reverse', 'center-out', 'edges-in'
```

- A negative `at` (down to -600): the key is under way at frame 0.
- `profile`: `'settle'` (`moveTo` only) backs away, shoots past, settles: it first arrives at 0.52 of `dur`, peaking at 5.6 times the mean speed. `'ease'`: rest to rest. `'steady'`: one speed. `'in'`, `'out'`: one eased end (`ramp`: its share of `dur`). These arrive at `at + dur` exactly.

## Effects (opt-in)

```ts
emitter({ id: 'fizz', colors: ['accent.aqua'], size: [4, 8], life: 4, rate: 9, sizing: 'steady', clipTo: 'drink', /* = */ area: [0, 0], prewarm: 0, direction: -90, spread: 360, speed: [20, 60], gravity: [0, 0], drag: 0.8 });
rect({ id: 'drink', fill: 'mid.mist', w: 264, h: 344, level: { at: 0.1, wave: { amp: 5, length: 160, speed: 40 } }, children: [group({ id: 'surface' })] });
rect({ id: 'wall', fill: 'dark.indigo', w: 240, h: 300, cover: true, backdrop: true });
```

- An emitter needs `rate` (per second), `bursts: [{ at, count }]` or `onContact: { count, minImpulse }`. `size` (radius), `life` (seconds), `speed` (units per second): a number or `[min, max]`. `sizing`: `'steady'` or `'spark'` (shrinks away). Also `at`, `from`, `until`, `attach`, `turbulence`, `core`, `glow`.
- `cover`: glow drawn before it does not shine through; the motion review does not judge what is wholly behind it. `backdrop`: labels may lie over it. `clipTo`: drawn only inside that shape. `level` (or a number, 0 to 1): it fills from the bottom, `wave` ripples it, its children ride on the surface.

## Sound (opt-in)

```ts
circle({ id: 'marble', fill: 'accent.amber', r: 30, sound: 'marble' }); // the node's voice: the bank's sound "marble.<kind>", or "marble"
popIn('c', { at: 1, sound: false }); // any intent: false mutes it, a key names the sound of its start
sfx('chime', { at: 6.5, /* = */ gain: 1 }); // a sound placed by hand, as on a word; + node: it is panned to that node
```

- `skink3 sfx` makes the track from the events of the shot (every intent, contact and burst) and a bank the production brings: one event, one sound; only what is seen sounds; the bank's rules drop most of the rest. No pixel or bake changes.
- In the bank a sound can have `rules` of its own, stand `apart` (a pour as a shower) and be fitted to a move (`anchor: "peak"`, `pan: "follow"`, `pick: "duration"`).
- You cannot hear the track: read `sfx --sheet` (`out/<shot>/sfx_sheet.png`), a tile per sound with its frame, its node ringed and an arrow along a move.

## Words, subtitles, generated content

No key is anchored to a word: work out `at` from the word times of the narration; `arrive`, `land` and `at + dur` are exact.

```ts
cuesFromWords([{ w: 'Hello.', start: 0, end: 0.4 }], { /* = */ maxChars: 42, maxLines: 2, pause: 0.5 }); // subtitle cues, for formatSrt, formatVtt, formatYtt
new Rng(7, 'scatter').range(-800, 800); // seeded by both; also int, pick, shuffle, next, sign, gauss, stream
```

## Command line

```
npx skink3 <command> <scene.ts> [options]     (in the engine: node bin/skink3.mjs)
check    palette, strings, text fit in every language; both reviews in short   [--bank bank.json]
bake     [--force]
still    frames as PNG   --frame n[,n] | --time s[,s]   [--hash]
strip    frames side by side   --from f [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet    a contact sheet   [--cols 6] [--rows 5] [--frames n,n] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render   [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion   [--pictures [--top 3]]
physics  [--pictures [--top 3]]
trail    a ghost trail   --node id[,id] [--from f] [--to f] | [--time s,s] [--every k] [--space stage|screen]
graph    a speed graph   --node id | --camera   [--from f] [--to f] | [--time s,s]
events   every intent, contact and burst of the shot, as JSON
sfx      the sound track, a WAV   --bank bank.json   [--sheet [--cols 4] [--tile 480]]
common   --lang tag (the first table)   --width px (1920)   --cpu   --out file   --cache dir
```

Output: `./out/<shot id>/`; cache: `./cache/`; every command bakes when it must. `check` fails on a palette law, a missing string, and a text that overflows, leaves the frame or overlaps another; the rest are warnings. `--crop`: stage units from the top-left corner.

## Reading the reviews

What each kind of finding (a warning) usually means, and the usual fix:

- `jump`: a teleport or pop: check the keys there; change place while hidden.
- `abrupt-start`: no ease-in: keep `anticipation` or `overshoot`, or use `'ease'` or `'in'`.
- `abrupt-stop`: no ease-out: `'ease'` or `'out'`, or an overshoot.
- `mechanical`: one speed between two rests in view: `'ease'`, or let it enter and leave the frame.
- `too-fast`: over half its size per frame, it strobes: slower, or larger.
- `spring-ringing`: still swinging 2.5 s after its target stopped: raise `z` or `f`.
- `spring-no-overshoot`: a bouncy spring that only lags: lower `f` or `z`, or drop it.
- `dead-area`: nothing moves by itself for 4 s (the camera does not count): add an `idle`, a pulse, particles.
- `overlap`: bodies in each other: released inside another, or poured too fast.
- `tunnelling`: through a wall or gap: thicker walls that overlap, less load.
- `escape`: below every fixed body: widen the ground, or mark it.
- `jitter`: trembling at rest: more `friction` or `angularDamping`, larger bodies.
- `unsettled`: a pile still travels at the end: pour earlier, more damping.
- `energy-spike`: speed from nowhere: bodies released inside each other or pressed into a wall.
- `unseen-hit`: a bounce off an undrawn body: bodies collide from their release on.
- `not-finite`: the simulation broke down: an extreme velocity, size or spring `f`.

Not reported: what is hidden, off the frame, wholly behind a `cover` or outside its clip. What is meant is marked, with its reason:

```ts
shot({ ...scene, intended: [intended('dot', 'abrupt-start', 'it is kicked away', { from: 1, to: 2 })] }); // the window is optional; subjects may be '(camera)', '(frame)', '(frame:top-left)'
```

## Index

SCENES.md: **The model in one page**; **Minimal example**; **Space, time, units**; **Colours: the palette**; **Text: string tables**; **`shot`** (the camera, its path and its keys, the physics); **`layer`**; **Nodes** (each in full; glow, covers, clipping, levels); **Timeline: intents** (each in full; profiles, travel, size along one axis, opacity, stagger); **Springs: secondary motion**; **Rigid bodies**; **Generating content in a scene**; **Checks**; **Motion review**, **Physics review**; **Sound** (events, the bank, the rules of a sound, a sound fitted to a move, the sound sheet); **Command line**; **From another repository**; **Programmatic use**; **What is not there yet**.

MOTION-REVIEW.md: **The findings**, **The life of the background**, **Reading a trail**, **Reading a graph**, **Thresholds**, **What these tools cannot tell**.

PHYSICS-REVIEW.md: **The findings**, **Reading the pictures**, **Thresholds**, **What the review cannot tell**.

## Other exports

```
constants  STAGE_W STAGE_H FPS SIM_DT SUBSTEPS ROLES PALETTE_LAWS CAMERA_DEFAULTS PHYSICS_DEFAULTS SPRING_PRESETS MOVE_PROFILES
           DEFAULT_RAMP EASINGS MOTION_FINDING_KINDS PHYSICS_FINDING_KINDS CAMERA_SUBJECT FRAME_SUBJECT FRAME_REGIONS
errors     SceneError IntentError PaletteError
functions  hexToHsv lightness mix(a, b, t) resolveColor checkPalette ease(name, t) moveTimes(options) profilePeak
           rampProgress pathLength pathTable pathAt(table, distance) frameToSeconds secondsToFrame new Noise(seed, name)
```

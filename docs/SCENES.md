# Writing a scene

This is the guide and the API reference for scene authors, people or agents. It describes what exists today (phase 0). If something is not here, the engine does not have it yet.

## The model in one page

- A **scene module** is a TypeScript file whose default export is a shot made with `shot({ ... })`. Node runs it directly; there is no build step.
- A **shot** is plain data: a palette, string tables, a camera, depth **layers** holding **nodes**, and a **timeline** of **keys**.
- You say *what* is there and *what happens when*. The engine adds the light, the motion curves, the secondary motion, the physics and the camera.
- A shot is validated as a whole when `shot()` returns. Mistakes fail there with a message that names the node and says what to change.

Rules that the API enforces:

| Rule | How |
|---|---|
| No on-screen text in scene code | a label takes a string-table **key**; anything that is not a key (for example a sentence) is rejected |
| No raw colours | every colour is a palette reference `"role.name"`; hex values are rejected |
| Simple forms only | the shapes are circle, capsule, rounded convex polygon and blob; there are no hands, fingers, feet or limb mechanics to call |
| Unique ids, valid references | duplicate ids, unknown targets and cross-layer references are rejected |
| Determinism | the engine never uses `Math.random` or the clock; a scene that generates content must use the seeded `Rng` (see below) |

## Minimal example

```ts
// examples/minimal/scene.ts
import { circle, definePalette, hsv, label, layer, moveTo, popIn, shot } from 'skink3-engine';

const palette = definePalette({
  deep: { night: hsv(250, 0.88, 0.2), abyss: hsv(240, 0.9, 0.11) },
  dark: { indigo: hsv(258, 0.8, 0.5) },
  mid: { violet: hsv(266, 0.68, 0.84), mist: hsv(250, 0.46, 0.74) },
  accent: { amber: hsv(40, 0.86, 0.99), aqua: hsv(176, 0.72, 0.93) },
  light: { cream: hsv(52, 0.34, 0.99) },
  pairs: [['amber', 'aqua']],
});

export default shot({
  id: 'minimal',
  seconds: 4,
  seed: 1,
  palette,
  strings: {
    en: { 'label.dot': 'A dot' },
  },
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.aqua' }),
        label({ id: 'dot-label', text: 'label.dot', target: 'dot', fill: 'light.cream', ink: 'deep.night' }),
      ],
    }),
  ],
  timeline: [
    popIn('dot', { at: 0.3 }),
    moveTo('dot', { at: 1.2, to: [260, -40] }),
    popIn('dot-label', { at: 2.4 }),
  ],
});
```

```
node bin/skink3.mjs check examples/minimal/scene.ts            # palette laws, strings, text fit
node bin/skink3.mjs still examples/minimal/scene.ts --time 2.9 # -> out/minimal/still_00174_en.png
node bin/skink3.mjs sheet examples/minimal/scene.ts            # contact sheet of the whole shot
node bin/skink3.mjs render examples/minimal/scene.ts           # -> out/minimal/minimal_en.mp4
```

A larger example that uses every feature is `examples/demo/scene.ts`.

## Space, time, units

- The stage is **1920 × 1080 units**, origin at the **centre** of the frame, **x to the right, y down**. One unit is one pixel of a 1080p render at depth 0 and zoom 1. Renders at other sizes scale everything.
- Times are **seconds** from the start of the shot. The engine renders 60 frames per second; frame *n* shows time *n*/60.
- Angles are **degrees, clockwise** on screen; 0 points right, -90 points up.
- A node's `at` is in the space of its parent (the layer for top-level nodes).
- The camera moves (see `camera` below), so a node at `[0, 0]` is in the centre of the frame only at the start.

## Colours: the palette

```ts
const palette = definePalette({
  deep:   { name: '#RRGGBB', ... },  // background tones, L* below 12
  dark:   { ... },                   // L* 12 to 30
  mid:    { ... },                   // L* 30 to 60
  accent: { ... },                   // saturation above 0.6 and value above 0.7
  light:  { ... },                   // L* above 85
  pairs:  [['warmAccentName', 'coolAccentName'], ...],
});
```

- `hsv(hueDegrees, saturation, value)` returns a `#RRGGBB` string; it keeps the construction of a palette readable.
- Scenes refer to a colour as `"role.name"`, for example `"accent.amber"`.
- `checkPalette(palette)` (run by `skink3 check` and before every render) enforces the measured laws:

| Law | Rule |
|---|---|
| role lightness | each colour sits in its role's L* band (above) |
| no gray | deep and dark colours have saturation ≥ 0.5; mid tones ≥ 0.3 |
| saturated shadows | mean saturation of deep and dark colours ≥ 0.7 |
| dark hue | at least 66 % of deep and dark colours have a hue of 210–300° (blue to violet) |
| accents | saturation > 0.6 and value > 0.7 |
| accent pairs | at least one pair; in each, the first is warm (hue 330–75°), the second cool (150–270°), at least 90° apart |

Shadow, rim and highlight tones are derived from a shape's `fill` automatically (shadows darker, more saturated, leaning to indigo; highlights lighter, paler, leaning to warm). You never specify them.

## Text: string tables

```ts
strings: {
  en: { 'label.core': 'Core' },
  de: { 'label.core': 'Kern' },
}
```

- Keys look like `label.core`: lower-case letters, digits, and `.`, `_`, `-` between parts.
- Every key a scene uses must exist in **every** table, or `shot()` throws.
- A render uses one language (`--lang`, default: the first table). Labels size and wrap themselves to that language's string.
- The bundled font covers Latin, Latin Extended, Cyrillic and Vietnamese. Lines break at spaces only. Other scripts, right-to-left text and fallback fonts are not implemented yet.
- Text never influences the bake: adding a language re-renders without re-baking.

## `shot({ ... })`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | names the output folder and the cache file |
| `seconds` | number | required | length of the shot |
| `seed` | integer | required | seed of everything random in the shot |
| `palette` | `Palette` | required | from `definePalette` |
| `strings` | tables | required | language → key → text |
| `background` | `{ inner, outer, center?, radius? }` | center `[0.5, 0.46]`, radius `0.72` | radial gradient between two palette colours; centre in fractions of the frame, radius in frame widths |
| `atmosphere` | colour | required | the colour far layers fade toward |
| `layers` | `layer()[]` | required | in any order; drawn farthest first |
| `timeline` | keys | `[]` | in any order; nested arrays are flattened |
| `light` | `{ from }` | `{ from: 'top-left' }` | `'top-left'`, `'top'`, `'top-right'`, `'left'`, `'right'`, `'bottom-left'`, `'bottom'`, `'bottom-right'`, or an angle in degrees |
| `vignette` | 0..1 | `0.5` | darkening of the corners toward `background.outer` |
| `camera` | see below | see below | drift, push-in, depth of field |
| `physics` | see below | see below | style of the rigid-body world |

### Camera

```ts
camera: {
  at: [0, 0],                                             // where it looks at the start
  drift: { speed: 0.5, heading: 0, wander: 10, period: 7 },
  pushIn: { from: 1, to: 1.05 },
  focus: { far: 6, near: 60 },
}
```

- `drift.speed` is the steady travel in units per frame along `heading` (degrees; 0 moves the camera right, so the picture slides left). The norm for the measured drift is 0.3–0.7 px per frame; because far layers move less, a speed of 0.6–0.7 measured about 0.4 on the demo.
- `drift.wander` adds a slow wobble of that many units, about once per `period` seconds.
- `pushIn` zooms from `from` to `to` over the whole shot.
- `focus` sets the blur per unit of depth behind (`far`) and in front of (`near`) the focus plane.
- Over a shot the camera travels `speed × 60 × seconds` units. Lay the scene out along that path and check a contact sheet.

### Physics style

```ts
physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7 }
```

100 units count as one metre, so the default gravity is 5.4 m/s²: slower than real, on purpose. Leave the defaults unless a shot needs otherwise.

## `layer({ id, depth, nodes, blur?, parallax?, tint? })`

| `depth` | Meaning | Derived defaults |
|---|---|---|
| `0` | the focus plane: sharp, moves with the camera | parallax 1, blur 0, tint 0 |
| above 0 | farther: moves less, slightly blurred, tinted toward `atmosphere` | parallax `1 / (1 + depth)`, blur `focus.far × depth`, tint `min(0.62, 0.3 × depth)` |
| below 0 (down to -0.9) | nearer: moves more, heavily blurred | parallax `1 / (1 + depth)`, blur `focus.near × -depth`, tint 0 |

`blur` (units), `parallax` and `tint` (0..1) override the derived values. Nodes are drawn in the order listed; children are drawn after their parent.

A good dark shot has at least three layers: a far one with large pale shapes, the stage at depth 0 where the action is, and a near one with a few big dark blurred shapes at the edges.

## Nodes

### Shapes

All shape factories take these options:

| Option | Default | Meaning |
|---|---|---|
| `id` | required | unique in the shot |
| `fill` | required | palette reference |
| `at` | `[0, 0]` | position in the parent's space |
| `rotation` | `0` | degrees, clockwise |
| `scale` | `1` | |
| `opacity` | `1` | constant |
| `lit` | `true` | automatic light: shadow crescent, lit rim, highlight stroke |
| `glow` | `0` | 0..1: halo around the shape and a lift of the background behind it |
| `rimLight` | none | palette colour of a thin rim light on the shadow side |
| `children` | `[]` | nodes that move with the shape and are drawn over it (shapes, groups, eyes) |
| `follow` | none | spring: the shape lags behind its rest position and overshoots (see Springs) |
| `idle` | none | `{ amp, period }`: gentle endless wander of `amp` units |
| `body` | none | makes it a rigid body (see Rigid bodies) |

| Factory | Extra options | Notes |
|---|---|---|
| `circle` | `r` | |
| `capsule` | `length`, `r`, `origin?`, `sway?` | a stick with round ends along its local x axis; `length` is tip to tip. `origin: 'start'` puts the first end at the node's position (a pivot); `sway` then makes the free end lag on a spring |
| `polygon` | `sides`, `r`, `radius?` or `points`, `radius?` | a rounded **convex** polygon: regular (3–12 sides on a circle of radius `r`, corner radius default `0.16 × r`) or from explicit corners |
| `rect` | `w`, `h`, `radius?` | rounded rectangle centred on its position; `radius` must stay below half the short side (use a capsule for a pill) |
| `blob` | `r`, `points?` (9), `wobble?` (0.14), `seed?` (1) | a soft irregular outline; the same seed gives the same blob |

Concave forms are composed from several shapes in a `group`.

### `group({ id, at?, rotation?, scale?, children?, follow?, idle? })`

An invisible parent. Its children move, turn and scale with it. A group with no children is useful as an anchor: something for a label to point at or for eyes to look at, which the timeline can move.

### `link({ id, from, to, color, pulseColor?, bend?, width?, gap? })`

A curved line between two nodes of the same layer. It follows them as they move.

| Option | Default | Meaning |
|---|---|---|
| `from`, `to` | required | ids of shapes, groups or eyes in the same layer |
| `color` | required | |
| `pulseColor` | `color` | colour of the pulses |
| `bend` | `0.12` | sideways bulge as a fraction of the length; negative bends the other way; 0 is straight |
| `width` | `7` | |
| `gap` | `6` | free space between the link's end and the node's edge |

List links before the nodes they join, so the nodes are drawn over the ends. A link is hidden while either of its nodes is hidden. Animate it with `drawOn` and `pulse`.

### `label({ id, text, target, fill, ink, side?, gap?, size?, minSize?, maxWidth?, maxLines?, follow? })`

A rounded rectangle with a pointer tail aimed at `target`.

| Option | Default | Meaning |
|---|---|---|
| `text` | required | string-table **key** |
| `target` | required | id of the node to point at; the label follows it |
| `fill`, `ink` | required | box colour and text colour |
| `side` | `'top'` | where the label sits relative to the target: `'top'`, `'bottom'`, `'left'`, `'right'` |
| `gap` | `14` | distance from the target's edge to the tip of the tail |
| `size` | `38` | preferred font size |
| `minSize` | 62 % of `size` | the layout may shrink the font down to this |
| `maxWidth` | `420` | widest the text block may get before it wraps |
| `maxLines` | `3` | |
| `follow` | none | spring: the label trails its target |

The layout wraps the string, balances the lines, and shrinks the font if needed. A string that still does not fit is reported by the text-fit check as overflow; it is never cut. Labels are listed directly in a layer, usually last so they are on top.

### `eye({ id, r, white, pupil, at?, scale?, lookAt?, blink? })`

A light disc with a pupil. `lookAt` is the id of a node in the same layer that the pupil follows. Eyes blink now and then (`blink: false` turns it off); eyes that share a parent blink together.

A simple creature is a blob with two eyes as children, optionally with `capsule` sticks that `sway`. That is all a character needs under the simple-forms rule; see `examples/demo/scene.ts`.

### `emitter({ id, colors, size, life, ... })`

Particles are small circles that swell quickly and then shrink to nothing. They live in the layer's space.

| Option | Default | Meaning |
|---|---|---|
| `colors` | required | palette references; each particle picks one |
| `size` | required | radius, `[min, max]` or one number |
| `life` | required | seconds, `[min, max]` or one number |
| `at` | `[0, 0]` | position in the layer, or the offset from `attach` |
| `attach` | none | id of a node (same layer) the emitter rides on |
| `area` | `[0, 0]` | spawn box `[width, height]` around the position |
| `rate` | `0` | particles per second, between `from` (0) and `until` (end) |
| `bursts` | `[]` | `[{ at, count }]` |
| `onContact` | none | `{ count, minImpulse }`: a burst at every rigid-body contact at least that strong, at the contact point |
| `prewarm` | `0` | seconds simulated before the shot starts, so that a field is already populated at frame 0 |
| `direction`, `spread` | `-90`, `360` | mean direction and full spread angle, degrees |
| `speed` | `[20, 60]` | units per second |
| `gravity` | `[0, 0]` | constant acceleration, units per second squared (also works as wind) |
| `drag` | `0.8` | share of velocity lost per second, as a rate |
| `turbulence` | none | `{ strength, scale, speed }`: a slowly changing swirl field |
| `glow` | `0` | 0..1: the particles also feed the halo |

An emitter needs at least one of `rate`, `bursts`, `onContact`.

## Timeline: intents

A key says what should happen to a node and when. The engine supplies the curve.

| Intent | Targets | Options (defaults) | What the engine does |
|---|---|---|---|
| `moveTo(id, { at, to, ... })` | shape, group, eye | `dur` (1.1), `anticipation` (0.08), `overshoot` (0.07), `arc` (0.12) | backs away a little, travels along an arc, shoots past the destination, settles. Starts from wherever the node is. `anticipation` and `overshoot` are fractions of the distance (capped at 44 and 38 units); `arc` is the bulge as a fraction of the distance (capped at 150 units), positive toward the top of the frame |
| `popIn(id, { at, ... })` | shape, group, eye, label | `dur` (0.55), `overshoot` (0.18) | grows from nothing past its size and settles. **The node is hidden before `at`** |
| `popOut(id, { at, ... })` | same | `dur` (0.35) | a small swell, then shrinks to nothing |
| `turnTo(id, { at, to, ... })` | shape, group | `dur` (0.8), `overshoot` (0.1) | turns to the absolute rotation `to` (degrees), overshoots, settles |
| `bump(id, { at, ... })` | shape, group, eye, label | `amount` (0.14) | a quick swell that rings out in about 0.7 s: a reaction, a beat |
| `drawOn(linkId, { at, ... })` | link | `dur` (0.6) | draws the link on from its `from` end. **The link is hidden before `at`**. Once per link |
| `pulse(linkId, { at, ... })` | link | `dur` (0.7), `bump` (0.14) | sends a glowing pulse from `from` to `to`; when it arrives, the node at the far end gets a bump (`bump: 0` turns that off) |

Rules:

- Moves of one node may not overlap in time; the same holds for turns and for pops. `popIn` and `popOut` must alternate.
- A node with a `popIn` and no earlier `popOut` starts hidden. A node without pops is visible from the start.
- A rigid body cannot be the target of `moveTo` or `turnTo`; it can pop and bump.
- To time something to a pulse's arrival, use `at + dur` of that pulse.

### `stagger(ids, { at, each, order? }, make)`

The same intent for a group, each a little later than the one before:

```ts
...stagger(['n0', 'n1', 'n2'], { at: 1, each: 0.1 }, (id, at) => popIn(id, { at })),
...stagger(nodeIds, { at: 6.5, each: 0.1 }, (id, at, i) => moveTo(id, { at, to: places[i] })),
```

`order` is `'forward'` (default), `'reverse'`, `'center-out'` or `'edges-in'`. `make` may return one key or an array of keys.

## Springs: secondary motion

`follow` (any shape, group or label) and `sway` (a capsule with `origin: 'start'`) take a preset name or `{ f, z, r }`:

| Preset | f (Hz) | z (damping) | r (response) | Feel |
|---|---|---|---|---|
| `'heavy'` | 1.1 | 0.9 | 0 | slow to start, no overshoot |
| `'light'` | 3.2 | 0.55 | 0.4 | quick and tidy, a small overshoot |
| `'springy'` | 2.4 | 0.26 | 0 | bounces a few times before it settles |
| `'viscous'` | 0.8 | 1.4 | 0 | lags as if in honey, never overshoots |

`f` is how fast it reacts, `z` below 1 overshoots, `r` above 0 reacts at once and below 0 anticipates.

- `follow`: the node's position chases the place it would have without the spring. Give it to a child of a moving node (a satellite, an ornament) or to a label.
- `sway`: the stick stays attached at its first end and its free end lags, so it swings when its parent moves.

Springs are simulated in the bake; nothing about them is left to the renderer.

## Rigid bodies

```ts
rect({ id: 'floor', at: [0, 400], w: 600, h: 36, fill: 'dark.indigo', body: { kind: 'fixed' } }),
circle({ id: 'ball', at: [0, -300], r: 30, fill: 'accent.coral', body: { kind: 'dynamic', release: 2.5, spin: 90 } }),
```

- `{ kind: 'fixed' }` never moves; other bodies land on it.
- `{ kind: 'dynamic', release, velocity?, spin?, density?, friction?, restitution? }` stays where the scene put it until `release` (seconds), then the simulation takes it over. Before its release it does not collide with anything. `velocity` (units per second) and `spin` (degrees per second) apply at the release.
- Bodies must be listed directly in a layer, and all bodies of a shot must be in the same layer.
- The collider is the shape itself (a blob uses its convex hull).
- Every contact is recorded with its time, place and peak impulse; `skink3 bake` prints how many. Emitters can react to them with `onContact`. They are also meant for sound, which is not built yet.

Joints, bodies driven by animation before their release, goal forces and seed search are not built yet.

## Generating content in a scene

A scene is ordinary TypeScript, so loops and helper functions are fine. For anything random use the engine's seeded generator, never `Math.random`:

```ts
import { Rng } from 'skink3-engine';
const rng = new Rng(SEED, 'scatter');            // the same seed and name always give the same numbers
const at: [number, number] = [rng.range(-800, 800), rng.range(-400, 400)];
```

`Rng` has `next()`, `range(lo, hi)`, `int(lo, hi)`, `sign()`, `pick(list)`, `gauss()`, `shuffle(list)` and `stream(name)` for an independent sub-stream.

## Checks

`skink3 check <scene>` runs, for every language of the string tables:

| Check | Fails when |
|---|---|
| palette | a law above is broken |
| strings | a used key is missing or empty in a language |
| text fit: overflow | a label's string does not fit its `maxWidth` and `maxLines` even at `minSize` |
| text fit: off-frame | a shown label comes closer than 12 units to the frame edge at any sampled frame |
| text fit: overlap | two shown labels overlap at any sampled frame |

`skink3 render` runs the same checks for the language it renders and stops if they fail (`--force` renders anyway). The checks do not test whether a label covers a node; look at a contact sheet for that.

`npm run check` in the engine repository also runs `tsc --noEmit` and the unit tests.

## Command line

```
skink3 <command> <scene module> [options]

check   palette laws, string tables and text fit in every language
bake    simulate physics, springs and particles; write the cache        [--force]
still   frames as PNG          --frame <n[,n...]> | --time <s[,s...]>   [--hash]
strip   a motion strip         --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   a contact sheet        [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  an mp4                 [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]

common  --lang <tag>  --width <px> (default 1920)  --cpu  --out <file>  --cache <dir>
```

- Inside the engine repository the command is `node bin/skink3.mjs`; from a repository that depends on the engine it is `npx skink3`.
- Output goes to `./out/<shot id>/`, the bake cache to `./cache/`, both relative to the directory the command is run from.
- `still`, `strip`, `sheet` and `render` bake first if the cache is missing or stale.
- `--crop` is in stage units with the origin at the **top-left** corner of the frame (unlike scene coordinates).
- `sheet --lang en,x-long --frames 700,880` puts the same frames side by side in several languages: the way to review a translation.
- `--hash` and `--hashes` print or write the SHA-256 of each frame's raw RGBA pixels, for determinism checks.

Review with stills, strips and sheets; render the video when those look right.

## From another repository

A production repository depends on a checkout of the engine (`"skink3-engine": "file:../skink3-engine"`), keeps its own scenes, palettes and string tables, and imports from the package name:

```ts
import { shot, layer, circle } from 'skink3-engine';
```

Run `npm ci` in the engine checkout too. The dependency must stay a link (npm's default for a `file:` directory); a copy inside `node_modules` cannot be loaded, because Node does not strip types there. For type checking, a `tsconfig.json` with `"module": "nodenext"`, `"allowImportingTsExtensions": true`, `"noEmit": true` and `"skipLibCheck": true` works.

## Programmatic use

Everything the command line does is exported: `compileShot`, `bakeShot`, `ensureBake`, `evaluate`, `runChecks`, `frameRaw`, `framePng`, `renderSheet`, `renderParallel`, `loadShot`. `evaluate(compiled, bake, frame, lang)` returns the display list of a frame and is a pure function.

## What is not there yet

No transitions between shots, no narration or audio, no keys anchored to words, no free-form paths, no bubbles, titles or counters, no scripts beyond Latin and Cyrillic, no soft bodies, ropes, flocks or fluids, no motion blur. See the roadmap in the README.

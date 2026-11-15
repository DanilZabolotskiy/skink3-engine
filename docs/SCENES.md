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
| `intended` | `intended()[]` | `[]` | findings of the motion review or of the physics review that are what you want, each with a reason (see Motion review, Physics review) |

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
physics: { gravity: 540, linearDamping: 0.35, angularDamping: 0.6, restitution: 0.12, friction: 0.7, prewarm: 0 }
```

100 units count as one metre, so the default gravity is 5.4 m/s²: slower than real, on purpose. Leave the defaults unless a shot needs otherwise.

`prewarm` is the number of seconds the world is simulated before the shot starts. With it a body may be released at a negative time, so a pile already lies there, or a stream already falls, at frame 0 (see Rigid bodies).

## `layer({ id, depth, nodes, blur?, parallax?, tint? })`

| `depth` | Meaning | Derived defaults |
|---|---|---|
| `0` | the focus plane: sharp, moves with the camera | parallax 1, blur 0, tint 0 |
| above 0 | farther: moves less, slightly blurred, paler and closer to the `atmosphere` colour | parallax `1 / (1 + depth)`, blur `focus.far × depth`, tint `min(0.9, 1 - e^(-0.8 × depth))`: 0.33 at depth 0.5, 0.55 at depth 1, 0.80 at depth 2 |
| below 0 (down to -0.9) | nearer: moves more, heavily blurred | parallax `1 / (1 + depth)`, blur `focus.near × -depth`, tint 0 |

`blur` (units), `parallax` and `tint` (0..1) override the derived values. Nodes are drawn in the order listed; children are drawn after their parent.

**Tint is atmospheric perspective.** With tint *t*, every colour drawn in the layer (fills, shadows, highlights, links, particles, labels) loses `0.6 × t` of its saturation and then moves *t* of the way to the shot's `atmosphere` colour: hue along the short way round the colour wheel, saturation and value straight. So far things are paler, less saturated and close to one tone, and a warm colour fading into a cool atmosphere never turns gray. At tint 1 everything is the atmosphere colour.

A good dark shot has at least three layers: a far one with large pale shapes, the stage at depth 0 where the action is, and a near one with a few big dark blurred shapes at the edges. Keep far shapes away from the spot behind the subject: the depth tint separates them by tone, but a diagram reads best against the deep background. A far layer moves less than the stage, so "behind the subject" is a band there, as wide as the camera's travel times `1 - parallax`.

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
| `opacity` | `1` | 0..1 at the start; `fadeTo` animates it (see Opacity) |
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
| `capsule` | `length`, `r`, `origin?`, `sway?` | a stick with round ends along its local x axis; `length` is tip to tip. `origin: 'start'` puts the first end at the node's position (a pivot); `sway` then lets the stick lean and swing around it on a spring |
| `polygon` | `sides`, `r`, `radius?` or `points`, `radius?` | a rounded **convex** polygon: regular (3–12 sides on a circle of radius `r`, corner radius default `0.16 × r`) or from explicit corners |
| `rect` | `w`, `h`, `radius?` | rounded rectangle centred on its position; `radius` must stay below half the short side (use a capsule for a pill) |
| `blob` | `r`, `points?` (9), `wobble?` (0.14), `seed?` (1) | a soft irregular outline; the same seed gives the same blob |

Concave forms are composed from several shapes in a `group`.

### `group({ id, at?, rotation?, scale?, opacity?, upright?, children?, follow?, idle? })`

An invisible parent. Its children move, turn and scale with it. A group with no children is useful as an anchor: something for a label to point at or for eyes to look at, which the timeline can move.

`upright: true` makes the group keep its own rotation in the layer's space instead of turning with its parent. It still follows the parent's position and size. Use it for a face on something that rolls or tumbles, such as a rigid body: the eyes stay level while the body turns under them.

```ts
circle({ id: 'ball', r: 30, fill: 'accent.amber', body: { kind: 'dynamic', release: 1 },
  children: [group({ id: 'ball-face', upright: true, children: [eye({ id: 'ball-eye', r: 8, white: 'light.snow', pupil: 'deep.abyss' })] })] })
```

### `link({ id, from, to, color, pulseColor?, bend?, width?, gap?, opacity?, glow? })`

A curved line between two nodes of the same layer. It follows them as they move.

| Option | Default | Meaning |
|---|---|---|
| `from`, `to` | required | ids of shapes, groups or eyes in the same layer |
| `color` | required | |
| `pulseColor` | `color` | colour of the pulses |
| `bend` | `0.12` | sideways bulge as a fraction of the length; negative bends the other way; 0 is straight |
| `width` | `7` | |
| `gap` | `6` | free space between the link's end and the node's edge |
| `opacity` | `1` | 0..1 at the start |
| `glow` | `0` | 0..1: the line itself glows, with a halo around it. Pulses glow whatever this is |

List links before the nodes they join, so the nodes are drawn over the ends. A link is hidden while either of its nodes is hidden, and it fades with the fainter of the two. Animate it with `drawOn` and `pulse`. A pulse is drawn as travelling light: a bright head with a tail that narrows and fades.

### `label({ id, text, target, fill, ink, side?, gap?, size?, minSize?, maxWidth?, maxLines?, opacity?, follow? })`

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
| `opacity` | `1` | 0..1 at the start |
| `follow` | none | spring: the label trails its target |

The layout wraps the string, balances the lines, and shrinks the font if needed. A string that still does not fit is reported by the text-fit check as overflow; it is never cut. Labels are listed directly in a layer, usually last so they are on top.

### `eye({ id, r, white, pupil, at?, scale?, opacity?, lookAt?, blink?, open? })`

A light disc with a pupil. `lookAt` is the id of a node in the same layer that the pupil follows. Eyes blink now and then (`blink: false` turns it off); eyes that share a parent blink together.

`open` (0..1, default 1) sets the lids at the start. At 0 the eye is shut, and a shut eye is not drawn at all, so a thing can look lifeless until its eyes open. `openTo` opens and closes the lids, and `blink` asks for a blink at a chosen moment (see the timeline). For a character whose blinks must not land on a staged moment, set `blink: false` and place the blinks yourself.

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
| `prewarm` | `0` | seconds simulated before the shot starts, so that a field is already populated at frame 0 (for an emitter whose `rate` runs from the start) |
| `direction`, `spread` | `-90`, `360` | mean direction and full spread angle, degrees |
| `speed` | `[20, 60]` | units per second |
| `gravity` | `[0, 0]` | constant acceleration, units per second squared (also works as wind) |
| `drag` | `0.8` | share of velocity lost per second, as a rate |
| `turbulence` | none | `{ strength, scale, speed }`: a slowly changing swirl field |
| `glow` | `0` | 0..1: the particles also feed the halo |
| `core` | none | `{ color, size }`: an inner disc on every particle, in one palette colour; `size` is its radius as a fraction of the particle's (0.05..0.95). A particle with a core reads as a ring around a face: a cell, a bead, a wheel |

An emitter needs at least one of `rate`, `bursts`, `onContact`.

## Timeline: intents

A key says what should happen to a node and when. The engine supplies the curve.

| Intent | Targets | Options (defaults) | What the engine does |
|---|---|---|---|
| `moveTo(id, { at, to, ... })` | shape, group, eye | `dur` (1.1), `anticipation` (0.08), `overshoot` (0.07), `arc` (0.12) | backs away a little, travels along an arc, shoots past the destination, settles. Starts from wherever the node is. `anticipation` and `overshoot` are fractions of the distance (capped at 44 and 38 units); `arc` is the bulge as a fraction of the distance (capped at 150 units), positive toward the top of the frame |
| `popIn(id, { at, ... })` | shape, group, eye, label | `dur` (0.55), `overshoot` (0.18) | grows from nothing past its size and settles. **The node is hidden before `at`** |
| `popOut(id, { at, ... })` | same | `dur` (0.35) | a small swell, then shrinks to nothing |
| `turnTo(id, { at, to, ... })` | shape, group | `dur` (0.8), `overshoot` (0.1) | turns to the absolute rotation `to` (degrees), overshoots, settles |
| `scaleTo(id, { at, to, ... })` | shape, group, eye, label | `dur` (0.6), `overshoot` (0.15) | a lasting change of size: grows or shrinks to `to` times the authored size, shoots past it and settles. For things that grow in steps |
| `fadeTo(id, { at, to, ... })` | shape, group, eye, label, link | `dur` (0.5) | fades to the opacity `to` (0..1), smoothly. For things that switch on or off softly, and for translucent shapes |
| `bump(id, { at, ... })` | shape, group, eye, label | `amount` (0.14) | a quick swell that rings out in about 0.7 s: a reaction, a beat |
| `drawOn(linkId, { at, ... })` | link | `dur` (0.6) | draws the link on from its `from` end. **The link is hidden before `at`**. Once per link |
| `pulse(linkId, { at, ... })` | link | `dur` (0.7), `bump` (0.14) | sends a glowing pulse from `from` to `to`; when it arrives, the node at the far end gets a bump (`bump: 0` turns that off) |
| `openTo(eyeId, { at, to, ... })` | eye | `dur` (0.3), `overshoot` (0.12) | opens or closes the lids to `to` (1 = open, 0 = shut and not drawn). The change lasts. With an overshoot the eye opens a little too wide first |
| `blink(eyeId, { at })` | eye | | one blink at that moment, on top of the eye's own schedule |

Rules:

- Moves of one node may not overlap in time; the same holds for turns and for pops. `popIn` and `popOut` must alternate.
- A node with a `popIn` and no earlier `popOut` starts hidden. A node without pops is visible from the start.
- `scaleTo` and `fadeTo` chain: each starts from the size or opacity the node has at that moment, also when the previous one is still under way.
- Size is a product: the authored `scale` × pops × the lasting size from `scaleTo` × bumps. So a node can pop in, grow in steps, and still react with a bump (also the bump a pulse gives on arrival) at any size. `scaleTo` overshoots in proportion: growing to 2 with `overshoot: 0.15` peaks near 2.2, shrinking to 0.5 dips to 0.45.
- A rigid body cannot be the target of `moveTo`, `turnTo` or `scaleTo`; it can pop, bump and fade.
- `openTo` keys chain like `fadeTo`: each starts from the opening the eye has at that moment. Blinks multiply with the lids, so a blink never opens a shut eye.
- To time something to a pulse's arrival, use `at + dur` of that pulse.

### Opacity

Every shape, group, eye, label and link has an `opacity` (default 1) that `fadeTo` animates. How it combines:

- **A faded node fades as one picture.** The node and everything in it (its automatic light, its children, their children) are drawn first and then faded together, so parts that overlap inside it do not show through each other: a half-faded creature does not reveal its body through its eyes.
- **Opacity multiplies down the tree.** A child at 0.5 inside a parent at 0.5 ends up at 0.25. A child cannot be more visible than its parent.
- **Glow fades too.** The halo of a glowing shape and the lift of the background behind it are scaled by the shape's opacity down the tree.
- **A link takes the fainter of its two nodes**, times its own opacity.
- At opacity 0 a node and its whole subtree are not drawn.
- Particles are not children of anything and do not fade with a node; stop the emitter instead (`until`).
- Opacity is only a look. A faded rigid body still collides, and a faded label's string still has to fit.

A translucent shape is simply a shape with `opacity` below 1, for example a soft field under a diagram: `circle({ id: 'field', r: 150, fill: 'mid.violet', lit: false, opacity: 0.2 })`.

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
- `sway`: the stick keeps its first end and its length, and the spring turns it.
  - It leans against the sideways travel of its free end: back when its parent moves, behind the turn when its parent turns. The free end trails by the distance it travels in `1 / (2π f)` seconds, so a softer spring (a lower `f`) leans more.
  - When the parent stops, the stick swings back, passes its rest direction and settles, the way `f`, `z` and `r` say.
  - It never turns more than 57° away from its rest direction, whatever the parent does and whatever the numbers are: a jump of the parent, a pop or a bump cannot make it snap or whip round. At a sustained high speed it leans about 44°.
  - The lean it follows changes no faster than 6 radians a second, so a parent that jumps or reverses within a frame swings the stick over in a few frames instead of flicking it.
  - It is at rest when it appears: what the parent does while the stick has no size leaves no swing behind.

Springs are simulated in the bake; nothing about them is left to the renderer.

## Rigid bodies

```ts
rect({ id: 'floor', at: [0, 400], w: 600, h: 36, fill: 'dark.indigo', body: { kind: 'fixed' } }),
circle({ id: 'ball', at: [0, -300], r: 30, fill: 'accent.coral', body: { kind: 'dynamic', release: 2.5, spin: 90 } }),
```

- `{ kind: 'fixed' }` never moves; other bodies land on it.
- `{ kind: 'dynamic', release, velocity?, spin?, density?, friction?, restitution? }` stays where the scene put it until `release` (seconds), then the simulation takes it over. Before its release it does not collide with anything. `velocity` (units per second) and `spin` (degrees per second) apply at the release.
- `release` may be negative, down to minus the shot's `physics.prewarm`. The world then starts that many seconds before frame 0, and such a body is already falling, or already at rest, when the shot opens. Contacts from before frame 0 are not recorded.
- Bodies must be listed directly in a layer, and all bodies of a shot must be in the same layer.
- The collider is the shape itself (a blob uses its convex hull).
- Every contact is recorded with its time, place and peak impulse; `skink3 bake` prints how many. Emitters can react to them with `onContact`. They are also meant for sound, which is not built yet.
- Put a body where it has room at its release: one that is released inside another body or inside a wall is pushed out over a few frames, in view. The physics review reports it as an overlap that starts at the release.
- A body is a solid thing only as far as its own shape goes. Children drawn past that shape, and a pop or a bump (which change the picture, not the collider), are not part of what collides.
- A faded body still collides, and so does a fixed body with `opacity: 0`. That is how a container is drawn by other shapes around invisible walls; draw it where the walls are.

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
| text fit: covers-node (**warning**) | a shown label covers a shape or an eye of its own layer other than its target (and the target's own children and parents), at any sampled frame |

A warning is printed with the label, the language, the node and the time ("label "a" [de]: covers node "n3" from 6.50 s to 8.20 s"), and does not fail the checks: sometimes a label over a shape is intended. Nodes fainter than 0.25 and labels fainter than 0.5 are not counted. Frames are sampled ten times a second, so a touch shorter than that can be missed.

`skink3 check` also runs the motion review and the physics review and shows each in short form: the number of findings by kind, the worst five, and a pointer to `skink3 motion` or `skink3 physics`. They are warnings and never fail the checks.

`skink3 render` runs the palette, string and text checks for the language it renders, prints any warnings, and stops if a check fails (`--force` renders anyway). It does not run the two reviews.

`npm run check` in the engine repository also runs `tsc --noEmit` and the unit tests.

## Motion review

Nobody has to watch the video to find out whether the motion is smooth. `skink3 motion <scene>` evaluates the shot at every frame without drawing and reports, as text and as JSON:

| Finding | What it is |
|---|---|
| `jump` | a teleport or a pop: position, rotation, size or opacity out of line with the frames around it |
| `abrupt-start`, `abrupt-stop` | a move with no ease at one end |
| `mechanical` | a move between two rests at constant speed |
| `too-fast` | travel of half the node's own size per frame or more, sustained: it strobes at 60 fps |
| `spring-ringing`, `spring-no-overshoot` | a spring that swings far too long, or a bouncy one that never passes its place |
| `dead-area` | nothing moves on its own in the frame for more than 4 s, or in a sixth of it for more than 6 s |

`skink3 trail` and `skink3 graph` draw pictures in which time is visible: a node at every k-th frame in one image, and its speed over time. `skink3 motion --pictures` draws both for the worst findings.

A finding that is what you want is marked in the scene, with the reason; the report then leaves it out of the warnings and lists it as honoured:

```ts
shot({
  // ...
  intended: [intended('plug', 'abrupt-start', 'it is shot out of the tube')],
});
```

Two things to know when you write a scene:

- With `anticipation: 0` and `overshoot: 0` a `moveTo` is a plain ease-out: it starts at full speed. The same holds for `turnTo`, `scaleTo` and `openTo` with `overshoot: 0`. The review reports that as `abrupt-start`. Keep one of the two above 0 unless the start is hidden or meant.
- Keep a small thing slow: under half of its own size per frame.

The full guide, with how to read a trail and a graph, every threshold, and what the review cannot tell: [MOTION-REVIEW.md](MOTION-REVIEW.md).

## Physics review

Whether the rigid bodies behave like solid things is checked from the bake, without drawing. `skink3 physics <scene>` reports, as text and as JSON:

| Finding | What it is |
|---|---|
| `overlap` | two bodies sunk into each other deeper than a soft contact gives, for long enough to be seen |
| `tunnelling` | a body that passed through a fixed body, or through a gap between two fixed bodies that is narrower than itself |
| `escape` | a body that lay on something and ends below every fixed body, still falling |
| `jitter` | a body at rest that keeps swinging back and forth by half a pixel or more |
| `unsettled` | a pile that still travels at the end of the shot, two seconds or more after the last body landed |
| `energy-spike` | speed that neither gravity nor anything in touch can have given |
| `unseen-hit` | a seen body whose path is bent by a body that is not drawn: it bounces off nothing |
| `not-finite` | a baked position that is not a number |

`skink3 physics --pictures` draws the worst findings: a close-up of the frames with the bodies ringed, a ghost trail, or a speed graph. A finding that is what you want is marked with `intended()`, as for the motion review:

```ts
shot({
  // ...
  intended: [intended(crumbIds, 'escape', 'the crumbs fall out of the picture')],
});
```

Things to know when you write a scene with bodies:

- Release bodies apart from each other and clear of the walls.
- Let the walls of a container overlap where they meet. A gap narrower than a body is a place where a loaded pile can press one through.
- Give a pile time: the review asks for rest two seconds after the last body landed. If the shot must end earlier, the pile may still travel, and that is not reported.
- A body that is meant to leave the picture and fall forever is reported as an escape only if it lay on something first and is seen leaving. Mark it as intended, or fade it out before it leaves.
- What is not seen is not reported: a body that is faded out, has no size or is outside the frame.
- A dynamic body collides from its release on, drawn or not. One that is faded out or has not popped in yet, in the way of bodies that are seen, makes them bounce off nothing.

The full guide, with every threshold, how to read the pictures, and what the review cannot tell: [PHYSICS-REVIEW.md](PHYSICS-REVIEW.md).

## Command line

```
skink3 <command> <scene module> [options]

check   palette laws, string tables and text fit in every language; motion and physics findings in short
bake    simulate physics, springs and particles; write the cache        [--force]
still   frames as PNG          --frame <n[,n...]> | --time <s[,s...]>   [--hash]
strip   a motion strip         --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   a contact sheet        [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  an mp4                 [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion  the motion review      [--pictures [--top 3]]                   report as text, and as JSON in out/<shot>/motion.json
physics the physics review     [--pictures [--top 3]]                   report as text, and as JSON in out/<shot>/physics.json
trail   a ghost trail          --node <id[,id...]> [--from f] [--to f] | [--time s,s]  [--every k] [--space stage|screen]
graph   a speed graph          --node <id> | --camera   [--from f] [--to f] | [--time s,s]

common  --lang <tag>  --width <px> (default 1920)  --cpu  --out <file>  --cache <dir>
```

- Inside the engine repository the command is `node bin/skink3.mjs`; from a repository that depends on the engine it is `npx skink3`.
- Output goes to `./out/<shot id>/`, the bake cache to `./cache/`, both relative to the directory the command is run from.
- `still`, `strip`, `sheet`, `render`, `check`, `motion`, `physics`, `trail` and `graph` bake first if the cache is missing or stale.
- `--crop` is in stage units with the origin at the **top-left** corner of the frame (unlike scene coordinates).
- `sheet --lang en,x-long --frames 700,880` puts the same frames side by side in several languages: the way to review a translation.
- `--hash` and `--hashes` print or write the SHA-256 of each frame's raw RGBA pixels, for determinism checks.
- `render` reports its progress: a line rewritten in place on a terminal, a line every five seconds otherwise.
- If one render worker fails, the others are stopped at once, the partial files are removed, and the command exits with code 1 and a message naming the worker's frame range.

Review the picture with stills, strips and sheets, the motion with `motion`, `trail` and `graph`, and the simulation with `physics`; render the video when those look right.

## From another repository

A production repository depends on a checkout of the engine (`"skink3-engine": "file:../skink3-engine"`), keeps its own scenes, palettes and string tables, and imports from the package name:

```ts
import { shot, layer, circle } from 'skink3-engine';
```

Run `npm ci` in the engine checkout too. The dependency must stay a link (npm's default for a `file:` directory); a copy inside `node_modules` cannot be loaded, because Node does not strip types there. For type checking, a `tsconfig.json` with `"module": "nodenext"`, `"allowImportingTsExtensions": true`, `"noEmit": true` and `"skipLibCheck": true` works.

## Programmatic use

Everything the command line does is exported: `compileShot`, `bakeShot`, `ensureBake`, `evaluate`, `runChecks`, `frameRaw`, `framePng`, `renderSheet`, `renderParallel`, `loadShot`, for the motion review `sampleMotion`, `reviewMotion`, `formatMotionReport`, `renderTrail`, `renderGraph`, `motionPictures`, and for the physics review `reviewPhysics`, `formatPhysicsReport`, `physicsPictures`, `renderCloseUp`. `evaluate(compiled, bake, frame, lang)` returns the display list of a frame and is a pure function.

## What is not there yet

No transitions between shots, no narration or audio, no keys anchored to words, no free-form paths, no bubbles, titles or counters, no scripts beyond Latin and Cyrillic, no soft bodies, ropes, flocks or fluids, no motion blur, no blending of overlapping moves. See the roadmap in the README.

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

Two larger examples: `examples/demo/scene.ts` (a network, a creature, a pile of rigid bodies, labels) and `examples/flow/scene.ts` (things that travel along paths, a cover, a content with a level, clipping, a hop, a camera path).

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
- `drift.wander` adds a slow wobble on top of the travel: up to `wander` units sideways and 0.6 of that up and down, each along its own smooth noise line that changes about once per `period` seconds. It is too slow to carry a drift by itself: 14 units over 6 s add a few hundredths of a pixel per frame to the median speed.
- `pushIn` zooms from `from` to `to` over the whole shot, at a constant apparent speed.
- `focus` sets the blur per unit of depth behind (`far`) and in front of (`near`) the focus plane.
- Over a shot the camera travels `speed × 60 × seconds` units. Lay the scene out along that path and check a contact sheet.

#### A camera path

On one heading the travel grows with the length of the shot: at 0.45 units per frame a 19-second shot moves 513 units, a quarter of the frame, and a subject that has to stay in the middle slides out of it. A path lets the camera keep that speed without leaving its subject:

```ts
import { loopPoints } from 'skink3-engine';

camera: {
  // Round a loop about the subject at the speed of a drift; the wander and the push-in stay as they are.
  path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 },
  drift: { wander: 14, period: 6 },
  pushIn: { from: 1, to: 1.05 },
}
```

| Option of `path` | Default | Meaning |
|---|---|---|
| `points` | required | the places the camera looks at, in units of the focus plane; the first is where it starts. At least two; three for a closed path |
| `closed` | `false` | after the last point, back to the first, and round again |
| `smooth` | `1` | 1 joins the points with a smooth curve through them, 0 with straight lines |
| `speed` | none | units per frame along the path, like `drift.speed`. The camera keeps it for the whole shot: round and round a closed path; on an open one to the end and back again, slowing to a stop where it turns |
| `turn` | `1.6` | open path with a speed: the seconds a turn takes, from full speed to a stop and back to full speed the other way |
| `profile`, `ramp` | `'steady'`, `0.3` | without a speed the camera covers the path once over the shot: `'steady'` at one speed, `'ease'` from rest to rest, `'in'` or `'out'` with one eased end; `ramp` is the share of the shot an eased end takes |

- A path replaces `at`, `drift.speed` and `drift.heading`; give the path alone. `drift.wander` and `drift.period` still apply.
- `loopPoints(center, radius, { start?, clockwise?, points? })` returns the points of an ellipse (`radius` is one number or `[rx, ry]`; `start` is the angle of the first point in degrees, 180 by default: left of the centre). With `closed: true` it is a loop that never stops and never leaves its middle. Its length is about `2π × sqrt((rx² + ry²) / 2)`; at 0.45 units per frame the camera needs that many units divided by 27 seconds for one round.
- A closed path at a set speed is the way to hold a subject in a long shot. An open path with a speed stands still for a moment at each end; a path covered once is for a move that is the point of the shot.
- `skink3 motion` prints how far the camera travels, the box it stays in, and how fast each layer slides (see Motion review). `skink3 graph <scene> --camera` draws its speed.

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

`blur` (units), `parallax` and `tint` (0..1) override the derived values. Nodes are drawn in the order listed; children are drawn after their parent. Layers are drawn farthest first; two layers of the same depth are drawn in the order they are listed.

A point of a layer lands on the screen at `p × zoom + (tx, ty)` (origin at the top-left corner of the frame), with `zoom = 1 + (camera.zoom - 1) × parallax`, `tx = 960 - camera.x × parallax × zoom` and `ty = 540 - camera.y × parallax × zoom`: a layer with parallax *p* sees the camera move *p* times as far and zoom *p* times as much.

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
| `cover` | `false` | an opaque thing in front: glow does not shine through it (see Covers) |
| `backdrop` | `false` | labels may lie over it without a covers-node warning: ground, a wall, a backdrop |
| `clipTo` | none | id of a shape of the same layer: this shape and its children are drawn only inside that shape's outline (see Clipping) |
| `level` | none | makes the shape a content that fills its outline from the bottom (see Levels) |

| Factory | Extra options | Notes |
|---|---|---|
| `circle` | `r` | |
| `capsule` | `length`, `r`, `origin?`, `sway?` | a stick with round ends along its local x axis; `length` is tip to tip. `origin: 'start'` puts the first end at the node's position (a pivot); `sway` then lets the stick lean and swing around it on a spring |
| `polygon` | `sides`, `r`, `radius?` or `points`, `radius?` | a rounded **convex** polygon: regular (3–12 sides on a circle of radius `r`, corner radius default `0.16 × r`; the first corner points up) or from explicit corners |
| `rect` | `w`, `h`, `radius?` | rounded rectangle centred on its position; `radius` (default 22 % of the short side) must stay below half the short side (use a capsule for a pill) |
| `blob` | `r`, `points?` (9), `wobble?` (0.14), `seed?` (1) | a soft irregular outline; the same seed gives the same blob |

Concave forms are composed from several shapes in a `group`.

How a glow is drawn, so that its reach can be planned: a halo around the shape, blurred by 0.2 and by 0.9 of the shape's outer radius (at least 5 and 18 units, at most 14 and 64), and a lift of the background in a soft disc 5.5 outer radii wide. Both grow with the shape, so a long glowing capsule lights a wide part of the sky; both are scaled by `glow` and by the opacity. A shape that waits outside the frame still lifts the part of the frame its disc reaches.

#### Covers

By default the halo of a glowing node is drawn over everything in its layer, also over an opaque shape listed after it, and its lift of the background spreads round that shape. `cover: true` on the shape in front stops both:

```ts
circle({ id: 'lamp', at: [0, 0], r: 16, fill: 'accent.amber', glow: 0.7 }),
rect({ id: 'wall', at: [0, 0], w: 240, h: 300, fill: 'dark.indigo', cover: true }),   // listed after what it hides
```

- A cover hides the glow of everything drawn **before** it in its layer, where it lies over it. What sticks out from behind it glows as before; what is drawn after it is in front of it and is untouched.
- A glowing shape lifts the background only as far as it can be seen: wholly behind a cover it adds nothing, half behind it adds half.
- A half-faded cover hides half: the effect follows its opacity.
- The motion review does not judge what is wholly behind a nearly opaque cover: a start, a stop or a jump there is not seen (see Motion review).
- Layers in front already hide the halos of layers behind them; a cover is about one layer.

#### Clipping

`clipTo: '<id>'` on a shape, a group, a link or an emitter draws that node, and everything in it, only inside the outline of the named shape of the same layer, wherever that shape is at the frame:

```ts
rect({ id: 'window', at: [0, 0], w: 300, h: 300, fill: 'dark.navy', opacity: 0 }),      // the shape may be invisible: only its outline counts
emitter({ id: 'snow', at: [0, -200], area: [600, 10], rate: 40, life: 6, size: 5, colors: ['light.snow'], clipTo: 'window' }),
```

- The shape that clips is not changed and may be invisible (`opacity: 0`), may move, turn and grow.
- Glow is clipped as well, and a glowing node lifts the background only by the share of it that is inside. Wholly outside its clip a node leaves nothing in the picture.
- Clipped to a shape with a `level`, a node is drawn only in the filled part of it: fizz in a drink.
- A node cannot be clipped to itself or to something inside it. Labels and eyes take no `clipTo`; put an eye in a group and clip that.

#### Levels

`level` makes a shape a content: it is drawn from the bottom of its outline up to a level, 0 (empty, nothing is drawn) to 1 (full). `levelTo` raises and lowers it.

```ts
rect({ id: 'glass', at: [0, 100], w: 300, h: 380, radius: 44, fill: 'dark.navy', opacity: 0.5 }),
rect({
  id: 'content', at: [0, 106], w: 264, h: 344, radius: 30, fill: 'mid.ocean',
  level: { at: 0.1, wave: { amp: 5, length: 150, speed: 36 } },
  children: [group({ id: 'surface' }), circle({ id: 'float', at: [44, -5], r: 15, fill: 'light.cream' })],
}),
// timeline
levelTo('content', { at: 2, to: 0.8, dur: 6 }),
```

- `level: 0.4` is a flat surface; `level: { at, wave: { amp, length?, speed? } }` adds a ripple of `amp` units, `length` units long (160), running at `speed` units per second (40; negative runs left). The ripple dies out toward empty and toward full, so 0 is empty and 1 is full.
- The level is a share of the height of the shape's outline as it stands in the layer: `surface y = bottom - level × (bottom - top)`. The surface stays level when the shape turns.
- **Children ride on the surface.** Their `at` is measured from the middle of the surface line, so a float, an anchor for a label or a thing for eyes to look at follows the level by itself. They are not clipped by it.
- The shape keeps its light, its glow and its opacity; a pale line marks the surface when the shape is `lit`.
- The vessel is a shape of its own, drawn before or after the content; the content is usually a little smaller.
- A rigid body cannot have a level.

### `group({ id, at?, rotation?, scale?, opacity?, upright?, children?, follow?, idle?, clipTo? })`

An invisible parent. Its children move, turn and scale with it. A group with no children is useful as an anchor: something for a label to point at or for eyes to look at, which the timeline can move.

`upright: true` makes the group keep its own rotation in the layer's space instead of turning with its parent. It still follows the parent's position and size. Use it for a face on something that rolls or tumbles, such as a rigid body: the eyes stay level while the body turns under them.

```ts
circle({ id: 'ball', r: 30, fill: 'accent.amber', body: { kind: 'dynamic', release: 1 },
  children: [group({ id: 'ball-face', upright: true, children: [eye({ id: 'ball-eye', r: 8, white: 'light.snow', pupil: 'deep.abyss' })] })] })
```

### `link({ id, from, to, color, pulseColor?, bend?, width?, gap?, opacity?, glow?, clipTo? })`

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
| `clipTo` | none | id of a shape of the same layer: the link is drawn only inside its outline (see Clipping) |

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

- **Lines break at ordinary spaces only.** A no-break space (U+00A0) in a string of the table keeps the words on both sides of it on one line: write a value and its unit, or a number and what it counts, with one between them. So do a narrow no-break space (U+202F) and a figure space (U+2007).
- The layout first tries the preferred size and wraps to `maxWidth`; only if that takes more than `maxLines` does it shrink the font, one unit at a time. So a wider `maxWidth` can give a larger font on more lines for a long string. To keep a box compact, lower `maxLines`.
- The tail of a label points at the edge of its target on the chosen `side`, `gap` units away; a label has no other offset. To put a label somewhere else, point it at an empty `group` placed there.
- A label and its target must be in the same layer.
- A label over ground or a wall gives a covers-node warning unless that shape is marked `backdrop: true`.

### `eye({ id, r, white, pupil, at?, scale?, opacity?, lookAt?, blink?, open? })`

A light disc with a pupil. `lookAt` is the id of a node in the same layer that the pupil follows. Eyes blink now and then (`blink: false` turns it off); eyes that share a parent blink together.

`open` (0..1, default 1) sets the lids at the start. At 0 the eye is shut, and a shut eye is not drawn at all, so a thing can look lifeless until its eyes open. `openTo` opens and closes the lids, and `blink` asks for a blink at a chosen moment (see the timeline). For a character whose blinks must not land on a staged moment, set `blink: false` and place the blinks yourself.

A simple creature is a blob with two eyes as children, optionally with `capsule` sticks that `sway`. That is all a character needs under the simple-forms rule; see `examples/demo/scene.ts`.

### `emitter({ id, colors, size, life, ... })`

Particles are small circles. By default each swells quickly and then shrinks to nothing (`sizing: 'spark'`); with `sizing: 'steady'` it keeps its size for nearly all of its life. They live in the layer's space.

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
| `sizing` | `'spark'` | how the radius runs over a particle's life. `'spark'`: it reaches its size after 12 % of its life, holds it until half-way, and shrinks smoothly to nothing over the second half. `'steady'`: full size from 8 % to 92 % of its life, with a short swell and a short shrink: for motes that drift and for particles that carry something across the frame |
| `clipTo` | none | id of a shape of the same layer: the particles are drawn only inside its outline (see Clipping) |

An emitter needs at least one of `rate`, `bursts`, `onContact`. `from`, `until` and the `at` of a burst are 0 or later; an emitter that should already be running at frame 0 takes a `prewarm`.

## Timeline: intents

A key says what should happen to a node and when. The engine supplies the curve.

| Intent | Targets | Options (defaults) | What the engine does |
|---|---|---|---|
| `moveTo(id, { at, to, ... })` | shape, group, eye | `dur` (1.1), `anticipation` (0.08), `overshoot` (0.07), `arc` (0.12), `profile` (`'settle'`), `ramp` (0.3), `arrive` instead of `at` | backs away a little, travels along an arc, shoots past the destination, settles. Starts from wherever the node is. `anticipation` and `overshoot` are fractions of the distance (capped at 44 and 38 units); `arc` is the bulge as a fraction of the distance (capped at 150 units), positive toward the top of the frame (to the left for a move straight up or down). Other profiles: see Moves |
| `hop(id, { at, to, ... })` | shape, group, eye | `dur` (0.6), `height` (80), `land` instead of `at` | a jump: leaves at `at`, flies a parabola `height` units high, lands at `at + dur`. See Moves |
| `travel(id, { at, path, ... })` | shape, group, eye | `speed` or `dur`, `profile` (`'steady'`), `ramp` (0.3), `smooth` (1), `closed`, `loops` (1), `roll`, `orient`, `only` | travels along a free-form path at a known speed. See Moves |
| `levelTo(id, { at, to, ... })` | a shape with a `level` | `dur` (1.5), `profile` (`'ease'`), `ramp` (0.3) | raises or lowers the level to `to` (0 = empty, 1 = full); it is there exactly at `at + dur`. See Levels |
| `squash(id, { at, ... })` | shape, group, eye | `amount` (-0.22), `dur` (0.6), `pivot` (`[0, 0]`) | a quick squash (negative) or stretch (positive) that rings out; the area stays. See Moves |
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

- Moves of one node (`moveTo`, `hop`, `travel`) may not overlap in time; the same holds for turns and for pops. `popIn` and `popOut` must alternate.
- A node with a `popIn` and no earlier `popOut` starts hidden. A node without pops is visible from the start.
- **A key may start before the shot:** `at` runs from -600 to 3600 seconds. What it does is then under way, or over, at frame 0: a light that is already on, a node that is already half-way, a flow that already runs. A key may not start after the shot ends.
- `seconds` of a shot is rounded to the nearest frame, and frame *n* shows the moment *n*/60.
- `scaleTo`, `fadeTo` and `levelTo` chain: each starts from the size, opacity or level the node has at that moment, also when the previous one is still under way.
- Size is a product: the authored `scale` × pops × the lasting size from `scaleTo` × bumps. So a node can pop in, grow in steps, and still react with a bump (also the bump a pulse gives on arrival) at any size. `scaleTo` overshoots in proportion: growing to 2 with `overshoot: 0.15` peaks near 2.2, shrinking to 0.5 dips to 0.45.
- A rigid body cannot be the target of `moveTo`, `hop`, `travel`, `turnTo` or `scaleTo`; it can pop, bump, squash and fade.
- `bump` takes an `amount` between -0.5 and 0.5; a negative one is a quick shrink.
- `scaleTo` and `bump` change the size evenly in every direction; `squash` is the one that changes the proportions.
- `openTo` keys chain like `fadeTo`: each starts from the opening the eye has at that moment. Blinks multiply with the lids, so a blink never opens a shut eye. The lids open to 1 at most; for eyes that widen, `scaleTo` the eye or the group it is in.
- To time something to a pulse's arrival, use `at + dur` of that pulse.

### Moves

**The default move settles.** `moveTo` with the profile `'settle'` backs away, goes, shoots past its destination and settles. Its moments, as shares of `dur`:

| Moment | With the defaults | In general |
|---|---|---|
| it stops backing away and goes | 0.24 | 0.24 with an `anticipation`, 0 without |
| it first reaches the destination | 0.52 | 0.47 to 0.55 with an `anticipation` and an `overshoot`; 0.30 to 0.36 with an `overshoot` alone; exactly 1 without an `overshoot` (the move is then an ease-out) |
| the rest | overshoot and settle | |

Most of the travel happens in about a quarter of the duration, so the peak speed is 5.6 times the mean with the defaults (about 4 without an anticipation, more with a large one): a long move needs a long `dur` to stay under the strobing limit of the motion review, or the profile `'ease'`. Two things spare you the arithmetic:

```ts
import { moveTimes, moveTo } from 'skink3-engine';

const { leaves, arrives } = moveTimes({ dur: 1.2 });       // seconds after `at`, for the options you give (here the defaults)
moveTo('ball', { arrive: 6.5, to: [200, 0], dur: 1.2 });   // placed by the moment it first reaches its destination
```

A move longer than about 540 units backs away and overshoots by fewer units than its fractions say (the caps), which shifts its arrival by a frame or two; `moveTimes({ dur, distance })` takes that into account, `arrive` cannot know the distance and does not.

**Plain profiles** spread the speed over the duration and arrive exactly at `at + dur`. They take no anticipation and no overshoot; `arc` still applies.

| `profile` | Speed | Peak speed, × distance / `dur` | For |
|---|---|---|---|
| `'settle'` | the curve above | 5.6 with the defaults | a thing that moves by itself and comes to rest |
| `'ease'` | ramps up, holds, ramps down | `1 / (1 - ramp)`: 1.43 at the default `ramp` 0.3, 2 at 0.5 | a plain move from rest to rest, a long move that must not strobe |
| `'steady'` | one speed from the first frame to the last | 1 | a flow: something that enters and leaves, or starts and ends out of sight |
| `'in'` | from rest, then steady | `1 / (1 - ramp / 2)` | it starts in view and leaves at speed |
| `'out'` | steady, then down to rest | `1 / (1 - ramp / 2)` | it arrives at speed and stops in view |

`ramp` is the share of the duration an eased end takes (0.02 to 0.5). The motion review still judges what it sees: a `'steady'` move between two rests in view is reported as mechanical, and a start at full speed in view as abrupt.

**A hop** is a jump with a known take-off and a known landing:

```ts
squash('buddy', { at: 4.0, amount: -0.16, dur: 0.34, pivot: [0, 50] }),   // it crouches
hop('buddy', { at: 4.3, to: [800, 130], dur: 0.72, height: 150 }),         // leaves at 4.3 s, lands at 5.02 s
squash('buddy', { at: 5.02, amount: -0.26, dur: 0.7, pivot: [0, 50] }),    // and squashes against what it lands on
```

- Sideways it travels at one speed; its height follows a parabola, as under gravity: at half time it is `height` units above the middle of the straight line from take-off to landing. It may land higher or lower than it left, or on the spot.
- `land` instead of `at` places it by its landing.
- It leaves and lands at speed. That is what a jump is, and the motion review does not report it as an abrupt start or stop. A hop between two places at the same height has the speed `sqrt((distance / dur)² + (4 × height / dur)²)` units per second at both ends; keep it under half the node's size per frame, or the review reports it as too fast.
- Up is the top of the frame, in the space of the node's parent.

**`squash`** changes the proportions for a moment: with a negative `amount` the node and everything in it get lower and wider (−0.25: about three quarters of the height), with a positive one taller and narrower; the area stays. It springs back, passes its shape a little and settles within `dur`. `pivot` is the point that stays in place, measured from the node's origin in the layer's directions (y down), in the node's own units: `[0, r]` is the lowest point of a circle of radius `r`, so it squashes against the ground. It is a look only, like a bump: colliders, labels and links do not follow it.

**`travel`** moves a node along a free-form path at a known speed:

```ts
const path: Vec2[] = [[-1180, -260], [-860, -300], [-600, -60], [-300, 150]];
// A flow: one node after the other at one speed, under way before the shot starts, drawn only while it travels.
...stagger(beadIds, { at: -4.6, each: 0.52 }, (id, at) => travel(id, { at, path, speed: 250, roll: 17, only: true })),
```

| Option | Default | Meaning |
|---|---|---|
| `path` | required | the points the node passes through, in its parent's space; the first is where it starts (if it is somewhere else at `at`, it jumps there) |
| `speed` or `dur` | one of them | `speed` in units per second on the steady stretch (the duration follows from the length of the path), or `dur` in seconds for the whole path |
| `profile`, `ramp` | `'steady'`, `0.3` | as for `moveTo`, without `'settle'` |
| `smooth` | `1` | 1 joins the points with a smooth curve through them (it bulges a little past the straight lines), 0 with straight lines |
| `closed`, `loops` | `false`, `1` | back to the first point after the last one; `loops` times round |
| `roll` | none | the node turns as a wheel of this radius that rolls along the path: clockwise when it travels to the right. Give the radius of the shape for a thing that rolls without slipping |
| `orient` | `false` | the node turns to face along the path (its local x axis points the way it goes) |
| `only` | `false` | the node is drawn only while it travels: hidden before `at` and after it arrives |

- The path is measured by its own length, so the speed along it is exactly what the profile says, on curves as on straight stretches.
- After the travel the node stays at the last point (a closed path: at the first).
- A flow reads as a flow when it enters and leaves: start the path outside the frame or behind a `cover`, and end it there. `only: true` spares the fades; a flow that should already run at frame 0 starts its first keys before 0.
- A node is turned by `roll` or `orient`, or by `turnTo`, not by both.
- `pathLength`, `pathTable` and `pathAt` are exported for scene code that needs the length of a path or a point on it.

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
- `{ kind: 'dynamic', release, velocity?, spin?, density?, friction?, restitution?, appear? }` stays where the scene put it until `release` (seconds), then the simulation takes it over. Before its release it does not collide with anything. `velocity` (units per second) and `spin` (degrees per second) apply at the release.
- While it waits for its release a body is drawn where the scene put it, glow included: a hundred glowing pieces that wait above the frame light the top of it. `appear: 'release'` leaves a body undrawn until it is released; the simulation is the same either way.
- `release` may be negative, down to minus the shot's `physics.prewarm`. The world then starts that many seconds before frame 0, and such a body is already falling, or already at rest, when the shot opens. Contacts from before frame 0 are not recorded.
- Bodies must be listed directly in a layer, and all bodies of a shot must be in the same layer.
- The collider is the shape itself (a blob uses its convex hull).
- Every contact is recorded with its time, place and peak impulse; `skink3 bake` prints how many. Emitters can react to them with `onContact`. They are also meant for sound, which is not built yet.
- Put a body where it has room at its release: one that is released inside another body or inside a wall is pushed out over a few frames, in view. The physics review reports it as an overlap that starts at the release.
- A body is a solid thing only as far as its own shape goes. Children drawn past that shape, and a pop or a bump (which change the picture, not the collider), are not part of what collides.
- A faded body still collides, and so does a fixed body with `opacity: 0`. That is how a container is drawn by other shapes around invisible walls; draw it where the walls are.
- Gravity, damping, friction and restitution are set for the whole shot (`physics`); a body can override friction and restitution, not gravity or damping. The damping is a drag on the velocity: without anything in touch a body follows `dv/dt = gravity - linearDamping × v`, so a fall levels off at the speed `gravity / linearDamping`. With `gravity: 0` nothing falls, and with both dampings at 0 a body keeps the velocity and the spin of its release.
- A body cannot be taken out of the world, steered or slowed once it is released, and collisions cannot be filtered. Something that should travel at a set speed along a set way is not a body: use `travel`.
- For a content that should reach an exact level, use a shape with a `level`: a pile of bodies ends where the simulation puts it.

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

A warning is printed with the label, the language, the node and the time ("label "a" [de]: covers node "n3" from 6.50 s to 8.20 s"), and does not fail the checks: sometimes a label over a shape is intended. Nodes fainter than 0.25 and labels fainter than 0.5 are not counted, and neither is a shape marked `backdrop: true` (ground, a wall: things that are there to have labels in front of them). Frames are sampled ten times a second, so a touch shorter than that can be missed.

The checks do not look at the glyphs of a string: a character that the bundled font lacks is drawn as an empty box and passes. Look at the label sheet of every language (`skink3 sheet --lang`).

`skink3 check` also runs the motion review and the physics review and shows each in short form: the number of findings by kind, the worst five, and a pointer to `skink3 motion` or `skink3 physics`. They are warnings and never fail the checks.

`skink3 render` runs the palette, string and text checks for the language it renders, prints any warnings, and stops if a check fails (`--force` renders anyway). It does not run the two reviews.

`npm run check` in the engine repository also runs `tsc --noEmit` and the unit tests.

## Motion review

Nobody has to watch the video to find out whether the motion is smooth. `skink3 motion <scene>` evaluates the shot at every frame without drawing and reports, as text and as JSON:

| Finding | What it is |
|---|---|
| `jump` | a teleport or a pop: position, rotation, size, opacity or level out of line with the frames around it |
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

The report also describes the life of the background, findings or not: the median drift of the camera and its zoom, how far the camera travels and the box it stays in, how fast every layer slides across the screen, and for every emitter how many particles are in frame and how fast they travel on their own. A background is alive when the camera drifts in the norm (0.3–0.7 px per frame), the layers slide at different speeds, and the particles move.

Things to know when you write a scene:

- With `anticipation: 0` and `overshoot: 0` a `moveTo` is a plain ease-out: it starts at full speed. The same holds for `turnTo`, `scaleTo` and `openTo` with `overshoot: 0`. The review reports that as `abrupt-start`. Keep one of the two above 0 unless the start is hidden or meant, or use the profile `'ease'`.
- Keep a small thing slow: under half of its own size per frame.
- What is wholly behind a `cover`, or wholly outside the shape it is clipped to, is not judged: put a start or a stop that should not be seen behind one, instead of marking it as intended.
- A hop leaves and lands at speed without a finding; a `'steady'` move or travel is a flow only if it enters and leaves the picture, or starts and ends out of sight.
- A node moved through a group that draws nothing of its own is judged on the group: its speed against the size of what the group holds. A peak of fewer than six frames above the strobing limit is not reported; look at `skink3 graph` for a fast move that matters.

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

What a test or a tool of a production usually reads:

```ts
import { bakeShot, compileShot, computeWorld, evaluate, flatItems, FPS, posesFromBake } from 'skink3-engine';

const c = compileShot(spec);            // spec: what shot() returned
const bake = await bakeShot(c);         // in memory; ensureBake(c, cacheDir) uses the cache on disk
```

| What | Where |
|---|---|
| length | `c.frames` (frame *n* is the moment *n* / `FPS`) |
| a node | `c.byId.get(id)`: `index`, `node` (the data the factory returned), `layer`, `parent`, `bodySlot`, `springSlot`, `emitterSlot` (-1 when it has none) |
| slots | `c.bodies`, `c.springs`, `c.emitters`: node indices by slot; the same order as `bake.header.bodies`, `.springs`, `.emitters` (node ids) |
| a rigid body at a frame | `bake.bodyX(slot, frame)`, `bake.bodyY(slot, frame)`, `bake.bodyRot(slot, frame)` (radians), in the units of the bodies' layer |
| contacts | `bake.header.events`: `{ frame, time, a, b, x, y, impulse }` per contact, in order of time; `a` and `b` are node ids, `x`, `y` the place in the layer, `impulse` the peak normal impulse |
| particles of an emitter at a frame | `bake.particlesAt(slot, frame)`: `x, y, radius, colour index` per particle, in the layer's units |
| any node at a frame | `computeWorld(c, frame, posesFromBake(bake))[index]`: `{ x, y, rot, scale }` in the space of the node's **layer** (not the screen; `rot` in radians). For a label: the tip of its tail |
| what is drawn at a frame | `evaluate(c, bake, frame, lang).layers[i].items`, a tree in draw order; `flatItems(items)` opens the groups. A leaf has `kind` (`'shape'`, `'eye'`, `'link'`, `'label'`, `'particles'`), `node` (the compiled node: `node.id`), and for shapes and eyes `xf` (as above) and `alpha` (its opacity down the tree); an eye also has `look` and `open`. A node that is hidden is simply not in the list |
| a layer on screen | `evaluate(...).layers[i].view`: `{ zoom, tx, ty }`, screen = layer × zoom + (tx, ty) |
| the style defaults | `PHYSICS_DEFAULTS`, `CAMERA_DEFAULTS` |

`evaluate` wraps what it draws in three kinds of items besides the leaves: `'group'` (a node that is not fully opaque, with its `opacity`), `'clip'` (nodes drawn inside the outline of a shape) and `'stretch'` (a node that is being squashed). `flatItems` opens all three.

For subtitles, `cuesFromWords(words, options)` turns the word timings of a narration into subtitle cues (lines of a set length, breaks at the ends of sentences and at pauses), and `formatSrt`, `formatVtt` and `formatYtt` write them out; see `src/text/subtitles.ts`.

## What is not there yet

No transitions between shots, no narration or audio, no keys anchored to words, no bubbles, titles or counters, no scripts beyond Latin and Cyrillic, no check that the font has every glyph of a string, no soft bodies, ropes, flocks or fluids, no motion blur, no blending of overlapping moves, no concave shapes or corners with different radii, no bodies that can be steered or retired, no way for a scene to follow a baked quantity (the height of a pile). See the roadmap in the README.

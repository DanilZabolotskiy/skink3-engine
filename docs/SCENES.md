# Writing a scene

This is the guide and the API reference for scene authors, people or agents. It describes what exists today (phase 0). If something is not here, the engine does not have it yet.

For one shot, read [QUICK-REFERENCE.md](QUICK-REFERENCE.md) first: every feature with its defaults and an example, the command line and how to read the reviews, on one page. Its index names the section of this guide to open for more.

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
| Nothing is dropped | every factory and every intent refuses an option it does not take, by name, with the options it does take: a misspelt option never gives a picture that quietly differs from what was asked |
| Simple forms only | the shapes are circle, capsule, rounded convex polygon, blob and a free-form region; there are no hands, fingers, feet or limb mechanics to call |
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
node bin/skink3.mjs check examples/minimal/scene.ts            # the palette's own rules, strings, text fit
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

Colour belongs to the production. The engine has no colour of its own and no rule about colour: a palette is the scheme of a channel or of a series, and what it may hold is for the production to say.

```ts
const palette = definePalette({
  deep:   { name: '#RRGGBB', ... },
  dark:   { ... },
  mid:    { ... },
  accent: { ... },
  light:  { ... },
  pairs:  [['oneAccent', 'another'], ...],             // optional: pairs of accents, for a rule to hold
  rules:  [{ roles: ['deep'], lightness: [0, 15] }],   // optional: the production's own rules
  tones:  { shadowHue: 220, highlightHue: 60 },        // optional: the hues the light leans to
});
```

- `hsv(hueDegrees, saturation, value)` returns a `#RRGGBB` string; it keeps the construction of a palette readable.
- Scenes refer to a colour as `"role.name"`, for example `"accent.amber"`. Every colour of a frame is one of the shot's palette, or derived from one: the background, the atmosphere, every fill, line, letter and particle.
- **A role is a name.** The five roles group the colours of a palette, by custom from its darkest (`deep`) to its lightest (`light`), with the `accent`s apart. The engine reads no lightness, hue or saturation into a role: any colour may stand under any of them. Each role holds at least one colour.

### Rules of a palette

A production may write down what it promises about its colours, in the palette itself. `checkPalette(palette)`, which `skink3 check` runs and every render runs first, holds the palette to those rules and fails on one that is broken. **A palette without `rules` is not checked for anything.**

A rule names the `roles` whose colours it holds (all five when left out) and one thing to hold them to:

| In a rule | Holds |
|---|---|
| `lightness: [min, max]` | the CIE L* of every colour of those roles, 0 to 100 |
| `saturation: [min, max]`, `value: [min, max]` | its HSV saturation, its HSV value, 0 to 1 |
| `meanSaturation: [min, max]` | the mean saturation of those colours together |
| `hue: [from, to]`, with `share` | a band of hue in degrees, clockwise, which may pass 360 (`[330, 75]`); `share` is the share of those colours that lie in it: a number is the least share, `[min, max]` a least and a most. Left out, all of them lie in it |
| `pairs: { atLeast?, first?, second?, apart? }` | the `pairs` of the palette: how many there are at least, the band of hue of the first and of the second colour of each, and how many degrees apart the two are at least. It takes no `roles` |
| `name` | what the rule is called in a message |

```ts
rules: [
  { name: 'the sky is the darkest', roles: ['deep'], lightness: [0, 14] },
  { name: 'accents are vivid', roles: ['accent'], saturation: [0.6, 1] },
  { name: 'never one hue', roles: ['deep', 'dark'], hue: [210, 300], share: [0, 0.5] },   // at most half of the dark colours between blue and violet
  { name: 'a warm accent with a cool one', pairs: { atLeast: 1, first: [330, 75], second: [150, 270], apart: 90 } },
],
```

A broken rule is reported with its name and the colour that breaks it: `accents are vivid: accent.dust #8A8F99: saturation 0.10 is outside 0.6..1`. To choose colours that stand apart, `colourDistance(a, b)` gives the difference of two colours in lightness and in colour (see Contrast review).

### Tones: the hues the light leans to

Shadow, rim and highlight tones are derived from a shape's `fill`: shadows darker and more saturated, lit tones lighter and paler. You never specify them. Each also leans a little in hue, as light does: the shadow by up to 14 degrees (the deep shadow by 28) toward one hue, the lit tones by up to 16 degrees toward another. `tones` names those two hues for a palette:

```ts
tones: { shadowHue: 220, highlightHue: 60 },     // blue shadows, yellow lights
tones: { shadowHue: null, highlightHue: null },  // no lean: every tone keeps the hue of its colour
```

- **A palette that names none keeps the lean the engine was built with:** shadows toward 262 (indigo), lit tones toward 52 (a warm yellow). It is the one thing about colour that the engine still supplies by itself, so that a palette written before `tones` draws as it did. A palette that names both owns its light entirely.
- Far layers fade toward the shot's `atmosphere`, which is a colour of the palette too (see `layer`).

### Variants of a palette

A series has one scheme, and a set or a chapter may have a light of its own. A variant is the base palette with some colours replaced: build it from the `spec` of the base, and give each shot the variant it draws with.

```ts
export const series = definePalette({ ... });                        // the scheme of the series
const variant = (over: Partial<PaletteSpec>): Palette =>
  definePalette({
    ...series.spec,                                                  // its rules, its tones, its pairs
    deep: { ...series.spec.deep, ...over.deep }, dark: { ...series.spec.dark, ...over.dark }, mid: { ...series.spec.mid, ...over.mid },
    accent: { ...series.spec.accent, ...over.accent }, light: { ...series.spec.light, ...over.light },
    ...(over.tones ? { tones: over.tones } : {}),
  });
export const palettes = {
  night: series,
  dawn: variant({ deep: { night: hsv(214, 0.7, 0.34), abyss: hsv(232, 0.82, 0.16) }, mid: { haze: hsv(18, 0.6, 0.86) }, tones: { shadowHue: 250 } }),
};
// a shot names the variant it draws with
shot({ palette: palettes.dawn, background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.haze', ... })
```

- **Every reference resolves against the palette of its shot:** fills, the background, the atmosphere, and the colours a `backgroundTo` names. A shot written for the base draws in any variant, because a variant has every name of the base.
- A variant carries the `rules` of its base and is held to them; it may bring `tones` of its own: the light of its set.
- **Give an override the name of a colour the base has.** A name the base does not have is a new colour: nothing refuses it, and the colour it was meant to replace stays as it was. Comparing `[...variant.colors.keys()]` with those of the base shows it.
- To change the light of a whole chapter, change which variant its shots name, in one place of the production (a table from chapter to palette): no shot is edited.
- One shot has one palette. A change of light inside a shot is a `backgroundTo`, between colours of that palette.

## Text: string tables

```ts
strings: {
  en: { 'label.core': 'Core' },
  de: { 'label.core': 'Kern' },
}
```

- Keys look like `label.core`: lower-case letters, digits, and `.`, `_`, `-` between parts.
- Every key a scene uses must exist in **every** table, or `shot()` throws.
- A render uses one language (`--lang`, default: the first table). Labels and texts size and wrap themselves to that language's string.
- Lines break at spaces only. Right-to-left text and scripts that need shaping are not implemented yet.
- Text never influences the bake: adding a language re-renders without re-baking.

### Fonts

Text is drawn with three bundled typefaces and with no font of the machine, so a string looks the same wherever it is rendered:

| Typeface | Drawn for |
|---|---|
| Nunito | everything it has: Latin, Latin Extended, Cyrillic, Vietnamese, digits, punctuation and the common signs. It is the typeface of the engine |
| Noto Sans | what Nunito lacks of: fractions, super- and subscripts, letterlike signs, punctuation, Greek, more Latin and Cyrillic |
| Noto Sans Symbols | what both lack of: arrows, Roman numerals, circled numbers, technical and other symbols |

- **A character is drawn by the first of them that has it,** in the weight of the text around it: all three have a weight axis (the two Noto typefaces up to 900), so an arrow in a heavy label is a heavy arrow.
- **For the typography of a figure they have:** the arrows `← ↑ → ↓ ↔ ↕ ↖ ↗ ↘ ↙`; the fractions `¼ ½ ¾ ⅐ ⅑ ⅒ ⅓ ⅔ ⅕ ⅖ ⅗ ⅘ ⅙ ⅚ ⅛ ⅜ ⅝ ⅞`; the signs `≈ ≠ ≤ ≥ ± × ÷ − ∞ √ ∑ ∏ ∫ ∂ ∆ ∅ ° µ ‰ ′ ″`; super- and subscript digits (`⁰` to `⁹`, `₀` to `₉`); currency signs (`€ £ ¥ ¢ ₽ ₹ ₿` and others); `№ ™ © ® ℓ ℃ ℉`; Roman numerals (`Ⅳ`) and circled numbers (`①` to `⑳`); the Greek alphabet.
- **They lack:** double and long arrows (`⇒`, `⟶`), the other mathematical operators (`∈`, `≡`, `∝`), geometric shapes (`■ ● ▲`), stars and check marks (`★ ✓ ✗`), and every script beyond Latin, Cyrillic and Greek.
- **A character that none of them has fails the checks** (see Checks), with the key, the language and the character. It would be drawn with whatever font the machine offers for it, or as an empty box, and the frame would depend on the machine.
- Every kind of space needs no glyph, and neither do the characters that are not drawn by themselves (a joiner, a soft hyphen).
- All three are under the SIL Open Font License 1.1 and lie in `assets/fonts/` with their licences. `fontOf(char)` says which of them draws a character, `missingGlyphs(text)` which characters of a text none of them has.

## `shot({ ... })`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | names the output folder and the cache file |
| `seconds` | number | required | length of the shot |
| `seed` | integer | required | seed of everything random in the shot |
| `palette` | `Palette` | required | from `definePalette` |
| `strings` | tables | required | language → key → text |
| `background` | `{ inner, outer, center?, radius? }` | center `[0.5, 0.46]`, radius `0.72` | radial gradient between two palette colours; centre in fractions of the frame, radius in frame widths. `backgroundTo` changes it over time, with `atmosphere` and `vignette` (see A background that changes) |
| `atmosphere` | colour | required | the colour far layers fade toward |
| `layers` | `layer()[]` | required | in any order; drawn farthest first |
| `timeline` | keys | `[]` | in any order; nested arrays are flattened |
| `light` | `{ from }` | `{ from: 'top-left' }` | `'top-left'`, `'top'`, `'top-right'`, `'left'`, `'right'`, `'bottom-left'`, `'bottom'`, `'bottom-right'`, or an angle in degrees |
| `vignette` | 0..1 | `0.5` | darkening of the corners toward `background.outer` |
| `camera` | see below | see below | drift or a path, push-in, depth of field; the timeline moves it (`cameraTo`) and zooms it (`zoomTo`) at a moment |
| `physics` | see below | see below | style of the rigid-body world |
| `intended` | `intended()[]` | `[]` | findings of the motion review, of the physics review or of the contrast review that are what you want, each with a reason (see Motion review, Physics review, Contrast review) |
| `contrast` | `{ nodes, lightness, colour, edge?, seconds? }` | off | turns the contrast review on for the nodes it names (see Contrast review) |

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

#### Camera keys

The drift, the push-in and a path run over the whole shot. A camera move with a moment of its own is a key of the timeline: a pull-back that starts on a word, a push into a detail, a long zoom through orders of scale.

```ts
// timeline
cameraTo({ at: 2, zoom: 0.5, dur: 1.6 }),                          // pull back: the view shows twice as much
cameraTo({ at: 5, zoom: 4, to: [300, -120] }),                     // push into a detail
cameraTo({ at: 8, zoom: 40, dur: 3, profile: 'steady' }),          // a long zoom at one apparent speed ...
cameraTo({ at: 11, zoom: 4000, dur: 3, profile: 'out' }),          // ... that speeds up, and comes to rest
```

| Option of `cameraTo` | Default | Meaning |
|---|---|---|
| `at` | required | seconds: when the move starts |
| `dur` | `1.2` | seconds it takes |
| `zoom` | the zoom it has | the zoom the camera has when the key ends, as a factor of the authored view: `2` shows the focus plane twice as large, `0.5` half as large. 0.01 to 10000 |
| `to` | where it looks | `[x, y]`: the place the camera looks at when the key ends, in units of the focus plane |
| `profile`, `ramp` | `'ease'`, `0.3` | how the speed is spread, as for a move: `'ease'` from rest to rest, `'steady'` at one speed, `'in'`, `'out'` with one eased end |

- Give `zoom`, `to`, or both. **Keys chain:** each takes over from where the camera is at its moment, also when the key before it is still under way.
- **The zoom is a ratio.** It runs from one factor to the other at one apparent speed along its profile, so a zoom from 1 to 1000 looks as even as one from 1 to 2. Two `'steady'` keys in a row are a zoom that changes speed where they meet.
- **A zoom alone holds the view:** what is in the middle of the frame stays there while the camera zooms, so the drift or the path stands still for as long as the key runs. That suits a quick move; for a slow push over a background that keeps sliding, use a zoom key (below). With `to` the camera is exactly there when the key ends, whatever the drift did meanwhile.
- **A push into a detail keeps the detail in view.** While the camera zooms in and moves, the place it is heading for nears the middle of the frame at one speed on screen; while it pulls back, the place it leaves slides out at one speed.
- **The drift, the wander and the push-in stay on top.** The keyed zoom multiplies the push-in. After a key the drift goes on from where the key ended, and it and the wander are as large on screen as ever: the more the camera has zoomed in, the fewer units they cover. Before the first key the camera is exactly what the shot's `camera` says.
- **Depth still shows.** A layer takes the keyed zoom to the power of its parallax: a far layer grows less than the focus plane and a near one more, whatever the zoom. Blur and halos stop growing at 400 px of a 1080p frame, so a deep zoom still draws.
- On a camera `path` the keys act from where the path has carried the camera; after a key the path goes on, as large on screen as before.
- A camera key is no node's intent: it has no target, no sound and makes no event. The motion review judges it as it judges the camera: a `'steady'` key from rest is an `abrupt-start` and an `abrupt-stop` on `(camera)`; mark it with `intended` when it is meant.
- Scaling a group instead of the camera leaves the other layers and their parallax behind; use a camera key.

#### Zoom keys

A camera key takes the view over: while it runs the camera is where the key puts it, and its drift waits. A subject that stays put for fifteen seconds needs the opposite: the camera comes nearer on a word, slowly, and the background goes on sliding all the while. A zoom key does that. It changes the zoom of the camera and nothing else:

```ts
camera: { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 } },   // a loop about the subject

// timeline
zoomTo({ at: 6, to: 1.15, dur: 8 }),                               // a slow push; the loop runs on under it
zoomTo({ at: 15, to: 1, dur: 2 }),                                 // and back to the authored view
```

| Option of `zoomTo` | Default | Meaning |
|---|---|---|
| `at` | required | seconds: when the zoom starts |
| `to` | required | the zoom it reaches, as a factor of the authored view: `1.15` shows the focus plane 15 % larger, `1` is the authored view again. 0.01 to 10000 |
| `dur` | `3` | seconds it takes |
| `profile`, `ramp` | `'ease'`, `0.3` | how the speed is spread, as for a camera key |

- **The camera looks where it looks without the key,** at every frame. Its drift, its path and its wander run on at their own speed; the key changes how large the picture is, about the middle of the frame, and never where the camera looks. So the push goes toward the middle of the view: frame the subject with the camera itself (its `at`, or a loop about the subject).
- **On screen the drift grows with the zoom:** 0.45 units per frame are 0.52 px at a zoom of 1.15. A push by a tenth or a quarter keeps a drift in its norm. For a zoom by a factor of two or more, or into a place off the middle, use `cameraTo`.
- **The zoom is a ratio, and it multiplies:** the push-in of the shot, and the zoom of the camera keys if the shot has any. `to` is the factor of the zoom keys alone. **Keys chain:** each starts from the factor the zoom keys have reached at its moment, also when the key before it is still under way.
- **Depth still shows,** as with a camera key: a layer takes the zoom to the power of its parallax, so a far layer grows less than the focus plane and a near one more. A layer of the frame (`parallax: 0`) keeps its size.
- A zoom key is no node's intent: it has no target, no sound and makes no event. The motion review judges it as it judges the camera: a `'steady'` key that is fast enough to be seen is an `abrupt-start` and an `abrupt-stop` on `(camera)`. Its report has a line for the zoom keys, with the zoom at both ends of each and how fast the camera drifts meanwhile (see Motion review).

### A background that changes

`background`, `atmosphere` and `vignette` are set once for the shot. `backgroundTo` changes them at a moment, while everything in the shot goes on: an evening sky turns into a night sky, a warm light into a cold one, and the subject stays where it is.

```ts
shot({
  background: { inner: 'deep.dusk', outer: 'deep.plum', center: [0.5, 0.7] }, atmosphere: 'mid.rose', vignette: 0.6,
  // ...
  timeline: [
    backgroundTo({ at: 3, dur: 3, inner: 'deep.night', outer: 'deep.abyss', atmosphere: 'mid.ocean', center: [0.5, 0.3] }),   // on a word, over three seconds
    backgroundTo({ at: 9, dur: 0.4, vignette: 0.85 }),                                                                         // later, the corners close in
  ],
});
```

| Option of `backgroundTo` | Default | Meaning |
|---|---|---|
| `at` | required | seconds: when the change starts |
| `dur` | `2` | seconds it takes, 0.1 at least |
| `inner`, `outer` | as they are | palette references: the colours of the gradient at its centre and at its edge when the key ends |
| `center`, `radius` | as they are | the centre of the gradient in fractions of the frame, and its radius in frame widths, when the key ends |
| `atmosphere` | as it is | palette reference: the colour far layers fade toward when the key ends |
| `vignette` | as it is | 0..1: how far the corners darken when the key ends |
| `profile`, `ramp` | `'ease'`, `0.3` | how the change is spread, as for a move: `'ease'` from rest to rest, `'steady'`, `'in'`, `'out'` |

- Give at least one of the six; what a key leaves out stays as it is. **Keys chain:** each takes over from what the background is at its moment, also when the key before it is still under way.
- **Colours run round the colour wheel:** hue along the short way, saturation and value straight, as the tint of a layer does. A warm sky that turns cold never passes through gray; it passes through the hues between.
- **The vignette follows `outer`:** on every frame the corners darken toward the outer colour of that frame.
- **The tint of every layer follows `atmosphere`:** far layers are tinted toward the atmosphere of each frame, so the whole depth of the picture turns with the sky. Nodes of the stage (tint 0) keep their colours.
- A shot without a `backgroundTo` is drawn as it always was. Before the first key the background is exactly what the shot says.
- A background key is no node's intent: it has no target, no sound and makes no event. Like every key it may start before the shot (a negative `at`): the change is then under way at frame 0.
- The motion review counts a background that changes as life in every part of the frame, while it changes fast enough to be seen; `skink3 motion` prints when that is ("background: changes at 3.20-5.80 s"). A change of a few dark colours over many seconds is too slow to count.
- For another set and another subject, cut to another shot. There are no transitions between shots yet.

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

A shot with depth has at least three layers: a far one with large shapes, the stage at depth 0 where the action is, and a near one with a few big blurred shapes at the edges. Keep far shapes away from the spot behind the subject: the depth tint separates them by tone, but a diagram reads best against the plain background. A far layer moves less than the stage, so "behind the subject" is a band there, as wide as the camera's travel times `1 - parallax`.

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
| `sound` | none | key of the shape's voice in a bank of sounds: what its intents and its contacts sound like (see Sound) |

| Factory | Extra options | Notes |
|---|---|---|
| `circle` | `r` | |
| `capsule` | `length`, `r`, `origin?`, `sway?` | a stick with round ends along its local x axis; `length` is tip to tip. `origin: 'start'` puts the first end at the node's position (a pivot); `sway` then lets the stick lean and swing around it on a spring |
| `polygon` | `sides`, `r`, `radius?` or `points`, `radius?` | a rounded **convex** polygon: regular (3–12 sides on a circle of radius `r`, corner radius default `0.16 × r`; the first corner points up) or from explicit corners (corner radius default 0: sharp) |
| `rect` | `w`, `h`, `radius?` | rounded rectangle centred on its position; `radius` (default 22 % of the short side) must stay below half the short side (use a capsule for a pill) |
| `blob` | `r`, `points?` (9), `wobble?` (0.14), `seed?` (1) | a soft irregular outline; the same seed gives the same blob |
| `region` | `points`, `smooth?` (1) | a free-form closed outline through its points, concave allowed (see below); not a rigid body |

A concave form is a `region`, or several shapes composed in a `group`.

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

#### `region({ id, fill, points, smooth?, ... })`

A free-form closed outline through `points`, as one shape: a map, an island, a pool, the ground other things stand on. Unlike a `polygon` it may be concave, with bays and capes. It takes the options of every shape and is lit, glows, fades, clips and fills as they do.

```ts
// An island with a bay on its lower side: a few points, in order round the outline.
region({ id: 'island', fill: 'deep.ink', backdrop: true,
  points: [[-820, 130], [-560, -70], [-200, -20], [60, -150], [330, -60], [420, 150], [230, 250], [40, 170], [-180, 330], [-470, 280], [-700, 360]] }),
```

| Option | Default | Meaning |
|---|---|---|
| `points` | required | 3 to 200 points `[x, y]` in order round the outline, in the shape's own space. Either way round |
| `smooth` | `1` | `1` joins the points with a smooth curve through them, `0` with straight edges; between, the corners are partly rounded. The same curve as a `stroke` and the path of a `travel` |

- **The outline may not cross itself.** The engine says near which points it does; move them apart, or lower `smooth` (a tight bend between distant points makes the curve swing wide).
- **A few points are enough.** With `smooth: 1` six to twelve points give a recognisable coast; the curve passes through every one of them.
- A closed `stroke` with the same points and the same `smooth` lies exactly on its edge: a coastline, a dashed border.
- **One shape, one light:** the shadow, the rim and the highlight follow the whole form, into its bays. Its middle, for the light and the glow, is the middle of the largest circle that fits inside it.
- A label points at its edge, things can be clipped to it (`clipTo`), it can be a `cover`, a `backdrop` or have a `level`.
- Its outline can change over time: `reshape` runs every point to a new place (see An outline that changes).
- **Not a rigid body.** A body is convex: build the ground of the simulation from `rect`s and `polygon`s, and draw the region over or under them.

### `group({ id, at?, rotation?, scale?, opacity?, upright?, children?, follow?, idle?, clipTo?, sound? })`

An invisible parent. Its children move, turn and scale with it. Like every node it takes `sound`, the key of its voice (see Sound). A group with no children is useful as an anchor: something for a label to point at or for eyes to look at, which the timeline can move.

`upright: true` makes the group keep its own rotation in the layer's space instead of turning with its parent. It still follows the parent's position and size. Use it for a face on something that rolls or tumbles, such as a rigid body: the eyes stay level while the body turns under them.

```ts
circle({ id: 'ball', r: 30, fill: 'accent.amber', body: { kind: 'dynamic', release: 1 },
  children: [group({ id: 'ball-face', upright: true, children: [eye({ id: 'ball-eye', r: 8, white: 'light.snow', pupil: 'deep.abyss' })] })] })
```

### `link({ id, from, to, color, pulseColor?, bend?, width?, gap?, opacity?, glow?, clipTo?, sound? })`

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
| `sound` | none | key of the link's voice: what its `drawOn` and its pulses sound like (see Sound) |

List links before the nodes they join, so the nodes are drawn over the ends. A link is hidden while either of its nodes is hidden, and it fades with the fainter of the two. Animate it with `drawOn` and `pulse`. A pulse is drawn as travelling light: a bright head with a tail that narrows and fades.

#### A link that sags and pulls taut

The `bend` of a link is set once; `bendTo` changes it over time, so a line can hang slack, pull taut and swing.

```ts
link({ id: 'line', from: 'post0', to: 'post1', color: 'mid.mist', bend: -0.3 }),   // it hangs
// timeline
bendTo('line', { at: 3.4, to: 0, dur: 0.9 }),      // it pulls taut: past the straight line, back, and straight
bendTo('line', { at: 6.2, to: 0.22, dur: 1.2 }),   // and sags again, to the other side
```

- `to` is the new bend: the sideways bulge as a fraction of the link's length, as for `bend`; `0` is a straight, taut line and the sign picks the side. `dur` (0.8) is the time it takes.
- **It swings past the new bend** by `overshoot` (0.25 of the change) and settles; `overshoot: 0` only arrives.
- **Keys chain:** each starts from the bend reached at its moment.
- The ends of the link stay on its two nodes; only its middle moves. A `bendTo` makes no event; the motion review counts a line whose bend changes as life in the frame.
- It is a look: there is no rope and no weight. For a line that hangs between more than two points, use a `stroke`; a `pulse` runs along a stroke too.

### `stroke({ id, points, color, width?, closed?, smooth?, dash?, solid?, drawn?, at?, rotation?, scale?, opacity?, glow?, pulseColor?, clipTo?, sound? })`

A line with round ends along a free-form path: a route, a chart line, an outline, a ring. It is placed like a shape (`at`, `rotation`, `scale`, a parent) and its `points` are in its own space. It can be drawn on over time, and it can be dashed.

| Option | Default | Meaning |
|---|---|---|
| `points` | required | at least two points `[x, y]` the line runs through, the first being where it starts |
| `color` | required | palette reference |
| `width` | `7` | thickness in units |
| `closed` | `false` | back to the first point after the last (at least three points) |
| `smooth` | `1` | `1` joins the points with a smooth curve, `0` with straight lines; between them the corners are partly rounded. The same as the path of a `travel` |
| `dash` | none | `[dash, gap]` in units: the straight part of a dash and the clear gap between two. The dashes have round ends, so a dash of `0` is a dot as wide as the line |
| `solid` | `0` | a dashed stroke: how far its gaps are closed at the start, `0` as authored, `1` a solid line. `solidTo` animates it |
| `drawn` | all, or none | the share of the line that is drawn before its first `drawOn`, from its first point. Left out: all of it, and none of it when the stroke has a `drawOn` |
| `at`, `rotation`, `scale`, `opacity` | `[0, 0]`, `0`, `1`, `1` | as for a shape |
| `glow` | `0` | `0` to `1`: the line glows, with a halo around it |
| `pulseColor` | `color` | colour of the lights that `pulse` sends along the stroke |
| `clipTo` | none | id of a shape of the same layer: the stroke is drawn only inside it |
| `sound` | none | key of the stroke's voice: what its `drawOn` sounds like (see Sound) |

```ts
stroke({ id: 'route', points: [[-760, 250], [-520, 60], [-260, 150], [-40, -40], [200, 40]], color: 'accent.amber', width: 9, glow: 0.5 }),
stroke({ id: 'ahead', points: [[200, 40], [380, 120], [560, -20]], color: 'accent.amber', width: 9, dash: [0, 22] }),   // dots
stroke({ id: 'share', at: [-560, -40], points: arcPoints([0, 0], 70, -90, 270), color: 'accent.aqua', width: 16 }),      // a ring, from its top
// timeline
drawOn('route', { at: 1, dur: 3, profile: 'ease' }),   // behind a node that travels the same path with the same at, dur and profile
drawOn('ahead', { at: 4.2, dur: 1.4 }),
solidTo('ahead', { at: 7, dur: 1.2 }),                 // the dots grow into a line
drawOn('share', { at: 2, dur: 1.6, to: 0.62 }),        // 62 % of the way round
```

- **Drawing on.** `drawOn(id, { at, dur?, to?, profile?, ramp? })` draws the stroke from its first point. `to` is the share of its length that is drawn when the key ends (`1` when left out). Keys chain: each starts from the share reached at its moment, so `to: 0.4` and later a key without `to` draw two fifths and then the rest; a smaller `to` takes the line back. The stroke is hidden before its first `drawOn`, unless it says `drawn`.
- **The speed of the drawing** follows a `profile` as a travel does: `'ease'` (the default) from rest to rest, `'steady'` at one speed, `'in'`, `'out'`, with `ramp`. A stroke and a node that travels its points with the same `at`, `dur` and profile stay together: the line appears behind the node.
- **Dashes** are anchored at the first point: they stay where they are while the line is drawn on. `solidTo(id, { at, to?, dur? })` closes the gaps (`to: 1`, the default) or opens them again (`to: 0`): every dash grows where it is until the dashes join.
- **A route with an uncertain end** is two strokes: a solid one, and a dashed one from where it ends.
- **`arcPoints(center, r, from, to, { step? })`** returns the points of an arc of a circle: from the angle `from` to the angle `to` in degrees (0 is right of the centre, 90 below it; a larger `to` runs clockwise), a point every `step` degrees (15). A smooth stroke through them is the arc; with `closed: true` and the last point left out it is a ring. A share of a ring is an arc drawn on with `to`.
- A stroke moves, turns, grows, pops and fades like a shape (`moveTo`, `turnTo`, `scaleTo`, `popIn`, `fadeTo` and the rest), and may be the child of a shape or a group. It has no children, no light and no physics. Its width scales with it.
- The motion review knows a stroke as a node: a move of it is judged like any move, and a line that is being drawn, or whose dashes close, keeps its part of the frame alive.

#### A light that runs along a stroke

A `pulse` on a link runs from one node to another, along one bend. On a stroke the same light runs along the line, whatever its form: a wire that sags over several poles, a closed loop, a route with corners, a long straight line.

```ts
stroke({ id: 'wire', points: [[-820, -330], [-560, -250], [-300, -330], [-40, -250], [220, -330]], color: 'dark.indigo', pulseColor: 'accent.amber' }),
stroke({ id: 'ring', at: [460, 0], points: arcPoints([0, 0], 150, 0, 345), closed: true, color: 'dark.indigo' }),
// timeline
pulse('wire', { at: 2, dur: 1.8 }),                                              // from its first point to its last
pulse('wire', { at: 5, dur: 1.2, from: 1, to: 0.5, profile: 'ease' }),           // back from its last point to its middle, from rest to rest
pulse('ring', { at: 1, dur: 6, to: 3, profile: 'steady', node: 'lamp' }),        // three times round at one speed; the lamp gets a bump when it arrives
```

| Option of `pulse` on a stroke | Default | Meaning |
|---|---|---|
| `at`, `dur` | required, `0.7` | when the light leaves, and the seconds it takes; it arrives exactly at `at + dur` |
| `from`, `to` | `0`, `1` | the shares of the length of the stroke between which it runs: `0` is its first point, `1` its last. With `from` above `to` it runs toward the first point. Round a closed stroke a share above 1 runs on: `to: 3` is three times round |
| `profile`, `ramp` | none, `0.3` | how its speed is spread, as for a move: `'steady'`, `'ease'`, `'in'`, `'out'`. Left out, it goes as the pulse of a link does: it leaves and arrives at speed, a little faster in between |
| `length` | a quarter of its way, at most 120 | the length of the light, in units of the stroke |
| `node`, `bump` | none, `0.14` | the node that gets a bump when the light arrives: a shape, a group, an eye, a stroke, a text or a label, in any layer. Without `node` nothing is bumped |

- **It is the light of a link's pulse:** a bright head with a tail that narrows and fades, drawn over the line, in `pulseColor` (the stroke's own colour when it has none), and it glows whatever the `glow` of the stroke is. When the head has arrived the tail catches up.
- **It shows on the part of the line that is drawn:** on a stroke that is half drawn on, the light ends where the line ends. A stroke that is not drawn at all, or is faded out, shows no light.
- **Several lights** may run along one stroke at once, and a stroke may be dashed, placed, turned and scaled as ever: the light follows the line, and its width and its length scale with it.
- The arrival is a `pulse` event (see Sound), at the place where the light arrives.
- The motion review holds a light against its own length, as it does on a link: one that covers half of its length per frame or more is `too-fast`. Give it a longer `dur`, or a longer `length`. While a light runs, the stroke counts as life in the frame.
- The options of this table are for a stroke: on a link a pulse runs from its first node to its second, which gets the bump.

### `label({ id, text, target, fill, ink, side?, gap?, size?, minSize?, maxWidth?, maxLines?, opacity?, follow?, sound? })`

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
| `sound` | none | key of the label's voice (see Sound) |

The layout wraps the string, balances the lines, and shrinks the font if needed. A string that still does not fit is reported by the text-fit check as overflow; it is never cut. Labels are listed directly in a layer, usually last so they are on top.

- **Lines break at ordinary spaces only.** A no-break space (U+00A0) in a string of the table keeps the words on both sides of it on one line: write a value and its unit, or a number and what it counts, with one between them. So do a narrow no-break space (U+202F) and a figure space (U+2007).
- The layout first tries the preferred size and wraps to `maxWidth`; only if that takes more than `maxLines` does it shrink the font, one unit at a time. So a wider `maxWidth` can give a larger font on more lines for a long string. To keep a box compact, lower `maxLines`.
- The tail of a label points at the edge of its target on the chosen `side`, `gap` units away; a label has no other offset. To put a label somewhere else, point it at an empty `group` placed there.
- A label and its target must be in the same layer.
- A label over ground or a wall gives a covers-node warning unless that shape is marked `backdrop: true`.

### `text({ id, text, ink, at?, rotation?, scale?, opacity?, size?, minSize?, maxWidth?, maxLines?, weight?, align?, box?, count?, clipTo?, sound? })`

Free-standing text: a title, a caption, a source line in a corner, a quotation, words on a card. It is a block of lines without a pointer. A `label` points at a thing; a `text` belongs to the frame, or to the shape it lies on.

| Option | Default | Meaning |
|---|---|---|
| `text` | required | a key of the shot's string tables, never the words themselves |
| `ink` | required | palette reference: the colour of the letters |
| `at`, `rotation`, `scale`, `opacity` | `[0, 0]`, `0`, `1`, `1` | as for a shape |
| `size`, `minSize` | `38`, 62 % of `size` | preferred and smallest font size, in units |
| `maxWidth`, `maxLines` | `600`, `3` | the widest a line may get before the text wraps, and the most lines |
| `weight` | `800` | weight of the letters, 200 (light) to 1000 (black) |
| `align` | `'center'` | where `at` is in the block, sideways, and how the lines are set: `'center'`: its middle; `'left'`: the lines start at `at`; `'right'`: they end there. Up and down the block is centred on `at` |
| `box` | none | palette reference: a rounded box of that colour behind the lines, with the padding and the corners of a label |
| `count` | none | makes the text a counter: a number, or `{ from, decimals }` (see A counter) |
| `clipTo` | none | id of a shape of the same layer: the text is drawn only inside it |
| `sound` | none | key of the text's voice (see Sound) |

```ts
// A title and a note that belong to the frame: a layer the camera neither moves nor zooms.
layer({ id: 'frame', depth: 0, parallax: 0, nodes: [
  text({ id: 'title', text: 'title.main', ink: 'light.cream', at: [0, -455], size: 60, maxWidth: 1100, maxLines: 2 }),
  text({ id: 'note', text: 'note.data', ink: 'mid.mist', at: [-900, 490], align: 'left', size: 26, weight: 600 }),
] }),
// A word on a card: the child of the shape. It moves, turns, grows and fades with it.
rect({ id: 'card', at: [560, 300], w: 240, h: 150, fill: 'dark.indigo', children: [text({ id: 'tag', text: 'card.tag', ink: 'light.cream', maxWidth: 200 })] }),
```

- **The layout is a label's:** the string wraps at spaces, the lines are balanced, and the font shrinks down to `minSize` when the string is too long; nothing is ever cut. A translation may take more lines.
- **It is placed like a shape:** it takes `moveTo`, `turnTo`, `scaleTo`, `popIn`, `popOut`, `fadeTo`, `bump` and `squash`, and may be the child of a shape or a group. It has no children and no light.
- **Text of the frame** goes into a layer with `parallax: 0`, listed after the others: the camera does not move it, and a camera key does not zoom it.
- **The text-fit checks hold it** in every language: a string that does not fit its lines, a text that leaves the frame while it is shown, and a text that lies over another text or over a label are errors. A text that lies on a shape is what it is for and is not reported.
- A text on something that turns is turned with it; the check takes the upright box round it.
- Its `popIn` is a `label` event (see Sound).

#### A counter

A text with `count` is a counter: a number that runs between values over time. Its string says where the number goes with `{n}`; the words round it are the language's.

```ts
strings: { en: { 'count.way': '{n} km' }, de: { 'count.way': '{n} km' }, fr: { 'count.way': '{n} km' } },
text({ id: 'way', text: 'count.way', ink: 'accent.amber', at: [900, -455], align: 'right', size: 40, count: 0 }),
// timeline
countTo('way', { at: 1, to: 1280, dur: 3 }),                           // it runs to 1280 in three seconds, from rest to rest
countTo('way', { at: 7, to: 1281, dur: 0.1 }),                         // a tick
countTo('grains', { at: 2, to: 2e9, dur: 4, profile: 'steady', ratio: true }),   // digit after digit at an even pace
```

| Option | Default | Meaning |
|---|---|---|
| `count` of `text` | none | a number: where the counter starts. Or `{ from, decimals }`: `decimals` (0, up to 6) are the places it shows after the decimal sign |
| `countTo(id, { at, to, ... })` | | runs the number to `to` |
| `dur` | `1` | seconds the run takes; a short one is a tick |
| `profile`, `ramp` | `'ease'`, `0.3` | how the pace is spread: `'ease'` from rest to rest, `'steady'`, `'in'`, `'out'` |
| `ratio` | `false` | `true`: the number grows as a ratio, so it gains its digits at an even pace. Both ends above 0 |

- **Keys chain:** each `countTo` starts from the number reached at its moment.
- **The number is written the way the language writes numbers:** the grouping of its digits and its decimal sign follow the language of the render (`1,280` in English, `1.280` in German, a no-break space in French), with Latin digits. A language tag that is no language, such as a pseudo-locale, is written as English.
- **The string must hold `{n}` once, in every language.** A unit, a sign or a word before or after it belongs to the string: `'{n} km'`, `'Total: {n}'`.
- **Its digits stand in cells of one width,** so a running number does not tremble. The text is set anew only when the number gains or loses a digit.
- **The layout is made for the widest value** the counter starts from or is sent to: the font size, the lines and the box do not change while it runs, and the text-fit checks hold the counter at that value from the first frame on.
- Everything else is a `text`: place, alignment, a box, the intents of a placed node.
- A `countTo` makes no event. The motion review counts a running number as life in the frame.
- Digits do not roll like an odometer: a digit is replaced by the next.

### `eye({ id, r, white, pupil, at?, scale?, opacity?, lookAt?, blink?, open?, sound? })`

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
| `speed` | `[20, 60]` | units per second, `[min, max]` or one number |
| `gravity` | `[0, 0]` | constant acceleration, units per second squared (also works as wind) |
| `drag` | `0.8` | share of velocity lost per second, as a rate |
| `turbulence` | none | `{ strength, scale, speed }`: a slowly changing swirl field |
| `glow` | `0` | 0..1: the particles also feed the halo |
| `core` | none | `{ color, size }`: an inner disc on every particle, in one palette colour; `size` is its radius as a fraction of the particle's (0.05..0.95). A particle with a core reads as a ring around a face: a cell, a bead, a wheel |
| `sizing` | `'spark'` | how the radius runs over a particle's life. `'spark'`: it reaches its size after 12 % of its life, holds it until half-way, and shrinks smoothly to nothing over the second half. `'steady'`: full size from 8 % to 92 % of its life, with a short swell and a short shrink: for motes that drift and for particles that carry something across the frame |
| `clipTo` | none | id of a shape of the same layer: the particles are drawn only inside its outline (see Clipping) |
| `sound` | none | key of the emitter's voice: what its bursts sound like (see Sound) |

An emitter needs at least one of `rate`, `bursts`, `onContact`. `from`, `until` and the `at` of a burst are 0 or later; an emitter that should already be running at frame 0 takes a `prewarm`.

## Timeline: intents

A key says what should happen to a node and when. The engine supplies the curve.

| Intent | Targets | Options (defaults) | What the engine does |
|---|---|---|---|
| `moveTo(id, { at, to, ... })` | placed: shape, group, eye, stroke, text | `dur` (1.1), `anticipation` (0.08), `overshoot` (0.07), `arc` (0.12), `profile` (`'settle'`), `ramp` (0.3), `arrive` instead of `at` | backs away a little, travels along an arc, shoots past the destination, settles. Starts from wherever the node is. `anticipation` and `overshoot` are fractions of the distance (capped at 44 and 38 units); `arc` is the bulge as a fraction of the distance (capped at 150 units), positive toward the top of the frame (to the left for a move straight up or down). Other profiles: see Moves |
| `hop(id, { at, to, ... })` | placed | `dur` (0.6), `height` (80), `land` instead of `at` | a jump: leaves at `at`, flies a parabola `height` units high, lands at `at + dur`. See Moves |
| `travel(id, { at, path, ... })` | placed | `speed`, `dur` or `speeds`, `profile` (`'steady'`), `ramp` (0.3), `smooth` (1), `closed`, `loops` (1), `roll`, `orient`, `only` | travels along a free-form path at a known speed. See Moves |
| `levelTo(id, { at, to, ... })` | a shape with a `level` | `dur` (1.5), `profile` (`'ease'`), `ramp` (0.3) | raises or lowers the level to `to` (0 = empty, 1 = full); it is there exactly at `at + dur`. See Levels |
| `squash(id, { at, ... })` | placed | `amount` (-0.22), `dur` (0.6), `pivot` (`[0, 0]`) | a quick squash (negative) or stretch (positive) that rings out; the area stays. See Moves |
| `popIn(id, { at, ... })` | placed, label | `dur` (0.55), `overshoot` (0.18) | grows from nothing past its size and settles. **The node is hidden before `at`** |
| `popOut(id, { at, ... })` | same | `dur` (0.35) | a small swell, then shrinks to nothing |
| `turnTo(id, { at, speed, ... })` | shape, group, stroke, text | `dur` (0.8), `profile` (`'steady'`), `ramp` (0.3) | turns at a speed, with a profile (see A turn at a speed) |
| `turnTo(id, { at, speeds, ... })` | shape, group, stroke, text | `dur` (up to its last key) | turns at a speed that is keyed over time (see A turn whose speed changes) |
| `turnTo(id, { at, to, ... })` | shape, group, stroke, text | `dur` (0.8), `overshoot` (0.1) | turns to the absolute rotation `to` (degrees), overshoots, settles |
| `scaleTo(id, { at, to: [sx, sy], ... })` | placed | `pivot` (`[0, 0]`), `dur` (0.6), `overshoot` (0.15) | changes the width and the height along the node's own axes, for good, about `pivot` (see Size along one axis) |
| `scaleTo(id, { at, to, ... })` | placed, label | `dur` (0.6), `overshoot` (0.15) | a lasting change of size: grows or shrinks to `to` times the authored size, shoots past it and settles. For things that grow in steps |
| `fadeTo(id, { at, to, ... })` | placed, label, link | `dur` (0.5) | fades to the opacity `to` (0..1), smoothly. For things that switch on or off softly, and for translucent shapes |
| `bump(id, { at, ... })` | placed, label | `amount` (0.14) | a quick swell that rings out in about 0.7 s: a reaction, a beat |
| `drawOn(id, { at, ... })` | link, stroke | `dur` (0.6); a stroke also `to` (1), `profile` (`'ease'`), `ramp` (0.3) | draws the link on from its `from` end, or the stroke from its first point. **It is hidden before `at`**. Once per link; the keys of a stroke chain (see `stroke`) |
| `countTo(textId, { at, to, ... })` | a text with `count` | `dur` (1), `profile` (`'ease'`), `ramp` (0.3), `ratio` (false) | runs the number of a counter to `to`; keys chain (see A counter) |
| `cameraTo({ at, ... })` | the camera | `dur` (1.2), `zoom`, `to`, `profile` (`'ease'`), `ramp` (0.3) | moves the camera at a moment: to a zoom, to a place, or both; keys chain (see Camera keys) |
| `zoomTo({ at, to, ... })` | the camera | `dur` (3), `profile` (`'ease'`), `ramp` (0.3) | changes the zoom of the camera at a moment and nothing else: its drift and its path run on under the key; keys chain (see Zoom keys) |
| `backgroundTo({ at, ... })` | the background | `dur` (2), `inner`, `outer`, `center`, `radius`, `atmosphere`, `vignette`, `profile` (`'ease'`), `ramp` (0.3) | changes the gradient of the shot, the colour far layers fade toward and the vignette at a moment; keys chain (see A background that changes) |
| `solidTo(strokeId, { at, ... })` | dashed stroke | `to` (1), `dur` (0.6) | closes the gaps of the dashes (`to: 1`) or opens them again (`to: 0`) |
| `reshape(id, { at, points, ... })` | region, stroke | `dur` (1.2), `smooth`, `profile` (`'ease'`), `ramp` (0.3) | runs every point of the outline to a new place: one form turns into another (see An outline that changes) |
| `bendTo(linkId, { at, to, ... })` | link | `dur` (0.8), `overshoot` (0.25) | changes the bend of the link: it sags, pulls taut, swings (see A link that sags and pulls taut) |
| `pulse(linkId, { at, ... })` | link | `dur` (0.7), `bump` (0.14) | sends a glowing pulse from `from` to `to`; when it arrives, the node at the far end gets a bump (`bump: 0` turns that off) |
| `pulse(strokeId, { at, ... })` | stroke | `dur` (0.7), `from` (0), `to` (1), `profile`, `ramp` (0.3), `length`, `node`, `bump` (0.14) | sends the same light along the stroke, between two shares of its length; the node it names gets the bump (see A light that runs along a stroke) |
| `openTo(eyeId, { at, to, ... })` | eye | `dur` (0.3), `overshoot` (0.12) | opens or closes the lids to `to` (1 = open, 0 = shut and not drawn). The change lasts. With an overshoot the eye opens a little too wide first |
| `blink(eyeId, { at })` | eye | | one blink at that moment, on top of the eye's own schedule |
| `sfx(key, { at, ... })` | none, or a node | `node`, `gain` (1) | places a sound of the bank at a moment; it animates nothing. See Sound |

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
- Every intent also takes `sound`: `false` makes it silent, a key names its sound. It changes nothing in the picture (see Sound).

### Moves

**The default move settles.** `moveTo` with the profile `'settle'` backs away, goes, shoots past its destination and settles. Its moments, as shares of `dur`:

| Moment | With the defaults | In general |
|---|---|---|
| it stops backing away and goes | 0.24 | 0.24 with an `anticipation`, 0 without |
| it first reaches the destination | 0.52 | 0.46 to 0.54 with an `anticipation` and an `overshoot` of 0.02 or more; 0.30 to 0.39 with such an `overshoot` alone; later with a smaller overshoot (up to 0.62 and 0.45); exactly 1 without an `overshoot` (the move is then an ease-out) |
| it is farthest past the destination | 0.62 | 0.62 with an `anticipation`, 0.5 without; never without an `overshoot` |
| the rest | it settles | |

Most of the travel happens in about a quarter of the duration, so the peak speed is 5.6 times the mean with the defaults (about 4 without an anticipation, more with a large one): a long move needs a long `dur` to stay under the strobing limit of the motion review, or the profile `'ease'`. Two things spare you the arithmetic:

```ts
import { moveTimes, moveTo } from 'skink3-engine';

const { leaves, arrives, peaks } = moveTimes({ dur: 1.2 }); // seconds after `at`, for the options you give (here the defaults)
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

### A travel whose speed changes

A `travel` keeps one speed on its steady stretch. With `speeds` its speed is keyed over time: a flow that runs faster where its way narrows, things on a belt that go faster and faster.

```ts
travel('bead', { at: 1, path: [[-500, 0], [500, 0]], speeds: [[0, 100], [2, 300]] }),            // 100 units a second, 300 from the third second on
travel('drop', { at: 4, path: BELT, speeds: [[0, 60], [2, 180], [4, 420]], only: true }),         // faster and faster, and gone at the end
```

- `speeds` is a list of keys `[seconds, speed]`: seconds after the start of the travel, and units per second. The first key is at 0: the speed the travel starts with. At least two keys, in order of time.
- **Between two keys the speed changes smoothly** from one to the other, without a kink; after the last key it stays. Half-way between two keys it is half-way between their speeds.
- **The travel ends when the path is covered** (`loops` times round a closed one): its length in time follows from the speeds. `speeds` stands in for `speed`, `dur`, `profile` and `ramp`.
- A speed is at least 0.001: to start almost from rest, start with a small one.
- `roll`, `orient` and `only` work as they do at one speed: a wheel turns as far as it has gone.
- A `drawOn` cannot follow such a travel exactly: it has profiles, not keys of speed.
- The motion review judges it as any travel: a start at nearly its top speed from rest in view is an `abrupt-start`.

### A turn at a speed

`turnTo` by itself goes to an angle, shoots past and settles. With a `profile` the turn has no overshoot and its speed is spread as a move's is, so a wheel can turn at one speed for a long time, start from rest, or come to rest.

```ts
turnTo('dial', { at: 2, to: 180, dur: 1.5, profile: 'ease' }),          // from rest to rest, no overshoot
turnTo('wheel', { at: -1, dur: 15, speed: 50 }),                        // 50 degrees a second, under way when the shot starts
turnTo('wheel', { at: 14, dur: 4, speed: 50, profile: 'out' }),         // on at that speed, and down to rest
```

| Option of `turnTo` | Default | Meaning |
|---|---|---|
| `profile` | none | `'steady'`: one speed from the first frame to the last. `'ease'`: from rest to rest. `'in'`: from rest, and on at speed. `'out'`: in at speed, and down to rest. A turn with a profile has no `overshoot` |
| `ramp` | `0.3` | the share of `dur` an eased end takes, for `'ease'`, `'in'` and `'out'` |
| `speed` | none | instead of `to`: degrees per second on the steady stretch, from wherever the node is; negative turns the other way. The profile is `'steady'` unless another is named |

- Give either `to` or `speed` (or `speeds`, see below). With `to` the angle is absolute, and a turn of many revolutions is a large angle: `to: 3600` is ten turns. `dur` may be as long as the shot.
- **Keys with one `speed` join without a step:** a `'steady'` key, then an `'out'` key with the same speed, is a wheel that spins and slows down. An eased end covers half of what the steady stretch would in its time; the engine works the angle out. Keys of two speeds meet with a step: for a wheel that changes its speed and turns on, key the speed over time (below).
- A key may start before the shot (a negative `at`): the wheel is under way at frame 0.
- The motion review judges a turn like a move: one speed between two rests in view is `mechanical`, also with eased ends when the steady stretch is most of it. A wheel that is already turning when the shot starts, or still turns when it ends, is a flow and is not reported.

### A turn whose speed changes

A `turnTo` with a `speed` keeps one speed on its steady stretch, and two keys of two speeds meet with a step. With `speeds` the speed of the turn is keyed over time, as the speed of a `travel` is: a wheel that slows in two steps and turns on, rollers that turn faster and faster.

```ts
turnTo('wheel', { at: -1, speed: 90, dur: 3 }),                                   // under way when the shot starts
turnTo('wheel', { at: 2, speeds: [[0, 90], [1.5, 40], [4, 12]], dur: 9 }),         // slower, slower again, and on at 12 degrees a second
turnTo('dial', { at: 3, speeds: [[0, 0], [1, 240], [2.5, 0]] }),                   // from rest, up to speed, and back to rest
```

- `speeds` is a list of keys `[seconds, speed]`: seconds after the start of the turn, and degrees per second. The first key is at 0: the speed the turn starts with. At least two keys, in order of time.
- **Between two keys the speed changes smoothly** from one to the other, without a kink; after the last key it stays. Half-way between two keys it is half-way between their speeds.
- **The angle follows from the speeds:** the node turns from wherever it is by what they add up to. `dur` is how long the key lasts; left out, it ends at its last key. It may not end before it.
- A speed may be 0, where the node rests, and negative, where it turns the other way: a key from a speed to 0 slows to rest, a key through 0 swings back.
- `speeds` stands in for `to`, `speed`, `profile`, `ramp` and `overshoot`.
- **Keys join without a step** where the speed is the same on both sides: a `'steady'` key at 90 degrees a second, then `speeds` that start at 90, then a `'steady'` key at the last of them.
- **In step with a travel.** A roller of radius `r` under a belt turns `speed / r` radians a second: give it the keys of the travel with each speed times `180 / (π × r)`, and it turns exactly as far as a thing on the belt rolls.
- The motion review judges it as any turn: a start at speed from rest in view is an `abrupt-start`.

### Size along one axis

`scaleTo` with a number changes the size evenly. With `to: [sx, sy]` it changes the node along its own axes, for good: `sx` times as wide and `sy` times as high as authored, about `pivot`.

```ts
rect({ id: 'bar', at: [0, 420], w: 46, h: 60, fill: 'mid.ocean' }),
// timeline
scaleTo('bar', { at: 2, to: [1, 2.8], pivot: [0, 30] }),            // 2.8 times as high, its lower edge in place: it grows, shoots past and settles
scaleTo('bar', { at: 4.4, to: [1, 2], pivot: [0, 30], dur: 0.5 }),  // down a step: keys chain from what is reached
scaleTo('card', { at: 6, to: [0.04, 1], dur: 0.3, overshoot: 0 }),  // a card turned edge-on
scaleTo('drop', { at: 7, to: [1.25, 0.8], pivot: [0, 40] }),        // it sags: lower and wider, and stays so
```

- `pivot` is the point that stays in place, in the node's own units from its origin: `[0, h / 2]` is the lower edge of a rect, `[-w / 2, 0]` its left end. Left out, it is the origin. `pivot` goes with `to: [sx, sy]` only.
- **The axes are the node's own:** a bar that is turned grows along its own length. Everything in the node (its children, its light, its glow) takes the change with it. Its corners stretch with it too: give a bar that grows far a small corner radius.
- **Keys chain** among themselves, each from the width and height reached at its moment, with the `overshoot` (0.15) and the `dur` (0.6) of `scaleTo`. A key may name another pivot: the picture does not jump, and from then on the new point stays in place.
- It plays on top of the even size, the pops and the bumps of the node, and of its moves and turns. Each factor is 0.01 to 100: a side never passes through nothing.
- A label points at the edge the shape has now, and a link ends there. What else reads the outline of the node keeps its authored proportions: a shape that others are clipped to, a cover, the frame checks.
- For shapes, groups, eyes, strokes and texts; not for a label, and not for a rigid body.
- The motion review judges the change as a change of size: with `overshoot: 0` it starts at full speed and is reported as an `abrupt-start`.

### An outline that changes

The `points` of a `region` and of a `stroke` are set once; `scaleTo` changes proportions, not form, and a cross-fade of two shapes dissolves one into the other. `reshape` turns one form into another in place: a square softens into the coast of an island, two banks of earth smooth into one long low embankment.

```ts
// A square as eight points, clockwise from its top-left corner, and a coast with as many, from the same place.
const SQUARE: Vec2[] = [[-100, -100], [0, -100], [100, -100], [100, 0], [100, 100], [0, 100], [-100, 100], [-100, 0]];
const COAST: Vec2[] = [[-160, -60], [0, -140], [150, -90], [220, 10], [120, 110], [-20, 70], [-140, 120], [-230, 20]];
region({ id: 'isle', fill: 'dark.indigo', points: SQUARE, smooth: 0 }),
stroke({ id: 'shore', points: SQUARE, closed: true, smooth: 0, color: 'accent.aqua', dash: [0, 16] }),
// timeline
reshape('isle', { at: 2, dur: 2.4, points: COAST, smooth: 1 }),     // every corner runs to its place on the coast, and the edges round off
reshape('shore', { at: 2, dur: 2.4, points: COAST, smooth: 1 }),    // the dotted line on its edge goes with it
```

| Option of `reshape` | Default | Meaning |
|---|---|---|
| `at` | required | seconds: when the change starts |
| `points` | required | the new outline: as many points as the node has. The point at each place in the list runs straight to the point at that place in the new list |
| `dur` | `1.2` | seconds it takes, 0.1 at least |
| `smooth` | as it is | how the points are joined when the key ends: `0` straight edges, `1` a smooth curve. It runs there with the points |
| `profile`, `ramp` | `'ease'`, `0.3` | how the change is spread, as for a move: `'ease'` from rest to rest, `'steady'`, `'in'`, `'out'` |

- **For a `region` and a `stroke`.** Other shapes have no list of points: build the form as a region (a square is four points with `smooth: 0`; give it more points along its sides so that it can become a coast).
- **Point for point.** Give the new outline the same way round as the first and from the same place. A region keeps its points clockwise whichever way they are given, so two outlines given the same way round match; one given the other way round is read backwards.
- **The change lasts, and keys chain:** each starts from the outline reached at its moment, also when the key before it is still under way. To come back, reshape to the first points.
- **A region stays a region all the way.** Its outline may not cross itself and may not turn inside out, at the end or on the way; the shot is refused with the share of the way at which it would. Move the points, or reshape in two steps.
- **One shape, one light, all the way:** the shadow, the rim, the highlight and the glow are those of the outline of each frame. Between two outlines the middle and the size the light works with run evenly from those of the first to those of the second.
- **What reads the outline follows it:** a label points at the edge it has now, a link ends there, what is clipped to it is drawn inside it, a cover hides what it covers now, and a `level` fills the form it has.
- A stroke that is half drawn on stays half drawn: its share is of the line it has. Its dashes and the lights that run along it follow the line.
- It plays on top of the moves, turns, sizes and fades of the node. Children of a region keep their places.
- A `reshape` makes no event. The motion review judges it as a move, on the channel `outline`: the travel of the point that goes farthest. `'steady'` between two rests in view is `mechanical`; while an outline changes, the node counts as life in the frame.

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
- Every contact is recorded with its time, place and peak impulse; `skink3 bake` prints how many. Emitters can react to them with `onContact`. The sound of a shot is built from them too (see Sound).
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

Other helpers a scene may call:

| Helper | What it gives |
|---|---|
| `mix(a, b, t)` | the blend of two `#RRGGBB` colours, `t` of the way from `a` to `b` |
| `hexToHsv(hex)`, `lightness(hex)` | the hue, saturation and value of a colour; its CIE L* |
| `resolveColor(palette, ref)`, `checkPalette(palette)` | the colour of a palette reference; the laws a palette breaks |
| `ease(name, t)` | an easing of `EASINGS` at `t` in 0..1 |
| `rampProgress(u, a, b)`, `profilePeak(profile, ramp)` | the progress of a plain profile with eased ends of the shares `a` and `b`; its peak speed as a multiple of the mean |
| `moveTimes(options)` | the moments of a move (see Moves) |
| `pathLength(path)`, `pathTable(path)`, `pathAt(table, distance)` | the length of a free-form path `{ points, closed, smooth }`, its table, and the point at a distance along it |
| `new Noise(seed, name)` | seeded smooth noise between -1 and 1: `n1(x)`, `n2(x, y)` |
| `frameToSeconds(frame)`, `secondsToFrame(seconds)` | a frame as a moment, and the frame that shows a moment |

## Checks

`skink3 check <scene>` runs, for every language of the string tables:

| Check | Fails when |
|---|---|
| palette | a rule that the palette declares for itself is broken (see Rules of a palette); a palette without rules has none to break |
| strings | a used key is missing or empty in a language |
| glyphs | a string that is used holds, in a language, a character that none of the bundled fonts has (see Fonts) |
| text fit: overflow | the string of a label or of a text does not fit its `maxWidth` and `maxLines` even at `minSize` |
| text fit: off-frame | a shown label or text comes closer than 12 units to the frame edge at any sampled frame |
| text fit: overlap | two shown labels or texts overlap at any sampled frame |
| text fit: covers-node (**warning**) | a shown label covers a shape or an eye of its own layer other than its target (and the target's own children and parents), at any sampled frame |
| sound (only with `--bank <bank.json>`) | a node, an intent or an `sfx()` names a sound key that the bank does not know (see Sound) |

A warning is printed with the label, the language, the node and the time ("label "a" [de]: covers node "n3" from 6.50 s to 8.20 s"), and does not fail the checks: sometimes a label over a shape is intended. Nodes fainter than 0.25 and labels fainter than 0.5 are not counted, and neither is a shape marked `backdrop: true` (ground, a wall: things that are there to have labels in front of them). Frames are sampled ten times a second, so a touch shorter than that can be missed.

`skink3 check` also runs the motion review and the physics review and shows each in short form: the number of findings by kind, the worst five, and a pointer to `skink3 motion` or `skink3 physics`. For a shot that turns it on, it runs the contrast review as well and prints every finding of it. They are warnings and never fail the checks.

`skink3 render` runs the palette, string, glyph and text checks for the language it renders, prints any warnings, and stops if a check fails (`--force` renders anyway). It does not run the reviews.

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

The report also describes the life of the background, findings or not: the median drift of the camera and its zoom, how far the camera travels and the box it stays in, how fast every layer slides across the screen, and for every emitter how many particles are in frame and how fast they travel on their own. A background is alive when the camera drifts in the norm (0.3–0.7 px per frame), the layers slide at different speeds, and the particles move. A shot with zoom keys (`zoomTo`) gets one more line: the zoom at both ends of every key, and the drift of the camera while it runs.

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

## Contrast review

Things must not blend into what is behind them. The contrast review says when a named node does, without drawing anything. It is off unless a shot turns it on, and its two thresholds are the production's: the engine has none.

```ts
shot({
  // ...
  contrast: { nodes: ['hero', 'ball', 'title'], lightness: 18, colour: 24 },
});
```

| Option of `contrast` | Default | Meaning |
|---|---|---|
| `nodes` | required | ids of the nodes that are held: shapes, strokes, texts and labels. For a group, name the shapes in it |
| `lightness` | required | the least difference in lightness that is enough by itself: CIE L*, 0 to 100 |
| `colour` | required | the least difference in colour that is enough by itself: hue and saturation together, as the distance in the a*b* plane of CIELAB |
| `edge` | `0.5` | the share of the node's outline that has to blend |
| `seconds` | `0.5` | how long it has to last |

- **A node blends** where it differs from what is seen beside it by less than `lightness` **and** by less than `colour`. Either difference alone tells two things apart: a light thing on a dark ground, or a red thing on a green ground of one lightness.
- **What is behind** is what a viewer sees next to the outline of the node: the topmost thing drawn there, in its layer or in another, each in the haze of its depth; or the background of the frame, with its gradient and its vignette, as a `backgroundTo` has made it by then. A stroke and the letters of a text are held against what lies under them; letters on a box of their own, and the letters of a label, against that box. A label is held twice: its box against what is round it, its letters against its box.
- **Only what is seen is judged:** not a node that is hidden or outside the frame, and not the part of its outline that something drawn later covers. A node that is not opaque shows its ground through itself, and is judged as it looks.
- `skink3 check` prints the review after the other two (`contrast: ok (3 node(s) held: lightness 18, colour 24)`) and each finding as a warning of the kind `low-contrast`, with the share of the outline, the two colours, their two differences and the frames. Findings never fail the checks.
- **To choose the thresholds,** `colourDistance(hexA, hexB)` returns `{ lightness, colour }` for two colours, and `resolveColor(palette, 'dark.ground')` the colour of a reference. Two neighbouring dark blues are about 3 and 16 apart; an amber accent on a dark ground about 60 and 130. Where the line runs between what must pass and what must not is the production's rule.
- A finding that is meant is marked like any other: `intended('ghost', 'low-contrast', 'it is a ghost')`.
- **It reads flat colours,** as the palette and the depth of a layer give them. The light on a shape (its shadow and its rim), blur, glow and the lift of the background are left out; clips, levels, squashes and a size changed along one axis are followed. Frames are sampled ten times a second, and an outline at 24 places.

## Sound

A shot can have a sound track of its own: sound effects that mark what happens in the picture. The engine makes it from two things: the **events** of the shot, which it reads from the scene and its bake, and a **bank** of sounds that a production brings. The engine holds no sound files.

**A film is never crowded with sound.** A sound marks an event that matters; it is not a click every second. Only what is seen sounds, small and slow moves are silent, and a crowd of events sounds as a few. So most events make no sound, and the rules of the bank say which do.

Sound changes no pixel. A sound key is not part of the scene hash, so it never re-bakes a shot, and a shot with sound renders the frames it rendered without.

```
skink3 events <scene>                    every event of the shot          -> out/<shot>/events.json
skink3 sfx <scene> --bank bank.json      the track and its report         -> out/<shot>/<shot>_sfx.wav, out/<shot>/sfx.json
skink3 sfx <scene> --bank bank.json --sheet    also the sound sheet       -> out/<shot>/sfx_sheet.png
skink3 check <scene> --bank bank.json    also fails on a sound key the bank does not know
```

### Sound in the scene

```ts
circle({ id: 'marble', r: 30, fill: 'accent.amber', sound: 'marble' }),   // a node: its voice
// timeline
popIn('marble', { at: 1 }),                                    // sounds as the bank decides
hop('marble', { at: 2, to: [200, 0], sound: 'boing' }),        // an intent that names the sound of its start
bump('marble', { at: 3, sound: false }),                       // an intent that is silent
sfx('chime', { at: 6.5 }),                                   // a sound placed by hand
sfx('marble', { at: 7, node: 'marble', gain: 0.7 }),
```

- **A node takes `sound: '<key>'`:** its voice, which is what its intents and its contacts sound like. Every kind of node takes it: shapes, groups, eyes, links, labels, emitters. A key looks like a string key: lower-case parts joined by `.`, `_` or `-`.
- **An intent takes `sound`.** `false` mutes everything the intent does. A key names the sound of the event at its start (the take-off of a hop, the start of a `drawOn`); the arrival keeps the sound it would have.
- **`sfx(key, { at, node?, gain? })`** is a key of the timeline that places a sound at a moment, for example on a word of the narration. It always sounds. With `node` (a shape, a group, an eye or a label) it is panned to where that node is. `gain` (default 1) multiplies the gain the bank gives the sound. `at` is 0 or later.
- With a bank, `skink3 check --bank` fails on a key the bank does not know, as it fails on a missing string.

### Events

Every key of the timeline is an event, and so are every recorded contact of the rigid bodies and every burst of an emitter. `skink3 events` writes them all.

| Kind | What makes it | Its moment |
|---|---|---|
| `appear`, `disappear` | `popIn`, `popOut` of a shape, a group or an eye | `at` |
| `label` | `popIn` of a label or of a text | `at` |
| `move` | `moveTo`, `travel`, the take-off of a `hop` | `at` |
| `land` | the landing of a `hop` | `at + dur` |
| `turn` | `turnTo` | `at` |
| `grow`, `shrink` | `scaleTo`, by whether the node gets larger or smaller | `at` |
| `fade` | `fadeTo` | `at` |
| `level` | `levelTo` | `at` |
| `bump`, `squash` | `bump`, `squash` | `at` |
| `draw`, `connect` | `drawOn`: the link or the stroke starts to be drawn, and the line reaches its far node, or the share it is drawn to | `at`, and `at + dur` |
| `pulse` | a `pulse` arrives at the far node of its link, or at the end of its way along a stroke | `at + dur` |
| `open`, `blink` | `openTo`, `blink` | `at` |
| `contact` | two rigid bodies hit each other | the frame of the impact |
| `burst` | an emitter bursts: one of its `bursts`, or one set off by a contact (`onContact`) | `at`, or the frame of the contact |
| `sfx` | `sfx()` | `at` |

An event has these fields:

| Field | Meaning |
|---|---|
| `id` | `<kind>:<node>@<frame>`, with `#2`, `#3` for more of the same: unique in the shot and the same from run to run |
| `kind`, `frame`, `time` | the moment falls on a frame: `time` is `frame / 60` seconds |
| `dur` | seconds the action lasts from that moment; 0 for an instant: a landing, an arrival, a contact, a burst |
| `node`, `key` | the node, and its sound key (null without one). The node of a contact is a dynamic body, a seen one first |
| `sound` | what the scene asked for this event: `false`, or the key of a sound. Left out when it asked for nothing |
| `gain` | a placed sound: the gain the scene gave it |
| `impulse` | a contact: its peak impulse, as the bake records it. A burst set off by a contact has it too |
| `other`, `otherKey` | a contact: the other body and its sound key |
| `count` | a burst: its particles |
| `size` | largest size on screen during the action, in px of a 1080p frame: the diameter of the circle that holds the node and what is in it; the length of a link, and of a stroke that is drawn on or that a light runs along; for a burst the diameter of a disc as large as all its particles together |
| `speed` | peak speed on screen during the action, in px per frame, the camera left out: of the node, of the end of a link that is drawn on, of a pulse |
| `x`, `y` | where it is on screen at that moment, in px from the top-left corner of the frame |
| `seen` | whether it is seen at some frame of the action |
| `peakFrame`, `peakTime` | a move: its fastest moment (see "A sound fitted to a move") |
| `from`, `to` | a move: where the node is on screen on its first and on its last frame, as `[x, y]` |
| `distance` | a move: the length of its way on screen, in px, the camera left out |
| `track` | a move: where the node is on screen on every frame of it, as a list of `[x, y]` from its first frame to its last |

- **Seen** means what it means in the motion review: drawn, at least 5 % opaque, reaching into the frame, and not wholly behind a `cover` or outside the shape it is clipped to. A contact is seen when its body is seen and the place where the two touch is in the frame; a burst when it is in the frame. A placed sound counts as seen.
- **A move** is the `move` of a `moveTo`, of a `travel` and of the take-off of a `hop`. It carries its motion; its last frame is the end of its `dur`, or the last frame of the shot when that comes first.
- A `solidTo`, a `countTo`, a `bendTo`, a `reshape`, a `cameraTo`, a `zoomTo` and a `backgroundTo` are no events.
- **What is no event:** the camera, springs, idle wander, particles in flight (the `rate` of an emitter), and the blinks an eye makes by itself. They make no sound. A fade, a turn, the lids of an eye and a blink the timeline asks for are events, of kinds that are silent unless a bank maps them to a sound.
- A key that starts before the shot has no start in it: a travel that is under way at frame 0 is no `move`. An arrival after the last frame is no event either.

### The bank of sounds

A bank is a JSON file that lies next to its sounds:

```json
{
  "about": "any note",
  "gain": 1,
  "sounds": {
    "pop":          { "file": "kit/pop.wav", "gain": 0.8 },
    "tick":         { "file": ["kit/tick-1.wav", "kit/tick-2.wav"], "pitchJitter": 1 },
    "marble.contact": { "file": "story/marble.wav", "priority": 1 },
    "chime":        { "file": "story/chime.wav" }
  },
  "kinds": { "appear": "pop", "label": "pop", "contact": "tick", "move": null },
  "curves": { "size": [[24, 0.5], [320, 1]] },
  "rules": { "gap": 0.5, "starts": 4, "startsWindow": 10 }
}
```

- Only `sounds` is required. A field the engine does not know is refused, so a misspelt rule is found.
- **`sounds`** holds each sound by its key.
  - `file` is a path relative to the bank, or a list of paths: takes of one sound, of which each use picks one by the seed.
  - `gain` (default 1) is the gain of the sound; 1 is as recorded.
  - `pitchJitter` (0.5) tunes each use up or down by at most that many semitones, and `gainJitter` (0.1) makes it louder or softer by at most that share of its gain: two repeats do not sound the same.
  - `priority` (0): see the rules below.
  - `rules`: rules of its own for its events, in place of the rules of the bank; see "Rules of a sound".
  - `anchor`, `peakAt`, `pan`, `pick`: how the sound is fitted to a move; see "A sound fitted to a move".
- **A file is a PCM WAV:** integer samples of 8, 16, 24 or 32 bits, or float samples of 32 or 64 bits; mono or stereo; any sample rate (a take is brought to 48 kHz when it is used). A compressed file (MP3, OGG, ADPCM in a WAV) is refused with a message: convert it first.
- **`kinds`** maps a kind of event to the key of a sound: what such an event sounds like when nothing else decides. A kind that is left out, or mapped to `null`, is silent.
- **`gain`** (1) is the gain of the whole track.

**One event makes one sound.** Which one:

1. The scene decides first: `sound: false` on the intent mutes it; a key on the intent, or in `sfx()`, names the sound.
2. Then the voice of the node (for a contact: of either body): the sound `<voice>.<kind>`, when the bank has it. `marble.contact` is what a node with `sound: 'marble'` sounds like when it hits something.
3. Then the kind: when the bank maps it to nothing, the event is silent.
4. Otherwise the sound `<voice>`, when the bank has it, and only without one the sound the bank maps the kind to. So a contact of a node with a voice of its own plays that voice, and not the sound of the kind as well.

A bank knows the key of a node when it has the sound `<key>` or a sound `<key>.<kind>`. A key on an intent, and the key of `sfx()`, must be a sound of the bank by that name.

**Curves** turn what is seen of an event into gain. A curve is a list of points `[x, gain]` in rising order of x, joined by straight lines and held flat beyond its ends.

| Curve | Against | For | Default |
|---|---|---|---|
| `size` | the size on screen, px | every event but a placed sound | `[[24, 0.5], [320, 1]]` |
| `speed` | the peak speed, px per frame | moves and landings | `[[4, 0.6], [40, 1]]` |
| `impulse` | the impulse | contacts and the bursts they set off | `[[0.25, 0.4], [2, 1]]` |

The gain of a sound in the track is the `gain` of the bank × the `gain` of the sound × its curves × its jitter. For a placed sound it is the `gain` of the bank × the `gain` of the sound × the `gain` of `sfx()` × its jitter.

**Rules** keep the track from being crowded. Each has a default in the engine (`SOUND_RULES`), chosen to be quiet rather than busy; a bank changes the ones it names.

| Rule | Default | An event is not heard when | In the report |
|---|---|---|---|
| (always) | | it is not seen | `unseen` |
| `minSize` | `24` px | it is smaller than this on screen | `small` |
| `minSpeed` | `4` px per frame | it is a move or a landing and slower than this at its peak | `slow` |
| `minImpulse` | `0.25` | it is a contact, or a burst set off by one, and weaker than this | `weak` |
| `mergeWindow` | `0.08` s | another event of its kind is closer than this and matters more: the two sound as one | `merged` |
| `kindGap`, `kindGaps` | `1` s, `{}` | a sound of its kind starts closer than this. `kindGaps` sets the gap of single kinds: `{ "contact": 0.4 }` | `kind-gap` |
| `crowdVoices`, `crowdWindow` | `2` in `5` s | its kind already has that many sounds within such a window | `crowd` |
| `gap` | `0.5` s | another sound starts closer than this, whatever its kind | `gap` |
| `starts`, `startsWindow` | `4` in `10` s | that many sounds already start within such a window, whatever their kinds | `starts` |
| `voices` | `3` | that many sounds are already heard at that moment | `voices` |

Two more rules do not drop anything: `priority` (below), and `pan` (default `0.6`): how far to a side a sound at the edge of the frame is panned, 0 for the middle, 1 for hard left or right.

- The rules are applied in the order of the table. A window or a gap of 0 turns its rule off.
- The rules are the same for every event, unless the sound of the event has rules of its own (below).
- A sound the scene named on an intent is not held to the three thresholds: it was asked for, whatever the size of the thing. It is held to all the other rules.
- **A placed sound always sounds.** No rule drops an `sfx()`, and the other events make room for it.
- **What matters more keeps its sound.** Where a rule has to choose between events, they rank in this order:
  1. a sound placed with `sfx()`;
  2. a sound the scene named on an intent;
  3. the `priority` the bank gives the sound, the higher first: give the sounds of a story's own things one above 0, and they go before the sounds of the kinds;
  4. the place of the kind in `rules.priority`;
  5. the gain, the stronger first; then the earlier event.
- `rules.priority` lists kinds of events from the one that matters most. The default is `land`, `contact`, `appear`, `disappear`, `label`, `connect`, `pulse`, `burst`, `grow`, `shrink`, `level`, `squash`, `bump`, `draw`, `move`, `turn`, `fade`, `open`, `blink`: what hits and what arrives, then what changes, then what merely moves. A bank names the kinds it wants first; the rest follow in the order of the default.
- A burst set off by a contact is an event of its own at the moment of that contact. With a `gap` above 0 only one of the two is heard.

### Rules of a sound

The rules of the bank treat every event alike. A sound may set rules of its own for its events, in `rules` of the sound:

```json
"marble.contact": {
  "file": ["story/marble-1.wav", "story/marble-2.wav", "story/marble-3.wav"],
  "pitchJitter": 2,
  "gainJitter": 0.25,
  "rules": { "minSize": 0, "minImpulse": 0.05, "mergeWindow": 0, "kindGap": 0, "crowdWindow": 0, "starts": 12, "startsWindow": 1, "voices": 8, "apart": true }
}
```

| In `rules` of a sound | What it sets | In the report |
|---|---|---|
| `minSize`, `minSpeed`, `minImpulse` | the thresholds, for its events | `small`, `slow`, `weak` |
| `mergeWindow` | the window in which its events sound as one | `merged` |
| `kindGap` | the least gap between two of its sounds | `kind-gap` |
| `crowdVoices`, `crowdWindow` | how many of its sounds may start within such a window | `crowd` |
| `starts`, `startsWindow` | its own cap: at most `starts` of its sounds start within any `startsWindow` seconds (the window of the bank when it names none). There is no such cap unless it names one | `sound-starts` |
| `voices` | at most this many of its sounds are heard at once. There is no such cap unless it names one | `sound-voices` |
| `apart` | `true`: its sounds stand apart from the limits of the whole track | |

- **A sound with `rules` is thinned by itself.** Its events are merged, spaced and counted among themselves, and no longer with the other events of their kind: the marbles above and the other contacts of the shot neither merge with each other nor crowd each other out. This holds for an empty `rules: {}` too.
- A rule it does not name has the value of the bank. `kindGaps` of the bank is for kinds, and is not read for it. A field that is not in the table is refused: `gap`, `priority` and `pan` are the bank's.
- The rules belong to the sound that is played: those of `marble` are for every event of that voice that has no sound of its own, those of `marble.contact` for its contacts.
- A sound's own cap and voices are applied after the crowd, and before the limits of the whole track.
- **`apart: true`** takes its sounds out of the limits of the whole track: they are not held to the `gap`, `starts` and `voices` of the bank, and they do not count toward them. The other sounds of the track, its **accents**, are then exactly what they are without it. A sound that stands apart has nothing but its own `starts` and `voices` to cap it, so set them.
- A sound placed with `sfx()` is an accent whatever the rules of its sound: it always sounds, and it is counted.

**A shower.** Under the rules of the bank a pour of many small things is one sound or two: the gaps and the crowd see to that, and a single tick does not say that forty marbles fell. The entry above makes the pour heard as it is seen:

- every impact sounds on the frame of its contact (`mergeWindow` and `kindGap` of 0; `crowdWindow` of 0 turns the crowd off), small and weak ones too (`minSize`, `minImpulse`);
- up to 12 of them start in any second and 8 are heard at once; where the cap has to choose, the harder impacts keep their sound;
- the gain of each impact comes from its impulse, on the `impulse` curve, and `pitchJitter`, `gainJitter` and several takes keep two impacts from sounding the same;
- `apart` keeps the pour from taking the place of the accents.

A **shower** is a run of a sound that stands apart: starts that follow each other by less than a second. The report counts a shower as one thing, with its starts, its length and its busiest second, and the sound sheet gives it one tile. With about 8 to 12 starts a second single impacts are still heard; a sound of about a tenth of a second suits that.

### A sound fitted to a move

A whoosh that is not fitted to what moves reads as noise. So a move says how it goes, and a sound of the bank can be laid on it: its loudest point on the fastest moment of the move, its pan going across with the node, its length near the length of the move.

```json
"panel.move": {
  "file": ["story/whoosh-short.wav", "story/whoosh.wav", "story/whoosh-long.wav"],
  "anchor": "peak",
  "pan": "follow",
  "pick": "duration"
}
```

A node with `sound: 'panel'` then whooshes when a `moveTo`, a `travel` or a `hop` moves it.

| In a sound | Default | What it does |
|---|---|---|
| `anchor` | `"start"` | the moment of its event the sound is placed on. `"start"`: the sound starts where the event starts. `"peak"`: the loudest point of the sound lands on the fastest moment of the move. `"end"`: the loudest point lands where the action ends |
| `peakAt` | measured | seconds into the take of its loudest point: one number, or a list with one for each take. Left out, it is measured from the take |
| `pan` | `"fixed"` | `"fixed"`: the sound is panned where it is placed. `"follow"`: its pan moves with the node over the length of the sound |
| `pick` | `"seed"` | how a use picks one of several takes. `"seed"`: by the seed of the shot. `"duration"`: the take whose length is nearest the duration of the event, the earlier of two that are as near |

- **The fastest moment of a move** is in its event (`peakFrame`, `peakTime`). The fastest frames of a move are those within a tenth of its highest speed on screen. Among them the moment is the frame on which the node is nearest the middle of the frame. So a thing that crosses the frame at one speed has its moment where it passes the middle; a move from rest to rest has it in the middle of its fast stretch; one that comes in at speed and brakes has it just before it brakes; one that leaves from rest has it as soon as it is at speed.
- **The loudest point of a take,** when `peakAt` does not give it, is the middle of the stretch around its loudest 30 ms in which the take stays within 1 dB of them: the top of a swell, the middle of a burst. Give `peakAt` when a take has two tops, or when its accent is not its loudest part.
- With `"peak"` or `"end"` the sound starts before the moment it is placed on, by `peakAt` (less when it is tuned up). A sound that would start before the shot is heard from inside its take, faded in over 10 ms.
- An event that is not a move has no fastest moment: `"peak"` places the loudest point on the frame of the event itself. That holds for `sfx()` too: the loudest point of such a sound lands on its `at`.
- **`"follow"`** reads the way of the move (`track`): before the move the pan is where the move starts, after it where the move ends. The power stays the same while the pan moves. An event without a way, which is every event but a move, is panned where it is.
- A sound that is placed on the peak or on the end, and does not follow, is panned where the node is on that frame.
- **`"duration"`** compares the length of each take as recorded with the `dur` of the event. A take is not stretched: give the sound takes of a few lengths. The gain still comes from the speed of the move, on the `speed` curve.
- The rules of the bank count a sound at the moment of its event, whatever its anchor: the gaps and the caps are about the starts of events. Only the voices at once are counted by when the sounds are heard.
- A bank that uses none of these fields gives the track it gave before, byte for byte.

### The track

- **48 kHz, stereo, 24-bit PCM WAV, exactly as long as the shot:** 800 samples for every frame.
- A sound starts on the first sample of the frame of its event. With the anchor `"peak"` or `"end"` it is its loudest point that lands on the first sample of the frame it is placed on.
- **Pan follows x on screen,** with constant power; in the middle of the frame both channels have the gain of the sound. A sound stays where it is placed, unless its pan follows the node.
- A sound that is still heard when the shot ends is cut there, with a fade of 10 ms.
- **The same scene, bank and seed give the same bytes.** The jitter of a sound comes from the seed of the shot and the id of its event, so an event more or less does not change the others.
- Nothing is limited or compressed. The report gives the peak of the mix and the number of samples that had to be held at full scale; when there are any, lower the gains.

The report is printed, and written in full to `out/<shot>/sfx.json`:

| In the report | Meaning |
|---|---|
| `events`, `heard` | the events of the shot, and how many of them are heard |
| `starts`, `startsPerMinute` | the accents: the sounds that the limits of the whole track count, which is every sound but those that stand apart; and how many of them start per minute of the shot |
| `mostStarts`, `startsWindow` | the most accents that start within any stretch of `startsWindow` seconds: the window of the rule `starts` |
| `mostVoicesAtOnce` | the most accents heard at one moment |
| `showerStarts`, `showers` | the sounds that stand apart, and their runs. A shower has its `sound`, the `id`, `node` and `time` of its first start, its `seconds` (to the end of its last sound), its `starts`, and `mostStartsInASecond` and `mostVoicesAtOnce` |
| `silent`, `muted` | events of kinds the bank keeps silent; events the scene muted |
| `dropped` | for each rule (`unseen`, `small`, `slow`, `weak`, `merged`, `kind-gap`, `crowd`, `sound-starts`, `sound-voices`, `gap`, `starts`, `voices`) the events it took out, each with the event that is heard instead where the rule names one |
| `byKind` | for each kind: its events, and how many of them are heard |
| `voices` | every sound of the track: the id of its event, its time and kind, the `node` it comes from (null for a sound placed by hand without one), the sound and its take, gain, pitch, pan and length; for a sound of a shower also `shower`, its place in `showers`. `time` is when the sound starts to be heard. A sound placed by its loudest point also has `anchor` (`peak` or `end`) and `at`, the moment that point lands on; a pan that moves has `panTo`, where it is when the sound ends (`pan` is where it starts) |
| `peak`, `clipped` | the largest sample of the mix (1 is full scale), and the samples above it |
| `rules`, `soundRules` | the rules as they were applied; the rules that sounds set for themselves, by the key of the sound |

The printed report lists the accents one by one, each with its node, and every shower in one line. A sound that is fitted says so in its line: `pan -0.27 to -0.60`, and `its loudest point on the peak, 4.20 s; take 1, 0.69 s`.

### The sound sheet

```
skink3 sfx <scene> --bank bank.json --sheet [--cols 4] [--tile 480]      -> out/<shot>/sfx_sheet.png
```

The sheet shows which event each sound belongs to, for an author who cannot hear the track. It has one tile for every sound, in order of time:

- **The picture** is the frame the sound is placed on: where it starts, or, with the anchor `"peak"` or `"end"`, where its loudest point lands.
- **A ring** goes around the node the sound comes from, where it is on that frame, as large as the node gets during the event. A link and an emitter get a small ring at the place of the event: the end of the link, the place of the burst. A sound placed by hand without a `node` has no ring.
- **Written on the tile** are the time, the frame and the key of the sound; then the kind of event and the id of the node (`placed by hand` without one), and for a contact the other body: `contact  marble-3 on jar`.
- **A move has an arrow:** the way of the node from the first frame of the move to its last, with a head where it ends. A move of less than 40 px has none.
- **A sound placed by its loudest point** says so in a third line: `loudest on the peak of 2.00-2.80 s`, with the span of the move. The ring is then where the node is at that moment, on its way along the arrow.
- **A shower is one tile,** at its first start, with a dashed ring and a line of its own: `shower: 40 starts in 3.5 s`.

Read it tile by tile. Is the ring on the thing a viewer would take for the source of that sound at that moment, and does the sound suit what the thing does there? For a whoosh: is the ring where the thing is at its fastest, and does the arrow show a move a viewer sees? A sound whose ring holds nothing a viewer sees act is a sound to mute (`sound: false`) or to move. A pour that shows as a few single tiles is a few accents: give its sound `rules`, and set it `apart`.

- An `appear` starts while its node is still invisible, so its ring is empty on that frame: it marks where the node is about to be.
- The writing is in the bottom-left corner of a tile, and in the top-left one when the ring is down there.
- The sheet holds at most 60 tiles, the first in time, and the command says how many sounds are left out. `--cols` sets the tiles in a row, `--tile` the width of a tile in px.
- With `--out` the sheet is `<out>.sheet.png`, next to the track.

### What sound does not do

- No narration, no music and no mix of a film: the track of a shot holds its sound effects and nothing else.
- No reverb, no filter, no change of a sound over its length.
- A sound follows its node only as a move with `pan: "follow"`; any other stays where it is placed. It cannot loop for as long as something lasts, and it is not stretched to the length of a move: the bank picks among takes.
- Nothing is heard of what a shot's last sound would do after the shot: a film that puts its shots end to end cuts each track at the cut.

## Command line

```
skink3 <command> <scene module> [options]

check   the palette's own rules, string tables, glyphs and text fit in every language; the reviews in short   [--bank <bank.json>]
bake    simulate physics, springs and particles; write the cache        [--force]
still   frames as PNG          --frame <n[,n...]> | --time <s[,s...]>   [--hash]
strip   a motion strip         --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   a contact sheet        [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  an mp4                 [--workers n] [--from f] [--to f] [--encoder x264|nvenc] [--hashes] [--force]
motion  the motion review      [--pictures [--top 3]]                   report as text, and as JSON in out/<shot>/motion.json
physics the physics review     [--pictures [--top 3]]                   report as text, and as JSON in out/<shot>/physics.json
trail   a ghost trail          --node <id[,id...]> [--from f] [--to f] | [--time s,s]  [--every k] [--space stage|screen]
graph   a speed graph          --node <id> | --camera   [--from f] [--to f] | [--time s,s]
events  the events of the shot                                           as JSON in out/<shot>/events.json
sfx     the sound track        --bank <bank.json> [--sheet [--cols 4] [--tile 480]]   a WAV, and its report as JSON in out/<shot>/sfx.json

common  --lang <tag>  --width <px> (default 1920)  --cpu  --out <file>  --cache <dir>
```

- Inside the engine repository the command is `node bin/skink3.mjs`; from a repository that depends on the engine it is `npx skink3`.
- Output goes to `./out/<shot id>/`, the bake cache to `./cache/`, both relative to the directory the command is run from.
- `still`, `strip`, `sheet`, `render`, `check`, `motion`, `physics`, `trail`, `graph`, `events` and `sfx` bake first if the cache is missing or stale.
- `check --bank <bank.json>` also holds the sound keys of the shot against that bank; `sfx` writes `out/<shot>/<shot>_sfx.wav`, or the file `--out` names, with its report next to it; `sfx --sheet` also writes the sound sheet, `out/<shot>/sfx_sheet.png`: which event each sound belongs to (see Sound).
- `--crop` is in stage units with the origin at the **top-left** corner of the frame (unlike scene coordinates).
- `sheet --lang en,x-long --frames 700,880` puts the same frames side by side in several languages: the way to review a translation.
- `--hash` and `--hashes` print or write the SHA-256 of each frame's raw RGBA pixels, for determinism checks.
- `render` reports its progress: a line rewritten in place on a terminal, a line every five seconds otherwise.
- If one render worker fails, the others are stopped at once, the partial files are removed, and the command exits with code 1 and a message naming the worker's frame range.

Review the picture with stills, strips and sheets, the motion with `motion`, `trail` and `graph`, the simulation with `physics`, and the sound with the report and the sheet of `sfx`; render the video when those look right.

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

For colour, `checkPalette(palette)` returns the rules of a palette that are broken, `colourDistance(a, b)` the difference of two colours in lightness and in colour, and `reviewContrast(c, bake)` the contrast review of a shot that asks for one (null otherwise); `runChecks(c, bake, langs, { contrast: true })` adds it to the checks.

For text, `BUNDLED_FONTS` lists the bundled families in the order they are tried for a character, `fontOf(char)` and `missingGlyphs(text)` answer from their character maps, and `checkGlyphs(c, langs)` is the check `runChecks` makes of the strings a shot uses.

For subtitles, `cuesFromWords(words, options)` turns the word timings of a narration (`[{ w: 'Hello.', start: 0, end: 0.4 }, ...]`) into subtitle cues: lines of a set length, breaks at the ends of sentences and at pauses. Its options, with their defaults: `maxChars` (42) a line, `maxLines` (2) a cue, and `pause` (0.5), the seconds of silence at which a cue ends. `formatSrt`, `formatVtt` and `formatYtt` write the cues out; see `src/text/subtitles.ts`. `formatYtt(cues, { color, edge, ... })` needs the colour of the text and of its outline: the engine has no colour of its own for a subtitle.

For sound, `sceneEvents(c, bake)` returns the events of a shot, `loadBank(file)` reads a bank, and `renderSound(c, bake, bank)` returns the track (`wav`: the bytes of the WAV file), its `plan` and its `report`. `planSound`, `mixVoices`, `readWav` and `writeWav` are the steps it is made of; `SOUND_RULES` and `SOUND_CURVES` are the defaults. `showersOf(plan.voices)` gives the showers of a plan, `takePeak(take)` measures the loudest point of a take, and `renderSoundSheet(c, bake, plan, options)` draws the sound sheet (`soundTiles`, `tileCaption`, `tileRing` and `tileArrow` are what is on it). See `src/audio`.

## What is not there yet

No transitions between shots, no narration, no music and no mix of a film's sound, no keys anchored to words, no bubbles, no digits that roll, no scripts beyond Latin, Cyrillic and Greek, no right-to-left text, no double arrows or geometric shapes in the bundled fonts, no soft bodies, ropes with weight, flocks or fluids, no motion blur, no blending of overlapping moves, no corners with different radii, no bodies that can be steered or retired, no way for a scene to follow a baked quantity (the height of a pile). See the roadmap in the README.

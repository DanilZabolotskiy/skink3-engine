# Principles

These rules hold for every part of the engine and for every scene built with it.

## 1. Simple forms, flawless motion

Drawing must be perfect, so motion must be perfect too: no glitches, no crooked or unclear movement. Glitches show up where viewers know exactly how something should move. So the engine avoids complex, familiar objects and motions.

- **Humans and any humanoid creatures.** Arms and legs are oval sticks with rounded ends: no hands, no fingers, no feet.
- **No human limb mechanics.** No stepping with knees, no grasping, no gestures, no precise hand-on-object contact. A character moves as a whole: it hops, slides, floats or rolls. Stick limbs only sway on springs and take simple poses. A "held" object floats next to the stick, sticks to its end, or is not there.
- **The same for any object.** If viewers know precisely how something moves (hands, feet, gait, paws, wing beats and the like), simplify its form until the correct motion is trivial, or do not show that motion.
- **Prefer forms without a strict reference in the viewer's mind:** drops, cells, blobs, sticks, geometry, particles.
- **Enforced by the API.** The character API has no hand, finger or foot parts and no knee-based walk cycle, so they cannot be drawn even by accident.

## 2. Determinism

- Frame *n* is a pure function of the scene description, the bake cache and *n*.
- Everything with history (physics, particles, springs, flocks) is simulated in a bake step with a fixed timestep and fixed seeds, and stored per frame.
- Dependency versions are pinned exactly. Rapier snapshots are not compatible across versions, so the bake cache is keyed by engine and physics versions.
- Consequences: any single frame can be rendered for review, chunks render in parallel on all cores, and "before / after" comparisons work pixel by pixel.

## 3. Text is data (multilingual by design)

- Scenes contain no on-screen text, only keys into per-language string tables.
- Labels, bubbles, titles and counters size and wrap themselves to the string. Pre-render checks catch overflow and overlaps in every language.
- Fonts are open (OFL) and cover the needed scripts: Latin, Cyrillic, Hangul, CJK, right-to-left Arabic, Devanagari and others. Noto is the fallback family.
- A translated narration has different durations, so shot timing and word-anchored events are re-derived from each language's voice. Physics is re-baked deterministically with the same seeds.
- Each language gets its own subtitles. Re-rendering a language is one command.

## 4. Motion like an animator

- A scene states intents. The engine turns them into curves with anticipation, arcs, overshoot and settle, and staggers reactions across groups.
- Secondary motion comes from second-order dynamics on rig nodes (frequency, damping, response), with presets such as heavy, light, springy and viscous.
- Solvers are tuned for readability: lower gravity, more drag, softer impacts, slower than real.
- Chaos is directed: a body follows animation until it is released, goal forces guide it in the last moments, and a seed search picks the take that fits the composition.

## 5. Light from the shape

- One light direction per shot.
- Shadow crescent = shape minus the shape shifted toward the light; rim highlight = shape minus the shape shifted away; deep shadows stack.
- Rounded corners come from a stroke in the shape's own colour; layered outlines are strokes clipped to the shape.
- Highlights are lighter, less saturated and hue-shifted; shadows are darker and more saturated.
- Glowing things get a line, a halo and a lift of the background.

## 6. Measured look

Target norms (checked with `tools/metrics` on renders):

| Metric | Target |
|---|---|
| Frame rate | true 60 fps, no duplicated frames in motion |
| Fully static frame pairs | 3–9 %; no hold longer than ~4 s |
| Camera drift (median) | 0.3–0.7 px per frame at 1080p |
| Average shot between hard cuts | 8–16 s |
| Pixels with L* < 30 | about 60 % on dark shots |
| Saturation of dark pixels | about 0.8 |
| Near-gray pixels (S < 0.12) | about 6 % or less |
| Hue of dark pixels | mostly 210–300° (blue, indigo, violet) |
| Texture or grain | none: clean vector and gradients |

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
| Pixels with L* < 30 | about 60 % over a whole video, which mixes dark and bright shots; 78–95 % on a dark shot (median 88 %) |
| Saturation of dark pixels | about 0.8 |
| Near-gray pixels (S < 0.12) | about 6 % or less |
| Hue of dark pixels | mostly 210–300° (blue, indigo, violet) |
| Texture or grain | none: clean vector and gradients |

## 7. Checks that can be trusted

- A check reports what a viewer would see as wrong, and nothing else. A finding on a sound shot is a bug of the check; so is a defect that it has no finding for.
- Every kind of finding is proven by a test that plants its defect and by sound scenes next to it that must stay clean.
- **The physics checks grow with the physics.** Any change to the physics of the engine (a new kind of body, a solver, a constraint, a setting) updates the physics review and its tests in the same piece of work: the geometry it works out, the detectors that apply, a planted defect and a sound scene for what is new. The list of what follows from which change is in [PHYSICS-REVIEW.md](PHYSICS-REVIEW.md#when-the-physics-changes).

## 8. A reference that follows the code

- [QUICK-REFERENCE.md](QUICK-REFERENCE.md) is the page a scene author reads instead of the whole guide: every feature with its defaults and an example, the command line, how to read the two reviews, and an index of the guide by question.
- **Whoever adds or changes a feature updates it in the same commit:** an export for scenes, an option or its default, a command or a flag of the CLI, a kind of finding, a section of the guide. The guide ([SCENES.md](SCENES.md)) gets the full text.
- **A test holds it to the code.** `test/quick-reference.test.ts` fails and names what is missing, runs every example, and holds every default the page shows against the engine.
- **It stays short.** The same test caps its length. What does not fit goes to the guide, and the page points to the section.

## 9. Sound in measure

- **A film is never crowded with sound.** A sound marks an event that matters; it is not a click every second.
- Only what is seen sounds. Small and slow moves are silent. A crowd of events sounds as a few.
- One event makes one sound.
- The engine holds no sounds: a production brings its bank. The limits (thresholds, gaps, caps, priorities) are data of the bank, and the defaults in the engine are quiet rather than busy.
- Sound never changes a pixel or a bake.

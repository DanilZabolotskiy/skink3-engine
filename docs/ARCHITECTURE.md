# Architecture

Phase 0 built a thin, real version of every module on the path from a scene to a video. This document says what each module does today and what is still planned. Anything not listed under "built" does not exist yet.

```
script + narration (word timings)                                   [planned, phase 4]
        │
        ▼
scene (TypeScript) ──► look ──► motion ──► physics bake ──► camera ──► render ──► ffmpeg
   │                    │         │             │                         │
   └── string tables    palette   intents,      rigid bodies, springs,    Skia GPU: layers, depth blur,
       per language     + light   springs       particles; cache keyed    glow, atmosphere, vignette
                                                by versions
        ▼
checks (before render): types, palette laws, string tables, text fit per language
review (no render needed): the motion of every node as findings, ghost trails, speed graphs;
                           the soundness of the simulation as findings, close-ups
```

## Modules

| Module | Built (phase 0) | Planned |
|---|---|---|
| `core` | 60 fps time base and the 1/240 s simulation step; seeded random with named sub-streams; easing; second-order dynamics (frequency, damping, response) with presets; seeded 1D and 2D noise; stable hashing of plain data | — |
| `shape` | circle, capsule, rounded convex polygon (regular, rectangle, explicit corners), blob; outline, extent and reach of a shape without a drawing library; paths; thin helpers over the path operations (difference, intersection, union, shift, round) | free-form paths, trim and interpolate helpers, generators (L-systems, procedural bodies, scattering) |
| `look` | palette by role (deep, dark, mid, accent, light) and a validator for the measured laws; one light direction per shot; shadow crescent, stacked deep shadow, lit rim, highlight stroke and optional coloured rim light, all derived from the shape; glow as line + halo + background lift; atmospheric perspective as a colour transform (paler, less saturated, toward the atmosphere colour, blended around the colour wheel so that nothing turns gray) | palettes generated from a mood; layered outlines |
| `scene` | shot, depth layers (parallax, blur and atmospheric perspective by depth), nodes: shape, group (optionally upright: it keeps its own rotation on a parent that turns), link, label, eye (with lids), emitter; rigid-body option on shapes; timeline keys anchored to seconds; compiler that validates the whole shot; pure evaluation of a frame into a display list, in which a faded node and its subtree form a group | keys anchored to narration words; rigs; more node types (bubble, title, counter) |
| `motion` | intents `moveTo` (anticipation, arc, overshoot, settle), `popIn`, `popOut`, `turnTo`, `scaleTo` (lasting size, chained, composing with pops and bumps), `fadeTo` (opacity), `bump`, `drawOn`, `pulse`, `openTo` (eye lids), `blink`; `stagger` over a group; spring-driven secondary motion (`follow`, `sway`) baked per frame; idle wander | blending of overlapping moves, more intents, squash and stretch, simple rigs under the simple-forms rule |
| `physics` | Rapier 2D wrapper: bodies from shapes, fixed step 1/240 s, style defaults (lower gravity, more drag, low restitution), release of a body at a given time, a prewarm that runs the world before frame 0, contact events with peak impulse; particle system (continuous emission, bursts, bursts on contacts, gravity or wind, drag, turbulence, prewarm); bake of bodies, springs and particles; on-disk cache | joints, kinematic hand-off, goal forces, seed search; XPBD soft bodies and ropes; PBF fluid; boids; particle collisions and sub-emitters |
| `camera` | steady drift plus low-frequency wander, exponential push-in, parallax view per depth layer; closed-form in the frame number | spring follow, zoom through scales |
| `text` | per-language string tables; one bundled OFL family (Latin, Latin Extended, Cyrillic, Vietnamese) registered under the engine's own family name; auto-fit layout (wrap at spaces, balance, shrink, report overflow); label geometry | shaping and fallback fonts for all scripts (CJK, Arabic, Devanagari…), right-to-left text, bubbles, titles, counters |
| `render` | compositing on Skia GPU with CPU fallback: background gradient, glow lift, layers back to front with blur by depth and atmospheric perspective, group opacity (a faded subtree is drawn as one picture, then faded), tapered pulses, links that glow, two-tone particles, halos, vignette; raw RGBA out; stills, strips and contact sheets; ffmpeg encoding; parallel chunk workers with progress, concatenation, and a clean stop when a worker fails | sub-frame motion blur, transitions, 4K master presets |
| `audio` | — (contact events are recorded by the bake for later use) | narration import, sound effects from physics and UI events, music bed with ducking, mixdown |
| `checks` | strict `tsc --noEmit`; unit and determinism tests on `node:test`; palette laws; string tables complete in every language; text fit per language (overflow, leaving the frame, label overlaps as errors; a label covering a node other than its target as a warning); the findings of the motion review and of the physics review in short form, as warnings | — |
| `review` | the motion review, for reviewers that cannot watch a video: the series of every node, link, emitter, spring and of the camera at every frame, in the space of the layer and on screen; findings from it (jump, abrupt start and stop, mechanical move, strobing speed, springs that ring or never bounce, dead areas of the frame) with every threshold in one file; intended exceptions marked in the scene; a report as capped text and complete JSON; ghost trails and speed graphs drawn on the engine's canvas. The physics review, from the bake: the distance and depth of every pair of colliders worked out in plain arithmetic, apart from the physics library; findings (overlap, tunnelling through a wall or a gap, escape, jitter at rest, a pile that does not settle, speed from nowhere, a hit by a body that is not drawn, broken numbers) with every threshold in one file; the same intended exceptions; a report of the same form; close-ups with the bodies ringed | calibration of the thresholds against reference videos; the physics review for soft bodies, ropes, fluids and joints when those are built |
| `cli` | `check`, `bake`, `still`, `strip`, `sheet`, `render`, `motion`, `trail`, `graph`, `physics`; scene modules from any directory; output and cache under the caller's working directory | `preview` window, per-language batch render |

Dependencies point one way: `core` ← `shape` ← `look`; `motion` uses `core`; `scene` uses all of these plus `text` and `camera`; `physics` bakes what `scene` describes; `render` draws what `scene` evaluates; `review` reads what `scene` evaluates and draws its pictures with `render`; `checks` and `cli` sit on top.

## Data flow

1. **Describe.** A scene module builds a shot with the factory functions. The result is plain data: no functions, no classes. `shot()` validates it as a whole.
2. **Compile.** The node trees are flattened in draw order, references and colours are resolved, the timeline is turned into per-node tracks, and every body, spring and emitter gets a slot in the bake. The scene hash is computed here, over everything except the string tables.
3. **Bake.** One process simulates everything with history at the fixed step and stores it per frame: rigid bodies (and their contact events), then springs, then particles. The pose stored for frame *n* is the state at *n*/60 s.
4. **Evaluate.** `evaluate(shot, bake, frame, language)` returns a display list: world transforms, link curves, pulse positions, label layouts, particle slices, opacities, the camera and the view of each layer. A node that is not fully opaque becomes a group holding its subtree. It has no state.
5. **Draw.** The renderer composites the display list on Skia and reads back raw RGBA. A group is drawn into a picture of its own and composited at its opacity. Atmospheric perspective is applied to colours, not to pixels: every colour a far layer draws with is transformed before it is used.
6. **Encode.** For a video, worker processes each take a contiguous frame range, pipe their frames into their own ffmpeg encoder, and the chunks are concatenated without re-encoding. Workers report their progress to the parent; if one fails, the parent stops the rest, removes the partial files and fails with that worker's frame range.

Because frames are pure, a still, a motion strip or a contact sheet never needs a rendered video.

## The motion review

A reviewer that cannot watch a video still has to judge motion. The review answers from the scene data, in three steps:

1. **Sample.** `sampleMotion` evaluates the shot at every frame without drawing: world transforms, opacities, the camera and the view of every layer. It keeps, for every placed node, its position, rotation, scale and opacity in the space of its layer, and its own motion in the space of its parent; for links, emitters and springs what their checks need. A node that nothing animates is sampled once.
2. **Detect.** Detectors read the series and return findings: plain data with a kind, a subject, a frame range, the measured value, the threshold and a usual fix. Every threshold is in `src/review/thresholds.ts`. Findings that the scene marks with `intended()` are taken out and listed as honoured.
3. **Show.** The report is printed as capped text and written as complete JSON. A ghost trail draws chosen nodes at every k-th frame over a dimmed frame; a speed graph plots speed and whatever else changes over time, with the findings marked.

The same scene always gives the same report and the same pictures. Guide: [MOTION-REVIEW.md](MOTION-REVIEW.md).

## The physics review

Whether the simulation is sound is answered from the bake, in one pass over the frames:

1. **Place.** Every rigid body gets the collider the world gave it: a convex core (a point, a segment, a polygon) and a radius around it, at the baked pose of the frame. The review builds this geometry itself and does not ask the physics library; a test holds the two against each other.
2. **Pair.** Bodies whose bounding circles are near are found by a sweep along x; for each pair the distance, or the depth, of the two colliders is worked out. From it come the overlaps, the piles (bodies that touch) and what a body can have touched within a frame.
3. **Detect.** Detectors read the poses and the pairs: an overlap that lasts, a centre that crosses a fixed body or a gap, a body below everything, swings of a body at rest, a pile that travels at the end, speed that nothing in touch can have given, a path bent by a body that is not drawn, numbers that are not numbers. Every threshold is in `src/review/physics-thresholds.ts`. What is not seen is not reported.
4. **Show.** The report has the form of the motion report. A close-up draws a few frames of the place, enlarged, with the bodies ringed.

It is synchronous and takes a fraction of a second on a shot with five hundred bodies, so it runs in every `skink3 check`. When the physics of the engine changes, this review changes with it in the same piece of work. Guide: [PHYSICS-REVIEW.md](PHYSICS-REVIEW.md).

## The bake cache

A cache file is `cache/<shot id>-<key>.bake` under the caller's working directory. The key is derived from:

- the **engine version**: the package version plus a fingerprint of the engine's sources, so any engine change invalidates old caches;
- the **physics version**: the exact pin of the rigid-body library;
- the **scene hash**: everything in the shot except the string tables (a translation does not re-bake);
- the **seed**.

The file holds a JSON header (the key, slot names, contact events) and five binary sections: body poses, spring positions, the particle index, the particles and the particle velocities, as 32-bit floats. The evaluator reads state only from this representation, whether the bake was just computed or loaded from disk. Nothing is drawn from the velocities; the motion review reads them to know how fast a particle travels.

## Determinism

- Nothing that affects pixels uses `Math.random`, the clock, or the iteration order of an unordered container; a test scans the sources for the first two.
- Random numbers come from named streams of the shot's seed. A stream depends on its name only, not on how much other streams were used.
- Springs and particles advance at 1/240 s inside the bake; the camera, intents, idle wander, blinks and pulses are closed-form functions of time.
- Rapier runs in its deterministic build; bodies join the world in a fixed order.
- Caches inside a process (paths, lit parts, text outlines, layouts) are keyed by their full input, so a hit returns what a miss would compute.
- GPU frames are exported with 4× MSAA. Stacked fills that share an edge (a crescent on its shape) resolve cleanly this way. On one machine and driver the GPU output is bit-exact between processes, between single frames and full renders, and between worker counts; the tests and the numbers in the README cover this. The CPU path is also deterministic but its pixels differ from the GPU's, and different GPUs or drivers are not expected to match bit for bit.

## Output formats

- Preview: 1920×1080 at 60 fps, H.264 (x264 by default, NVENC with `--encoder nvenc`), BT.709.
- Any 16:9 width with `--width`; scenes are written in stage units, not pixels. A 4K master preset is planned.

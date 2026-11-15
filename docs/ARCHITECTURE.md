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
```

## Modules

| Module | Built (phase 0) | Planned |
|---|---|---|
| `core` | 60 fps time base and the 1/240 s simulation step; seeded random with named sub-streams; easing; second-order dynamics (frequency, damping, response) with presets; seeded 1D and 2D noise; stable hashing of plain data | — |
| `shape` | circle, capsule, rounded convex polygon (regular, rectangle, explicit corners), blob; outline, extent and reach of a shape without a drawing library; paths; thin helpers over the path operations (difference, intersection, union, shift, round) | free-form paths, trim and interpolate helpers, generators (L-systems, procedural bodies, scattering) |
| `look` | palette by role (deep, dark, mid, accent, light) and a validator for the measured laws; one light direction per shot; shadow crescent, stacked deep shadow, lit rim, highlight stroke and optional coloured rim light, all derived from the shape; glow as line + halo + background lift | palettes generated from a mood; layered outlines |
| `scene` | shot, depth layers (parallax, blur and atmospheric tint by depth), nodes: shape, group, link, label, eye, emitter; rigid-body option on shapes; timeline keys anchored to seconds; compiler that validates the whole shot; pure evaluation of a frame into a display list | keys anchored to narration words; rigs; more node types (bubble, title, counter) |
| `motion` | intents `moveTo` (anticipation, arc, overshoot, settle), `popIn`, `popOut`, `turnTo`, `bump`, `drawOn`, `pulse`; `stagger` over a group; spring-driven secondary motion (`follow`, `sway`) baked per frame; idle wander | more intents, squash and stretch, simple rigs under the simple-forms rule |
| `physics` | Rapier 2D wrapper: bodies from shapes, fixed step 1/240 s, style defaults (lower gravity, more drag, low restitution), release of a body at a given time, contact events with peak impulse; particle system (continuous emission, bursts, bursts on contacts, gravity or wind, drag, turbulence, prewarm); bake of bodies, springs and particles; on-disk cache | joints, kinematic hand-off, goal forces, seed search; XPBD soft bodies and ropes; PBF fluid; boids; particle collisions and sub-emitters |
| `camera` | steady drift plus low-frequency wander, exponential push-in, parallax view per depth layer; closed-form in the frame number | spring follow, zoom through scales |
| `text` | per-language string tables; one bundled OFL family (Latin, Latin Extended, Cyrillic, Vietnamese) registered under the engine's own family name; auto-fit layout (wrap at spaces, balance, shrink, report overflow); label geometry | shaping and fallback fonts for all scripts (CJK, Arabic, Devanagari…), right-to-left text, bubbles, titles, counters |
| `render` | compositing on Skia GPU with CPU fallback: background gradient, glow lift, layers back to front with blur by depth and atmospheric tint, halos, vignette; raw RGBA out; stills, strips and contact sheets; ffmpeg encoding; parallel chunk workers and concatenation | sub-frame motion blur, transitions, 4K master presets |
| `audio` | — (contact events are recorded by the bake for later use) | narration import, sound effects from physics and UI events, music bed with ducking, mixdown |
| `checks` | strict `tsc --noEmit`; unit and determinism tests on `node:test`; palette laws; string tables complete in every language; text fit per language (overflow, leaving the frame, label overlaps) | motion norms (static holds, drift) and physics sanity (tunnelling, escapes, NaN) as pre-render checks |
| `cli` | `check`, `bake`, `still`, `strip`, `sheet`, `render`; scene modules from any directory; output and cache under the caller's working directory | `preview` window, per-language batch render |

Dependencies point one way: `core` ← `shape` ← `look`; `motion` uses `core`; `scene` uses all of these plus `text` and `camera`; `physics` bakes what `scene` describes; `render` draws what `scene` evaluates; `checks` and `cli` sit on top.

## Data flow

1. **Describe.** A scene module builds a shot with the factory functions. The result is plain data: no functions, no classes. `shot()` validates it as a whole.
2. **Compile.** The node trees are flattened in draw order, references and colours are resolved, the timeline is turned into per-node tracks, and every body, spring and emitter gets a slot in the bake. The scene hash is computed here, over everything except the string tables.
3. **Bake.** One process simulates everything with history at the fixed step and stores it per frame: rigid bodies (and their contact events), then springs, then particles. The pose stored for frame *n* is the state at *n*/60 s.
4. **Evaluate.** `evaluate(shot, bake, frame, language)` returns a display list: world transforms, link curves, pulse positions, label layouts, particle slices, the camera and the view of each layer. It has no state.
5. **Draw.** The renderer composites the display list on Skia and reads back raw RGBA.
6. **Encode.** For a video, worker processes each take a contiguous frame range, pipe their frames into their own ffmpeg encoder, and the chunks are concatenated without re-encoding.

Because frames are pure, a still, a motion strip or a contact sheet never needs a rendered video.

## The bake cache

A cache file is `cache/<shot id>-<key>.bake` under the caller's working directory. The key is derived from:

- the **engine version**: the package version plus a fingerprint of the engine's sources, so any engine change invalidates old caches;
- the **physics version**: the exact pin of the rigid-body library;
- the **scene hash**: everything in the shot except the string tables (a translation does not re-bake);
- the **seed**.

The file holds a JSON header (the key, slot names, contact events) and four binary sections: body poses, spring positions, the particle index and the particles, as 32-bit floats. The evaluator reads state only from this representation, whether the bake was just computed or loaded from disk.

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

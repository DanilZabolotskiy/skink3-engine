# Architecture (planned)

The engine is being built now; this is the target structure. Module names may change as code lands.

```
script + narration (word timings)
        │
        ▼
scene (TypeScript) ──► look ──► motion ──► physics bake ──► camera ──► render ──► ffmpeg
   │                    │         │             │                         │
   └── string tables    palette   intents,      rigid, soft, ropes,       Skia GPU: layers, depth blur,
       per language     + light   springs, rigs particles, flocks, fluid  glow, atmosphere, motion blur
                                                cache keyed by versions
        ▼
checks (before render): types, layout and text fit per language, colour norms, motion norms, physics sanity
```

## Modules

| Module | Responsibility |
|---|---|
| `core` | time (60 fps), seeded random, easing, second-order dynamics, noise |
| `scene` | shots, depth layers with parallax influence, nodes (shape, group, text, emitter, body, rig), timeline keys anchored to time or to narration words |
| `shape` | primitives (circle, capsule, rounded polygon, blob, path), path operations (boolean, round, trim, interpolate, jitter), generators (L-systems, procedural bodies, scattering) |
| `look` | palette from a mood by the measured laws; one light per shot; automatic crescents, rims, highlights, stacked shadows, glow, layered outlines |
| `motion` | intents → curves with anticipation, arcs, overshoot and settle; staggering; simple rigs under the simple-forms rule; springs on parts |
| `physics` | Rapier 2D wrapper (bodies from shapes, joints, kinematic hand-off, contact events); XPBD (soft bodies, ropes, cloth strips); PBF fluid rendered as metaballs; particles (emitters, forces, collisions, sub-emitters); boids; bake and cache; seed search |
| `camera` | parallax levels, spring follow, constant drift, zoom through scales (nested scenes 10^k apart) |
| `text` | per-language string tables, shaping and fallback fonts, auto-fit layout for labels, bubbles, titles, counters |
| `render` | layer compositing on Skia (GPU or CPU), blur by depth, glow and bloom, atmospheric tint, vignette, sub-frame motion blur, raw RGBA out |
| `audio` | narration import, sound effects from physics and UI events, music bed with ducking, mixdown |
| `checks` | type check, layout and text fit per language, colour norms, motion norms (static holds, drift), physics sanity (tunnelling, escapes, jitter, NaN) |
| `cli` | `bake`, `still`, `strip`, `render` (parallel chunks → ffmpeg), `sheet` (contact sheets for review) |

## Data flow and parallelism

1. **Bake.** One process runs all stateful simulation for the video at a fixed timestep (1/240 s) and writes per-frame state to the cache. It also writes physics events (impacts with impulse) for audio.
2. **Render.** N worker processes each take a frame range. A worker evaluates the scene at frame *n* (pure), draws it with Skia, and writes raw RGBA to its ffmpeg encoder.
3. **Assemble.** The chunks are concatenated, and the audio mix is muxed in.

Because frames are pure, review tools can render any single frame, a motion strip, or a contact sheet without rendering the video.

## Output formats

- Preview: 1920×1080 at 60 fps (NVENC or x264).
- Master: 3840×2160 at 60 fps (x264 or x265, high quality), rendered from the same scene and bake.

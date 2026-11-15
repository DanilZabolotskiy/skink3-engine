# skink3-engine

A code-first engine for animated science-explainer videos in a flat-vector style. It draws crisp shapes lit automatically, with dark saturated palettes, depth of field and glow, and computes their motion with physics at 60 fps. Scenes are TypeScript, written by people or by LLM agents. Skia draws the frames on the GPU without a browser, and they are piped straight into ffmpeg.

> **Status: pre-alpha (November 2026).** The stack is chosen and benchmarked on real hardware (numbers below), and the engine core is being built. The roadmap is at the end of this file.

## Why

In this genre, every movement on screen is usually keyframed by hand by a team of animators: anticipation, arcs, overshoot, parts that lag behind, soft impacts, everything a little slower than real life. The engine computes that motion instead of asking anyone to key it:

- **Intent → motion.** A scene says *what* happens ("the cell drifts to the nucleus on the word *glucose*"). The engine adds what an animator would: a short anticipation, a curved path, overshoot and settle, lagging appendages, staggered reactions of neighbours, idle drift.
- **Physics where it helps.** Rigid bodies, soft bodies, ropes, particles, flocks and simple fluids. All of it is deterministic, tuned for readability rather than realism (lower gravity, more drag, softer impacts), and art-directable through kinematic hand-off, goal forces and seed search.
- **Light, not drawing.** One light per shot. The engine builds shadow crescents (a shape minus its shifted copy), rim highlights, highlight strokes, stacked shadows and glow from the shape itself.

## Principles

1. **Deterministic.** Frame *n* is a pure function of the scene, the bake cache and *n*. Everything stateful (physics, particles, springs) is baked beforehand with fixed seeds. Any frame can be rendered alone, chunks render in parallel, and a re-render matches pixel for pixel.
2. **Simple forms, flawless motion.** Drawing must be perfect, so motion must be bug-free. The engine avoids objects whose motion viewers know precisely and would instantly judge as wrong. Humanoid limbs are rounded sticks with no hands, fingers or feet, and there are no human limb mechanics (stepping, grasping, gestures). The character API has no such parts, so they cannot be drawn by accident. See [docs/PRINCIPLES.md](docs/PRINCIPLES.md).
3. **Text is data.** Scenes never contain on-screen text, only keys into per-language string tables. Layout fits any text length, fonts cover all scripts, and timing follows each language's narration. A video can be re-rendered in another language with one command.
4. **Measured look.** Palette and motion norms are numbers (share of dark pixels, saturation of shadows, camera drift, static-frame share) checked by `tools/metrics` on every render.

## Stack

| Layer | Choice | Version |
|---|---|---|
| Language and runtime | TypeScript on Node (built-in type stripping); `tsc` as a pre-render check | Node 26 |
| Drawing | [skia-canvas](https://github.com/samizdatco/skia-canvas) — Skia with a Canvas 2D API, GPU (Vulkan/Metal) or CPU | 4.0.0 |
| Rigid bodies | [Rapier 2D](https://rapier.rs), cross-platform deterministic build | `@dimforge/rapier2d-deterministic-compat` 0.21.0 |
| Soft bodies, ropes, fluids, particles, flocks | own solvers (XPBD, PBF, boids) in TypeScript | — |
| Video and audio | ffmpeg: NVENC for drafts, x264 for masters | 9.x |
| Growth path | a Rust addon (napi-rs) over skia-safe for SkSL shaders, D3D12 and hot physics loops — only where profiling demands it | — |

Why this stack and what was rejected: [docs/STACK.md](docs/STACK.md).

## Benchmarks

Measured on November 15, 2026, with a Ryzen 7 9700X and an RTX 5070 Ti (Vulkan). The test frame is deliberately heavier than an average shot. It has 532 shapes lit with boolean-op crescents, 5,000 particles, three depth layers with blur, a glowing ring with bloom, and text.

| What | Result |
|---|---|
| 4K frame, 1 process, GPU | 130 ms (64 ms of it raster + pixel readback) |
| Same frame, CPU | 320 ms |
| 4K, 8 processes | 45 frames/s |
| 1080p, 8 processes | 78 frames/s, so a 13-minute 60 fps video renders in about 10 minutes |
| Rapier 2D: 2,000 bodies, 4 substeps per frame | 8.5 ms/frame; identical state hash across processes |
| XPBD in JS: 11,200 points, 18,300 constraints, 8 iterations | 10.6 ms/frame |
| 100,000 particles in a force field | 3.2 ms/frame |

## Quick start

```
npm ci
node bench/render.mjs 1920 gpu 20   # 1080p benchmark frame (writes frame_1920_gpu.png)
node bench/phys.mjs                 # rigid bodies, XPBD and particle timings
```

The first line of the render benchmark's output shows which engine is in use. If Vulkan is unavailable, skia-canvas falls back to the CPU.

## Layout

| Path | What |
|---|---|
| `bench/` | drawing and physics benchmarks |
| `tools/metrics/` | style and motion metrics for any video (reference or our own render): frame sampling, contact sheets, cut detection, palette by role, static frames, camera drift, duplicate frames, motion strips — see [docs/METRICS.md](docs/METRICS.md) |
| `docs/` | principles, architecture, stack |

## Roadmap

| Phase | Scope | Done when |
|---|---|---|
| 0 | A 15-second test shot through the whole path: scene → light → physics bake → GPU render → ffmpeg | the shot reads as the target genre, and its metrics fall in the target ranges |
| 1 | Core picture: scene graph and depth layers, palettes and automatic light, camera (parallax levels, drift, zoom through scales), depth of field and glow, text and labels through string tables, transitions, pre-render checks | three reference shots (dark, light, microscopic) |
| 2 | Motion and physics: intent curves, springs, simple rigs, particles, ropes, soft and rigid bodies, flocks, fluids; baking, caching, seed search, sound from impact events | one demo shot per layer |
| 3 | Library: generators (L-systems, procedural bodies, scattering), characters under the simple-forms rule, infographics | character and prop sheets |
| 4 | Pipeline: script → narration with word timings → shots → checks → render → subtitles; translation with re-render per language | a complete video |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Not specified yet. Third-party components keep their own licenses: skia-canvas (MIT), Skia (BSD-3-Clause), Rapier (Apache-2.0); ffmpeg is used as an external binary.

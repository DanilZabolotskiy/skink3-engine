# skink3-engine

A code-first engine for animated science-explainer videos in a flat-vector style. It draws crisp shapes lit automatically, with dark saturated palettes, depth of field and glow, and computes their motion with physics at 60 fps. Scenes are TypeScript, written by people or by LLM agents. Skia draws the frames on the GPU without a browser, and they are piped straight into ffmpeg.

> **Status: pre-alpha, phase 0 done (November 2026).** The first engine code is in: a vertical slice through the whole path (scene → look and light → motion → physics bake → camera → render → ffmpeg) and a 15-second demo shot that goes through it. Every layer is real but minimal; what is built and what is only planned is listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The roadmap is at the end of this file.

## Why

In this genre, every movement on screen is usually keyframed by hand by a team of animators: anticipation, arcs, overshoot, parts that lag behind, soft impacts, everything a little slower than real life. The engine computes that motion instead of asking anyone to key it:

- **Intent → motion.** A scene says *what* happens ("this node moves there at 6.5 s"). The engine adds what an animator would: a short anticipation, a curved path, overshoot and settle, parts that lag behind on springs, staggered reactions of neighbours, idle drift.
- **Physics where it helps.** Rigid bodies and particles today; soft bodies, ropes, flocks and simple fluids are planned. All of it is deterministic and tuned for readability rather than realism (lower gravity, more drag, softer impacts).
- **Light, not drawing.** One light per shot. The engine builds shadow crescents (a shape minus its shifted copy), lit rims, highlight strokes, stacked shadows and glow from the shape itself.

## Principles

1. **Deterministic.** Frame *n* is a pure function of the scene, the bake cache and *n*. Everything stateful (physics, particles, springs) is baked beforehand with fixed seeds. Any frame can be rendered alone, chunks render in parallel, and a re-render matches pixel for pixel.
2. **Simple forms, flawless motion.** Drawing must be perfect, so motion must be bug-free. The engine avoids objects whose motion viewers know precisely and would instantly judge as wrong. Humanoid limbs are rounded sticks with no hands, fingers or feet, and there are no human limb mechanics (stepping, grasping, gestures). The API has no such parts, so they cannot be drawn by accident. See [docs/PRINCIPLES.md](docs/PRINCIPLES.md).
3. **Text is data.** Scenes never contain on-screen text, only keys into per-language string tables. Labels size and wrap themselves to the string, and a pre-render check reports overflow and overlaps in every language.
4. **Measured look.** Palette and motion norms are numbers (share of dark pixels, saturation of shadows, camera drift, static-frame share) checked by `tools/metrics` on renders.

## Stack

| Layer | Choice | Version |
|---|---|---|
| Language and runtime | TypeScript run directly by Node (built-in type stripping, no build step); `tsc --noEmit` as a check | Node 26, TypeScript 7.0.2 |
| Drawing | [skia-canvas](https://github.com/samizdatco/skia-canvas) — Skia with a Canvas 2D API, GPU (Vulkan/Metal) or CPU | 4.0.0 |
| Rigid bodies | [Rapier 2D](https://rapier.rs), cross-platform deterministic build | `@dimforge/rapier2d-deterministic-compat` 0.21.0 |
| Particles, springs | own code in TypeScript | — |
| Soft bodies, ropes, fluids, flocks | planned: own solvers (XPBD, PBF, boids) in TypeScript | — |
| Video | ffmpeg (x264 by default, NVENC as an option) | 9.x |
| Growth path | a Rust addon (napi-rs) over skia-safe for SkSL shaders, D3D12 and hot physics loops — only where profiling demands it | — |

Why this stack and what was rejected: [docs/STACK.md](docs/STACK.md).

## Quick start

Requirements: Node 26 or newer, ffmpeg on `PATH` (for `render` only).

```
npm ci
npm run check                                             # tsc, unit tests, scene checks of the demo
node bin/skink3.mjs still examples/demo/scene.ts --frame 450     # one frame       -> out/demo/still_00450_en.png
node bin/skink3.mjs sheet examples/demo/scene.ts                 # contact sheet   -> out/demo/sheet_en.png
node bin/skink3.mjs strip examples/demo/scene.ts --from 388 --count 24 --step 3    # motion strip
node bin/skink3.mjs render examples/demo/scene.ts                # 15 s, 1080p60   -> out/demo/demo_en.mp4
node bin/skink3.mjs render examples/demo/scene.ts --lang x-long  # the same shot in the pseudo-locale
```

`node bin/skink3.mjs help` lists every command and option. Output goes to `./out`, the bake cache to `./cache`, both under the directory the command is run from.

How to write a scene: [docs/SCENES.md](docs/SCENES.md). The smallest one is [examples/minimal/scene.ts](examples/minimal/scene.ts).

### Using the engine from another repository

Productions live in their own repository and depend on a checkout of this one:

```
# in the production repository, next to a checkout of skink3-engine
npm install --save-exact ../skink3-engine      # adds "skink3-engine": "file:../skink3-engine"
npx skink3 check scenes/my-shot.ts
npx skink3 still scenes/my-shot.ts --frame 120
```

Scene modules import from the package name (`import { shot, circle } from 'skink3-engine'`). Two things to know:

- Run `npm ci` in the engine checkout as well: the engine's own dependencies are resolved from there.
- npm links a `file:` directory instead of copying it, and that is required: Node does not strip types from files inside `node_modules`, so a copied engine (`npm install --install-links`) will not load.

## Demo shot

`examples/demo/scene.ts` is 15 seconds of neutral content: a glowing source wakes up a small network, pulses travel along the links, a blob creature drifts in, the network rearranges itself, and a handful of pieces tumble into a tray while the camera drifts and pushes in. Measured on November 15, 2026 (Ryzen 7 9700X, RTX 5070 Ti, Vulkan):

| What | Result |
|---|---|
| Bake (17 rigid bodies, 8 springs, 8 emitters, 900 frames) | 0.17 s |
| Render, 1920×1080, 900 frames, 8 worker processes, GPU, x264 | 5.2 s (about 172 frames/s) |
| Same with 1 worker process | 7.2 s (125 frames/s) |
| Same with 8 worker processes on the CPU (`--cpu`) | 16.1 s (56 frames/s) |
| Bake in two separate processes | identical cache hash |
| Frames 0, 450, 899 alone vs inside the full render | identical raw RGBA hashes |
| 1 worker vs 8 workers | identical hashes for all 900 frames |

The GPU path is bit-exact on one machine and driver; it is not expected to match the CPU path or another GPU bit for bit.

The look of the rendered mp4, measured with `tools/metrics` (tone numbers from 30 frames sampled every 0.5 s, see [docs/METRICS.md](docs/METRICS.md#short-clips)):

| Metric | Target | Demo shot |
|---|---|---|
| Camera drift, median | 0.3–0.7 px per frame at 1080p | 0.38 |
| Duplicated frames in motion | none | 0 of 790 |
| Fully static frame pairs; longest hold | 3–9 % over a whole video; no hold above ~4 s | 0.0 %; 0.0 s (one continuously moving shot, no cuts) |
| Pixels with L* < 30 | about 60 % on dark shots | 61.0 % |
| Saturation of dark pixels | about 0.8 | 0.80 |
| Near-gray pixels (S < 0.12) | about 6 % or less | below 0.1 % |
| Hue of dark pixels | mostly 210–300° | 99 % (210–240°: 5 %, 240–270°: 85 %, 270–300°: 9 %) |

## Benchmarks

Measured on November 15, 2026, with a Ryzen 7 9700X and an RTX 5070 Ti (Vulkan). The test frame of `bench/render.mjs` is deliberately heavier than an average shot. It has 532 shapes lit with boolean-op crescents, 5,000 particles, three depth layers with blur, a glowing ring with bloom, and text.

| What | Result |
|---|---|
| 4K frame, 1 process, GPU | 130 ms (64 ms of it raster + pixel readback) |
| Same frame, CPU | 320 ms |
| 4K, 8 processes | 45 frames/s |
| 1080p, 8 processes | 78 frames/s, so a 13-minute 60 fps video renders in about 10 minutes |
| Rapier 2D: 2,000 bodies, 4 substeps per frame | 8.5 ms/frame; identical state hash across processes |
| XPBD in JS: 11,200 points, 18,300 constraints, 8 iterations | 10.6 ms/frame |
| 100,000 particles in a force field | 3.2 ms/frame |

```
node bench/render.mjs 1920 gpu 20   # 1080p benchmark frame (writes frame_1920_gpu.png)
node bench/phys.mjs                 # rigid bodies, XPBD and particle timings
```

## Layout

| Path | What |
|---|---|
| `src/core` | time base (60 fps, 1/240 s simulation step), seeded random with named streams, easing, second-order dynamics, seeded noise, stable hashing |
| `src/shape` | circle, capsule, rounded convex polygon and blob as data and as paths; helpers over the path operations |
| `src/look` | colour math, palette by role with the law validator, automatic light (crescents, rim, highlight, glow numbers) |
| `src/scene` | scene description types, factory functions, compiler (validation, tracks, bake slots), pure evaluation of a frame |
| `src/motion` | intents (`moveTo`, `popIn`, `popOut`, `turnTo`, `bump`, `drawOn`, `pulse`), `stagger`, the curves behind them |
| `src/physics` | Rapier wrapper, particles, the bake and its on-disk cache |
| `src/camera` | drift, push-in, parallax view of a depth layer |
| `src/text` | string tables, bundled font, auto-fit layout, label geometry |
| `src/render` | frame compositing on Skia, review sheets, ffmpeg encoding, parallel chunk workers |
| `src/checks` | palette laws, string tables, text fit per language |
| `src/cli`, `bin/` | the `skink3` command |
| `examples/` | the demo shot and a minimal scene |
| `test/` | unit and determinism tests (`node --test`) |
| `assets/fonts/` | the bundled font family with its licence |
| `bench/` | drawing and physics benchmarks |
| `tools/metrics/` | style and motion metrics for any video — see [docs/METRICS.md](docs/METRICS.md) |
| `docs/` | principles, architecture, stack, scene authoring, metrics |

## Roadmap

| Phase | Scope | Done when | State |
|---|---|---|---|
| 0 | A 15-second test shot through the whole path: scene → light → physics bake → GPU render → ffmpeg | the shot reads as the target genre, and its metrics fall in the target ranges | **done** — see the demo shot above |
| 1 | Core picture: more node types, palettes from a mood, camera (spring follow, zoom through scales), bubbles, titles and counters, full script coverage with fallback fonts, transitions, motion norms as checks | three reference shots (dark, light, microscopic) | next |
| 2 | Motion and physics: more intents, simple rigs, ropes, soft bodies, flocks, fluids; kinematic hand-off, goal forces, seed search, sound from impact events | one demo shot per layer | planned |
| 3 | Library: generators (L-systems, procedural bodies, scattering), characters under the simple-forms rule, infographics | character and prop sheets | planned |
| 4 | Pipeline: script → narration with word timings → shots → checks → render → subtitles; translation with re-render per language | a complete video | planned |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Not specified yet for the engine's own code. Third-party components keep their own licenses: skia-canvas (MIT), Skia (BSD-3-Clause), Rapier (Apache-2.0); ffmpeg is used as an external binary. The bundled font is Nunito, copyright The Nunito Project Authors, under the SIL Open Font License 1.1 ([assets/fonts/nunito/OFL.txt](assets/fonts/nunito/OFL.txt)).

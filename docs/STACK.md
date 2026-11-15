# Stack and why

## Requirements

- Vector quality on par with Skia: boolean path ops, rounded corners, trim paths, gradients, large Gaussian blur per depth layer, blend modes.
- Real physics: rigid bodies, soft bodies, ropes, simple fluids, tens of thousands of particles.
- 60 fps at up to 4K: tens of thousands of frames per video.
- Any single frame on demand, for automated review.
- Scenes written as code by LLM agents.
- Permissive licenses.

## Choice

| Layer | Choice | Version, license |
|---|---|---|
| Language and runtime | TypeScript on Node (built-in type stripping), `tsc` for checks | Node 26 |
| Drawing | skia-canvas: Skia via the skia-safe crate with a Canvas 2D API; GPU through Vulkan (Windows, Linux) or Metal (macOS); CPU fallback | 4.0.0, MIT |
| Rigid bodies | Rapier 2D, deterministic build ("cross-platform deterministic execution") | `@dimforge/rapier2d-deterministic-compat` 0.21.0, Apache-2.0 |
| Other physics | own XPBD, PBF and boids in TypeScript; Rapier 0.36 soft bodies (ropes, cloth; September 2026) to be evaluated in phase 2 | — |
| Encoding | ffmpeg: NVENC for drafts, x264/x265 for masters | 9.x |

### What skia-canvas 4.0 gives us (verified)

- `canvas.engine` reports the backend, for example `{renderer: "GPU", api: "Vulkan", device: "Discrete GPU (NVIDIA GeForce RTX 5070 Ti)"}`.
- `Path2D` operations:
  - booleans: `union`, `difference`, `intersect`, `xor`, `complement`;
  - shaping: `simplify`, `round` (corner rounding), `trim`, `interpolate` (morphing), `jitter`;
  - measuring: `points`, `positionAt`, `tangentAt`, `normalAt`, `slice`, `transform`.
- `ctx.outlineText()` turns text into a path.
- `ctx.filter` supports blur and drop-shadow. `globalCompositeOperation` and `drawCanvas` let a layer be drawn as an image through a filter.
- `toBuffer('raw')` returns RGBA pixels for ffmpeg. `Window` and `App` give an on-screen preview.
- Not available:
  - SkSL runtime shaders;
  - path inflate or deflate (`offset` only translates; layered outlines are strokes clipped to the shape);
  - a D3D backend.
- It is maintained by a single person.

### Growth path

Some features may need more than skia-canvas offers: custom shaders, D3D12, or faster physics loops. In that case a Rust addon (napi-rs 3.x) over skia-safe 0.157 takes them over. skia-safe has prebuilt Windows binaries, `RuntimeEffect` (SkSL) and `textlayout`. The engine API stays the same.

## Benchmarks

See the README. In short, a deliberately heavy 4K frame takes 130 ms on the GPU in one process, and eight processes reach 45 frames/s at 4K and 78 frames/s at 1080p. Rapier with 2,000 bodies runs 2× faster than real time with identical results across processes.

## Rejected

| Option | Why not |
|---|---|
| Browser-based (Remotion, Motion Canvas, Revideo) | Every frame is captured from a page, which is the main bottleneck at 60 fps and 4K. Remotion needs a paid company license above 3 employees and forbids selling derivatives. Motion Canvas has had no code changes since February 2025. |
| Godot 4.7 | Curves become polygons. Movie Maker renders frames only in order and only with a window (windowless rendering is an open PR). There are no 2D soft bodies in core, and particles are not promised to be bit-exact. |
| Blender 5.x | A 3D workflow for a flat style, slow at 4K, scenes heavy for agents to author (though it has an XPBD node in Geometry Nodes). |
| Vello | All three renderers are pre-1.0; blur and complex filters are missing or panic; no boolean path ops. |
| Own Rust core from day one | 2–3× more work up front; the benchmarks show the extra speed is not needed yet. It stays the growth path. |
| After Effects | Mouse-driven, not code; agents cannot drive a project reliably. |

Sources (checked November 15, 2026):

- skia-canvas: https://github.com/samizdatco/skia-canvas/tree/main/docs/api
- skia-safe: https://github.com/rust-skia/rust-skia
- Rapier determinism: https://rapier.rs/docs/user_guides/rust/determinism
- Rapier changelog: https://github.com/dimforge/rapier/blob/master/CHANGELOG.md
- Remotion license: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- Godot Movie Maker: https://docs.godotengine.org/en/stable/tutorials/animation/creating_movies.html
- Godot windowless-rendering PR: https://github.com/godotengine/godot/pull/94530
- Vello: https://github.com/linebender/vello

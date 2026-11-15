# skink3-engine — rules for Claude

This is the **public** engine repository. Read `README.md` and `docs/PRINCIPLES.md` first.

## Must

- **General code only.** No channel names, series, episodes, video topics, scripts, characters of a specific production, or decisions of a specific production. Those live in the private production repository that depends on this engine. Examples and test scenes use neutral content.
- **English only:** code, comments, docs, commit messages. The one exception is test fixtures that check non-Latin script rendering, which must say so in the file name.
- **Agents run on Fable 5.2 at effort xhigh:** every Agent call uses `model: "fable"`, `effort: "xhigh"`, and definitions in `.claude/agents/` use `model: fable`, `effort: xhigh`.
- **Principles are binding** (`docs/PRINCIPLES.md`):
  - simple forms (no hands, fingers or feet; no human limb mechanics; the API has no such parts);
  - determinism (frame *n* is a pure function of scene, bake cache and *n*; fixed seeds; pinned versions);
  - text is data (no on-screen text in scene code, only string-table keys; layout fits any length);
  - light from the shape;
  - measured look.
- **No third-party footage, frames or brand assets** in the repository. Metrics tools may analyse any video, but only our own renders and numbers are committed.
- **Pin dependency versions exactly.** The physics bake cache is keyed by engine and physics versions.
- **Commit explicit paths only:** no `git commit -a` and no `git add -A`.
- **Before every push:** search the diff for production-specific names, non-English prose, personal data, keys and file paths of a specific machine.

## How to work

- Previews render at 1920×1080, 60 fps. 4K masters are rendered only on explicit request.
- Run the checks before any render. Review with stills, strips and contact sheets rather than full renders.
- Keep scratch files out of the repo; `out/` and `cache/` are ignored.

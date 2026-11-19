# Physics review

In short: [QUICK-REFERENCE.md](QUICK-REFERENCE.md#reading-the-reviews) has one line for every kind of finding, with what it usually means and the usual fix, and how to mark what is meant. This guide is the full text: open it at the section a question needs.

How to judge whether the simulation of a shot is sound without watching the video. It is the sibling of the [motion review](MOTION-REVIEW.md): that one asks whether things move well, this one asks whether the rigid bodies behave like solid things. This guide is for whoever reviews a scene, a person or an agent.

The review reads the bake: the pose of every rigid body at every frame, the springs and the particles. It draws nothing and takes a fraction of a second, so it runs with every `skink3 check`. It gives a reviewer:

1. **Findings**: checks of the simulation, as text and as JSON.
2. **Pictures** of the worst findings: a close-up of the frames, a ghost trail or a speed graph, whichever shows that kind of finding.

## Commands

```
skink3 physics <scene> [--pictures [--top 3]]       the report: text on the terminal, JSON in out/<shot>/physics.json
skink3 check   <scene>                              also shows the findings in short form
```

- `physics` prints a summary of the shot, then the findings grouped by body, the worst first. It writes the complete report to `out/<shot id>/physics.json`. Findings are warnings: the command always exits with 0.
- `physics --pictures` also writes pictures of the worst findings (three unless `--top` says otherwise) to `out/<shot id>/physics/`.
- `check` shows the count by kind and the worst five findings, and points to `physics`. Generated bodies with the same kind of finding take one line. They never fail the checks.
- For any body, `skink3 trail <scene> --node <id>` and `skink3 graph <scene> --node <id>` of the motion review draw its path and its speed.

```
node bin/skink3.mjs physics examples/demo/scene.ts
node bin/skink3.mjs physics test/fixtures/defects/scene.ts --pictures
```

The demo shot has no findings. `test/fixtures/defects/scene.ts` is a small shot with defects planted in it, kept for the tests of the command line; it shows what a report looks like.

## The report

```
physics defects: 240 frames (4.00 s); 4 rigid bodies (3 dynamic, 1 fixed), 0 springs, 0 emitters; gravity 540
bodies: deepest overlap 30.47 px ("host" and "inside", f61); fastest 10.2 px per frame ("roller", f193); 1 still travelling at the end (the fastest, "roller", at 13.31 px per frame, out of sight)
2 warning(s): 1 overlap, 1 escape

roller
  escape        f141-239 (2.35-3.98 s)  950 px below the lowest fixed body at the end of the shot and still falling at 13.8 px per frame; it last lay on something at frame 120 (2.00 s) and passed below everything at frame 141  [949.982 against 40 px]
  usual fix for escape: widen the ground or add a wall where the body left; if it is meant to fall out of the picture, mark it as intended

host
  overlap       f61-87 (1.02-1.45 s)  sunk 30.5 px into "inside" at frame 61; deeper than 1.5 px for 27 frame(s), 27 in a row; it starts at the release of "inside" (frame 61), which was put inside "host"  [30.473 against 1.5 px]
  usual fix for overlap: if it starts at a release, the body is released inside another one or inside a wall: move its start. ...
```

The second line describes the simulation as a whole, findings or not: the deepest two seen bodies are in each other at any frame, the fastest a seen body travels, and the frame from which nothing travels any more. A reviewer reads from it how far the shot is from the limits.

Every finding has:

| Field | Meaning |
|---|---|
| `kind` | one of the kinds below |
| `subject` | the id of a rigid body; for `not-finite` also of a spring-driven node or of an emitter |
| `other` | the second body of a pair: what it is sunk into, what it passed through; otherwise null |
| `group` | more bodies the finding speaks for: the others of a pile that does not settle, the second wall of a gap |
| `from`, `to` | first and last frame; the text adds the seconds |
| `value`, `threshold`, `unit` | the measurement and the limit it is held against, in the same unit |
| `severity` | `value / threshold`; the report is sorted by it |
| `detail` | the measurement in words |
| `fix` | one line on what usually fixes it |
| `worst`, `at` | the frame at which it is worst and the place in units of the bodies' layer: where the pictures look |

The text report is capped: at most 12 bodies and 4 findings per body. Generated bodies whose ids differ only in digits and that have the same kinds of findings (`piece0` … `piece89`) are shown once, with the worst of them. The JSON report holds everything, together with the thresholds and the meaning of every kind. The same scene always gives the same report.

## The findings

| Kind | What it means | Usual fix |
|---|---|---|
| `overlap` | Two bodies are sunk into each other by more than 1.5 px for a tenth of a second or longer, or by a quarter of the smaller one (at least 4 px) for two frames. | If it starts at a release, the body is released inside another one or inside a wall: move its start. In a pile the load presses bodies together: pour slower or less, use fewer and larger bodies, or a wider container. |
| `tunnelling` | A body passed through a fixed body: it was outside it, and it is outside it again on another side. Or it passed between two fixed bodies through a gap narrower than itself. | Make the wall thicker, close the gap between the walls (let them overlap), or lower the load that pressed the body through: a slower or thinner pour, a lower release velocity. |
| `escape` | A body that lay on something is, at the end of the shot, below every fixed body and still falling: nothing is left for it to land on. | Widen the ground or add a wall where the body left. If it is meant to fall out of the picture, mark it as intended. |
| `jitter` | A body at rest swings back and forth by half a pixel or more, four times or more within half a second, while nothing near it travels. A turn counts like a move, by the travel of the body's edge. | Raise `physics.friction` or `physics.angularDamping`, or lower the restitution. A tall narrow stack of small bodies trembles more than a wide one of larger bodies. |
| `unsettled` | A pile (three or more bodies that touch, standing on a fixed body) still travels at the end of the shot, two seconds or more after the last body landed on it. One finding per pile: it names the fastest body and lists the others. | End the pour earlier or make the shot longer. Raise `physics.linearDamping`, `physics.angularDamping` or `physics.friction` so that sliding and rolling die out. |
| `energy-spike` | A body gains speed, or spin, that neither gravity nor anything it can have touched can have given. | Look just before the spike for bodies released inside each other or pressed into a wall: the solver throws them apart. Release them apart, slow the pour, or thicken what they are pressed against. |
| `unseen-hit` | The path of a seen body is bent, by 2 px per frame or more within a frame, while the only thing it can have touched is a dynamic body that is not drawn: one that is faded out, or has no size yet. To the eye it bounces off nothing. | A body collides from its release on, whether it is drawn or not. Release it when it appears, keep bodies that are faded out or have no size yet out of the way of the seen ones, or fade it out only where nothing can meet it. |
| `not-finite` | A baked position is not a number: the simulation broke down. Looked for in rigid bodies, springs and particles, the streaks of particles included. | Look for extreme values in the scene: a huge velocity or spin, a body far smaller or larger than the others, a spring with a very high frequency. |

Things that are legitimate and are not flagged:

- **The give of a contact.** Contacts are soft: a resting pile sinks into itself by a few tenths of a pixel, and an impact by a pixel or two for a frame or two.
- **A pile that takes an impact.** Where a body lands or slides, its neighbours rock for a moment. Swings count as a tremble only while nothing travels within three body widths.
- **A settle.** A body that comes to rest rocks back once or twice.
- **A hit.** A body struck by a faster one takes its speed, up to twice the speed of the striker. A release with a velocity and a spin, a free fall and a bounce are sound too.
- **A stream.** Bodies that never lie on anything, such as a pour that crosses the picture, are not expected to land, and without gravity nothing falls.
- **A flow.** One body that rolls along the ground is not a pile; it may still roll when the shot ends.
- **A way out.** A body that falls through a gap wider than itself took a way that was open.
- **What is not seen.** A body that is faded out, has no size or is outside the frame is not reported, whatever it does. Only broken numbers are reported regardless.
- **Walls that are not drawn.** A fixed body with `opacity: 0` is the usual way to give a container that is drawn by other shapes something to hold its contents. Resting on it, or bouncing off it, is not a hit by something unseen; only dynamic bodies count for that. A dynamic body that is merely outside the frame is a thing too.
- **A body that waits unseen for its release.** With `appear: 'release'` a body is not drawn until the solver takes it over. Before that it is not in the world: it touches nothing, so it is not a body that is not drawn, and the simulation is the same as without the option. From its release on it is judged like any other body.
- **Things that are not bodies.** A node moved by `travel`, `hop` or `moveTo`, and a content with a `level`, are not in the simulation: they pass through bodies without touching them, and nothing here speaks of them. Their motion is the motion review's.

### What applies to what

| | dynamic bodies | fixed bodies | springs | particles |
|---|---|---|---|---|
| overlap | against each other and against fixed bodies | as the other body | – | – |
| tunnelling | through fixed bodies and through the gaps between them | as what is passed | – | – |
| escape | yes, with gravity and at least one fixed body | as the ground | – | – |
| jitter, energy-spike | yes | – | – | – |
| unseen-hit | seen ones, hit by ones that are not drawn | – | – | – |
| unsettled | piles of three or more that stand on a fixed body | as the support | – | – |
| not-finite | yes | yes | yes | yes |

Springs and particles have no contacts, so nothing but their numbers can break here. How a spring swings and how fast particles travel are questions of the motion review.

### How things are measured

- **px** is a pixel of a 1080p frame: a unit of the bodies' layer times the zoom of that layer at the frame.
- **The colliders** are worked out by the review itself, from the shapes of the scene, in plain arithmetic (`src/review/collide.ts`): a circle is a point with a radius, a capsule a segment with a radius, a rounded polygon the polygon moved inward by its corner radius, a blob its convex hull. The review does not ask the physics library, so it does not share its mistakes; a test holds the two against each other on hundreds of pairs.
- **Depth** of an overlap is the shortest move that would part the two shapes.
- **From its release.** A body is looked at from the first frame at which the solver owns it. Before that it stands where the scene put it and collides with nothing.
- **Seen.** A body counts while it is at least 5 % opaque, has a size and reaches into the frame.
- **Rest and travel.** A body travels when it has moved more than 0.15 px per frame over half a second. A tremble has no travel over that span; a slide has.
- **A pile** is bodies that touch (surfaces within 0.75 units). It stands when one of them touches a fixed body.
- **Passing through** is judged on a point inside the body (its centre): the body was outside the fixed body, its centre was inside or crossed it between two frames, and it is outside again, with the straight line between the two outside places running through the fixed body. In and back out on the same side is an overlap, not a passage.
- **A gap** is the nearest place between two fixed bodies. A body cannot pass it when the largest disc inside the body is wider than the gap.
- **Speed that nothing gave.** The speed of a body at a frame is held against what it had in the two frames before, what gravity adds, and twice the speed of the fastest body it can have touched in those frames, directly or through others. The first frames after a release hold the release itself and are left out.
- **A hit by something unseen.** The change of a body's velocity from one frame to the next, less what gravity adds, while within those two frames it was near no fixed body and no drawn body, but near a dynamic body that is not drawn.

## Thresholds

All of them live in `src/review/physics-thresholds.ts`, with the reason for each value. The JSON report carries the table. They were set on the engine's demo shot and on shots with piles of up to 540 bodies.

| Name | Value | Unit | Why |
|---|---|---|---|
| `seenAlpha` | 0.05 | opacity | Below this opacity a body is too faint for a defect of it to be seen. What happens unseen is not reported; only broken numbers are, wherever they are. |
| `touchUnits` | 0.75 | units | Bodies whose surfaces are this near touch: the solver keeps resting contacts within a fraction of a unit. Touching bodies form one pile. |
| `overlapPx` | 1.5 | px | Contacts are soft: a resting pile sinks into itself by a few tenths of a pixel, an impact by more for a frame or two. Past a pixel and a half an edge is seen to cut into its neighbour. |
| `overlapFrames` | 6 | frames | A tenth of a second. A shorter overlap of this depth is the give of an impact and reads as a squash. |
| `overlapDeepShare` | 0.25 | share of the smaller body | Sunk in by a quarter of the half-width of the smaller body, two shapes read as one inside the other, even for two frames. |
| `overlapDeepPx` | 4 | px | A deep overlap must still be large enough to see on small bodies. |
| `tunnelPx` | 2 | px | The straight line from where a body was outside a fixed body to where it is outside again must run at least this far inside it; less is a graze of a corner. |
| `escapePx` | 40 | px | A body this far below the lowest fixed body has nothing left to land on. |
| `restPx` | 0.15 | px per frame | Slower than this, measured over half a second, a body reads as standing still (9 px per second). The same limit as in the motion review. |
| `restFrames` | 30 | frames | Half a second: the span over which the travel of a body is taken to tell rest from motion. A tremble has no travel over it; a slide has. |
| `jitterPx` | 0.5 | px | A body that swings back and forth by half a pixel or more makes its edges shimmer; below that the anti-aliased edge hides it. |
| `jitterTurns` | 4 | reversals | A body that settles rocks back once or twice. Four reversals within the window is a tremble, not a settle. |
| `jitterFrames` | 30 | frames | Half a second: the window in which the reversals are counted. All of it must be calm: neither the body nor anything near it travels. |
| `jitterClear` | 6 | x its own radius | A pile rocks for a moment where a body lands or slides: nothing may travel within three body widths for a swing to count as a tremble. |
| `jitterStepPx` | 0.05 | px | A step smaller than this is the noise of 32-bit positions, not a move; it does not count as a reversal. |
| `settleSeconds` | 2 | s | Time a pile is given after the last body landed on it. The piles of the examples are at rest within a second and a half. |
| `spikePx` | 2 | px per frame | A gain of speed of 120 px per second that neither gravity nor anything touching the body can have given is a visible kick. |
| `spikeBounce` | 2 | x the speed of the fastest body in touch | The most a body can take from a hit: a light body struck by a heavy one leaves at twice the speed of the striker, if nothing is lost. |
| `hitPx` | 2 | px per frame | A change of velocity of 120 px per second within a frame is a visible kink in the path of a body. When the only thing in touch is not drawn, it is a bounce off nothing. |
| `reportSubjects` | 12 | subjects | The text report shows the worst subjects; the JSON file holds everything. |
| `reportPerSubject` | 4 | findings | Findings shown per subject in the text report. |
| `checkWorst` | 5 | findings | Findings that `skink3 check` shows before it points to `skink3 physics`. |
| `pictureSubjects` | 3 | subjects | Pictures written by `skink3 physics --pictures`, unless a number is given. |

## Reading the pictures

`physics --pictures` draws what shows the kind of finding. Of generated bodies with the same kind of finding only the worst is drawn.

| Kind | Picture | How to read it |
|---|---|---|
| `overlap` | a close-up of four frames around the deepest moment | The same part of the stage, enlarged, in every tile; the stamp gives the frame and the enlargement. The body is ringed in blue, the other body in orange. Two outlines that cross are the overlap. A fixed body larger than the picture gets no ring: it is the wall or the floor in view. |
| `tunnelling`, `escape`, `energy-spike`, `unseen-hit` | a ghost trail of the body, and a close-up | The trail is the one of the motion review: a line through a wall is a passage, a path that leaves the frame downward an escape, a gap much wider than its neighbours a kick, a bend in mid-air a hit. In the close-up of a hit the orange ring shows where the body that is not drawn is. |
| `jitter`, `unsettled` | a speed graph of the body | The graph is the one of the motion review, with the finding marked in yellow. A body at rest is a line at zero. A tremble lifts the line off zero for as long as it lasts: a flat step when the body flips every frame, a train of small humps when it rocks more slowly. A pile that does not settle is a line that stays above zero to the right edge. |

A close-up of any bodies at any frames is `renderCloseUp` (see Programmatic use).

## Marking an intended exception

Sometimes a finding is what the author wants: crumbs that fall out of the picture, a soft thing that is meant to sink into another. Mark it in the scene, with the reason, exactly as for the motion review:

```ts
import { intended, shot } from 'skink3-engine';

export default shot({
  // ...
  intended: [
    intended(crumbIds, 'escape', 'the crumbs fall out of the picture'),
    intended('cushion', 'overlap', 'things sink into the cushion', { from: 4, to: 9 }),
  ],
});
```

- `intended(nodes, kind, reason, window?)`: one id or an array of ids, the kind of finding, one line that says why, and optionally a window in seconds.
- A finding on a pair of bodies is covered by naming either of them. A finding on a pile names its fastest body, which can be any of them: name all the bodies of the pile.
- Covered findings are left out of the warnings. The report lists every exception it honoured, with its reason and the number of findings it covers.
- An exception that covers nothing is reported as **unused**. Remove it.
- An exception must name a node that exists, or the shot does not compile. It changes nothing in the picture and nothing in the bake.
- Each review counts its own exceptions: one for `escape` is never listed as unused by the motion review.

## A review routine

1. `skink3 physics <scene> --pictures`. Read the line about the bodies, then the findings from the top.
2. For each finding, open its picture. Decide: a defect, or intended.
3. Fix defects in the scene: the fix line says where to look. Mark what is intended with `intended()` and a reason.
4. Run it again. A reviewed shot has no warnings, and every exception it lists is one you would defend.

## What the review cannot tell

- **Whether what is drawn is what collides.** The review sees colliders. A container drawn by shapes that are not bodies, around invisible fixed bodies, may be drawn larger or smaller than what the bodies rest against. So may a body whose children reach past its own shape, or one that pops or bumps: its picture changes size and its collider does not. Look at a still.
- **Whether a stream was meant to land.** A body that never touches anything is taken as a stream. A pour that misses its container looks the same to the review.
- **Bodies that drift away without gravity.** Nothing falls there, so nothing escapes.
- **What happens between two frames, other than a passage.** The bake holds 60 poses per second and the solver takes 240 steps. An overlap that begins and ends within a frame is not seen, and would not be seen on screen either.
- **What is hidden behind what.** A body behind a cover counts as seen while it is opaque and in frame. Mark what happens there as intended.
- **A body that rests on one that is not drawn.** Only a bend in a path is reported as a hit. A seen body that lies still on an unseen one, or is carried along by it, hangs in the air without a finding.
- **Weight and taste.** Whether a fall is too fast for its size, or a pile too stiff: that is for the motion review and for a person.
- **The limits themselves.** A finding close to its limit is a question, not a verdict; the numbers in the report say how close it is.

## When the physics changes

**The physics checks grow with the physics.** Any change to the physics of the engine updates this review and its tests in the same piece of work:

| Change | What follows here |
|---|---|
| a new kind of body or collider (a joint, a soft body, a rope, a compound shape) | `src/review/collide.ts` learns its geometry, and the test that holds the review against the physics library covers it |
| a new solver or a new kind of simulated thing (fluids, flocks, particle collisions) | the detectors that apply are extended to it, and the failure modes that are new get a kind of finding of their own |
| a new constraint or setting that changes what is sound (a kinematic hand-off, a goal force, restitution above 1) | the detectors that it makes wrong are corrected, and a sound scene that uses it joins the tests |
| a new source of speed (a force field, a motor, wind on bodies) | the energy check learns it, so that it is not reported as speed from nowhere |
| a new way for a body to be drawn or not (as `appear: 'release'`: not drawn before its release) | what counts as seen follows it, and a sound scene and a planted defect with it join the tests |

Each such change comes with a planted defect that the review catches and a sound scene that it leaves alone, in `test/physics-review.test.ts`, and with the rows of this guide that it changes; a new kind of finding also gets its line in [QUICK-REFERENCE.md](QUICK-REFERENCE.md#reading-the-reviews). A kind of finding without a test that plants its defect is a blind spot; a finding on a sound shot is a false one. Both are bugs of the review.

## Programmatic use

```ts
import { compileShot, bakeShot, reviewPhysics, formatPhysicsReport, physicsPictures, renderCloseUp, sampleMotion } from 'skink3-engine';

const c = compileShot(spec);
const bake = await bakeShot(c);
const report = reviewPhysics(c, bake);                    // synchronous, draws nothing
console.log(formatPhysicsReport(report));
const pictures = await physicsPictures(c, bake, sampleMotion(c, bake, { particles: false }), report, { count: 3, gpu: true, lang: 'en' });
const close = await renderCloseUp(c, bake, { bodies: ['piece12', 'piece31'], frames: [410, 412, 414], lang: 'en', gpu: true });   // PNG bytes
```

`runChecks(c, bake, langs, { physics: true })` adds the report to the checks. `PHYSICS_THRESHOLDS` and `PHYSICS_KINDS` are the tables the report carries.

# Motion review

How to judge the smoothness of motion without watching the video. This guide is for whoever reviews a scene, a person or an agent. An agent can read text and look at still images; it cannot watch a video play. The engine knows the exact state of every node at every frame, so it gives a reviewer two things instead:

1. **Findings**: motion checks computed from the scene, as text.
2. **Pictures in which time is visible**: ghost trails and speed graphs.

Nothing here needs a rendered video.

## Commands

```
skink3 motion <scene> [--pictures [--top 3]]        the report: text on the terminal, JSON in out/<shot>/motion.json
skink3 trail  <scene> --node <id[,id...]>  [--from <frame>] [--to <frame>] | [--time <s,s>]  [--every <k>] [--space stage|screen]
skink3 graph  <scene> --node <id> | --camera        [--from <frame>] [--to <frame>] | [--time <s,s>]
skink3 check  <scene>                               also shows the findings in short form
```

- `motion` prints a summary line, then the findings grouped by subject, the worst first, then one line per spring. It writes the complete report to `out/<shot id>/motion.json`. Findings are warnings: the command always exits with 0.
- `motion --pictures` also writes a trail and a graph for the worst subjects (three unless `--top` says otherwise) to `out/<shot id>/motion/`. One command gives the list of problems and the pictures of them.
- `trail` draws one picture: `out/<shot id>/trail_<ids>_<from>-<to>.png`. Without a window it takes the frames in which the nodes move.
- `graph` draws one picture: `out/<shot id>/graph_<id>.png`. Without a window it shows the whole shot.
- `--from` and `--to` are frames, as in `strip` and `render`; `--time 6.5,7.8` gives the same window in seconds.
- `check` shows the count by kind and the worst five findings, and points to `motion`. They never fail the checks.

```
node bin/skink3.mjs motion examples/demo/scene.ts --pictures
node bin/skink3.mjs trail examples/demo/scene.ts --node n2 --time 6.4,8
node bin/skink3.mjs graph examples/demo/scene.ts --node buddy-ant-l --time 3.5,6
node bin/skink3.mjs graph examples/demo/scene.ts --camera
```

## The report

```
motion demo: 900 frames (15.00 s); 64 placed nodes, 17 of them rigid bodies, 8 springs, 8 emitters, 7 links
camera: median drift 0.72 px per frame at depth 0, zoom 1 to 1.07
5 warning(s): 4 jump, 1 too-fast

buddy-ant-r (capsule, sway spring, in "buddy")
  jump          f253-255 (4.22-4.25 s)  rotation (travel of its edge): turned by 196.4 px within two frames (253 to 255); the steps around are at most 3.4 px  [196.351 against 4 px in two frames]
  usual fix for jump: look at the keys at that moment: ...

springs: 8 spring-driven node(s), 8 responded
  buddy-ant-l (sway, f 2.1, z 0.22, r 0): 3 response(s); at most: lag 194.4 px, overshoot 80.7 px, 7 visible swing(s), swinging for 1.37 s, settled after 1.67 s
```

Every finding has:

| Field | Meaning |
|---|---|
| `kind` | one of the kinds below |
| `subject` | a node id; `(camera)`; `(frame)` for the whole frame; `(frame:top-left)` and so on for one of its six regions |
| `channel` | what changed: `position`, `rotation`, `scale`, `opacity`, `particles`, `pulse`, `spring`, `hold` |
| `from`, `to` | first and last frame; the text adds the seconds |
| `value`, `threshold`, `unit` | the measurement and the limit it is held against, in the same unit |
| `severity` | `value / threshold`; the report is sorted by it |
| `detail` | the measurement in words |
| `fix` | one line on what usually fixes it |

The text report is capped: at most 12 subjects and 4 findings per subject. Generated nodes whose ids differ only in digits and that have the same kinds of findings (`item0` … `item39`) are shown once, with the worst of them. The JSON report holds everything, together with the thresholds and the meaning of every kind. The same scene always gives the same report.

## The findings

| Kind | What it means | Usual fix |
|---|---|---|
| `jump` | Position, rotation, size or opacity changes between two frames out of line with the frames around it: a teleport or a pop. Also a jump spread over two frames, a flicker (away and back), and a link that appears within a frame because its end node starts to pop in. | Look at the keys at that moment: two keys at once, a duration shorter than a frame, a wrong target. To change place unseen, do it while the node is hidden (`popOut`, then `popIn`) or faded out. Draw a link on (`drawOn`) after its nodes have arrived. |
| `abrupt-start` | A move that is at its peak speed within two frames of rest: there is no ease-in. | Give it an anticipation or an overshoot above 0. With both at 0 a `moveTo`, `turnTo` or `scaleTo` is a plain ease-out, which starts at full speed. Or lengthen the move. |
| `abrupt-stop` | A move that is still at its peak speed two frames before it rests: it runs into its place. | Use an eased intent, lengthen the move, or let it overshoot and settle. |
| `mechanical` | A move between two rests at constant speed over at least 70 % of its length. | Replace it with an eased move. If it is meant as a flow, let it enter and leave the frame instead of resting in view. |
| `too-fast` | The node travels at least half of its own size per frame, and at least 6 px, for a tenth of a second or longer. There is no motion blur, so it strobes at 60 fps. For an emitter: most of its particles in frame do. For a link: a pulse crosses it in fewer than 9 frames. | Slow it down or make it larger: a longer move, a lower release velocity or gravity, more drag; for particles a lower speed or a larger size. |
| `spring-ringing` | A spring still swings visibly more than 2.5 s after its target came to rest. | Raise its damping `z` or its frequency `f`. |
| `spring-no-overshoot` | A spring that is set to bounce (`z` of 0.4 or less) lagged at least 10 px and then came to rest without passing its place by a visible amount. It reads as lag, not as a spring. | Lower `f` so that it lags more, or lower `z`; or use a preset that says what you get (`light`, `heavy`); or drop the spring. |
| `dead-area` | Nothing moves on its own in the whole frame for more than 4 s, or in one of its six regions for more than 6 s. | Give something there a life of its own: an idle wander, a pulse, particles that cover the area, or an action staged there. |

Things that are legitimate and are not flagged:

- **Flows at constant speed**: the drift of the camera, a pulse running along a link, particles in flight, a body that rolls, and anything that enters, leaves, appears or vanishes while it moves. Only a move that rests in view at both ends can be mechanical.
- **Kicks**: a `bump`, and any other sudden excursion that comes back by half within a third of a second. A hit starts suddenly; that is the point.
- **Pops**: a node that grows from nothing or shrinks to nothing is not checked for ease at that end.
- **Short holds**: under 4 s for the frame, under 6 s for a region.

### What applies to what

| | timeline nodes | rigid bodies | particles | links | camera |
|---|---|---|---|---|---|
| jump | yes | size and opacity only | – | appearing or vanishing | yes |
| abrupt start, abrupt stop | yes | size only | – | – | yes |
| mechanical | yes | size only | – | – | no |
| too-fast | yes | yes | per emitter | pulses | no |
| dead-area | count as alive while they move | the same | the same | while a pulse runs or the link is drawn on | never counts |

A rigid body gets its place and its turn from the solver. A contact changes its velocity within a frame, a neighbour nudges it a few pixels at once, and a body that rolls at constant speed is a flow. So the place and the turn of a body are checked for strobing speed only. Its size and its opacity are animated by the timeline (`popIn`, `bump`, `fadeTo`) and are checked like those of any node. Children of a body are judged on their own tracks.

Whether the simulation itself is sound is a different question: bodies that sink into each other, jitter at rest, energy that appears from nowhere, tunnelling, fall speed against size. Those are physics checks. They are not built; the report has room for them (a finding is plain data with a kind, and kinds can be added).

### How things are measured

- **px** is a pixel of a 1080p frame.
- **Own motion.** A node is judged on what it does itself: its place, turn and size in the space of its parent, scaled to the screen. The camera is not in it, and neither is the motion of the parent. So a defect of a parent is reported once, on the parent, and not again on everything it carries. A label is measured against the node it points at, and a node on a `follow` spring against the origin of its parent.
- **Rotation and size** are measured as the travel of the node's edge in px, so that all three channels share one unit. A plain disc that turns shows nothing, so it has no rotation channel unless it carries something off its centre.
- **Seen.** A node counts while it is drawn, at least 5 % opaque, at least 2 px in radius and reaching into the frame. What happens while a node is hidden or outside the frame is not reported.
- **Too fast** is the only check in screen space: the step of a node on screen divided by its size along that step. A part is measured against its parent as the parent is turned at each moment, so a ball on a stick that whips round is caught, and a cap on a tower that grows is not.
- **Springs.** A response starts when the node leaves its rest place (where it would be without the spring) by 0.5 px and ends when it is back within it. Reported per response: the largest lag, the overshoot past the rest place, the number of visible swings (1 px or more) after the target stopped, how long it kept swinging, and when it settled.
- **Alive** means that something visible changes by itself: a node moves, turns, grows, fades or blinks, a pulse runs, a link is drawn on, a particle travels. A thing counts in every region that the circle around it touches. An area with nothing in it is dead too. The camera never counts: a picture that only slides is still a hold.

## Thresholds

All of them live in `src/review/thresholds.ts`, with the reason for each value. The JSON report carries the table. They are first settings, chosen from the engine's own curves and the look of the examples; they are not yet calibrated against measurements of reference videos.

| Name | Value | Unit | Why |
|---|---|---|---|
| `visibleAlpha` | 0.05 | opacity | Below this opacity a node is too faint for a defect in its motion to be seen. |
| `minRadiusPx` | 2 | px | A node smaller than this on screen is a dot; its motion is not judged. |
| `jumpPx` | 4 | px in one frame | A displacement of one frame below this reads as part of the motion, not as a tick. |
| `jumpRatio` | 4 | x the steps around it | A smooth curve sampled at 60 fps changes its step by a few percent per frame, and the hardest legitimate start (a bump) by a factor below 2; four times the largest step of the two frames on either side is out of line. |
| `jumpOpacity` | 0.34 | opacity in one frame | A third of full opacity in one frame is a pop: an eased fade has to be shorter than 5 frames to do that. |
| `restPx` | 0.15 | px per frame | Slower than this a node reads as standing still (9 px per second). |
| `restShare` | 0.15 | share of the speed reached | A node that idles a little is still at rest compared with the move it starts or ends. |
| `abruptPeakShare` | 0.9 | share of the peak speed | A move is abrupt when two frames after rest it is already at its peak speed, or two frames before rest it still is. The engine's eased curves reach 2 to 84 % in two frames, down to an 18-frame pop; a linear move or an ease-out reaches 100 %. |
| `abruptMinPx` | 3 | px per frame | A start or stop at less than this speed (180 px per second) is too gentle to read as a jolt. |
| `kickFrames` | 20 | frames | A kick is a sudden excursion that comes back: a bump, a hit. Its swell and return take under a third of a second. |
| `kickReturn` | 0.5 | share of the excursion | A sudden start that comes back by at least half within the kick window is a reaction, not a move. |
| `mechTolerance` | 0.1 | share of the speed | Speed within 10 % of the middle of a stretch counts as constant. |
| `mechMinFrames` | 10 | frames | A shorter stretch of constant speed cannot be told from the middle of a quick ease. |
| `mechMinPx` | 24 | px | A move shorter than this is too small for its speed profile to be read. |
| `mechMinSpeedPx` | 0.5 | px per frame | Slower than this a constant speed reads as a drift, which is legitimate. |
| `mechShare` | 0.7 | share of the move | Constant speed over most of a move between two rests is what reads as mechanical; the top of an eased move stays in that band for about a third of the move. |
| `fastRatio` | 0.5 | own size per frame | There is no motion blur. At half of its own size per frame, measured along the motion, successive images overlap by half and the motion starts to strobe; at 1 they separate. |
| `fastMinPx` | 6 | px per frame | Below this travel per frame (360 px per second) successive images lie too close together to come apart, however small the thing is. |
| `fastFrames` | 6 | frames | Sustained: a tenth of a second. A single fast frame is part of an impact or a pop. |
| `fastParticleShare` | 0.5 | share of the particles in frame | An emitter is flagged when most of its visible particles strobe, not for a few fast ones. |
| `fastMinParticles` | 4 | particles | Fewer particles than this are not a stream to judge. |
| `springMinResponsePx` | 4 | px | A deviation from the rest place smaller than this is idle wobble, not a response to report. |
| `springVisiblePx` | 1 | px | A swing smaller than a pixel is not seen. |
| `springSettlePx` | 0.5 | px | Within half a pixel of its rest place a spring has settled. |
| `springRingSeconds` | 2.5 | s | The bounciest preset swings visibly for about a second after a large move; a spring still swinging after 2.5 s holds the eye long after the action. |
| `springBouncyDamping` | 0.4 | damping z | A spring damped this lightly is there to bounce (the springy preset is 0.26, the tidy one 0.55). |
| `springClearResponsePx` | 10 | px | A bouncy spring that lagged this far and then never passed its rest place by a visible amount does not read as a spring. |
| `alivePx` | 0.1 | px per frame | Motion of its own slower than 6 px per second does not make a thing look alive. Camera motion is not counted. |
| `aliveOpacity` | 0.004 | opacity per frame | A fade slower than full range in four seconds does not read as change. |
| `holdSeconds` | 4 | s | Measured on reference videos: the longest hold of the whole frame is about 4 seconds. |
| `regionHoldSeconds` | 6 | s | A sixth of the frame may rest longer than the whole frame, but not for most of a shot. |
| `reportSubjects` | 12 | subjects | The text report shows the worst subjects; the JSON file holds everything. |
| `reportPerSubject` | 4 | findings | Findings shown per subject in the text report. |
| `checkWorst` | 5 | findings | Findings that `skink3 check` shows before it points to `skink3 motion`. |
| `pictureSubjects` | 3 | subjects | Trails and graphs written by `skink3 motion --pictures`, unless a number is given. |

## Reading a trail

A trail is one picture. The chosen nodes are drawn at every k-th frame over a dimmed frame of the scene: faint for the early frames, solid for the late ones. A thin line joins their origins, with a dot at every ghost and the frame number at a few of them. The stamp in the corner says which frames, which step and which space.

The spacing of the dots is the reading:

| You see | It means |
|---|---|
| dots that bunch up at both ends and spread in the middle | ease in and ease out |
| even spacing from the first dot to the last | constant speed: a mechanical move |
| wide spacing from the first dot, then closing up | no ease-in: an abrupt start |
| spacing that stays wide up to the last dot | no ease-out: an abrupt stop |
| a gap much wider than its neighbours | a jump |
| dots that pass the end and come back | overshoot and settle |
| ghosts that do not touch each other at `--every 1` | more than its own size per frame: it strobes |
| a line with a break | the node was hidden between those ghosts |

- **Space.** By default the camera is frozen at the last frame of the window (`stage`), so the spacing shows what the node itself does. `--space screen` puts every ghost where it is on screen at its own frame, camera included.
- **Framing.** The picture is cut to the path with a margin and enlarged up to four times, at most 1920 px wide. Where the path leaves the frame, a thin white line shows the edge of the frame.
- **Step.** `--every` sets k. Without it there are about 40 ghosts. For speed, use `--every 1` over a short window.
- **An emitter** leaves the trail of its particles: at `--every 1` every particle draws a row of dots. Dots that stand apart are particles that strobe.
- **Ghosts are drawn on top of the scene.** A trail does not show whether something in front hides the node. For that, look at a still or a strip of those frames.

## Reading a graph

A graph is one picture of one subject over time. The large panel is its speed in px per frame. Small panels below show whatever else changes on it: position, rotation, scale, opacity. Every panel has its own scale; the time axis at the bottom gives seconds and frames. A yellow band marks the frames of a finding, with its kind and frames above the first panel. A dark band marks frames at which the node is not drawn.

For a node that is attached to something, the speed panel has two lines: its speed on the stage with the camera frozen, and its speed against what it is attached to, which is what the strobing check measures.

| You see in the speed panel | It means |
|---|---|
| a hump that rises from zero and returns to zero | an eased move |
| a plateau with vertical sides | constant speed between two rests: mechanical |
| a vertical edge up, then a slope down | an abrupt start (a plain ease-out) |
| a slope up, then a vertical edge down | an abrupt stop |
| a single spike | a jump |
| a train of humps that die out | a spring settling; count the humps and read the time on the axis |
| a flat line above zero | a flow, or the drift of the camera |

In the small panels a jump is a step, a linear change is a straight ramp, an eased change is an S-curve, and an overshoot is a bump past the new level.

`graph --camera` shows the speed of the camera at depth 0, its position and its zoom. For an emitter the panels are the median speed of its particles in frame, their number, and the share of them that strobes.

## Marking an intended exception

Sometimes a finding is what the author wants: a thing that is shot out of a tube starts at full speed, sparks are meant to streak, a title card holds. Mark it in the scene, with the reason:

```ts
import { intended, shot } from 'skink3-engine';

export default shot({
  // ...
  intended: [
    intended('plug', 'abrupt-start', 'it is shot out of the tube'),
    intended(sparkIds, 'too-fast', 'sparks are meant to streak', { from: 4, to: 6 }),
    intended('(frame)', 'dead-area', 'the title card holds here'),
  ],
});
```

- `intended(nodes, kind, reason, window?)`: one id or an array of ids, the kind of finding, one line that says why, and optionally a window in seconds. Only findings of that kind on those subjects that overlap the window are covered.
- For the camera the subject is `'(camera)'`; for a hold of the whole frame `'(frame)'`, which also covers its regions; for one region `'(frame:top-left)'`, `'(frame:top-center)'`, `'(frame:top-right)'`, `'(frame:bottom-left)'`, `'(frame:bottom-center)'` or `'(frame:bottom-right)'`.
- Covered findings are left out of the warnings. The report lists every exception it honoured, with its reason and the number of findings it covers, so a reviewer still sees them.
- An exception that covers nothing is reported as **unused**: the defect is gone, or the exception names the wrong node or kind. Remove it.
- An exception must name a node that exists, or the shot does not compile.
- It changes nothing in the picture and nothing in the bake.

Mark an exception on the subject the finding names. A defect of a parent is reported on the parent.

## A review routine

1. `skink3 motion <scene> --pictures`. Read the summary line, then the findings from the top.
2. For each finding, open the trail and the graph of its subject. Decide: a defect, or intended.
3. Fix defects in the scene. Mark what is intended with `intended()` and a reason.
4. For a move the report does not name but that matters to the shot, draw its trail and its graph yourself and read the spacing.
5. Read the springs lines: a few swings and a settle time around a second is the usual look.
6. Run it again. A reviewed shot has no warnings, and every exception it lists is one you would defend.

## What these tools cannot tell

- **Whether the physics is plausible.** Bodies that sink into each other, jitter at rest, tunnelling and wrong weight are not looked at.
- **Taste.** Timing against the narration, whether a pause is too long for the story, whether a move is elegant. A clean report means there is no mechanical defect; it does not mean the motion is good.
- **Sound.**
- **What is hidden behind what.** The review does not know that a node is covered by another one. A jump or a start behind a cover is still reported; mark it as intended.
- **What it does not measure**: the pupils and lids of eyes, the drawing-on of a link, the shape of a link as its ends move, colour, glow, blur, and the look of text.
- **A fast spin.** Speed is judged on how far a node travels. A shape that spins fast in place is seen only through parts that ride on it off its centre.
- **The limits themselves.** They are first settings. A finding close to its limit is a question, not a verdict; the numbers in the report say how close it is.

## Programmatic use

```ts
import { compileShot, bakeShot, reviewMotion, formatMotionReport, renderTrail, renderGraph } from 'skink3-engine';

const c = compileShot(spec);
const bake = await bakeShot(c);
const { series, report } = reviewMotion(c, bake);        // series: every node at every frame; report: the findings
console.log(formatMotionReport(report, c));
const trail = await renderTrail(c, bake, series, { nodes: ['n2'], from: 384, to: 480 });   // trail.png
const graph = await renderGraph(series, { subject: 'n2', findings: report.findings });      // graph.png
```

`sampleMotion(c, bake)` returns the series alone: for every placed node its position, rotation, scale and opacity per frame in the space of its layer, with the view of every layer per frame to bring them to screen pixels, plus the series of the camera, the links, the emitters and the springs. `runChecks(c, bake, langs, { motion: true })` adds the report to the checks.

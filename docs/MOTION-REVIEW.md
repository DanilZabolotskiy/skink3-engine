# Motion review

In short: [QUICK-REFERENCE.md](QUICK-REFERENCE.md#reading-the-reviews) has one line for every kind of finding, with what it usually means and the usual fix, and how to mark what is meant. This guide is the full text: open it at the section a question needs.

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
- `check` shows the count by kind and the worst five findings, and points to `motion`. Generated nodes with the same kind of finding take one line. They never fail the checks.

```
node bin/skink3.mjs motion examples/demo/scene.ts
node bin/skink3.mjs motion test/fixtures/defects/scene.ts --pictures
node bin/skink3.mjs trail examples/demo/scene.ts --node n2 --time 6.4,8
node bin/skink3.mjs graph examples/demo/scene.ts --node buddy-ant-l --time 3.5,6
node bin/skink3.mjs graph examples/demo/scene.ts --camera
```

The demo shot has no findings. `test/fixtures/defects/scene.ts` is a small shot with defects planted in it, kept for the tests of the command line.

## The report

```
motion defects: 240 frames (4.00 s); 5 placed nodes, 4 of them rigid bodies, 0 springs, 0 emitters, 0 links
camera: median drift 0.00 px per frame at depth 0, zoom 1 to 1
1 warning(s): 1 abrupt-start

mover (circle)
  abrupt-start  f60-62 (1.00-1.03 s)  position: from rest to 29.5 px per frame within two frames (frames 60-62), 100 % of the peak speed of the move (limit 90 %)  [29.503 against 3 px per frame]
  usual fix for abrupt-start: give the move an ease-in: ...
```

A shot with springs ends with one line per spring, as the demo does:

```
springs: 8 spring-driven node(s), 8 responded
  buddy-ant-r (sway, f 2.1, z 0.22, r 0): 3 response(s); at most: lag 49.0 px, overshoot 18.6 px, 4 visible swing(s), swinging for 0.95 s, settled after 1.27 s
```

### The life of the background

Whether a picture feels alive is mostly a matter of its background: a camera that barely moves, layers that slide as one, motes that stand still. No finding says that, so the report states it in numbers, findings or not. After the summary line (`examples/flow/scene.ts`):

```
camera: median drift 0.48 px per frame at depth 0, zoom 1 to 1.155
no warnings
camera path: 286 px long, inside a box of 174 x 72 px; drift between 0.43 and 0.53 px per frame
layers, farthest first: far 0.18, stage 0.48, near 0.99 px per frame
particles: motes 0.41 px per frame (50 in frame, moving 100 % of the time); fizz 0.66 px per frame (34 in frame, moving 100 % of the time)
zoom keys: 1.027 to 1.152 at 5.40-9.40 s, the camera drifting 0.49 px per frame meanwhile
```

| In the JSON report | Meaning | What to look for |
|---|---|---|
| `camera.driftPx` | median travel of the camera per frame, in px at depth 0 | the norm is 0.3 to 0.7; below it the picture stands |
| `camera.driftMinPx`, `camera.driftMaxPx` | the 5th and the 95th percentile of that travel | a minimum near 0 is a camera that stops (the turn of an open path, an eased end) |
| `camera.zoomFrom`, `camera.zoomTo` | the zoom at the first and at the last frame: the push-in, times the camera keys and the zoom keys | a few percent over a shot; more where a key pushes in |
| `camera.travelPx` | length of the camera's path over the shot | |
| `camera.spanPx` | width and height of the box the camera's centre stays in | how far a subject slides across the frame; on one heading it equals the travel, on a loop it is the size of the loop |
| `layers[]`: `id`, `depth`, `parallax`, `driftPx` | how fast each depth layer slides across the screen, farthest first. In a shot with zoom keys it is taken in the middle of the frame, where a zoom moves nothing | the layers should differ: that is what gives depth |
| `background[]`: `from`, `to` | only in a shot whose background is keyed (`backgroundTo`): the stretches of frames in which it changes fast enough to be seen | an empty list: the change is too slow or too small to read as life |
| `zooms[]`: `from`, `to`, `zoomFrom`, `zoomTo`, `driftPx` | only in a shot with zoom keys (`zoomTo`), one entry per key that runs within the shot: its frames, the zoom of the camera at the first and the last of them (the push-in and every key in it), and the median travel of the camera per frame meanwhile, in px at depth 0 | the drift under a key should be in the norm like the drift of the shot: a push over a camera that stands is a background that stands |
| `particles[]`: `id`, `layer`, `inFrame`, `speedPx`, `movingShare` | per emitter: the median number of particles in frame, their median speed on their own (camera left out), and the share of the frames with particles in which they move | motes with a speed near 0 or a low share stand still |

A reviewer who cannot watch the video reads these lines to say whether the background lives; `skink3 graph <scene> --camera` shows the speed of the camera over time, and its zoom.

All of it is measured on the camera as it is composed: its drift or its path, its wander, its push-in, its camera keys and its zoom keys. A camera key that zooms holds the view while it runs, and the numbers say so: the slowest drift falls to nearly 0, and over a long key the median with it. A zoom key leaves the drift running, and the line `zoom keys` shows it.

Every finding has:

| Field | Meaning |
|---|---|
| `kind` | one of the kinds below |
| `subject` | a node id; `(camera)`; `(perspective:<layer id>)` for the camera of a perspective layer; `(focus:<layer id>)` for a pull of focus on a layer; `(frame)` for the whole frame; `(frame:top-left)` and so on for one of its six regions |
| `channel` | what changed: `position`, `rotation`, `scale`, `opacity`, `fill`, `level`, `outline`, `width`, `shadow`, `particles`, `haze`, `pulse`, `focus`, `spring`, `hold` |
| `from`, `to` | first and last frame; the text adds the seconds |
| `value`, `threshold`, `unit` | the measurement and the limit it is held against, in the same unit |
| `severity` | `value / threshold`; the report is sorted by it |
| `detail` | the measurement in words |
| `fix` | one line on what usually fixes it |

The text report is capped: at most 12 subjects and 4 findings per subject. Generated nodes whose ids differ only in digits and that have the same kinds of findings (`item0` … `item39`) are shown once, with the worst of them. The JSON report holds everything, together with the thresholds and the meaning of every kind. The same scene always gives the same report.

## The findings

| Kind | What it means | Usual fix |
|---|---|---|
| `jump` | Position, rotation, size, opacity, the fill of a shape, the level of a content, or the width or colour of a line changes between two frames out of line with the frames around it: a teleport or a pop. Also a jump spread over two frames, a flicker (away and back), and a link that appears within a frame because its end node starts to pop in. | Look at the keys at that moment: two keys at once, a duration shorter than a frame, a wrong target. To change place unseen, do it while the node is hidden (`popOut`, then `popIn`) or faded out. Draw a link on (`drawOn`) after its nodes have arrived. |
| `abrupt-start` | A move that is at its peak speed within two frames of rest: there is no ease-in. | Give it an anticipation or an overshoot above 0. With both at 0 a `moveTo`, `turnTo`, `scaleTo` or `widthTo` is a plain ease-out, which starts at full speed. Or use the profile `'ease'` or `'in'`, or lengthen the move. A `travel` that starts in view takes the profile `'in'` or `'ease'`. |
| `abrupt-stop` | A move that is still at its peak speed two frames before it rests: it runs into its place. | Use an eased intent or the profile `'ease'` or `'out'`, lengthen the move, or let it overshoot and settle. |
| `mechanical` | A move between two rests at constant speed over at least 70 % of its length: a `'steady'` move, travel or level that starts and ends in view. | Replace it with an eased move (the profile `'ease'`). If it is meant as a flow, let it enter and leave the frame, or start and end behind a cover, instead of resting in view. |
| `too-fast` | The node travels at least half of its own size per frame, and at least 6 px, for a tenth of a second or longer. There is no motion blur, so it strobes at 60 fps. For an emitter: most of its particles in frame do; a particle drawn as a streak is measured along its streak. For a heat haze: its finer ripples drift half their own size per frame or more, and at least 6 px. For a link: a pulse crosses it in fewer than 9 frames. For a stroke: a light that runs along it covers half of its own length per frame or more. | Slow it down or make it larger: a longer move, a lower release velocity or gravity, more drag; for particles a lower speed, a larger size or a `streak` (one of 1/30 s or longer never strobes); for a haze a lower `speed` or a larger `scale`. |
| `spring-ringing` | A spring still swings visibly more than 2.5 s after its target came to rest. | Raise its damping `z` or its frequency `f`. |
| `spring-no-overshoot` | A spring that is set to bounce (`z` of 0.4 or less) lagged at least 10 px and then came to rest without passing its place by a visible amount. It reads as lag, not as a spring. | Lower `f` so that it lags more, or lower `z`; or use a preset that says what you get (`light`, `heavy`); or drop the spring. |
| `dead-area` | Nothing moves on its own in the whole frame for more than 4 s, or in one of its six regions for more than 6 s. | Give something there a life of its own: an idle wander, a pulse, particles that cover the area, a heat haze over it, or an action staged there. |

Things that are legitimate and are not flagged:

- **Flows at constant speed**: the drift of the camera, a pulse running along a link, particles in flight, a body that rolls, and anything that enters, leaves, appears or vanishes while it moves. Only a move that rests in view at both ends can be mechanical.
- **Kicks**: a `bump`, and any other sudden excursion that comes back by half within a third of a second. A hit starts suddenly; that is the point.
- **Hops**: a `hop` leaves the ground at speed and comes down at speed. Neither end is an abrupt start or stop; that is what a jump is. A hop is still reported when it is too fast for its size, and a hop with almost no height is a slide at one speed: mechanical.
- **Pops**: a node that grows from nothing or shrinks to nothing is not checked for ease at that end.
- **Short holds**: under 4 s for the frame, under 6 s for a region.
- **What is behind a cover or outside its clip**: a shape or an eye that lies wholly under a nearly opaque `cover` drawn after it in its layer, or wholly outside the shape it is clipped to, is not seen, whatever it does there.

### What applies to what

| | timeline nodes | rigid bodies | particles | links | camera |
|---|---|---|---|---|---|
| jump | yes | size and opacity only | the opacity of the emitter | appearing or vanishing; a width that changes | yes |
| abrupt start, abrupt stop | yes | size only | – | a width that changes | yes |
| mechanical | yes | size only | – | – | no |
| too-fast | yes | yes | per emitter | pulses | no |
| dead-area | count as alive while they move | the same | while they move, or fade fast enough, and are seen | while a pulse runs, the link is drawn on, or its bend or its width changes | never counts |

A content with a level (a shape that fills from the bottom) has one more channel: `level`, the travel of its surface in px. It is judged like a move: a jump, an abrupt start or stop, one speed between two rests. Its children ride on the surface and are judged on their own motion, which includes that ride. A level that moves, or a surface that ripples, counts as alive.

A rigid body gets its place and its turn from the solver. A contact changes its velocity within a frame, a neighbour nudges it a few pixels at once, and a body that rolls at constant speed is a flow. So the place and the turn of a body are checked for strobing speed only. Its size and its opacity are animated by the timeline (`popIn`, `bump`, `fadeTo`) and are checked like those of any node. Children of a body are judged on their own tracks.

A node that follows a `drive` is a timeline node: every channel it drives is judged as a keyed one is. The engine has only the samples, one per frame, so a function that leaps is a jump, one that leaves rest at full speed an abrupt start, and one speed between two rests a mechanical move. A flow (an orbit that never rests in the shot) is no finding.

In a perspective layer there are two things to judge, and each is judged apart: what a node does in the space of the layer, and what the camera of the layer does. The second has the subject `(perspective:<layer id>)` and the camera's column of the table.

Whether the simulation itself is sound is a different question: bodies that sink into each other, jitter at rest, energy that appears from nowhere, tunnelling, escapes. That is the physics review, a sibling of this one with a report of the same form: [PHYSICS-REVIEW.md](PHYSICS-REVIEW.md).

### How things are measured

- **px** is a pixel of a 1080p frame.
- **Own motion.** A node is judged on what it does itself: its place, turn and size in the space of its parent, scaled to the screen. The camera is not in it, and neither is the motion of the parent. So a defect of a parent is reported once, on the parent, and not again on everything it carries. A label is measured against the node it points at, and a node on a `follow` spring against the origin of its parent.
- **Rotation and size** are measured as the travel of the node's edge in px, so that all three channels share one unit. A plain disc that turns shows nothing, so it has no rotation channel unless it carries something off its centre.
- **Seen.** A node counts while it is drawn, at least 5 % opaque, at least 2 px in radius and reaching into the frame. What happens while a node is hidden or outside the frame is not reported. Hidden also means: wholly behind a cover, wholly outside its clip, a node that shows only while it travels (`travel` with `only`) outside its travel, a rigid body that appears at its release (`appear: 'release'`) before it, and an empty content.
- **Behind a cover** is judged on nine points of a shape or an eye: its middle and eight points of its edge. It is hidden when every one of them lies under a cover that is at least 95 % opaque and is drawn after it in the same layer. One point that shows, and the node is seen.
- **Too fast** is the only check in screen space: the step of a node on screen divided by its size along that step. A part is measured against its parent as the parent is turned at each moment, so a ball on a stick that whips round is caught, and an eye on a body that pops in is not.
- **Springs.** A response starts when the node leaves its rest place (where it would be without the spring) by 0.5 px and ends when it is back within it. Reported per response: the largest lag, the overshoot past the rest place, the number of visible swings (1 px or more) after the target stopped, how long it kept swinging, and when it settled.
- **Alive** means that something visible changes by itself: a node moves, turns, grows, fades or blinks, changes its width, its height or its outline, a shape changes its fill, a pulse runs, a link is drawn on or changes its bend, a stroke is drawn on, its dashes close or a light runs along it, a link or a stroke changes its width or its colour, a counter runs, a particle travels or fades fast enough, a heat haze moves the picture under it by 0.1 px per frame or more. A background that changes (`backgroundTo`) is seen everywhere: while it changes by 0.0005 of the range of its values per frame or more, every part of the frame is alive. A thing counts in every region that the circle around it touches. An area with nothing in it is dead too. The camera never counts: a picture that only slides is still a hold. The camera of a perspective layer does not count either: a view that only turns round things that stand still is a hold. Nor does a pull of focus: a picture that only sharpens is still a hold.

- **Strokes and free-standing texts** are nodes like shapes: their moves, turns, sizes and fades are judged as a shape's. A stroke that is being drawn, a counter that runs and a link that bends are not judged for their speed; they count as life.
- **A background that changes** (`backgroundTo`) has no finding of its own: a key takes a tenth of a second at least and starts from what the background is at its moment, so it cannot jump. Its change is measured as the largest change of any of its values per frame, each as a share of its full range: a channel of one of its colours, the vignette, the place and the size of the gradient. The report says when it changes visibly.
- **A light that runs along a stroke** (`pulse` on a stroke) is judged as the pulse of a link is: its mean speed against its own length, on the channel `pulse`, on the stroke. The length of the light is a quarter of its way, at most 120 units, unless the key gives one. While it runs the stroke counts as life.
- **An outline that changes** (`reshape` of a region or of a stroke) has a channel of its own, `outline`: the travel of the point of the outline that goes farthest, in px. It is judged like a move: a jump, an abrupt start or stop, one speed between two rests. While it changes the node counts as life.
- **A colour key** (`fillTo`) has a channel of its own, `fill`: the change of the fill per frame, as the largest change of a channel of its colour, a share of its range. It is judged for a jump alone, where the shape is seen and large enough to judge: a change of a third of the range in one frame pops. A key starts from the colour the fill has at its moment, and a colour has no speed to start or stop abruptly. While it changes by 0.0005 of the range per frame or more, the shape counts as life.

- **The colour of a line** (`colorTo` on a stroke or a link) is judged the same way, on the same channel `fill`: a jump where the line is seen and its width on screen is large enough to judge, and life while it changes. Its finding says `colour: a channel of the colour of the line changed by …`. A link is judged while both its frames show it, in the frame.
- **A heat haze** (`haze` on a shape) has a channel of its own, `haze`, on its shape. Its ripples drift at one speed; the finer ones are half the size of the larger ones and strobe first, so the haze is judged on them: drifting half their own size per frame or more, and at least 6 px, for a tenth of a second while the haze moves the picture by a pixel or more, it is too fast. Under a ripple of size d that drifts v per frame a point moves by up to 2πv/d of the amount; that much, at 0.1 px per frame or more, keeps every region its shape touches alive. A haze whose ripples do not drift (`speed: 0`) holds one picture and is no life.
- **Particles drawn as streaks** (`streak` on an emitter) are measured along the streak: a particle strobes when its travel per frame is half of its size plus the length of its streak or more. A streak at least as long as the way of two frames closes the gaps, however fast the particles go.
- **Particles that fade** (`fade` on an emitter) are judged, and counted as life, only while they are seen: a particle's own opacity times the emitter's is at least 0.05. A particle whose opacity runs over its life by 0.004 a frame or more (full range in four seconds; the slowest is that of the longest `life`) is life in every region it touches, however slowly it drifts: lights that come up and go out keep the frame alive.
- **The opacity of an emitter** (`opacity`, keyed by `fadeTo`) fades its particles as one picture. It is judged as the opacity of a node is: a change of a third of full opacity in one frame, while some of its particles are seen, is a `jump` on the channel `opacity`. Below 0.05 none of its particles is seen.
- **A rate that changes** (`rateTo`) has no finding of its own: what it sends out is judged as any particles are. A rate keyed to 0 leaves the area its particles covered without life once they are gone.
- **A line whose width changes** (`widthTo` of a link or of a stroke) has a channel of its own, `width`: the travel of the edge of the line, which is half the change of its width, in px. It is judged for a jump and for an abrupt start or stop, on a link as on a stroke. A key has no steady speed, so there is no mechanical change of width to find. While it changes the line counts as life.
- **A height that changes** (`riseTo` of a shape or of a stroke with a `rise`) is the move of the top of the body on screen, and is judged as that move, on the channel `position`: the top travels by the change of the height, up the screen in a flat layer. In a plane of a perspective layer the top also grows as it comes nearer to the camera, so the same change is read on `scale` as well. A height that changes within a few frames is an abrupt start and an abrupt stop; one speed between two rests in view (`'steady'`) is mechanical; from rest to rest (`'ease'`, the default) there is nothing to report. The shortest key takes three frames, so a rise is never a jump. While it changes the node counts as life; a body that stands at one height is still.
- **The shadow of a body whose height changes** (`riseTo` of a body in a group with `cast`) has a channel of its own, `shadow`: the travel of the end of the shadow on the ground, which is `cast.length` times the change of the height, in px. It is judged like a move: a jump, an abrupt start or stop, one speed between two rests. With a `length` of 1 or less the end of the shadow travels no farther than the top of the body, and a finding on it comes beside the one on `position`; with a longer shadow a rise that is too small to judge on the body is judged on its shadow. Under a cast that lies on the ground (`cast.ground`) the travel is that of the end of the shadow on the ground: down a slope longer than on level ground (up to twice), up one shorter.
- **A group that sorts its children** (`sort: 'depth'`) and **a level of detail** (`detail`) move nothing, and the review has no finding for them. Two things they do are not judged: two bodies that overlap on screen change places in the draw order at one frame as the camera turns, and a body changes between plain and full at the frame its size on screen crosses `min`. Look at a strip of the frames where the camera turns through a dense spot, and keep `min` small.
- **A line that keeps a least width on screen** (`least` on a stroke) has no width of its own that changes: the camera zooms, and the review reads that on the camera.
- **A change of width and height** (`scaleTo` with `to: [sx, sy]`) is judged on the scale channel, as the travel of the edge along each axis, the larger of the two.
- **A size on a profile** (`scaleTo` with a `profile`) is judged on the scale channel as any change of size, by the travel of the edge of the node. From rest to rest (`'ease'`) there is nothing to report. One speed between two rests in view (`'steady'`, and `'in'` or `'out'` where the steady stretch is most of the change) is mechanical; a short change that starts or stops in view at its top speed is an abrupt start or stop. A node that appears or vanishes while its size changes is a flow.
- **A turn whose speed is keyed** (`turnTo` with `speeds`) is judged as any turn, on the rotation channel: a start at speed from rest in view is an abrupt start, a wheel that never rests in the shot is a flow. Where two keys meet at one speed there is nothing to report.
- **A node that follows a function of time** (`drive`) is judged on the channels it drives, from its samples: place, turn, size and opacity as those of any node. Driven `points` of a region or of a stroke are judged on the channel `outline`, as the way of the point that goes farthest between two frames, summed frame by frame. A driven depth changes only the order of drawing and is not judged. A driven group with nothing in it is a place for links to hold on to: it is judged while a link that holds on to it is seen, because the link shows its every step, and a link counts as alive while a driven node at one of its ends moves.
- **The nodes of a perspective layer** are judged on what they do in the space of the layer: the step of a node from one frame to the next is taken as the camera of that frame sees it, and what the camera does is left out. A node that is carried from the front to the back grows smaller; that is its own change of size, and it is judged. What lies in a plane is judged on what it does in the plane; a plane that turns on its hinge is judged on the rotation channel, by the travel of the edge of what lies in it.
- **The camera of a perspective layer** (`perspectiveTo`) is judged under `(perspective:<layer id>)`, for a jump and for a start or a stop without an ease, on three channels in px: `position`, how far the picture slides at the point the camera looks at; `rotation`, how far the camera goes round that point or tilts, as the travel of what stands at the edge of the frame (the angle times half the height of the frame); `scale`, how fast the picture grows, by a dolly or by the lens, as the travel of the edge of the frame. A key takes three frames at least, so a leap of one frame cannot be written; a `'steady'` key that is fast enough (3 px per frame) starts and stops abruptly. Like the camera of the shot, it is not judged for one speed between two rests.
- **A pull of focus** (`blurTo`) is the lens's, and is judged as the camera is, under `(focus:<layer id>)` on the channel `focus`: the travel of a blurred edge, which is the change of the layer's blur per frame times the zoom of its view, in px. A jump and a start or a stop without an ease are reported; one speed between two rests is not. A focus pulled within a few frames is an abrupt start and stop; from rest to rest (`'ease'`, the default) there is nothing to report. The change spreads the edge of what is drawn whether or not anything moves, so it is judged over the whole frame. A pull never counts as life.
- **Camera keys** (`cameraTo`) are judged as the camera always is: a jump, an abrupt start or stop of its position or of its zoom. A keyed zoom is measured as a ratio, because that is what it is to the eye: a zoom from 10 to 20 is the change that one from 1 to 2 is.
- **Zoom keys** (`zoomTo`) are judged on the zoom of the camera in the same way, as a ratio: a `'steady'` key whose edge of the frame travels 3 px per frame or more starts and stops abruptly, and a zoom squeezed into a few frames does too. A slow push at one speed stays under that and is no finding. The key moves nothing by itself, so it never counts as life; neither does the camera.

## Thresholds

All of them live in `src/review/thresholds.ts`, with the reason for each value. The JSON report carries the table. They are first settings, chosen from the engine's own curves and the look of the examples; they are not yet calibrated against measurements of reference videos.

| Name | Value | Unit | Why |
|---|---|---|---|
| `visibleAlpha` | 0.05 | opacity | Below this opacity a node is too faint for a defect in its motion to be seen. |
| `minRadiusPx` | 2 | px | A node smaller than this on screen is a dot; its motion is not judged. |
| `coverAlpha` | 0.95 | opacity | A cover hides what is behind it from the review only while it is nearly opaque; through a fainter one a thing is still seen. |
| `jumpPx` | 4 | px in one frame | A displacement of one frame below this reads as part of the motion, not as a tick. |
| `jumpRatio` | 4 | x the steps around it | A smooth curve sampled at 60 fps changes its step by a few percent per frame, and the hardest legitimate start (a bump) by a factor below 2; four times the largest step of the two frames on either side is out of line. |
| `jumpOpacity` | 0.34 | opacity in one frame | A third of full opacity in one frame is a pop: an eased fade has to be shorter than 5 frames to do that. |
| `jumpFill` | 0.34 | share of the range of a channel in one frame | A fill that changes a channel by a third of its range in one frame pops, as a fade does: an eased fillTo has to be shorter than 5 frames to do that. |
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
| `hazeMinPx` | 1 | px | A heat haze that moves the picture by less than a pixel is not seen to strobe, however fast its ripples drift. |
| `springMinResponsePx` | 4 | px | A deviation from the rest place smaller than this is idle wobble, not a response to report. |
| `springVisiblePx` | 1 | px | A swing smaller than a pixel is not seen. |
| `springSettlePx` | 0.5 | px | Within half a pixel of its rest place a spring has settled. |
| `springRingSeconds` | 2.5 | s | The bounciest preset swings visibly for about a second after a large move; a spring still swinging after 2.5 s holds the eye long after the action. |
| `springBouncyDamping` | 0.4 | damping z | A spring damped this lightly is there to bounce (the springy preset is 0.26, the tidy one 0.55). |
| `springClearResponsePx` | 10 | px | A bouncy spring that lagged this far and then never passed its rest place by a visible amount does not read as a spring. |
| `alivePx` | 0.1 | px per frame | Motion of its own slower than 6 px per second does not make a thing look alive. Camera motion is not counted. |
| `aliveOpacity` | 0.004 | opacity per frame | A fade slower than full range in four seconds does not read as change. |
| `aliveFill` | 0.0005 | share of the range per frame | Taken from the background: a fill that turns by an eighth of the range of a channel in four seconds still reads as change; slower than that it is a hold. |
| `aliveBackground` | 0.0005 | share of the range per frame | The colours of a background lie close together, so its change is small in numbers: a sky that turns by an eighth of the range of a channel in four seconds still reads as change; slower than that it is a hold. |
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

A graph is one picture of one subject over time. The large panel is its speed in px per frame. Small panels below show whatever else changes on it: position, rotation, scale, opacity, the width of a stroke, the change of its fill or of the colour of a stroke. Every panel has its own scale; the time axis at the bottom gives seconds and frames. A yellow band marks the frames of a finding, with its kind and frames above the first panel. A dark band marks frames at which the node is not drawn.

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
- For the camera the subject is `'(camera)'`; for the camera of a perspective layer `'(perspective:<layer id>)'`; for a pull of focus `'(focus:<layer id>)'`; for a hold of the whole frame `'(frame)'`, which also covers its regions; for one region `'(frame:top-left)'`, `'(frame:top-center)'`, `'(frame:top-right)'`, `'(frame:bottom-left)'`, `'(frame:bottom-center)'` or `'(frame:bottom-right)'`.
- Covered findings are left out of the warnings. The report lists every exception it honoured, with its reason and the number of findings it covers, so a reviewer still sees them.
- An exception that covers nothing is reported as **unused**: the defect is gone, or the exception names the wrong node or kind. Remove it.
- An exception must name a node that exists, or the shot does not compile.
- It changes nothing in the picture and nothing in the bake.
- The same `intended()` marks findings of the physics review. Each review honours, and counts as unused, the exceptions of its own kinds only.

Mark an exception on the subject the finding names. A defect of a parent is reported on the parent.

## A review routine

1. `skink3 motion <scene> --pictures`. Read the summary line, then the findings from the top.
2. For each finding, open the trail and the graph of its subject. Decide: a defect, or intended.
3. Fix defects in the scene. Mark what is intended with `intended()` and a reason.
4. For a move the report does not name but that matters to the shot, draw its trail and its graph yourself and read the spacing.
5. Read the springs lines: a few swings and a settle time around a second is the usual look.
6. Run it again. A reviewed shot has no warnings, and every exception it lists is one you would defend.

## What these tools cannot tell

- **Whether the simulation is sound.** Bodies that sink into each other, jitter at rest, tunnelling and escapes are the physics review's findings ([PHYSICS-REVIEW.md](PHYSICS-REVIEW.md)). Wrong weight, a fall too fast or too slow for its size, is looked at by neither.
- **Taste.** Timing against the narration, whether a pause is too long for the story, whether a move is elegant. A clean report means there is no mechanical defect; it does not mean the motion is good.
- **Sound.**
- **What is hidden behind what, unless it is said.** The review knows that a node is covered only when the shape in front is marked `cover: true` and lies in the same layer. A jump or a start behind any other shape, or behind a nearer layer, is still reported: mark the shape as a cover, or the finding as intended. A node that comes out from behind a cover in one frame is not reported as a jump: it was not seen before.
- **Links, labels and particles behind a cover or outside a clip.** Only shapes and eyes are tested against covers and clips. A label is taken as seen; particles are counted wherever they are.
- **Whether a driven law is the right one.** The review reads the samples of a `drive`: that they run smoothly, not that the orbit, the fold or the projection behind them is correct. A driven outline is not checked for crossing itself.
- **A perspective layer, beyond the motion.** Its order of drawing changes with the camera, so a `cover` in it hides nothing from the review, and what lies in a plane is taken as seen: a defect behind another thing is still reported. Whether the nearer of two things is the one in front is the order the layer draws in (by the distance of each thing's own point), not a finding. The camera of the layer has no trail and no graph: `--pictures` passes it over; read its findings and look at a strip.
- **Squashes.** A `squash` changes the picture of a node, not its place or its size as the review reads them: the kick itself is not measured.
- **What it does not measure**: the pupils (however far an eye's `reach` lets them go) and lids of eyes, the drawing-on of a link, the shape of a link as its ends move, glow, blur, and the look of text. Colour is not its question either: whether a thing stands out from what is behind it is the contrast review's, for a shot that turns it on ([SCENES.md](SCENES.md#contrast-review)).
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

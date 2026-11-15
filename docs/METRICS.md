# Metrics tools

`tools/metrics/` measures the look and motion of any video: a reference you study, or your own render. The same numbers on both make the comparison objective. The targets are in [PRINCIPLES.md](PRINCIPLES.md#6-measured-look).

Requirements: Python 3.11+ with numpy, scipy, opencv-python and Pillow; ffmpeg on `PATH`. Run the scripts with `python -I` when they read downloaded files.

```
export METRICS_DIR=<work dir>; mkdir -p $METRICS_DIR/dl       # videos go to $METRICS_DIR/dl/<id>.<ext>
tools/metrics/pass1.sh <id> [interval_s]                      # one decode pass: a frame every 6 s (or every interval_s), 480 px, + scene-cut scores → $METRICS_DIR/an/<id>
python -I tools/metrics/sheets.py $METRICS_DIR <id>                    # 6×5 contact sheets with timestamps
python -I tools/metrics/palette.py $METRICS_DIR <id> [skip_frames]     # 16-colour palette (k-means in Lab) + tone stats → palette.json, palette.png
python -I tools/metrics/roles.py $METRICS_DIR [skip_frames]            # palette by role (deep, dark, mid, accent, light) over all sampled videos; skips the first 3 samples of each unless told otherwise
python -I tools/metrics/still.py <video> [start_sec] [crop]   # share of static frame pairs, holds > 1 s, camera drift (phase correlation); crop = x,y,w,h in 1080p px
python -I tools/metrics/dupes.py <video> <start> <seconds>    # duplicated frames inside motion (true frame rate check)
python -I tools/metrics/strip.py <video> <start> <n> <step> <width> <cols> <out.jpg> [crop]   # motion strip; crop = x,y,w,h in 1080p px
```

| Script | Output | Main numbers |
|---|---|---|
| `pass1.sh` | `an/<id>/s/*.jpg`, `scene.txt` | number of hard cuts (scene score > 0.3) |
| `palette.py` | `palette.json` | mean V, median L*, share with V < 0.3, mean S, S of dark pixels, near-gray share, hue histogram |
| `roles.py` | `an/roles.json` | colours and shares per lightness role; the share of pixels below L* 30 over all pixels, and per frame for dark frames and for the others |
| `still.py` | stdout | static share, holds > 1 s, longest hold, drift px/frame at 1080p (median, p75, p95), median shift across and down |
| `dupes.py` | stdout | zero-difference frames inside motion runs |

## Short clips

By default `pass1.sh` takes one frame every 6 s and `roles.py` leaves out the first three samples of each video (the intro), which suits whole videos. For a single shot of a few seconds, sample densely and skip nothing:

```
tools/metrics/pass1.sh <id> 0.5                          # a frame every 0.5 s
python -I tools/metrics/roles.py $METRICS_DIR 0          # $METRICS_DIR/an must hold only the clips to measure
python -I tools/metrics/palette.py $METRICS_DIR <id> 0
```

`pass1.sh` clears the samples of an earlier run of the same id, so changing the interval is safe. `still.py` and `dupes.py` read the video itself and need no sampling. A single continuously moving shot has no hard cuts and close to 0 % static frame pairs; the 3–9 % norm describes whole videos.

## Reading the numbers

**Tone depends on the kind of shot.** The norm "about 60 % of pixels below L* 30" is an average over whole videos, which mix dark and bright shots. `roles.py` therefore also prints the share per frame, separately for dark frames (V below 0.3 on more than half of the frame) and for the others. Compare a single dark shot with the dark frames of the reference, not with the average: on the six reference videos the dark frames have a median of 88 % below L* 30 (quartiles 78–95 %), and the other frames a median of 40 %.

**Drift is the strongest motion in the picture, not always the camera.** `still.py` finds the shift between frames by phase correlation. When something large moves through the shot (a stream of falling things, a crowd, a wipe), the number is that motion: the output shows it as a median shift straight along the flow (`dx`, `dy`). To read the camera on such a shot, give `still.py` a crop that the flow does not cross, for example the half of the frame beside it: `python -I tools/metrics/still.py shot.mp4 0 960,0,960,1080`. A crop also changes the static share and the holds, which are then those of that region. The analysis runs at 160 px across, so a slow drift is read a little low: a camera travelling 0.45–0.7 px per frame measured 0.3–0.5.

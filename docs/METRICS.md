# Metrics tools

`tools/metrics/` measures the look and motion of any video: a reference you study, or your own render. The same numbers on both make the comparison objective. The targets are in [PRINCIPLES.md](PRINCIPLES.md#6-measured-look).

Requirements: Python 3.11+ with numpy, scipy, opencv-python and Pillow; ffmpeg on `PATH`. Run the scripts with `python -I` when they read downloaded files.

```
export METRICS_DIR=<work dir>; mkdir -p $METRICS_DIR/dl       # videos go to $METRICS_DIR/dl/<id>.<ext>
tools/metrics/pass1.sh <id>                                   # one decode pass: a frame every 6 s (480 px) + scene-cut scores → $METRICS_DIR/an/<id>
python -I tools/metrics/sheets.py $METRICS_DIR <id>                    # 6×5 contact sheets with timestamps
python -I tools/metrics/palette.py $METRICS_DIR <id> [skip_frames]     # 16-colour palette (k-means in Lab) + tone stats → palette.json, palette.png
python -I tools/metrics/roles.py $METRICS_DIR                          # palette by role (deep, dark, mid, accent, light) over all sampled videos
python -I tools/metrics/still.py <video> [start_sec]          # share of static frame pairs, holds > 1 s, camera drift (phase correlation)
python -I tools/metrics/dupes.py <video> <start> <seconds>    # duplicated frames inside motion (true frame rate check)
python -I tools/metrics/strip.py <video> <start> <n> <step> <width> <cols> <out.jpg> [crop]   # motion strip
```

| Script | Output | Main numbers |
|---|---|---|
| `pass1.sh` | `an/<id>/s/*.jpg`, `scene.txt` | number of hard cuts (scene score > 0.3) |
| `palette.py` | `palette.json` | mean V, median L*, share with V < 0.3, mean S, S of dark pixels, near-gray share, hue histogram |
| `roles.py` | `an/roles.json` | colours and shares per lightness role |
| `still.py` | stdout | static share, holds > 1 s, longest hold, drift px/frame at 1080p (median, p75, p95) |
| `dupes.py` | stdout | zero-difference frames inside motion runs |

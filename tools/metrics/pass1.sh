#!/bin/bash
# one decode pass per video: frames every 6 s (480 px) + scene-change scores
METRICS_DIR="${METRICS_DIR:?set METRICS_DIR to the work dir with videos in dl/}"
id="$1"; v=$(ls "$METRICS_DIR/dl/$id".* | head -1)
mkdir -p "$METRICS_DIR/an/$id/s"; cd "$METRICS_DIR/an/$id"
ffmpeg -hide_banner -loglevel error -threads 2 -i "$v" -filter_complex \
 "[0:v]scale=480:-2,split=2[a][b];[a]fps=1/6[o1];[b]select='gt(scene,0.30)',metadata=print:file=scene.txt[o2]" \
 -map "[o1]" -q:v 3 "$METRICS_DIR/an/$id/s/%04d.jpg" -map "[o2]" -f null -
echo "$id done $(ls "$METRICS_DIR/an/$id/s" | wc -l) frames, $(grep -c pts_time "$METRICS_DIR/an/$id/scene.txt") cuts"

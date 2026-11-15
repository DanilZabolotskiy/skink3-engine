#!/bin/bash
# one decode pass per video: a frame every <interval> s (480 px) + scene-change scores
# usage: pass1.sh <id> [interval_seconds=6]   (a short interval, e.g. 0.5, suits a clip of a few seconds)
METRICS_DIR="${METRICS_DIR:?set METRICS_DIR to the work dir with videos in dl/}"
id="$1"; step="${2:-6}"; v=$(ls "$METRICS_DIR/dl/$id".* | head -1)
mkdir -p "$METRICS_DIR/an/$id/s"; cd "$METRICS_DIR/an/$id"
rm -f s/*.jpg scene.txt
ffmpeg -hide_banner -loglevel error -threads 2 -i "$v" -filter_complex \
 "[0:v]scale=480:-2,split=2[a][b];[a]fps=1/$step[o1];[b]select='gt(scene,0.30)',metadata=print:file=scene.txt[o2]" \
 -map "[o1]" -q:v 3 "$METRICS_DIR/an/$id/s/%04d.jpg" -map "[o2]" -f null -
cuts=$(grep -c pts_time "$METRICS_DIR/an/$id/scene.txt" 2>/dev/null)
echo "$id done $(ls "$METRICS_DIR/an/$id/s" | wc -l) frames, ${cuts:-0} cuts"

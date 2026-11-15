"""whole video at 60 fps, 160x90 gray: share of static frame pairs, longest static holds, global pan via phase correlation
python -I still.py <video> [start_sec] [crop=x,y,w,h in 1080p px]
with a crop, everything is measured on that part of the frame only. Use it when something large moves through the shot
(a stream, a crowd, a fall): phase correlation follows the strongest motion in the picture, so on the whole frame it
reports that motion instead of the camera. Crop to a region the flow does not cross to read the camera drift."""
import sys, subprocess, numpy as np, cv2
v = sys.argv[1]; skip = float(sys.argv[2]) if len(sys.argv) > 2 else 0
crop = [float(x) for x in sys.argv[3].split(",")] if len(sys.argv) > 3 else None
if crop is not None and (len(crop) != 4 or crop[2] <= 0 or crop[3] <= 0): sys.exit("crop must be x,y,w,h in 1080p px")
W, H = 160, 90
# px of a 1080p frame per analysis pixel, across and down
kx, ky = ((crop[2] / W, crop[3] / H) if crop else (1920 / W, 1080 / H))
vf = (f"scale=1920:1080,crop={crop[2]:g}:{crop[3]:g}:{crop[0]:g}:{crop[1]:g}," if crop else "") + f"scale={W}:{H},format=gray"
p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(skip), "-threads", "4", "-i", v, "-vf", vf,
                    "-f", "rawvideo", "-"], capture_output=True)
fr = np.frombuffer(p.stdout, np.uint8).reshape(-1, H, W)
d = np.abs(np.diff(fr.astype(np.int16), axis=0)).mean(axis=(1, 2))
static = d < 0.06
runs = []; n = 0
for s in static:
    if s: n += 1
    else:
        if n: runs.append(n); n = 0
runs = np.array(runs or [0])
# global translation per frame (sample every 6th pair), ignore cuts
win = cv2.createHanningWindow((W, H), cv2.CV_32F); sh = []; sx = []; sy = []
for i in range(0, len(fr) - 1, 6):
    if d[i] > 8: continue
    (dx, dy), r = cv2.phaseCorrelate(fr[i].astype(np.float32), fr[i + 1].astype(np.float32), win)
    sx.append(dx * kx); sy.append(dy * ky); sh.append(np.hypot(dx * kx, dy * ky))  # px per frame at 1080p
sh = np.array(sh)
where = f" crop={sys.argv[3]}" if crop else ""
print(f"{v.split('/')[-1]}{where}: pairs={len(d)} static={static.mean():.3f} holds>1s={int((runs>=60).sum())} longest={runs.max()/60:.1f}s "
      f"| pan px/frame@1080p: median={np.median(sh):.2f} p75={np.percentile(sh,75):.2f} p95={np.percentile(sh,95):.2f} share>0.3px={(sh>0.3).mean():.2f} "
      f"| median dx={np.median(sx):.2f} dy={np.median(sy):.2f}")

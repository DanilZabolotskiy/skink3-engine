"""whole video at 60 fps, 160x90 gray: share of static frame pairs, longest static holds, global pan via phase correlation"""
import sys, subprocess, numpy as np, cv2
v = sys.argv[1]; skip = float(sys.argv[2]) if len(sys.argv) > 2 else 0
W, H = 160, 90
p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(skip), "-threads", "4", "-i", v, "-vf", f"scale={W}:{H},format=gray",
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
win = cv2.createHanningWindow((W, H), cv2.CV_32F); sh = []
for i in range(0, len(fr) - 1, 6):
    if d[i] > 8: continue
    (dx, dy), r = cv2.phaseCorrelate(fr[i].astype(np.float32), fr[i + 1].astype(np.float32), win)
    sh.append(np.hypot(dx, dy) * 1920 / W)  # px per frame at 1080p
sh = np.array(sh)
print(f"{v.split('/')[-1]}: pairs={len(d)} static={static.mean():.3f} holds>1s={int((runs>=60).sum())} longest={runs.max()/60:.1f}s "
      f"| pan px/frame@1080p: median={np.median(sh):.2f} p75={np.percentile(sh,75):.2f} p95={np.percentile(sh,95):.2f} share>0.3px={(sh>0.3).mean():.2f}")

"""unique-frame rate: decode [start, start+dur] at native 60 fps, 320px gray, per-frame mean abs diff"""
import sys, subprocess, numpy as np
v, start, dur = sys.argv[1], sys.argv[2], sys.argv[3]
W, H = 320, 180
p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", start, "-t", dur, "-i", v,
                    "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True)
fr = np.frombuffer(p.stdout, np.uint8).reshape(-1, H, W).astype(np.int16)
d = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))
moving = d > 0.25
zero = d < 0.08
# among frames inside motion runs (neighbours moving), how many are static -> doubled frames
inner = np.zeros_like(d, bool); inner[1:-1] = moving[:-2] & moving[2:]
print(f"{v.split('/')[-1]} @{start}: frames={len(fr)} moving={moving.mean():.2f} zero={zero.mean():.2f} "
      f"zero-inside-motion={(zero & inner).sum()}/{inner.sum()}  pattern={''.join('.' if z else ('#' if m else '-') for z, m in zip(zero[:120], moving[:120]))}")

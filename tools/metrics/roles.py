"""global palette by role across all sampled frames: python -I roles.py ROOT [skip_first_n=3]
the first skip_first_n sampled frames of each video are left out (intro, sponsor); pass 0 for a single shot"""
import glob, json, sys, numpy as np, cv2
ROOT = sys.argv[1]
SKIP = int(sys.argv[2]) if len(sys.argv) > 2 else 3
px = []; fL = []; fV = []
for d in glob.glob(ROOT + "/an/*/s"):
    fs = sorted(glob.glob(d + "/*.jpg"))[SKIP:]
    for f in fs:
        im = cv2.resize(cv2.imread(f), (96, 54), interpolation=cv2.INTER_AREA); px.append(im.reshape(-1, 3))
        # per frame: the share of pixels below L* 30, and the share with V below 0.3
        fL.append((cv2.cvtColor(im, cv2.COLOR_BGR2Lab)[:, :, 0].astype(np.float32) * 100 / 255 < 30).mean())
        fV.append((cv2.cvtColor(im, cv2.COLOR_BGR2HSV)[:, :, 2].astype(np.float32) / 255 < .3).mean())
bgr = np.concatenate(px)
lab = cv2.cvtColor(bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2Lab).reshape(-1, 3).astype(np.float32)
hsv = cv2.cvtColor(bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)
L = lab[:, 0] * 100 / 255; S = hsv[:, 1] / 255; V = hsv[:, 2] / 255
roles = {"deep (L<12)": L < 12, "dark (12-30)": (L >= 12) & (L < 30), "mid (30-60)": (L >= 30) & (L < 60),
         "accent (S>.6,V>.7)": (S > .6) & (V > .7), "light (L>85)": L > 85}
out = {}
crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, .5)
for name, m in roles.items():
    sub = lab[m]; k = 6 if "accent" not in name else 10
    _, lbl, cen = cv2.kmeans(sub, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    cnt = np.bincount(lbl.ravel(), minlength=k) / len(lbl)
    c = cv2.cvtColor(cen.astype(np.uint8).reshape(-1, 1, 3), cv2.COLOR_Lab2BGR).reshape(-1, 3)
    o = np.argsort(-cnt)
    out[name] = dict(share=round(float(m.mean()) * 100, 1), colors=[["#%02X%02X%02X" % tuple(int(x) for x in c[i][::-1]), round(float(cnt[i]) * 100)] for i in o])
    print(name, out[name]["share"], " ".join(f"{h}:{p}" for h, p in out[name]["colors"]))
# hue of darks
dk = (L < 30) & (S > .2)
hh = np.histogram(hsv[dk, 0] * 2, bins=12, range=(0, 360))[0]; print("dark hue hist 30deg:", np.round(hh / hh.sum(), 2).tolist())
print("overall: median L", np.median(L).round(1), " S of L<30:", S[L < 30].mean().round(2), " gray(S<.12):", (S < .12).mean().round(3))
# tone per frame: a whole video mixes dark and bright shots, so the share of L<30 over all pixels says little about one shot
fL = np.array(fL); dk = np.array(fV) > .5
q = lambda a: f"median {100 * np.median(a):.0f} %, quartiles {100 * np.percentile(a, 25):.0f}-{100 * np.percentile(a, 75):.0f} %"
print(f"L<30 over all pixels: {100 * (L < 30).mean():.1f} %  | dark frames (V<.3 on more than half of the frame): {int(dk.sum())} of {len(fL)}"
      + (f", L<30 in them: {q(fL[dk])}" if dk.any() else "") + (f"  | the other frames: {q(fL[~dk])}" if (~dk).any() else ""))
json.dump(out, open(ROOT + "/an/roles.json", "w"))

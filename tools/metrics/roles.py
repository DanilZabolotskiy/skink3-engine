"""global palette by role across all sampled frames (skip first 2 frames of each = intro/sponsor)"""
import glob, json, sys, numpy as np, cv2
ROOT = sys.argv[1]
px = []
for d in glob.glob(ROOT + "/an/*/s"):
    fs = sorted(glob.glob(d + "/*.jpg"))[3:]
    for f in fs:
        im = cv2.resize(cv2.imread(f), (96, 54), interpolation=cv2.INTER_AREA); px.append(im.reshape(-1, 3))
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
json.dump(out, open(ROOT + "/an/roles.json", "w"))

"""palette + tone stats over sampled frames: python -I palette.py ROOT id [skip_first_n]"""
import sys, glob, json
import numpy as np, cv2
from PIL import Image, ImageDraw
root, vid = sys.argv[1], sys.argv[2]
skip = int(sys.argv[3]) if len(sys.argv) > 3 else 0
files = sorted(glob.glob(f"{root}/an/{vid}/s/*.jpg"))[skip:]
px = []
for f in files:
    im = cv2.imread(f); im = cv2.resize(im, (160, 90), interpolation=cv2.INTER_AREA)
    px.append(im.reshape(-1, 3))
bgr = np.concatenate(px).astype(np.uint8)
lab = cv2.cvtColor(bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2Lab).reshape(-1, 3).astype(np.float32)
hsv = cv2.cvtColor(bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)
crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 60, 0.5)
K = 16
_, lbl, cen = cv2.kmeans(lab, K, None, crit, 4, cv2.KMEANS_PP_CENTERS)
cnt = np.bincount(lbl.ravel(), minlength=K) / len(lbl)
cbgr = cv2.cvtColor(cen.astype(np.uint8).reshape(-1, 1, 3), cv2.COLOR_Lab2BGR).reshape(-1, 3)
order = np.argsort(-cnt)
pal = [("#%02X%02X%02X" % tuple(int(x) for x in cbgr[i][::-1]), round(float(cnt[i]) * 100, 1)) for i in order]
S, V = hsv[:, 1] / 255, hsv[:, 2] / 255
H = hsv[:, 0] * 2
L = lab[:, 0] * 100 / 255
sat = (S > 0.35) & (V > 0.25)
hh = np.histogram(H[sat], bins=12, range=(0, 360))[0]; hh = hh / max(1, hh.sum())
stats = dict(frames=len(files), meanV=round(float(V.mean()), 3), medL=round(float(np.median(L)), 1),
             dark_V_lt_0_3=round(float((V < 0.3).mean()), 3), bright_L_gt_80=round(float((L > 80).mean()), 3),
             meanS=round(float(S.mean()), 3), meanS_dark=round(float(S[V < 0.3].mean()), 3),
             accent_S06_V05=round(float(((S > 0.6) & (V > 0.5)).mean()), 3),
             near_gray_S_lt_0_12=round(float((S < 0.12).mean()), 3),
             hue_hist_30deg=[round(float(x), 3) for x in hh])
print(vid, json.dumps(stats)); print(" ".join(f"{h}:{p}" for h, p in pal))
# swatch
sw = Image.new("RGB", (K * 80, 110), (20, 20, 20)); d = ImageDraw.Draw(sw); x = 0
for h, p in pal:
    d.rectangle([x, 0, x + 79, 79], fill=h); d.text((x + 3, 84), h, fill=(230, 230, 230)); d.text((x + 3, 96), f"{p}%", fill=(180, 180, 180)); x += 80
sw.save(f"{root}/an/{vid}/palette.png")
json.dump(dict(stats=stats, palette=pal), open(f"{root}/an/{vid}/palette.json", "w"))

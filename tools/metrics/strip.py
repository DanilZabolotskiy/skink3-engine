"""motion strip: python -I strip.py video start_sec n step_frames width cols out.jpg [crop=x,y,w,h in 1080p px]"""
import sys, subprocess, numpy as np
from PIL import Image, ImageDraw
v, start, n, step, w, cols, out = sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), sys.argv[7]
crop = sys.argv[8] if len(sys.argv) > 8 else None
vf = (f"crop={crop.replace(',', ':')}," if crop else "") + f"select='not(mod(n\\,{step}))',scale={w}:-2"
p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", v, "-frames:v", str(n),
                    "-vf", vf, "-fps_mode", "passthrough", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True)
data = p.stdout; ims = []; i = 0
while True:
    j = data.find(b"\x89PNG", i + 1)
    chunk = data[i:j] if j > 0 else data[i:]
    if chunk: 
        import io; ims.append(Image.open(io.BytesIO(chunk)).convert("RGB"))
    if j < 0: break
    i = j
h = ims[0].height; rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * h)); d = ImageDraw.Draw(sheet)
for k, im in enumerate(ims):
    x, y = (k % cols) * w, (k // cols) * h; sheet.paste(im, (x, y))
    d.text((x + 3, y + 2), f"+{k*step}f", fill=(255, 255, 0))
sheet.save(out, quality=88); print(out, len(ims), "frames")

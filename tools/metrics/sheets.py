"""contact sheets: an/<id>/s/*.jpg -> an/<id>/sheet_XX.jpg (cols x rows, timestamp label)"""
import sys, glob, os
from PIL import Image, ImageDraw
root, vid = sys.argv[1], sys.argv[2]
step = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
cols, rows, w = 6, 5, 320
files = sorted(glob.glob(f"{root}/an/{vid}/s/*.jpg"))
per = cols * rows
for si in range(0, len(files), per):
    chunk = files[si:si + per]
    im0 = Image.open(chunk[0]); h = round(im0.height * w / im0.width)
    sheet = Image.new("RGB", (cols * w, rows * h), (0, 0, 0))
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(chunk):
        idx = int(os.path.basename(f)[:4]) - 1
        t = idx * step + step / 2
        im = Image.open(f).convert("RGB").resize((w, h))
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im, (x, y))
        d.rectangle([x, y, x + 44, y + 14], fill=(0, 0, 0))
        d.text((x + 2, y + 1), f"{int(t//60)}:{int(t%60):02d}", fill=(255, 255, 0))
    sheet.save(f"{root}/an/{vid}/sheet_{si//per:02d}.jpg", quality=82)
print(vid, len(files), "frames")

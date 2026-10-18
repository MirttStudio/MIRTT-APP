#!/usr/bin/env python3
"""Extract the official MIRTT wordmark (+ star) from IMG_1270.PNG as a transparent RGBA PNG.

The upload is a cream/paper-textured wordmark on a near-black textured background.
We map luminance -> alpha with a soft knee so:
  - background noise (dark) disappears
  - letter body keeps its subtle paper texture (slightly < 1 alpha)
  - anti-aliased edges stay smooth
RGB is kept from the source (authentic cream texture) so the asset also works
as a direct <img>; as a CSS mask only alpha matters, so it recolors fine.
"""
import numpy as np
from PIL import Image, ImageFilter

SRC = "/home/z/my-project/upload/IMG_1270.PNG"
OUT = "/home/z/my-project/public/logo-mirtt.png"

LOW = 70.0    # luminance at/below this -> fully transparent
HIGH = 150.0  # luminance at/above this -> fully opaque
TRIM = 25     # alpha level that counts as real content for the crop bbox

img = Image.open(SRC).convert("RGB")
arr = np.asarray(img).astype(np.float32)
L = 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]

print("image size:", img.size)
print("L min/max/mean:", round(L.min(), 1), round(L.max(), 1), round(L.mean(), 1))
hist, _ = np.histogram(L, bins=16, range=(0, 256))
print("hist% (0-256 in 16 bins):", (hist / L.size * 100).round(2).tolist())

# soft-knee alpha
alpha = np.clip((L - LOW) / (HIGH - LOW), 0.0, 1.0)
# slight smooth to avoid jaggies on the alpha edge
alpha_img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(
    ImageFilter.GaussianBlur(0.6)
)
alpha = np.asarray(alpha_img).astype(np.float32) / 255.0

# crop to content bbox + padding — robust against isolated noise specks:
# a row/col counts as content only if it has >= MIN_LIT pixels above TRIM
lit = alpha > TRIM / 255.0
MIN_LIT = 10
rows_ok = np.where(lit.sum(axis=1) >= MIN_LIT)[0]
cols_ok = np.where(lit.sum(axis=0) >= MIN_LIT)[0]
ys, xs = (rows_ok, cols_ok)
pad = 12
y0 = max(0, ys.min() - pad); y1 = min(arr.shape[0], ys.max() + pad + 1)
x0 = max(0, xs.min() - pad); x1 = min(arr.shape[1], xs.max() + pad + 1)
print("content bbox:", x0, y0, x1, y1, "->", x1 - x0, "x", y1 - y0)
print("aspect ratio (w/h):", round((x1 - x0) / (y1 - y0), 4))

rgba = np.dstack([arr[..., 0].clip(0, 255), arr[..., 1].clip(0, 255), arr[..., 2].clip(0, 255), alpha * 255]).astype(np.uint8)
out = Image.fromarray(rgba, "RGBA").crop((x0, y0, x1, y1))
out.save(OUT)
print("saved:", OUT, out.size)

# preview strips: logo composited on dark and light backgrounds
w, h = out.size
scale = 420 / h
prev = Image.new("RGB", (900, 470), (11, 11, 11))
prev.paste(out.resize((int(w * scale), 420), Image.LANCZOS), (20, 25), out.resize((int(w * scale), 420), Image.LANCZOS))
light = Image.new("RGB", (460, 470), (251, 249, 244))
small = out.resize((int(w * 300 / h), 300), Image.LANCZOS)
# recolor to ink for light-bg preview
sa = np.asarray(small).astype(np.float32)
ink = np.zeros_like(sa); ink[..., 0] = 23; ink[..., 1] = 21; ink[..., 2] = 15
rec = np.dstack([ink[..., 0], ink[..., 1], ink[..., 2], sa[..., 3]]).astype(np.uint8)
rec_img = Image.fromarray(rec, "RGBA")
light.paste(rec_img, (20, 85), rec_img)
prev.paste(light, (440, 0))
prev.save("/home/z/my-project/scripts/logo_extract_preview.png")
print("preview saved")

#!/usr/bin/env python3
"""Generate MIRTT PWA icons from the official wordmark asset (public/logo-mirtt.png).

The asset is the transparent wordmark extracted from the brand logo sheet
(IMG_1270) — italic display lettering + four-point star — so icons match
the official mark exactly. No sub-line (removed per brand update).
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("/home/z/my-project")
OUT = ROOT / "public" / "icons"
MARK = ROOT / "public" / "logo-mirtt.png"
MARK_URI = MARK.as_uri()

PAGE = """<!DOCTYPE html>
<html><head><style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
.stage {{ width:{size}px; height:{size}px; background:#0B0B0B; display:flex; align-items:center; justify-content:center; overflow:hidden; }}
.mark {{ width:80%; height:auto; }}
</style></head>
<body>
<div class="stage" id="stage">
  <img class="mark" id="mark" src="{mark}">
</div>
<script>
window.fit = () => {{
  const stage = document.getElementById('stage');
  const mark = document.getElementById('mark');
  const sw = stage.getBoundingClientRect().width;
  mark.style.width = (sw * {frac}) + 'px';
  mark.style.height = 'auto';
}};
</script></body></html>"""


async def shoot(size, frac, name):
    html = PAGE.format(mark=MARK_URI, size=size, frac=frac)
    p = OUT / "tmp.html"
    p.write_text(html, encoding="utf-8")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": size, "height": size})
        await page.goto(p.as_uri())
        await page.evaluate("fit()")
        await page.wait_for_timeout(250)
        await page.screenshot(path=str(OUT / name),
                              clip={"x": 0, "y": 0, "width": size, "height": size})
        await browser.close()
    p.unlink()
    print("done:", name)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    await shoot(512, 0.80, "icon-512.png")
    await shoot(192, 0.80, "icon-192.png")
    await shoot(512, 0.60, "icon-maskable-512.png")
    await shoot(192, 0.60, "icon-maskable-192.png")
    await shoot(180, 0.80, "apple-touch-icon.png")
    await shoot(32, 0.72, "favicon-32.png")


if __name__ == "__main__":
    asyncio.run(main())

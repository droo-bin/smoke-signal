"""Draws the Smoke Signal logo and renders every icon from it.

    python3 assets/make_icons.py      (needs: pip install playwright pillow)

The mark is a continuous-phase FSK wave: a slow tone that switches to a faster one,
which is what the modem actually sends (1200 Hz and 2200 Hz, a ratio of 1.83).
"""
import io
import math
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent


def wave(slow=180, ratio=1.8333, x0=100, x1=412, amp=82, n=96):
    split = x0 + slow
    pts, ph, dx = [], 0.0, (x1 - x0) / n
    for i in range(n + 1):
        x = x0 + dx * i
        if i:
            ph += 2 * math.pi * dx / (slow if x <= split else slow / ratio)
        pts.append((x, 256 - amp * math.sin(ph)))
    return "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in pts)


def mark(stroke=34, shadow=True, corner=116, **kw):
    d = wave(**kw)
    sh = (f'<path d="{d}" fill="none" stroke="#1A0B02" stroke-opacity=".18" stroke-width="{stroke + 4}" '
          'stroke-linecap="round" stroke-linejoin="round" transform="translate(0 10)"/>') if shadow else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Smoke Signal</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF9A4D"/><stop offset="1" stop-color="#C2410C"/></linearGradient>
    <radialGradient id="shine" cx=".25" cy=".15" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="512" height="512" rx="{corner}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="{corner}" fill="url(#shine)"/>
  {sh}
  <path d="{d}" fill="none" stroke="#FFFFFF" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
'''


SOCIAL = '''<!doctype html><html><head><style>
html,body{margin:0;width:1280px;height:640px;background:#090D0C;overflow:hidden}
body{background:radial-gradient(900px 420px at 20% 10%,rgba(255,138,61,.16),transparent 60%),
  linear-gradient(rgba(233,239,236,.045) 1px,transparent 1px) 0 0/100% 32px,linear-gradient(90deg,rgba(233,239,236,.045) 1px,transparent 1px) 0 0/32px 100%,#090D0C;
  font-family:Inter,sans-serif;color:#E9EFEC;display:flex;align-items:center;gap:64px;padding:0 110px;box-sizing:border-box}
.mark{width:240px;height:240px;flex:none;filter:drop-shadow(0 24px 60px rgba(255,138,61,.35))} .mark svg{width:100%;height:100%}
h1{font-family:"Inter Display",Inter,sans-serif;font-weight:800;font-size:104px;letter-spacing:-.035em;margin:0;line-height:1}
p{font-size:34px;color:#93A39B;margin:20px 0 34px;line-height:1.3;max-width:760px}
.chips{display:flex;gap:12px;flex-wrap:wrap} .chips span{font:600 20px "DejaVu Sans Mono",monospace;letter-spacing:.06em;color:#E9EFEC;border:1px solid #22302B;background:#111816;border-radius:999px;padding:9px 18px}
.chips span b{color:#FF8A3D;font-weight:700}
</style></head><body><div class="mark">MARK</div><div><h1>Smoke Signal</h1>
<p>Messages, photos and files over any radio, from one offline web page.</p>
<div class="chips"><span><b>&#9679;</b> 1200 / 300 baud</span><span>AX.25</span><span>Works offline</span></div></div></body></html>'''


def sized(svg, n):
    return svg.replace('width="512" height="512"', f'width="{n}" height="{n}"', 1)


def main():
    big = mark()
    small = mark(stroke=52, shadow=False, slow=200, x0=104, x1=408, amp=86)  # bolder, for 32 px and the favicon
    square = mark(corner=0)  # iOS rounds home-screen icons itself
    (HERE / "logo.svg").write_text(big)
    (HERE / "logo-small.svg").write_text(small)
    with sync_playwright() as p:
        b = p.chromium.launch()

        def shot(html, w, h, transparent=True):
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.set_content(html)
            png = pg.screenshot(omit_background=transparent)
            pg.close()
            return Image.open(io.BytesIO(png))

        for size, name, svg in [(512, "icon-512.png", big), (192, "icon-192.png", big), (32, "favicon-32.png", small)]:
            shot(f'<body style="margin:0;background:transparent">{sized(svg, size)}</body>', size, size).save(HERE / name, optimize=True)
        touch = shot(f'<body style="margin:0">{sized(square, 180)}</body>', 180, 180, transparent=False).convert("RGB")
        # Inlined into the page, so it is kept small: 256 dithered colours look identical on a gradient this soft.
        touch.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(HERE / "apple-touch-icon.png", optimize=True)
        shot(SOCIAL.replace("MARK", big), 1280, 640, transparent=False).save(HERE / "social-preview.png", optimize=True)
        b.close()
    for f in sorted(HERE.iterdir()):
        if f.suffix in (".png", ".svg"):
            print(f"{f.name:24} {f.stat().st_size:>8} bytes")


if __name__ == "__main__":
    main()

#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""Derive every app icon from docs/brand/icon-master.png.

The master is full-bleed square artwork (AI-generated, see docs/brand/README.md).
Transparent icons get a superellipse (squircle) mask; small sizes are cropped a
little tighter so the key stays readable at 16-48 px.

    ./scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "docs/brand/icon-master.png"
EXT_ICONS = ROOT / "extension/static/icons"
WEB = ROOT / "server/internal/web/static/assets"
EXT_ASSETS = ROOT / "extension/src/assets"
DOCS = ROOT / "docs/images"


def squircle_mask(size: int, n: float = 5.0, supersample: int = 4) -> Image.Image:
    big = size * supersample
    r = big / 2
    pts = []
    steps = 720
    import math

    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / n), c)
        y = r + r * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def art(master: Image.Image, size: int, zoom: float = 1.0) -> Image.Image:
    """Full-bleed artwork at `size`; zoom > 1 crops the center tighter."""
    w = master.width
    crop = round(w / zoom)
    off = (w - crop) // 2
    return master.crop((off, off, off + crop, off + crop)).resize((size, size), Image.LANCZOS)


def rounded(master: Image.Image, size: int, padding: int = 0) -> Image.Image:
    inner = size - 2 * padding
    zoom = 1.18 if inner <= 48 else 1.0
    tile = art(master, inner, zoom).convert("RGBA")
    tile.putalpha(squircle_mask(inner))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(tile, (padding, padding), tile)
    return out


def save(img: Image.Image, path: Path, **kw) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True, **kw)
    print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}  {path.stat().st_size // 1024} KiB")


def main() -> None:
    master = Image.open(MASTER).convert("RGB")

    # Chrome extension: toolbar / management page icons, plus the logo used in the page UI.
    for s in (16, 32, 48):
        save(rounded(master, s), EXT_ICONS / f"icon-{s}.png")
    save(rounded(master, 128, padding=8), EXT_ICONS / "icon-128.png")
    save(rounded(master, 128), EXT_ICONS / "logo-128.png")
    save(rounded(master, 64), EXT_ASSETS / "logo-64.png")

    # Web console: favicon, brand mark, PWA and iOS icons.
    save(rounded(master, 48), WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    save(rounded(master, 32), WEB / "favicon-32.png")
    save(rounded(master, 128), WEB / "logo-128.png")
    save(rounded(master, 192), WEB / "icon-192.png")
    save(rounded(master, 512), WEB / "icon-512.png")
    save(art(master, 512), WEB / "icon-maskable-512.png")
    save(art(master, 180), WEB / "apple-touch-icon.png")

    # README.
    save(rounded(master, 512), DOCS / "logo.png")


if __name__ == "__main__":
    main()

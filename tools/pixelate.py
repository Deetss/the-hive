"""True pixel-art post-processing for AI (FLUX/Foundry) generations.

Turns a soft, anti-aliased raw generation into mathematically clean pixel art:
a strict grid, a fixed small palette, no intermediate AA pixels, optional
seamless tiling, and a true alpha key. Requires numpy + Pillow; scikit-learn is
used for K-Means if present, otherwise a numpy K-Means fallback runs.

Pipeline order is deliberate (see PixelArtPipeline.run):
  downscale-to-grid -> palette snap -> key background -> (tile enforce) -> upscale
Snapping the SMALL image and keying the FLAT palette result is what removes the
anti-aliased fringe that block-averaging alone leaves behind.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
from PIL import Image


# ─── color helpers ────────────────────────────────────────────────────────────
def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def palette_array(palette: Sequence[str | tuple[int, int, int]]) -> np.ndarray:
    out = []
    for c in palette:
        out.append(hex_to_rgb(c) if isinstance(c, str) else tuple(c))
    return np.asarray(out, dtype=np.float64)


# ─── 1. quantize to a strict pixel grid ───────────────────────────────────────
def quantize_to_grid(
    img: Image.Image,
    grid: int = 64,
    keep_aspect: bool = True,
    downscale_filter: int = Image.BOX,
) -> Image.Image:
    """Collapse a high-res generation onto a strict `grid`-cell lattice.

    Downsampling with BOX (area average) makes each output cell the mean of the
    source block, which reads as one clean pixel once the palette is snapped.
    NEAREST is offered but samples a single source pixel per cell, so it keeps
    generation noise; BOX is the right default for "true" pixel art.
    """
    img = img.convert("RGBA")
    if keep_aspect:
        w, h = img.size
        if w >= h:
            tw, th = grid, max(1, round(grid * h / w))
        else:
            tw, th = max(1, round(grid * w / h)), grid
    else:
        tw = th = grid
    # Downscale RGB and alpha separately so the average never bleeds fully
    # transparent color values into opaque edge cells.
    return img.resize((tw, th), downscale_filter)


# ─── 2. palette snapping ───────────────────────────────────────────────────────
def _kmeans_centroids(pixels: np.ndarray, k: int, seed: int = 0) -> np.ndarray:
    try:
        from sklearn.cluster import KMeans

        km = KMeans(n_clusters=k, n_init=4, random_state=seed).fit(pixels)
        return km.cluster_centers_
    except Exception:
        return _numpy_kmeans(pixels, k, seed)


def _numpy_kmeans(pixels: np.ndarray, k: int, seed: int = 0, iters: int = 25) -> np.ndarray:
    rng = np.random.default_rng(seed)
    k = min(k, len(np.unique(pixels, axis=0)))
    cent = pixels[rng.choice(len(pixels), k, replace=False)].astype(np.float64)
    for _ in range(iters):
        d = ((pixels[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        new = np.array(
            [pixels[lab == i].mean(0) if np.any(lab == i) else cent[i] for i in range(k)]
        )
        if np.allclose(new, cent):
            break
        cent = new
    return cent


def _snap_pixels(rgb: np.ndarray, palette: np.ndarray) -> np.ndarray:
    """Map every RGB row to its nearest palette color (Euclidean in linear RGB)."""
    d = ((rgb[:, None, :] - palette[None, :, :]) ** 2).sum(-1)
    return palette[d.argmin(1)]


def snap_palette_kmeans(img: Image.Image, n: int = 16, seed: int = 0) -> Image.Image:
    """Reduce to `n` colors discovered by K-Means over the opaque pixels."""
    arr = np.asarray(img.convert("RGBA"), dtype=np.float64)
    rgb, a = arr[..., :3], arr[..., 3]
    mask = a > 8
    flat = rgb[mask]
    if len(flat) == 0:
        return img
    cent = _kmeans_centroids(flat, n, seed)
    snapped = rgb.copy()
    snapped[mask] = _snap_pixels(flat, cent)
    out = np.dstack([np.rint(snapped), a]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def snap_palette_fixed(
    img: Image.Image, palette: Sequence[str | tuple[int, int, int]]
) -> Image.Image:
    """Force the image into a supplied fixed palette (e.g. a 16/32-color ramp)."""
    pal = palette_array(palette)
    arr = np.asarray(img.convert("RGBA"), dtype=np.float64)
    rgb, a = arr[..., :3], arr[..., 3]
    mask = a > 8
    snapped = rgb.copy()
    snapped[mask] = _snap_pixels(rgb[mask], pal)
    out = np.dstack([np.rint(snapped), a]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


# ─── 3. alpha keying ───────────────────────────────────────────────────────────
def key_background(
    img: Image.Image,
    key: tuple[int, int, int] = (255, 0, 255),
    tol: float = 60.0,
    flood: bool = True,
) -> Image.Image:
    """Replace a solid key color with true (binary) transparency.

    `flood=True` only removes the key color connected to the image border, so an
    identical color used *inside* the sprite survives. Alpha is hard 0/255 to
    avoid reintroducing the semi-transparent halo that AA keying produces.
    """
    arr = np.asarray(img.convert("RGBA")).copy()
    rgb = arr[..., :3].astype(np.float64)
    near = np.sqrt(((rgb - np.asarray(key)) ** 2).sum(-1)) <= tol
    if flood:
        near = _border_connected(near)
    arr[..., 3] = np.where(near, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def _border_connected(mask: np.ndarray) -> np.ndarray:
    """Flood-fill the True region reachable from any edge pixel (4-connected)."""
    h, w = mask.shape
    out = np.zeros_like(mask)
    stack = []
    for x in range(w):
        if mask[0, x]:
            stack.append((0, x))
        if mask[h - 1, x]:
            stack.append((h - 1, x))
    for y in range(h):
        if mask[y, 0]:
            stack.append((y, 0))
        if mask[y, w - 1]:
            stack.append((y, w - 1))
    while stack:
        y, x = stack.pop()
        if y < 0 or x < 0 or y >= h or x >= w or out[y, x] or not mask[y, x]:
            continue
        out[y, x] = True
        stack.extend([(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)])
    return out


def despeckle_alpha(img: Image.Image, min_neighbors: int = 2) -> Image.Image:
    """Drop lone opaque pixels with too few opaque orthogonal neighbors."""
    arr = np.asarray(img.convert("RGBA")).copy()
    a = arr[..., 3] > 0
    nb = np.zeros_like(a, dtype=int)
    nb[1:, :] += a[:-1, :]; nb[:-1, :] += a[1:, :]
    nb[:, 1:] += a[:, :-1]; nb[:, :-1] += a[:, 1:]
    kill = a & (nb < min_neighbors)
    arr[kill, 3] = 0
    return Image.fromarray(arr, "RGBA")


# ─── 4. tileability ────────────────────────────────────────────────────────────
def check_tileable(img: Image.Image, tol: float = 8.0) -> dict:
    """Report how well the image wraps. Lower edge-diff = more seamless."""
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    hdiff = float(np.abs(a[:, -1] - a[:, 0]).mean())   # right meets left
    vdiff = float(np.abs(a[-1, :] - a[0, :]).mean())   # bottom meets top
    return {
        "h_edge_diff": hdiff,
        "v_edge_diff": vdiff,
        "tile_x": hdiff <= tol,
        "tile_y": vdiff <= tol,
        "seamless": hdiff <= tol and vdiff <= tol,
    }


def enforce_tileable(
    img: Image.Image,
    palette: Sequence | None = None,
    border: int = 3,
    axes: str = "xy",
) -> Image.Image:
    """Blend a narrow wrap border so opposite edges meet, then re-snap to palette.

    Post-hoc enforcement always alters edge content; for production tiles prefer
    generating seamless (tile_x/tile_y at gen time, or the offset-and-inpaint
    trick). Re-snapping after the blend keeps edges hard (no new AA). Pass the
    same palette you snapped with so no off-palette colors are introduced.
    """
    arr = np.asarray(img.convert("RGBA"), dtype=np.float64)
    rgb, a = arr[..., :3].copy(), arr[..., 3:]
    h, w = rgb.shape[:2]
    if "x" in axes and w > 2 * border:
        for i in range(border):
            t = (i + 1) / (border + 1) * 0.5
            l, r = rgb[:, i].copy(), rgb[:, w - 1 - i].copy()
            rgb[:, i] = l * (1 - t) + r * t
            rgb[:, w - 1 - i] = r * (1 - t) + l * t
    if "y" in axes and h > 2 * border:
        for i in range(border):
            t = (i + 1) / (border + 1) * 0.5
            tp, bt = rgb[i, :].copy(), rgb[h - 1 - i, :].copy()
            rgb[i, :] = tp * (1 - t) + bt * t
            rgb[h - 1 - i, :] = bt * (1 - t) + tp * t
    out = Image.fromarray(np.dstack([np.rint(rgb), a]).astype(np.uint8), "RGBA")
    if palette is not None:
        out = snap_palette_fixed(out, palette)
    return out


# ─── 5. display upscale ────────────────────────────────────────────────────────
def upscale_nearest(img: Image.Image, factor: int) -> Image.Image:
    """Blow the grid up with NEAREST so every cell is a hard, chunky square."""
    w, h = img.size
    return img.resize((w * factor, h * factor), Image.NEAREST)


# ─── pipeline ──────────────────────────────────────────────────────────────────
@dataclass
class PixelArtPipeline:
    grid: int = 64
    colors: int = 16
    palette: Sequence | None = None          # fixed palette; overrides K-Means
    key: tuple[int, int, int] | None = (255, 0, 255)
    key_tol: float = 60.0
    key_flood: bool = True
    tile_axes: str | None = None             # e.g. "x" for conveyors, None to skip
    keep_aspect: bool = True
    downscale_filter: int = Image.BOX
    kmeans_seed: int = 0
    despeckle: bool = True

    def run(self, img: Image.Image) -> Image.Image:
        small = quantize_to_grid(img, self.grid, self.keep_aspect, self.downscale_filter)
        if self.palette is not None:
            small = snap_palette_fixed(small, self.palette)
        else:
            small = snap_palette_kmeans(small, self.colors, self.kmeans_seed)
        if self.key is not None:
            small = key_background(small, self.key, self.key_tol, self.key_flood)
            if self.despeckle:
                small = despeckle_alpha(small)
        if self.tile_axes:
            small = enforce_tileable(small, self.palette, axes=self.tile_axes)
        return small


# ─── curated retro palettes ────────────────────────────────────────────────────
PALETTES: dict[str, list[str]] = {
    # Factory / industrial 16 (steel, rust, belt-yellow, node-teal, warning-red)
    "factory16": [
        "#0d0f14", "#1b2028", "#2e3742", "#4a5a68", "#7d8a97", "#b8c2cc",
        "#e8edf2", "#3a2a1e", "#7a5230", "#c8892f", "#f2c14e", "#8a1f1f",
        "#d13b2f", "#1f6f6a", "#2fae9e", "#8ad0c8",
    ],
    # Classic DB16-style general purpose
    "db16": [
        "#140c1c", "#442434", "#30346d", "#4e4a4e", "#854c30", "#346524",
        "#d04648", "#757161", "#597dce", "#d27d2c", "#8595a1", "#6daa2c",
        "#d2aa99", "#6dc2ca", "#dad45e", "#deeed6",
    ],
}


if __name__ == "__main__":
    import argparse, sys

    ap = argparse.ArgumentParser(description="AI generation -> true pixel art")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--grid", type=int, default=64)
    ap.add_argument("--colors", type=int, default=16)
    ap.add_argument("--palette", choices=list(PALETTES), default=None)
    ap.add_argument("--key", default="255,0,255", help="R,G,B or 'none'")
    ap.add_argument("--key-tol", type=float, default=60.0)
    ap.add_argument("--tile", default=None, help="x, y, or xy")
    ap.add_argument("--upscale", type=int, default=0)
    args = ap.parse_args()

    key = None if args.key == "none" else tuple(int(v) for v in args.key.split(","))
    pipe = PixelArtPipeline(
        grid=args.grid,
        colors=args.colors,
        palette=PALETTES.get(args.palette),
        key=key,
        key_tol=args.key_tol,
        tile_axes=args.tile,
    )
    out = pipe.run(Image.open(args.input))
    print("tileability:", check_tileable(out), file=sys.stderr)
    if args.upscale:
        out = upscale_nearest(out, args.upscale)
    out.save(args.output)
    print(f"wrote {args.output} {out.size}", file=sys.stderr)

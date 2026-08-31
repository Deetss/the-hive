// Rendering helpers for the Hive bee cast.
//
// Unlike the procedural zergPortraitArt, the bee cast ships as authored PNG
// sprites (see src/assets/hive/*.png, generated from BeeYoncé's approved
// roster). These helpers turn one authored still into the scene's walk-frame
// grid and paint the same still as a static portrait. hiveCast.ts owns the
// roster and the asset URLs; this module is the reusable draw layer.

import { Texture } from 'pixi.js';
import { PORTRAIT_W, PORTRAIT_H } from './portraitArt';

/**
 * Build the frame grid CharacterSprite expects — 3 rows (down, up, right) × 7
 * frames [walk1, walk2, walk3, type1, type2, read1, read2] — from a single
 * authored still. There is one pose, so motion is procedural: the three
 * animated columns are a bob+sway cycle (base → up + lean-right → higher +
 * lean-left). Every frame shares one padded canvas so the anchor stays put.
 * Mirrors zergCast's loadAssetFrames (the abathur asset path).
 */
export async function loadHiveFrames(url: string): Promise<Texture[][]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const PADX = 3, PADT = 3; // room for the sway/bob so nothing clips
  const mk = (dx: number, dy: number): Texture => {
    const c = document.createElement('canvas');
    c.width = img.width + PADX * 2; c.height = img.height + PADT;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, PADX + dx, PADT + dy);
    const tex = Texture.from(c);
    tex.source.scaleMode = 'nearest';
    return tex;
  };
  const f0 = mk(0, 0), f1 = mk(1, -1), f2 = mk(-1, -2);
  const row = [f0, f1, f2, f0, f0, f0, f0]; // cols 0,1,2 are the animated cycle
  return [row, row, row]; // the front pose serves every direction
}

/** Paint a bee's authored still as a static portrait for cards / the picker.
 *  The square bee is scaled to COVER the portrait footprint (PORTRAIT_W ×
 *  PORTRAIT_H) by height, centered — the wing tips crop at the sides so the body,
 *  stripes, and head fill the avatar the way the office portraits do. Nearest-
 *  neighbour keeps the pixel art crisp at whole and half scales. */
export async function paintHivePortrait(
  ctx: CanvasRenderingContext2D,
  url: string,
  scale = 2,
): Promise<void> {
  const img = new Image();
  img.src = url;
  await img.decode();
  ctx.imageSmoothingEnabled = false;
  const boxW = PORTRAIT_W * scale, boxH = PORTRAIT_H * scale;
  const size = boxH; // square bee, fill the box height
  const dx = Math.round((boxW - size) / 2); // center (negative → wing tips crop)
  ctx.drawImage(img, dx, 0, size, size);
}

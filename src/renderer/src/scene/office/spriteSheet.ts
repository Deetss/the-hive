import { Texture } from 'pixi.js';

// Slice an authored sprite strip (equal-size frames laid out along one axis) into
// per-frame nearest-neighbour textures. Mirrors zergCast's loadSlitherFrames /
// hivePortraitArt's frame cutting, factored out so the scene's small authored
// sheets (message envelope, desk screen, tool glyphs) share one loader.
//
// The result is cached per URL: these sheets are tiny and shared across every
// instance (every envelope in flight, every lit desk), so one decode is enough.

type Axis = 'x' | 'y';

const cache = new Map<string, Promise<Texture[]>>();

async function slice(url: string, count: number, axis: Axis): Promise<Texture[]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const fw = axis === 'x' ? Math.floor(img.width / count) : img.width;
  const fh = axis === 'y' ? Math.floor(img.height / count) : img.height;
  const frames: Texture[] = [];
  for (let f = 0; f < count; f++) {
    const c = document.createElement('canvas');
    c.width = fw;
    c.height = fh;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const sx = axis === 'x' ? f * fw : 0;
    const sy = axis === 'y' ? f * fh : 0;
    ctx.drawImage(img, sx, sy, fw, fh, 0, 0, fw, fh);
    const tex = Texture.from(c);
    tex.source.scaleMode = 'nearest';
    frames.push(tex);
  }
  return frames;
}

/** Load + slice a strip once (cached by URL). Frames are returned in sheet order.
 *  On a decode/load failure the rejection is cached-cleared so a later call can
 *  retry; callers should treat the sheet as optional and keep a fallback. */
export function loadFrameStrip(url: string, count: number, axis: Axis): Promise<Texture[]> {
  let p = cache.get(url);
  if (!p) {
    p = slice(url, count, axis).catch((e) => {
      cache.delete(url);
      console.warn('[spriteSheet] failed to load', url.slice(0, 64), e);
      throw e;
    });
    cache.set(url, p);
  }
  return p;
}

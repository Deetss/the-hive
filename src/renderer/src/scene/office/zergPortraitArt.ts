// Procedural portraits + walking sprites for the Zerg brood (The Hive theme).
//
// Same approach as portraitArt.ts (The Office): each unit is a recipe drawn pixel
// by pixel on an 18×28 portrait canvas / 18×32 scene canvas, so a brood on the
// floor matches its card. Instead of skin/hair/clothing the primitives here are
// chitin carapace, glowing eyes, mandibles, and crest spikes, tinted per unit and
// shaped by a coarse silhouette (small / tall / wide / wing). See zergCast.ts.

import { PORTRAIT_W, PORTRAIT_H, SCENE_W, SCENE_H } from './portraitArt';

type RGB = [number, number, number];
type Buf = Uint8ClampedArray;

const OUTLINE: RGB = [22, 18, 30];

// Current canvas dims, set per compose() so the primitives serve both sizes.
let CUR_W = PORTRAIT_W, CUR_H = PORTRAIT_H;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function shades(rgb: RGB, dl = 1.28, dd = 0.62): [RGB, RGB, RGB] {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)],
  ];
}
function set(buf: Buf, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return;
  const i = (y * CUR_W + x) * 4;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
}
function alphaAt(buf: Buf, x: number, y: number): number {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return 0;
  return buf[(y * CUR_W + x) * 4 + 3];
}
function rect(buf: Buf, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(buf, x, y, c);
}
/** A glowing eye: a hot (brightened toward white) core with a faint colored halo
 *  on its four neighbors, so eyes read strongly even at 18px. */
function glowEye(buf: Buf, x: number, y: number, c: RGB): void {
  const halo: RGB = c;
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) set(buf, x + dx, y + dy, halo, 80);
  set(buf, x, y, [Math.min(255, c[0] + 70), Math.min(255, c[1] + 70), Math.min(255, c[2] + 50)]);
}

/** A soft outline around every opaque pixel that borders transparency. */
function outlinePass(buf: Buf): void {
  const edges: [number, number][] = [];
  for (let y = 0; y < CUR_H; y++) {
    for (let x = 0; x < CUR_W; x++) {
      if (alphaAt(buf, x, y) !== 0) continue;
      if (alphaAt(buf, x - 1, y) || alphaAt(buf, x + 1, y) ||
          alphaAt(buf, x, y - 1) || alphaAt(buf, x, y + 1)) edges.push([x, y]);
    }
  }
  for (const [x, y] of edges) set(buf, x, y, OUTLINE);
}

// ─── recipe ──────────────────────────────────────────────────────────────────
export type ZergFrame = 'small' | 'tall' | 'wide' | 'wing';
export interface ZergRecipe {
  /** Silhouette family. */
  frame: ZergFrame;
  /** Main chitin color. */
  carapace: RGB;
  /** Spikes / claws / mandibles / ridge accent. */
  accent: RGB;
  /** Glowing eye color. */
  eye: RGB;
  /** Eye count (1 to 6). */
  eyes: number;
  /** Extra dorsal/crest spikes. */
  spiky?: boolean;
  /** Relative body size on the floor, 0.5 (tiny, e.g. zergling) to 1.0 (huge,
   *  e.g. ultralisk). Bottom-aligned to the ground so bulk differs per lore. */
  size?: number;
}

// ─── head (portrait bust) ──────────────────────────────────────────────────────
// A chitin dome centered on cols 4..13, rows 5..17, with a ridge highlight, side
// shade, glowing eyes, mandibles, and crest spikes above.
function drawCarapaceHead(buf: Buf, r: ZergRecipe): void {
  const [hi, base, sh] = shades(r.carapace);
  const [aHi, aBase, aSh] = shades(r.accent);
  const cx = 9;
  const MAW: RGB = [18, 14, 22];
  // Elongated reptilian skull: a wide ridged brow tapering to a fanged snout.
  const rows: [number, number, number][] = [
    [7, 11, 4], [6, 12, 5], [5, 13, 6], [4, 13, 7], [4, 13, 8], [4, 13, 9],
    [5, 12, 10], [5, 12, 11], [6, 11, 12], [6, 11, 13],
    [7, 10, 14], [7, 10, 15], [8, 9, 16],
  ];
  for (const [x0, x1, y] of rows) { rect(buf, x0, y, x1, y, base); set(buf, x0, y, hi); set(buf, x1, y, sh); }
  for (let x = 5; x <= 12; x++) set(buf, x, 9, sh); // brow ridge shade

  // crest horns swept up off the cranium
  const horns = r.spiky ? [-4, -1, 1, 4] : [-3, 3];
  for (const dx of horns) { set(buf, cx + dx, 3, aBase); set(buf, cx + dx, 2, aBase); if (r.spiky) set(buf, cx + dx, 1, aSh); }
  set(buf, cx, 3, aBase); set(buf, cx, 2, aHi);

  // flared cheek/mandible plates (two-tone)
  for (const [mx, dir] of [[3, -1], [14, 1]] as const) { set(buf, mx, 11, aBase); set(buf, mx, 12, aBase); set(buf, mx + dir, 12, aSh); set(buf, mx, 13, aSh); }

  for (const [ex, ey] of eyeColumns(r.eyes, 4, 13)) glowEye(buf, ex, 7 + (ey === 0 ? 0 : 1), r.eye);

  // fanged open maw
  rect(buf, 7, 14, 10, 15, MAW);
  set(buf, 7, 16, MAW); set(buf, 10, 16, MAW);
  set(buf, 6, 13, aBase); set(buf, 11, 13, aBase); // upper tusks
  set(buf, 6, 14, aSh); set(buf, 11, 14, aSh);
  set(buf, 7, 17, aHi); set(buf, 10, 17, aHi);     // lower fangs
}

/** Positions for N glowing eyes. y=0 → top eye row, y=1 → lower row (for >2). */
function eyeColumns(n: number, x0: number, x1: number): [number, number][] {
  const cx = (x0 + x1) / 2;
  const out: [number, number][] = [];
  const add = (x: number, y: number) => out.push([Math.round(x), y]);
  if (n <= 2) { add(cx - 2, 0); if (n === 2) add(cx + 2, 0); }
  else if (n === 3) { add(cx - 3, 0); add(cx + 3, 0); add(cx, 1); }
  else if (n === 4) { add(cx - 3, 0); add(cx + 3, 0); add(cx - 2, 1); add(cx + 2, 1); }
  else { add(cx - 3, 0); add(cx, 0); add(cx + 3, 0); add(cx - 2, 1); add(cx + 2, 1); if (n >= 6) add(cx, 1); }
  return out;
}

// ─── carapace neck / shoulders (portrait) ──────────────────────────────────────
function drawCarapaceShoulders(buf: Buf, r: ZergRecipe): void {
  const [hi, base, sh] = shades(r.carapace);
  const [, aBase] = shades(r.accent);
  rect(buf, 5, 18, 12, 19, sh);        // neck plate
  rect(buf, 3, 20, 14, 27, base);      // shoulder carapace
  for (let y = 20; y <= 27; y++) { set(buf, 3, y, hi); set(buf, 14, y, sh); }
  // segment ridges
  for (const y of [22, 25]) for (let x = 4; x <= 13; x++) set(buf, x, y, sh);
  // shoulder spikes
  if (r.frame !== 'wing') { set(buf, 2, 21, aBase); set(buf, 15, 21, aBase); }
  else { // folded wing hints
    for (let y = 20; y <= 24; y++) { set(buf, 2, y, aBase); set(buf, 15, y, aBase); }
  }
}

// ─── scene sprite (18×32 walker) ───────────────────────────────────────────────
const GROUND = 31; // feet rest on this row; every creature is bottom-aligned here
const walk = (phase: number, i: number) => (i % 2 === 0 && phase === 1) || (i % 2 === 1 && phase === 2);

/** A scalable snouted head: half-width `hw` (2..4) tapering to a fanged snout,
 *  with crest horns, glowing eyes, and mandible tusks. Bigger units get bigger
 *  heads. Returns the row just below the head (where the neck/body begins). */
function drawZergHead(buf: Buf, r: ZergRecipe, cx: number, topY: number, hw: number, back: boolean): number {
  const [hi, base, sh] = shades(r.carapace);
  const [, aBase] = shades(r.accent);
  const H = hw * 2 + 1;
  for (let i = 0; i <= H; i++) {
    const w = Math.max(0, Math.round(hw - (i / H) * (hw - 0.4) * 1.5));
    const y = topY + i;
    rect(buf, cx - w, y, cx + w, y, base);
    set(buf, cx - w, y, hi); set(buf, cx + w, y, sh);
  }
  for (const dx of (r.spiky ? [-hw, -1, 1, hw] : [-hw + 1, hw - 1])) {
    set(buf, cx + dx, topY - 1, aBase); set(buf, cx + dx, topY - 2, aBase);
  }
  if (!back) {
    for (const [ex, ey] of eyeColumns(r.eyes, cx - hw, cx + hw)) glowEye(buf, ex, topY + 1 + (ey === 0 ? 0 : 1), r.eye);
    const my = topY + H - 1;
    set(buf, cx - 1, my, [18, 14, 22]); set(buf, cx, my, [18, 14, 22]); set(buf, cx + 1, my, [18, 14, 22]);
    set(buf, cx - 2, my - 1, aBase); set(buf, cx + 2, my - 1, aBase);
  } else {
    for (let i = 0; i < H; i++) set(buf, cx, topY + i, sh);
  }
  return topY + H;
}

/** Bottom-aligned scene sprite. `r.size` (0.5 tiny to 1.0 huge) scales the whole
 *  creature so bulk differs per lore; the archetype `frame` sets the silhouette. */
function drawSceneBody(buf: Buf, r: ZergRecipe, phase: number, back: boolean): void {
  const [hi, base, sh] = shades(r.carapace);
  const [aHi, aBase, aSh] = shades(r.accent);
  const cx = 9;
  const size = Math.max(0.5, Math.min(1, r.size ?? 0.8));
  const bh = Math.round(size * 27);
  const top = GROUND - bh;
  const hw = Math.max(2, Math.round(1.5 + size * 2.6)); // head half-width 2..4

  const body = (x0: number, y0: number, x1: number, y1: number) => {
    rect(buf, x0, y0, x1, y1, base);
    for (let y = y0; y <= y1; y++) { set(buf, x0, y, hi); set(buf, x1, y, sh); }
  };
  const dorsal = (y0: number, y1: number) => { for (let y = y0; y <= y1; y += 2) set(buf, cx, y - 1, r.spiky ? aBase : aSh); };
  const leg = (x0: number, x1: number, up: boolean) => {
    const t = up ? GROUND - 3 : GROUND - 2;
    rect(buf, x0, t, x1, GROUND, base);
    for (let y = t; y <= GROUND; y++) set(buf, x1, y, sh);
    set(buf, x0, GROUND, aBase);
  };
  const legs = (xs: [number, number][]) => xs.forEach(([a, b], i) => leg(a, b, walk(phase, i)));

  if (r.frame === 'small') {
    // hunched quadruped: big head, compact body, four short legs
    const neck = drawZergHead(buf, r, cx, top, hw, back);
    const bw = Math.max(3, Math.round(size * 6));
    body(cx - bw, neck - 1, cx + bw, GROUND - 3);
    rect(buf, cx - bw + 1, GROUND - 4, cx + bw - 1, GROUND - 3, aSh);
    dorsal(neck, GROUND - 4);
    legs([[cx - bw, cx - bw + 2], [cx - 2, cx], [cx + 1, cx + 3], [cx + bw - 2, cx + bw]]);
    return;
  }
  if (r.frame === 'tall') {
    // upright torso on a coiled base with scythe forelimbs
    const neck = drawZergHead(buf, r, cx - 1, top, hw, back);
    const bw = Math.max(2, Math.round(size * 3));
    const coilTop = GROUND - Math.round(bh * 0.32);
    body(cx - bw, neck - 1, cx + bw, coilTop);
    for (let x = cx - bw + 1; x <= cx + bw - 1; x++) set(buf, x, neck + 2, aSh);
    // coiled base
    body(3, coilTop, 14, GROUND - 1); rect(buf, 4, GROUND, 13, GROUND, sh);
    for (let x = 4; x <= 13; x += 2) set(buf, x, coilTop + 2, sh);
    // scythe arms
    const dy = phase === 1 ? -1 : 0;
    for (let i = 0; i < 5; i++) { set(buf, cx - bw - i, neck + 1 + i + dy, aBase); set(buf, cx + bw + i, neck + 1 + i - dy, aBase); }
    set(buf, Math.max(0, cx - bw - 5), neck + 6 + dy, aHi); set(buf, Math.min(17, cx + bw + 5), neck + 6 - dy, aHi);
    dorsal(neck, coilTop);
    return;
  }
  if (r.frame === 'wing') {
    // floats above the ground: bulbous sac body, membranous wings, tentacles
    const floatBottom = GROUND - 5;
    const neck = drawZergHead(buf, r, cx, top, hw, back);
    const bw = Math.max(3, Math.round(size * 4));
    body(cx - bw, neck - 1, cx + bw, floatBottom);
    rect(buf, cx - bw + 1, neck + 1, cx + bw - 1, floatBottom - 1, aSh); // sac
    // wings
    const wy = neck + (phase === 0 ? 0 : 1);
    for (let i = 0; i <= bw + 2; i++) {
      set(buf, cx - bw - i, wy + i, aBase); set(buf, cx - bw - i, wy + i, i === bw + 2 ? aHi : aBase);
      set(buf, cx + bw + i, wy + i, i === bw + 2 ? aHi : aBase);
      if (i > 0) { set(buf, cx - bw - i, wy + i - 1, aSh); set(buf, cx + bw + i, wy + i - 1, aSh); }
    }
    // dangling tentacles
    for (const tx of [cx - 2, cx, cx + 2]) for (let y = floatBottom; y <= GROUND - 1; y++) set(buf, tx + (y % 2), y, y > floatBottom + 2 ? aSh : sh);
    dorsal(neck, floatBottom);
    return;
  }
  // 'wide': broad low carapace, many legs, heavy dorsal spikes
  const neck = drawZergHead(buf, r, cx, top, hw, back);
  const bw = Math.max(5, Math.round(size * 7));
  body(cx - bw, neck - 1, cx + bw, GROUND - 3);
  rect(buf, cx - bw + 1, GROUND - 4, cx + bw - 1, GROUND - 3, aSh);
  for (let y = neck + 1; y <= GROUND - 5; y += 2) for (let x = cx - bw + 1; x <= cx + bw - 1; x++) set(buf, x, y, sh);
  for (const sx of [cx - bw + 1, cx, cx + bw - 1]) { set(buf, sx, neck - 1, aBase); if (r.spiky) { set(buf, sx, neck - 2, aBase); set(buf, sx, neck - 3, aSh); } }
  legs([[cx - bw, cx - bw + 2], [cx - 3, cx - 1], [cx + 1, cx + 3], [cx + bw - 2, cx + bw]]);
}

// Head is drawn inside drawSceneBody (its anchor depends on the frame + size).
function drawSceneHead(_buf: Buf, _r: ZergRecipe, _back: boolean): void { /* no-op */ }

// ─── compose ───────────────────────────────────────────────────────────────────
function composePortrait(r: ZergRecipe): Buf {
  CUR_W = PORTRAIT_W; CUR_H = PORTRAIT_H;
  const buf = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  drawCarapaceShoulders(buf, r);
  drawCarapaceHead(buf, r);
  outlinePass(buf);
  return buf;
}
function composeScene(r: ZergRecipe, phase: number, back: boolean): Buf {
  CUR_W = SCENE_W; CUR_H = SCENE_H;
  const buf = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  drawSceneBody(buf, r, phase, back);
  drawSceneHead(buf, r, back);
  outlinePass(buf);
  return buf;
}

// ─── public render ───────────────────────────────────────────────────────────
export interface ZergSceneFrames { front: Buf[]; back: Buf[]; }
const portraitCache = new Map<string, Buf>();
const sceneCache = new Map<string, ZergSceneFrames>();

export function zergPortraitBuf(name: string, r: ZergRecipe): Buf {
  let buf = portraitCache.get(name);
  if (!buf) { buf = composePortrait(r); portraitCache.set(name, buf); }
  return buf;
}
export function zergSceneFrameBufs(name: string, r: ZergRecipe): ZergSceneFrames {
  let frames = sceneCache.get(name);
  if (!frames) {
    frames = {
      front: [composeScene(r, 0, false), composeScene(r, 1, false), composeScene(r, 2, false)],
      back: [composeScene(r, 0, true), composeScene(r, 1, true), composeScene(r, 2, true)],
    };
    sceneCache.set(name, frames);
  }
  return frames;
}

/** Paint a brood's portrait onto `ctx`, nearest-neighbor at `scale`. */
export function paintZergPortrait(ctx: CanvasRenderingContext2D, name: string, r: ZergRecipe, scale = 2): void {
  const buf = zergPortraitBuf(name, r);
  const stage = document.createElement('canvas');
  stage.width = PORTRAIT_W; stage.height = PORTRAIT_H;
  const sctx = stage.getContext('2d')!;
  const img = sctx.createImageData(PORTRAIT_W, PORTRAIT_H);
  img.data.set(buf);
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
  ctx.drawImage(stage, 0, 0, PORTRAIT_W, PORTRAIT_H, 0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
}

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
}

// ─── head (portrait bust) ──────────────────────────────────────────────────────
// A chitin dome centered on cols 4..13, rows 5..17, with a ridge highlight, side
// shade, glowing eyes, mandibles, and crest spikes above.
function drawCarapaceHead(buf: Buf, r: ZergRecipe): void {
  const [hi, base, sh] = shades(r.carapace);
  const wide = r.frame === 'wide';
  const x0 = wide ? 3 : 4, x1 = wide ? 14 : 13;
  // dome
  for (let y = 6; y <= 16; y++) {
    for (let x = x0; x <= x1; x++) {
      const edgeTop = y <= 7 && (x === x0 || x === x1);
      const chin = y === 16 && (x <= x0 + 1 || x >= x1 - 1);
      if (edgeTop || chin) continue;
      set(buf, x, y, base);
    }
  }
  // top-left ridge highlight, right-side shade
  for (let y = 7; y <= 13; y++) set(buf, x0 + 1, y, hi);
  for (const x of [x0 + 2, x0 + 3]) set(buf, x, 6, hi);
  for (let y = 7; y <= 14; y++) set(buf, x1 - 1, y, sh);
  for (let x = x0 + 2; x <= x1 - 2; x++) set(buf, x, 16, sh);
  // brow ridge
  for (let x = x0 + 1; x <= x1 - 1; x++) set(buf, x, 9, sh);

  // crest spikes above the dome
  const [, aBase, aSh] = shades(r.accent);
  const crest = r.spiky ? [x0 + 1, x0 + 4, 7, 10, 13] : [6, 9, 12];
  for (const cx of crest) {
    set(buf, cx, 5, aBase); set(buf, cx, 4, aBase);
    if (r.spiky) set(buf, cx, 3, aSh);
  }

  // glowing eyes: rows 11 (and 12 for higher counts), spread across the face
  const eyeRow = 11;
  const cols = eyeColumns(r.eyes, x0, x1);
  for (const [ex, ey] of cols) {
    set(buf, ex, ey === 0 ? eyeRow : eyeRow + 1, r.eye);
    // a faint glow halo
    set(buf, ex, (ey === 0 ? eyeRow : eyeRow + 1) - 1, r.eye, 90);
  }

  // mandibles / tusks at the mouth
  set(buf, x0 + 2, 15, aBase); set(buf, x1 - 2, 15, aBase);
  set(buf, x0 + 2, 16, aSh);   set(buf, x1 - 2, 16, aSh);
  set(buf, x0 + 3, 16, aBase); set(buf, x1 - 3, 16, aBase);
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
function drawLegs(buf: Buf, r: ZergRecipe, phase: number): void {
  const [, base, sh] = shades(r.carapace);
  const [, aBase] = shades(r.accent);
  if (r.frame === 'wing') {
    // hovering: a stubby tucked underbelly + dangling claws instead of legs
    rect(buf, 6, 28, 11, 29, sh);
    set(buf, 6, 30, aBase); set(buf, 11, 30, aBase);
    return;
  }
  const legs: [number, number][] = r.frame === 'wide'
    ? [[3, 5], [7, 9], [12, 14]]   // low, many legs
    : [[5, 7], [10, 12]];
  const lift = phase; // 0 none, 1 left up, 2 right up
  legs.forEach(([lx0, lx1], i) => {
    const up = (i % 2 === 0 && lift === 1) || (i % 2 === 1 && lift === 2);
    const top = up ? 28 : 29, bot = up ? 30 : 31;
    rect(buf, lx0, top, lx1, bot, base);
    for (let y = top; y <= bot; y++) set(buf, lx1, y, sh);
    set(buf, lx0, bot, aBase); // claw
  });
}

function drawSceneBody(buf: Buf, r: ZergRecipe, phase: number, back: boolean): void {
  const [hi, base, sh] = shades(r.carapace);
  const [, aBase, aSh] = shades(r.accent);
  drawLegs(buf, r, phase);
  const wide = r.frame === 'wide';
  const tall = r.frame === 'tall';
  const bx0 = wide ? 3 : 4, bx1 = wide ? 14 : 13;
  const byTop = tall ? 15 : 17;
  rect(buf, bx0, byTop, bx1, 27, base);
  for (let y = byTop; y <= 27; y++) { set(buf, bx0, y, hi); set(buf, bx1, y, sh); }
  // dorsal spine ridge
  for (let y = byTop; y <= 26; y += 2) for (let x = bx0 + 2; x <= bx1 - 2; x++) set(buf, x, y, sh);
  if (r.spiky || back) for (let y = byTop; y <= 25; y += 2) { set(buf, Math.round((bx0 + bx1) / 2), y - 1, aSh); }
  // wings for the flyers
  if (r.frame === 'wing') {
    const wy = 16 + (phase === 0 ? 0 : 1);
    for (let i = 0; i < 4; i++) { set(buf, bx0 - 1 - i, wy + i, aBase); set(buf, bx1 + 1 + i, wy + i, aBase); }
    for (let i = 0; i < 3; i++) { set(buf, bx0 - 1 - i, wy + i + 1, aSh); set(buf, bx1 + 1 + i, wy + i + 1, aSh); }
  }
}

function drawSceneHead(buf: Buf, r: ZergRecipe, back: boolean): void {
  const [hi, base, sh] = shades(r.carapace);
  const [, aBase] = shades(r.accent);
  rect(buf, 5, 5, 12, 14, base);
  for (let y = 5; y <= 14; y++) { set(buf, 5, y, hi); set(buf, 12, y, sh); }
  // crest
  for (const cx of (r.spiky ? [6, 9, 12] : [7, 10])) { set(buf, cx, 4, aBase); set(buf, cx, 3, aBase); }
  if (back) {
    for (let y = 6; y <= 13; y++) set(buf, 8, y, sh); // spine seam on the back of the head
    return;
  }
  // eyes + mandibles (front)
  for (const [ex, ey] of eyeColumns(r.eyes, 5, 12)) set(buf, ex, ey === 0 ? 9 : 10, r.eye);
  set(buf, 6, 13, aBase); set(buf, 11, 13, aBase);
}

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

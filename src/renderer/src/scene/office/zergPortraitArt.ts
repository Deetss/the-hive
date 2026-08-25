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
/** An elongated, snouted head anchored at center `cx`, top row `topY`: brow
 *  tapering to a fanged snout, crest horns, glowing eyes, mandible tusks. */
function drawZergHead(buf: Buf, r: ZergRecipe, cx: number, topY: number, back: boolean): void {
  const [hi, base, sh] = shades(r.carapace);
  const [, aBase] = shades(r.accent);
  const rows: [number, number][] = [[cx - 3, cx + 3], [cx - 3, cx + 3], [cx - 2, cx + 2], [cx - 2, cx + 2], [cx - 1, cx + 1]];
  rows.forEach(([x0, x1], i) => { rect(buf, x0, topY + i, x1, topY + i, base); set(buf, x0, topY + i, hi); set(buf, x1, topY + i, sh); });
  // crest horns sweeping up
  for (const dx of (r.spiky ? [-3, 0, 3] : [-2, 2])) { set(buf, cx + dx, topY - 1, aBase); set(buf, cx + dx, topY - 2, aBase); if (r.spiky) set(buf, cx + dx, topY - 3, sh); }
  if (back) { for (let i = 0; i < 4; i++) set(buf, cx, topY + i, sh); return; }
  for (const [ex, ey] of eyeColumns(r.eyes, cx - 3, cx + 3)) glowEye(buf, ex, topY + 1 + (ey === 0 ? 0 : 1), r.eye);
  set(buf, cx, topY + 4, [20, 16, 24]);                                   // fanged maw
  set(buf, cx - 1, topY + 5, aBase); set(buf, cx + 1, topY + 5, aBase);   // tusks
}

const walk = (phase: number, i: number) => (i % 2 === 0 && phase === 1) || (i % 2 === 1 && phase === 2);
function drawLeg(buf: Buf, x0: number, x1: number, up: boolean, base: RGB, sh: RGB, claw: RGB): void {
  const top = up ? 27 : 28;
  rect(buf, x0, top, x1, 30, base);
  for (let y = top; y <= 30; y++) set(buf, x1, y, sh);
  rect(buf, x0, 31, x0 + 1, 31, claw);
}

function drawSceneBody(buf: Buf, r: ZergRecipe, phase: number, back: boolean): void {
  const [hi, base, sh] = shades(r.carapace);
  const [aHi, aBase, aSh] = shades(r.accent);
  const dorsal = (x0: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y += 2) set(buf, x0, y - 1, r.spiky ? aBase : aSh); };

  if (r.frame === 'small') {
    // hunched quadruped: compact body + four splayed legs
    rect(buf, 4, 17, 13, 25, base);
    for (let y = 17; y <= 25; y++) { set(buf, 4, y, hi); set(buf, 13, y, sh); }
    rect(buf, 5, 24, 12, 25, aSh); // low belly plate (two-tone)
    dorsal(9, 18, 24);
    [[1, 3], [5, 7], [10, 12], [14, 16]].forEach(([a, b], i) => drawLeg(buf, a, b, walk(phase, i), base, sh, aBase));
    drawZergHead(buf, r, 9, 9, back);
    return;
  }
  if (r.frame === 'tall') {
    // upright torso on a coiled base, scythe forelimbs
    rect(buf, 6, 12, 11, 23, base);
    for (let y = 12; y <= 23; y++) { set(buf, 6, y, hi); set(buf, 11, y, sh); }
    for (let x = 7; x <= 10; x++) set(buf, x, 16, aSh); // chest plate seam
    // coiled base
    rect(buf, 3, 24, 14, 29, base); rect(buf, 4, 30, 13, 30, sh);
    for (let x = 4; x <= 13; x += 2) set(buf, x, 26, sh);
    // scythe arms (sweep out + down), lift with walk
    const dy = phase === 1 ? -1 : 0;
    for (let i = 0; i < 5; i++) { set(buf, 5 - i, 14 + i + dy, aBase); set(buf, 12 + i, 14 + i - dy, aBase); }
    set(buf, 0, 19 + dy, aHi); set(buf, 17, 19 - dy, aHi); // blade tips
    dorsal(8, 13, 23);
    drawZergHead(buf, r, 8, 3, back);
    return;
  }
  if (r.frame === 'wing') {
    // floating bulbous body, big membranous wings, dangling tentacles
    rect(buf, 6, 12, 12, 22, base);
    for (let y = 12; y <= 22; y++) { set(buf, 6, y, hi); set(buf, 12, y, sh); }
    rect(buf, 7, 15, 11, 20, aSh); // sac (two-tone belly)
    // wings: triangles sweeping out from the shoulders, flap with phase
    const wy = 9 + (phase === 0 ? 0 : 1);
    for (let i = 0; i <= 5; i++) {
      rect(buf, 5 - i, wy + i, 5, wy + i, aBase); set(buf, 5 - i, wy + i, aHi);
      rect(buf, 13, wy + i, 13 + i, wy + i, aBase); set(buf, 13 + i, wy + i, aHi);
    }
    // dangling tentacles
    for (const tx of [7, 9, 11]) { for (let y = 23; y <= 29; y++) set(buf, tx + (y % 2), y, y > 26 ? aSh : sh); }
    dorsal(9, 12, 20);
    drawZergHead(buf, r, 9, 11, back);
    return;
  }
  // 'wide': broad low carapace, many legs, heavy dorsal spikes
  rect(buf, 2, 15, 15, 26, base);
  for (let y = 15; y <= 26; y++) { set(buf, 2, y, hi); set(buf, 15, y, sh); }
  rect(buf, 3, 24, 14, 26, aSh); // underplate
  for (let y = 16; y <= 25; y += 2) for (let x = 4; x <= 13; x++) set(buf, x, y, sh); // segment ridges
  for (const sx of [4, 8, 13]) { set(buf, sx, 14, aBase); set(buf, sx, 13, r.spiky ? aBase : aSh); if (r.spiky) set(buf, sx, 12, aSh); }
  [[1, 3], [5, 7], [8, 10], [12, 14]].forEach(([a, b], i) => drawLeg(buf, a, b, walk(phase, i), base, sh, aBase));
  drawZergHead(buf, r, 9, 8, back);
}

// Head is drawn inside drawSceneBody (its anchor depends on the frame).
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

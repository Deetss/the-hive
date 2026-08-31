// The Zerg brood, roster metadata + procedural sprites/portraits (The Hive theme).
//
// Mirrors cast.ts: a selectable roster plus scene walking frames and static
// portraits, all drawn procedurally (see zergPortraitArt.ts). Abathur fills the
// god/orchestrator seat and is the default character. See ZERG-RESKIN.md.

import { Texture } from 'pixi.js';
import { SCENE_W, SCENE_H } from './portraitArt';
import {
  paintZergPortrait,
  zergSceneFrameBufs,
  type ZergRecipe,
} from './zergPortraitArt';

// Authored sprite assets (FLUX-generated from the official refs, background keyed
// out, downscaled). A unit with an asset uses it instead of the procedural
// drawing; the rest fall back to procedural until their asset lands.
import abathurUrl from '@/assets/zerg/abathur-slither.png?url';
const ASSET_URLS: Partial<Record<ZergCharacterName, string>> = {
  abathur: abathurUrl,
};

// Serpentine units animate as a continuous loop sliced from an authored
// horizontal sprite sheet (N frames), instead of the walk cycle.
const SLITHER: ReadonlySet<ZergCharacterName> = new Set<ZergCharacterName>(['abathur']);
export function zergIsSlither(name: string): boolean {
  return SLITHER.has(name as ZergCharacterName);
}

export type ZergCharacterName =
  | 'abathur' | 'queen' | 'drone' | 'zergling' | 'hydralisk' | 'roach'
  | 'overlord' | 'mutalisk' | 'ultralisk' | 'baneling' | 'infestor'
  | 'corruptor' | 'broodlord' | 'viper' | 'lurker';

export interface ZergCastMember {
  name: ZergCharacterName;
  displayName: string;
  /** Signature accent color (hex), used for the in-scene selection glow. */
  shirt: string;
  blurb: string;
}

/** Per-unit art recipe. Palette follows the official Blizzard concept art
 *  (refs/zerg/official-*.png): muted dusty purples + burnt browns/oranges + bone,
 *  with bioluminescent ORANGE eyes on most units and GREEN on the psionic /
 *  evolution / acid units (Abathur, Queen, Baneling, Infestor, Viper). */
const RECIPES: Record<ZergCharacterName, ZergRecipe> = {
  abathur:   { frame: 'wide',  size: 0.82, carapace: [122, 124, 102], accent: [200, 190, 160], eye: [150, 230, 100], eyes: 5, spiky: true },
  queen:     { frame: 'tall',  size: 0.95, carapace: [112, 72, 122],  accent: [180, 140, 92],  eye: [140, 220, 90],  eyes: 3, spiky: true },
  drone:     { frame: 'small', size: 0.62, carapace: [178, 110, 60],  accent: [120, 80, 112],  eye: [255, 150, 60],  eyes: 2 },
  zergling:  { frame: 'small', size: 0.55, carapace: [132, 96, 112],  accent: [210, 196, 168], eye: [255, 140, 50],  eyes: 2, spiky: true },
  hydralisk: { frame: 'tall',  size: 0.85, carapace: [160, 96, 60],   accent: [210, 195, 165], eye: [255, 150, 60],  eyes: 2, spiky: true },
  roach:     { frame: 'wide',  size: 0.72, carapace: [120, 84, 58],   accent: [110, 74, 104],  eye: [255, 150, 60],  eyes: 2 },
  overlord:  { frame: 'wing',  size: 0.92, carapace: [88, 60, 88],    accent: [140, 96, 140],  eye: [255, 150, 50],  eyes: 3 },
  mutalisk:  { frame: 'wing',  size: 0.68, carapace: [128, 84, 96],   accent: [200, 180, 150], eye: [255, 150, 60],  eyes: 2 },
  ultralisk: { frame: 'wide',  size: 1.0,  carapace: [110, 96, 84],   accent: [210, 196, 168], eye: [255, 150, 60],  eyes: 2, spiky: true },
  baneling:  { frame: 'small', size: 0.55, carapace: [150, 168, 80],  accent: [90, 120, 50],   eye: [200, 240, 120], eyes: 3 },
  infestor:  { frame: 'wide',  size: 0.70, carapace: [110, 130, 88],  accent: [110, 80, 110],  eye: [180, 240, 120], eyes: 5 },
  corruptor: { frame: 'wing',  size: 0.75, carapace: [96, 64, 110],   accent: [150, 100, 150], eye: [255, 150, 60],  eyes: 3 },
  broodlord: { frame: 'wing',  size: 0.88, carapace: [150, 120, 84],  accent: [90, 70, 60],    eye: [255, 150, 60],  eyes: 2, spiky: true },
  viper:     { frame: 'wing',  size: 0.75, carapace: [118, 124, 78],  accent: [190, 180, 140], eye: [180, 230, 110], eyes: 3 },
  lurker:    { frame: 'wide',  size: 0.75, carapace: [96, 64, 72],    accent: [200, 150, 120], eye: [255, 140, 50],  eyes: 4, spiky: true },
};

const rgbToHex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Selectable roster, in display order (Abathur = god seat, first). */
const ROSTER: Array<Omit<ZergCastMember, 'shirt'>> = [
  { name: 'abathur',   displayName: 'Abathur',   blurb: 'Evolution master, orchestrates the swarm' },
  { name: 'queen',     displayName: 'Queen',     blurb: 'Larva injection, brood management' },
  { name: 'drone',     displayName: 'Drone',     blurb: 'The worker, gathers and builds' },
  { name: 'zergling',  displayName: 'Zergling',  blurb: 'Fast, eager, swarms in numbers' },
  { name: 'hydralisk', displayName: 'Hydralisk', blurb: 'Ranged, versatile generalist' },
  { name: 'roach',     displayName: 'Roach',     blurb: 'Tanky, regenerates under fire' },
  { name: 'overlord',  displayName: 'Overlord',  blurb: 'Transport and supply, ferries signals' },
  { name: 'mutalisk',  displayName: 'Mutalisk',  blurb: 'Flyer, hit-and-run harasser' },
  { name: 'ultralisk', displayName: 'Ultralisk', blurb: 'Heavy hitter, breaks the line' },
  { name: 'baneling',  displayName: 'Baneling',  blurb: 'Volatile, blows up on contact (QA)' },
  { name: 'infestor',  displayName: 'Infestor',  blurb: 'Control and infestation' },
  { name: 'corruptor', displayName: 'Corruptor', blurb: 'Anti-air specialist' },
  { name: 'broodlord', displayName: 'Broodlord', blurb: 'Siege, spawns broodlings' },
  { name: 'viper',     displayName: 'Viper',     blurb: 'Utility, abduction, disruption' },
  { name: 'lurker',    displayName: 'Lurker',    blurb: 'Ambush from below' },
];
export const ZERG_CAST: ZergCastMember[] =
  ROSTER.map((c) => ({ ...c, shirt: rgbToHex(RECIPES[c.name].carapace) }));

export const ZERG_CAST_BY_NAME: Record<ZergCharacterName, ZergCastMember> =
  Object.fromEntries(ZERG_CAST.map((c) => [c.name, c])) as Record<ZergCharacterName, ZergCastMember>;

/** Hash a string to pick a deterministic zerg character from the brood. */
export function getDefaultZergCharacter(nameOrId: string): ZergCharacterName {
  let h = 0;
  for (let i = 0; i < nameOrId.length; i++) {
    h = (h * 31 + nameOrId.charCodeAt(i)) | 0;
  }
  return ZERG_CAST[Math.abs(h) % ZERG_CAST.length].name;
}

export function zergHexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<ZergCharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. Front view serves the down
 * + side rows; back view is the up row. The three walk frames are stand / step-L
 * / step-R.
 */
/** Build the frame grid from a single authored sprite PNG. There's one pose, so
 *  motion is procedural: the three animated columns are a bob+sway cycle
 *  (base -> up + lean-right -> higher + lean-left), which the walk/type/read
 *  states play as [0,1,2,1]. Every frame shares one padded canvas so the feet
 *  anchor stays put; idle stays on frame 0 (static, per the engine). */
async function loadAssetFrames(url: string): Promise<Texture[][]> {
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

/** A continuous slither sliced from a horizontal sprite sheet of `frameCount`
 *  equal-width frames (each frameW × H). The frames are the authored animation,
 *  so the loop plays them in order. */
async function loadSlitherFrames(url: string, frameCount = 8): Promise<Texture[][]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const H = img.height;
  const frameW = Math.floor(img.width / frameCount);
  const seq: Texture[] = [];
  for (let f = 0; f < frameCount; f++) {
    const c = document.createElement('canvas');
    c.width = frameW; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, f * frameW, 0, frameW, H, 0, 0, frameW, H);
    const tex = Texture.from(c);
    tex.source.scaleMode = 'nearest';
    seq.push(tex);
  }
  return [seq, seq, seq]; // continuous mode loops row 0
}

export async function getZergCastFrames(name: ZergCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const assetUrl = ASSET_URLS[name];
  if (assetUrl && SLITHER.has(name)) {
    const frames = await loadSlitherFrames(assetUrl);
    frameCache.set(name, frames);
    return frames;
  }
  if (assetUrl) {
    const frames = await loadAssetFrames(assetUrl);
    frameCache.set(name, frames);
    return frames;
  }
  const recipe = RECIPES[name] ?? RECIPES.abathur;
  const { front, back } = zergSceneFrameBufs(name, recipe);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/** Paint a brood's static portrait for cards / the picker. */
export async function paintZergCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: ZergCharacterName,
  scale = 2,
): Promise<void> {
  paintZergPortrait(ctx, name, RECIPES[name] ?? RECIPES.abathur, scale);
}

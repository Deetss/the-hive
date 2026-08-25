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

/** Per-unit art recipe. */
const RECIPES: Record<ZergCharacterName, ZergRecipe> = {
  abathur:   { frame: 'wide', carapace: [154, 168, 96],  accent: [122, 86, 140], eye: [240, 180, 70],  eyes: 5, spiky: true },
  queen:     { frame: 'tall', carapace: [150, 64, 120],  accent: [200, 120, 170], eye: [255, 150, 200], eyes: 3, spiky: true },
  drone:     { frame: 'small', carapace: [180, 150, 110], accent: [140, 110, 70], eye: [240, 190, 90],  eyes: 2 },
  zergling:  { frame: 'small', carapace: [170, 54, 54],  accent: [230, 120, 90], eye: [255, 180, 80],  eyes: 2, spiky: true },
  hydralisk: { frame: 'tall', carapace: [90, 140, 80],   accent: [200, 200, 120], eye: [230, 220, 120], eyes: 2, spiky: true },
  roach:     { frame: 'wide', carapace: [130, 96, 64],   accent: [180, 150, 90], eye: [240, 190, 90],  eyes: 2 },
  overlord:  { frame: 'wing', carapace: [110, 86, 150],  accent: [160, 140, 200], eye: [200, 180, 240], eyes: 3 },
  mutalisk:  { frame: 'wing', carapace: [70, 140, 140],  accent: [150, 220, 210], eye: [180, 240, 230], eyes: 2 },
  ultralisk: { frame: 'wide', carapace: [96, 104, 120],  accent: [210, 200, 170], eye: [240, 190, 90],  eyes: 2, spiky: true },
  baneling:  { frame: 'small', carapace: [170, 190, 70], accent: [120, 150, 50], eye: [220, 240, 120], eyes: 4 },
  infestor:  { frame: 'wide', carapace: [110, 140, 90],  accent: [160, 200, 120], eye: [200, 240, 140], eyes: 6 },
  corruptor: { frame: 'wing', carapace: [120, 80, 150],  accent: [180, 120, 210], eye: [220, 160, 240], eyes: 3 },
  broodlord: { frame: 'wing', carapace: [180, 168, 140], accent: [130, 110, 80], eye: [240, 190, 90],  eyes: 2, spiky: true },
  viper:     { frame: 'wing', carapace: [120, 120, 70],  accent: [180, 180, 110], eye: [220, 220, 130], eyes: 3 },
  lurker:    { frame: 'wide', carapace: [110, 50, 50],   accent: [180, 90, 80],  eye: [255, 150, 90],  eyes: 4, spiky: true },
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

export const DEFAULT_ZERG_CHARACTER: ZergCharacterName = 'abathur';

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
export async function getZergCastFrames(name: ZergCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
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

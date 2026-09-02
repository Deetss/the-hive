import { Texture, Rectangle } from 'pixi.js';

import atlasUrl from '@/assets/hive-kit/bee_atlas.png?url';
import chipsUrl from '@/assets/hive-kit/status_chips.png?url';
import tilesetUrl from '@/assets/hive-kit/tileset_16.png?url';
import propsUrl from '@/assets/hive-kit/props_sheet.png?url';

export type HiveKitStatus =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'moving'
  | 'blocked'
  | 'done'
  | 'handoff';

export type Direction = 'down' | 'up' | 'right' | 'left';

export const HIVE_STATUS_ORDER: readonly HiveKitStatus[] = [
  'idle',
  'thinking',
  'working',
  'moving',
  'blocked',
  'done',
  'handoff'
] as const;

export const HIVE_STATUS_INDEX: Record<HiveKitStatus, number> = {
  idle: 0,
  thinking: 1,
  working: 2,
  moving: 3,
  blocked: 4,
  done: 5,
  handoff: 6
};

// Atlas grid specs:
// 192×504 total. 7 status sheets stacked vertically.
// Each sheet: 192×72 (8 frames across × 3 rows of 24×24 cells).
// Row 0: down, Row 1: right, Row 2: up.
const CELL_SIZE = 24;
const FRAMES_PER_ROW = 8;
const SHEET_HEIGHT = 72;

let atlasBasePromise: Promise<Texture> | null = null;
let chipsBasePromise: Promise<Texture> | null = null;
let tilesetBasePromise: Promise<Texture> | null = null;
let propsBasePromise: Promise<Texture> | null = null;

async function loadBaseTexture(url: string): Promise<Texture> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const tex = Texture.from(img);
  tex.source.scaleMode = 'nearest';
  return tex;
}

export function getAtlasBase(): Promise<Texture> {
  if (!atlasBasePromise) atlasBasePromise = loadBaseTexture(atlasUrl);
  return atlasBasePromise;
}

export function getChipsBase(): Promise<Texture> {
  if (!chipsBasePromise) chipsBasePromise = loadBaseTexture(chipsUrl);
  return chipsBasePromise;
}

export function getTilesetBase(): Promise<Texture> {
  if (!tilesetBasePromise) tilesetBasePromise = loadBaseTexture(tilesetUrl);
  return tilesetBasePromise;
}

export function getPropsBase(): Promise<Texture> {
  if (!propsBasePromise) propsBasePromise = loadBaseTexture(propsUrl);
  return propsBasePromise;
}

// Cached sliced textures: status -> direction ('down' | 'right' | 'up') -> Texture[]
const statusDirectionFrames = new Map<string, Texture[]>();
const statusChipTextures = new Map<HiveKitStatus, Texture>();

/**
 * Get the 8 animation frame textures for a specific status and direction.
 * Note: For 'left', caller should use 'right' textures and flip sprite.scale.x = -1.
 */
export async function getHiveBeeStatusFrames(
  status: HiveKitStatus,
  direction: 'down' | 'right' | 'up'
): Promise<Texture[]> {
  const key = `${status}:${direction}`;
  const existing = statusDirectionFrames.get(key);
  if (existing) return existing;

  const base = await getAtlasBase();
  const statusIdx = HIVE_STATUS_INDEX[status] ?? 0;
  const rowOffset = direction === 'down' ? 0 : direction === 'right' ? 1 : 2;
  const startY = statusIdx * SHEET_HEIGHT + rowOffset * CELL_SIZE;

  const frames: Texture[] = [];
  for (let f = 0; f < FRAMES_PER_ROW; f++) {
    const frame = new Rectangle(f * CELL_SIZE, startY, CELL_SIZE, CELL_SIZE);
    const tex = new Texture({ source: base.source, frame });
    frames.push(tex);
  }

  statusDirectionFrames.set(key, frames);
  return frames;
}

/**
 * Get all 3 rows (down=0, up=1, right=2) for an idle bee to satisfy standard CharacterSprite initialization.
 */
export async function getHiveBeeIdleGrid(): Promise<Texture[][]> {
  const [down, right, up] = await Promise.all([
    getHiveBeeStatusFrames('idle', 'down'),
    getHiveBeeStatusFrames('idle', 'right'),
    getHiveBeeStatusFrames('idle', 'up')
  ]);
  // CharacterSprite expects down=0, up=1, right=2
  return [down, up, right];
}

/**
 * Get status chip texture (14×14) for a given kit status.
 */
export async function getHiveStatusChipTexture(status: HiveKitStatus): Promise<Texture> {
  const existing = statusChipTextures.get(status);
  if (existing) return existing;

  const base = await getChipsBase();
  const idx = HIVE_STATUS_INDEX[status] ?? 0;
  const frame = new Rectangle(idx * 14, 0, 14, 14);
  const tex = new Texture({ source: base.source, frame });
  statusChipTextures.set(status, tex);
  return tex;
}

export interface HiveTileset {
  floor: Texture;
  wall: Texture;
  capped: Texture;
  wood: Texture;
  beam: Texture;
}

let tilesetCache: HiveTileset | null = null;

export async function getHiveTileset(): Promise<HiveTileset> {
  if (tilesetCache) return tilesetCache;
  const base = await getTilesetBase();
  tilesetCache = {
    floor: new Texture({ source: base.source, frame: new Rectangle(0, 0, 16, 16) }),
    wall: new Texture({ source: base.source, frame: new Rectangle(16, 0, 16, 16) }),
    capped: new Texture({ source: base.source, frame: new Rectangle(32, 0, 16, 16) }),
    wood: new Texture({ source: base.source, frame: new Rectangle(48, 0, 16, 16) }),
    beam: new Texture({ source: base.source, frame: new Rectangle(64, 0, 16, 16) })
  };
  return tilesetCache;
}

export interface HiveProps {
  desk: Texture;
  vat: Texture;
  cabinet: Texture;
  plant: Texture;
  whiteboard: Texture;
  mug: Texture;
}

let propsCache: HiveProps | null = null;

export async function getHiveProps(): Promise<HiveProps> {
  if (propsCache) return propsCache;
  const base = await getPropsBase();
  propsCache = {
    desk: new Texture({ source: base.source, frame: new Rectangle(0, 0, 32, 26) }),
    vat: new Texture({ source: base.source, frame: new Rectangle(32, 0, 32, 40) }),
    cabinet: new Texture({ source: base.source, frame: new Rectangle(64, 0, 24, 32) }),
    plant: new Texture({ source: base.source, frame: new Rectangle(88, 0, 16, 28) }),
    whiteboard: new Texture({ source: base.source, frame: new Rectangle(104, 0, 32, 28) }),
    mug: new Texture({ source: base.source, frame: new Rectangle(136, 0, 8, 8) })
  };
  return propsCache;
}

/**
 * Map agent status string to HiveKitStatus.
 */
export function mapAgentStatusToHiveKit(status?: string, isMoving?: boolean): HiveKitStatus {
  if (isMoving) return 'moving';
  switch (status) {
    case 'thinking':
    case 'compacting':
      return 'thinking';
    case 'working':
      return 'working';
    case 'blocked':
    case 'looping':
      return 'blocked';
    case 'success':
    case 'done':
      return 'done';
    case 'handoff':
    case 'typing':
      return 'handoff';
    case 'idle':
    case 'waiting':
    case 'ghost':
    default:
      return 'idle';
  }
}

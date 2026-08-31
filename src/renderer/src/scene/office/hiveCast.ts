// The Hive bee cast — roster metadata + authored sprite loading.
//
// Mirrors cast.ts / zergCast.ts: a selectable roster whose scene frames and
// portraits come from authored PNG stills (src/assets/hive/*.png), loaded via
// the ASSET_URLS + loadHiveFrames pattern. BeeYoncé the queen fills the god
// seat and is the default. See hivePortraitArt.ts for the draw layer.

import { Texture } from 'pixi.js';
import { loadHiveFrames, paintHivePortrait } from './hivePortraitArt';

import queenUrl from '@/assets/hive/queen.png?url';
import docbeegoodUrl from '@/assets/hive/docbeegood.png?url';
import buzzthebuilderUrl from '@/assets/hive/buzzthebuilder.png?url';
import buzzybakerUrl from '@/assets/hive/buzzybaker.png?url';
import sherlockcombsUrl from '@/assets/hive/sherlockcombs.png?url';
import buzzcassidyUrl from '@/assets/hive/buzzcassidy.png?url';
import buzzlomanUrl from '@/assets/hive/buzzloman.png?url';
import buzzaldrinUrl from '@/assets/hive/buzzaldrin.png?url';
import beecassoUrl from '@/assets/hive/beecasso.png?url';
import muhammadalbeeUrl from '@/assets/hive/muhammadalbee.png?url';
import albeeeinsteinUrl from '@/assets/hive/albeeeinstein.png?url';

export type HiveCharacterName =
  | 'queen' | 'docbeegood' | 'buzzthebuilder' | 'buzzybaker' | 'sherlockcombs'
  | 'buzzcassidy' | 'buzzloman' | 'buzzaldrin' | 'beecasso' | 'muhammadalbee'
  | 'albeeeinstein';

export interface HiveCastMember {
  name: HiveCharacterName;
  displayName: string;
  /** Signature accent color (hex), used for the in-scene selection glow. */
  shirt: string;
  blurb: string;
}

const ASSET_URLS: Record<HiveCharacterName, string> = {
  queen: queenUrl,
  docbeegood: docbeegoodUrl,
  buzzthebuilder: buzzthebuilderUrl,
  buzzybaker: buzzybakerUrl,
  sherlockcombs: sherlockcombsUrl,
  buzzcassidy: buzzcassidyUrl,
  buzzloman: buzzlomanUrl,
  buzzaldrin: buzzaldrinUrl,
  beecasso: beecassoUrl,
  muhammadalbee: muhammadalbeeUrl,
  albeeeinstein: albeeeinsteinUrl,
};

/** Selectable roster, in display order (BeeYoncé = god seat, first). */
export const HIVE_CAST: HiveCastMember[] = [
  { name: 'queen',          displayName: 'BeeYoncé',       shirt: '#F2C55A', blurb: 'Queen of the hive, runs the swarm' },
  { name: 'docbeegood',     displayName: 'Doc BeeGood',    shirt: '#EDEDE8', blurb: 'The doctor, patches up the colony' },
  { name: 'buzzthebuilder', displayName: 'Buzz the Builder', shirt: '#F5CD3C', blurb: 'Construction, builds the comb' },
  { name: 'buzzybaker',     displayName: 'Buzzy Baker',    shirt: '#F0F0EC', blurb: 'Bakes the daily bread' },
  { name: 'sherlockcombs',  displayName: 'Sherlock Combs', shirt: '#9C8C6C', blurb: 'The detective, cracks the case' },
  { name: 'buzzcassidy',    displayName: 'Buzz Cassidy',   shirt: '#8A643A', blurb: 'The outlaw cowboy' },
  { name: 'buzzloman',      displayName: 'Buzz Loman',     shirt: '#4070A8', blurb: 'The salesman, always closing' },
  { name: 'buzzaldrin',     displayName: 'Buzz Aldrin',    shirt: '#EAECEE', blurb: 'The astronaut, shoots for the moon' },
  { name: 'beecasso',       displayName: 'Bee-casso',      shirt: '#28262E', blurb: 'The painter, master of the arts' },
  { name: 'muhammadalbee',  displayName: 'Muhammad Albee', shirt: '#CA2E2E', blurb: 'The boxer, floats and stings' },
  { name: 'albeeeinstein',  displayName: 'Albee Einstein', shirt: '#EEEEEA', blurb: 'The scientist, theory of relativitBee' },
];

export const HIVE_CAST_BY_NAME: Record<HiveCharacterName, HiveCastMember> =
  Object.fromEntries(HIVE_CAST.map((c) => [c.name, c])) as Record<HiveCharacterName, HiveCastMember>;

/** Hash a string to a deterministic worker bee. The queen (index 0) is the god
 *  seat, assigned explicitly, so workers draw from the rest of the roster. */
export function getDefaultHiveCharacter(nameOrId: string): HiveCharacterName {
  const workers = HIVE_CAST.slice(1);
  let h = 0;
  for (let i = 0; i < nameOrId.length; i++) {
    h = (h * 31 + nameOrId.charCodeAt(i)) | 0;
  }
  return workers[Math.abs(h) % workers.length].name;
}

const frameCache = new Map<HiveCharacterName, Texture[][]>();

export async function getHiveCastFrames(name: HiveCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const url = ASSET_URLS[name] ?? ASSET_URLS.queen;
  const frames = await loadHiveFrames(url);
  frameCache.set(name, frames);
  return frames;
}

/** Paint a bee's static portrait for cards / the picker. */
export async function paintHiveCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: HiveCharacterName,
  scale = 2,
): Promise<void> {
  await paintHivePortrait(ctx, ASSET_URLS[name] ?? ASSET_URLS.queen, scale);
}

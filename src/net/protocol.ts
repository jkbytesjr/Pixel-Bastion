/**
 * Co-op messages between the host (who runs the dungeon) and guests. Guests
 * simulate their own hero and send its state and actions; the host resolves
 * combat, loot and progress and sends snapshots and events back. Pure data and
 * validation, unit-tested.
 */
import type { Appearance } from '../systems/appearance';
import { validateAppearance } from '../systems/appearance';
import { isItem } from '../systems/save';
import type { ArmorItem, Drop, WeaponItem } from '../systems/loot';
import { PERK_IDS, type PerkCounts } from '../systems/perks';

/** Bump when messages change; peers on different versions can't play together. */
export const NET_VERSION = 1;
export const MAX_PLAYERS = 4;
/** The host is always player 0. */
export const HOST_ID = 0;

/** What other players need to draw and fight alongside a hero. */
export interface Profile {
  name: string;
  look: Appearance;
  weapon: WeaponItem;
  armor: ArmorItem | null;
  perks: PerkCounts;
  level: number;
}

/** Action counters: each goes up by one when the hero starts that action. */
export type Counters = [strike: number, dodge: number, slam: number, volley: number, drink: number];

/** A hero's live state, sent about 20 times a second. */
export interface PlayerState {
  id: number;
  x: number;
  z: number;
  /** Facing (radians). */
  f: number;
  hp: number;
  mhp: number;
  alive: boolean;
  /** Can't be hit right now (dodging, god mode). */
  inv: boolean;
  c: Counters;
  /** Bag full / potions full: the host won't hand them that kind of drop. */
  bag: boolean;
  pot: boolean;
}

/** Enemy snapshot: [netId, kind index, x, z, facing, hp, maxHp, flags]. Flags: 1 elite, 2 engaged boss. */
export type EnemyState = [number, number, number, number, number, number, number, number];

/** In-flight projectile. */
export interface ProjectileState {
  x: number;
  z: number;
  dx: number;
  dz: number;
  s: number;
  /** 1 = an enemy's. */
  e?: 1;
  c?: number;
  o?: 1;
  sp?: [number, number];
  tr?: number;
}

/** An event replayed on guests for effects and sound: [type, payload, origin player or -1]. */
export type NetEvent = [string, unknown, number];

export type ToHost =
  | { t: 'hello'; v: number; name: string }
  | { t: 'profile'; p: Profile }
  | { t: 'state'; s: PlayerState }
  | { t: 'act'; a: 'strike' | 'slam' | 'volley'; x: number; z: number; f: number };

export type ToGuest =
  | { t: 'welcome'; v: number; you: number }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: { id: number; name: string }[]; started: boolean }
  /** A run started (`fresh`: everyone starts over) or the party moved to another floor. */
  | { t: 'run'; seed: number; depth: number; token: number; fresh: boolean }
  | { t: 'snap'; k: number; pl: PlayerState[]; en: EnemyState[]; pr: ProjectileState[] }
  | { t: 'ev'; k: number; list: NetEvent[] }
  | { t: 'profiles'; list: { id: number; p: Profile }[] }
  | { t: 'dmg'; amount: number; kx: number; kz: number }
  | { t: 'xp'; amount: number }
  | { t: 'loot'; drop: Drop }
  | { t: 'heal'; amount: number }
  | { t: 'drop'; k: number; id: number; drop: Drop; x: number; z: number; a: number }
  | { t: 'take'; k: number; id: number }
  | { t: 'chest'; k: number; i: number }
  | { t: 'wipe' };

/** Enemy kinds by index in snapshots. */
export const ENEMY_KINDS = ['grunt', 'archer', 'exploder', 'spider', 'shieldbearer', 'shaman', 'wraith', 'boss'] as const;

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short, easy-to-read room code (no 0/O or 1/I/L). `rand` returns floats in [0, 1). */
export function makeRoomCode(rand: () => number, length = 5): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return code;
}

/** Tidy a typed room code: upper-case, letters and digits only, or null if it can't be one. */
export function normalizeRoomCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) return null;
  return [...code].every((ch) => ROOM_ALPHABET.includes(ch)) ? code : null;
}

/** A display name: trimmed, plain characters, 1-16 long. */
export function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _\-'.]/gu, '').trim().slice(0, 16) : '';
  return s || 'Adventurer';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Round to 2 decimals for compact snapshots. */
export const q2 = (v: number) => Math.round(v * 100) / 100;

/** Check a guest's state message; null if malformed. */
export function readPlayerState(raw: unknown): PlayerState | null {
  if (!isObj(raw)) return null;
  const { x, z, f, hp, mhp, alive, inv, c, bag, pot } = raw;
  if (![x, z, f, hp, mhp].every(isNum)) return null;
  if (!Array.isArray(c) || c.length !== 5 || !c.every(isNum)) return null;
  return {
    id: 0,
    x: x as number,
    z: z as number,
    f: f as number,
    hp: Math.max(0, hp as number),
    mhp: Math.max(1, mhp as number),
    alive: alive === true,
    inv: inv === true,
    c: c as Counters,
    bag: bag === true,
    pot: pot === true,
  };
}

/** Check a guest's profile; null if malformed (weapon and armor must be real items). */
export function readProfile(raw: unknown): Profile | null {
  if (!isObj(raw)) return null;
  const { name, look, weapon, armor, perks, level } = raw;
  if (!isItem(weapon) || weapon.kind !== 'weapon') return null;
  if (armor !== null && (!isItem(armor) || armor.kind !== 'armor')) return null;
  if (!isNum(level)) return null;
  const cleanPerks: PerkCounts = {};
  if (isObj(perks)) for (const id of PERK_IDS) if (isNum(perks[id])) cleanPerks[id] = Math.max(0, Math.min(100, perks[id] as number));
  return {
    name: cleanName(name),
    look: validateAppearance(look),
    weapon: weapon as WeaponItem,
    armor: (armor as ArmorItem | null) ?? null,
    perks: cleanPerks,
    level: Math.max(1, Math.min(1000, Math.floor(level))),
  };
}

/** Check any message a guest sends; null if it isn't one. */
export function readToHost(raw: unknown): ToHost | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello':
      return isNum(raw.v) ? { t: 'hello', v: raw.v, name: cleanName(raw.name) } : null;
    case 'profile': {
      const p = readProfile(raw.p);
      return p ? { t: 'profile', p } : null;
    }
    case 'state': {
      const s = readPlayerState(raw.s);
      return s ? { t: 'state', s } : null;
    }
    case 'act':
      if ((raw.a === 'strike' || raw.a === 'slam' || raw.a === 'volley') && isNum(raw.x) && isNum(raw.z) && isNum(raw.f))
        return { t: 'act', a: raw.a, x: raw.x, z: raw.z, f: raw.f };
      return null;
    default:
      return null;
  }
}

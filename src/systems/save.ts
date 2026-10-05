/**
 * Saved runs. A save holds the seed, the floor to resume on, and the
 * character (level, attributes, gear). Floors rebuild from the seed, so the
 * run resumes at the start of the saved floor. Pure apart from the small
 * localStorage wrappers at the bottom.
 */
import type { ArmorItem, Item, WeaponItem } from './loot';
import type { Progress } from './progression';

export const SAVE_VERSION = 1;
const SAVE_KEY = 'voxel-dungeon:save';

export interface RunSave {
  version: number;
  seed: number;
  /** Floor to resume on (0-based). */
  depth: number;
  runTime: number;
  kills: number;
  progress: Progress;
  weapon: WeaponItem;
  armor: ArmorItem | null;
  bag: Item[];
  potions: number;
  /** Epoch ms, for the menu's "saved ..." line. */
  savedAt: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isItem(v: unknown): v is Item {
  if (!isObj(v) || typeof v.name !== 'string' || typeof v.rarity !== 'string' || !Array.isArray(v.mods)) return false;
  if (v.kind === 'weapon') return typeof v.weapon === 'string' && isNum(v.damage);
  if (v.kind === 'armor') return isNum(v.armor) && isNum(v.maxHp);
  return false;
}

/** Check that parsed JSON really is a usable save; anything else is rejected rather than half-loaded. */
export function validateSave(raw: unknown): RunSave | null {
  if (!isObj(raw) || raw.version !== SAVE_VERSION) return null;
  const { seed, depth, runTime, kills, progress, weapon, armor, bag, potions, savedAt } = raw;
  if (![seed, depth, runTime, kills, potions, savedAt].every(isNum)) return null;
  if (!isObj(progress) || !isNum(progress.level) || !isNum(progress.xp) || !isNum(progress.pendingPicks) || !isObj(progress.perks))
    return null;
  if (!isItem(weapon) || weapon.kind !== 'weapon') return null;
  if (armor !== null && (!isItem(armor) || armor.kind !== 'armor')) return null;
  if (!Array.isArray(bag) || !bag.every(isItem)) return null;
  return raw as unknown as RunSave;
}

export function serializeSave(save: RunSave): string {
  return JSON.stringify(save);
}

export function parseSave(text: string | null): RunSave | null {
  if (!text) return null;
  try {
    return validateSave(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---- localStorage (may be unavailable: private mode, blocked storage) ----

export function loadSave(): RunSave | null {
  try {
    return parseSave(window.localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

/** Returns false if the browser refused to store it. */
export function writeSave(save: RunSave): boolean {
  try {
    window.localStorage.setItem(SAVE_KEY, serializeSave(save));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch {
    // Nothing stored, or storage blocked: either way there's no save.
  }
}

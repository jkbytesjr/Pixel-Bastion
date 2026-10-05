import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { cleanName, makeRoomCode, normalizeRoomCode, readProfile, readToHost } from '../src/net/protocol';
import { STARTER_WEAPON } from '../src/systems/loot';
import { DEFAULT_APPEARANCE } from '../src/systems/appearance';

describe('room codes', () => {
  it('are 5 easy-to-read characters and survive being typed back in', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode(() => rng.next());
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}$/);
      expect(normalizeRoomCode(code.toLowerCase())).toBe(code);
      expect(normalizeRoomCode(` ${code.slice(0, 2)}-${code.slice(2)} `)).toBe(code);
    }
  });

  it('rejects anything that cannot be a code', () => {
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDEF')).toBeNull();
    expect(normalizeRoomCode('ABCD0')).toBeNull(); // 0 is never used
  });
});

describe('player names', () => {
  it('are trimmed, limited and stripped of markup', () => {
    expect(cleanName('  Kai  ')).toBe('Kai');
    expect(cleanName('<b>Kai</b>')).toBe('bKaib');
    expect(cleanName('<script>alert(1)</script>')).not.toMatch(/[<>()/]/);
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
    expect(cleanName('')).toBe('Adventurer');
    expect(cleanName(42)).toBe('Adventurer');
  });
});

describe('messages from guests', () => {
  const state = { x: 1, z: 2, f: 0.5, hp: 80, mhp: 100, alive: true, inv: false, c: [1, 0, 0, 0, 0], bag: false, pot: false };

  it('accepts well-formed ones', () => {
    expect(readToHost({ t: 'hello', v: 1, name: 'Mo' })).toEqual({ t: 'hello', v: 1, name: 'Mo' });
    expect(readToHost({ t: 'state', s: state })?.t).toBe('state');
    expect(readToHost({ t: 'act', a: 'slam', x: 1, z: 2, f: 0 })?.t).toBe('act');
  });

  it('rejects junk', () => {
    expect(readToHost(null)).toBeNull();
    expect(readToHost({ t: 'nope' })).toBeNull();
    expect(readToHost({ t: 'act', a: 'nuke', x: 1, z: 2, f: 0 })).toBeNull();
    expect(readToHost({ t: 'state', s: { ...state, x: 'far' } })).toBeNull();
    expect(readToHost({ t: 'state', s: { ...state, c: [1, 2] } })).toBeNull();
  });

  it('checks profiles: real items, sane perks and level', () => {
    const good = { name: 'Mo', look: DEFAULT_APPEARANCE, weapon: STARTER_WEAPON, armor: null, perks: { might: 3, bogus: 9 }, level: 7 };
    const p = readProfile(good)!;
    expect(p.perks).toEqual({ might: 3 });
    expect(p.level).toBe(7);
    expect(readProfile({ ...good, weapon: { kind: 'weapon' } })).toBeNull();
    expect(readProfile({ ...good, armor: STARTER_WEAPON })).toBeNull();
    expect(readProfile({ ...good, level: 1e9 })!.level).toBe(1000);
  });
});

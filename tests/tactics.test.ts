import { describe, expect, it } from 'vitest';
import { affinity, affinityLabel, heightMult, HIGH_GROUND_BONUS, LOW_GROUND_PENALTY, POWER_ELEMENT } from '../src/systems/combat';
import { DODGE_COST, STAMINA_DELAY, STAMINA_MAX, newStamina, spendStamina, tickStamina } from '../src/systems/stamina';
import { POWER_IDS } from '../src/systems/powers';

describe('elements', () => {
  it('every weapon power has an element', () => {
    for (const id of POWER_IDS) expect(POWER_ELEMENT[id]).toBeDefined();
  });

  it('monsters have weaknesses and resistances', () => {
    expect(affinity('spider', 'fire')).toBeGreaterThan(1);
    expect(affinity('exploder', 'fire')).toBeLessThan(1);
    expect(affinity('wraith', 'lightning')).toBeGreaterThan(1);
    expect(affinity('pyromancer', 'fire')).toBeLessThan(0.5);
    expect(affinity('nobody', 'fire')).toBe(1);
    expect(affinityLabel(1.5)).toBe('weak');
    expect(affinityLabel(0.5)).toBe('resist');
    expect(affinityLabel(1)).toBeNull();
  });

  it('every boss has a weakness to exploit', () => {
    for (const boss of ['colossus', 'huntress', 'pyromancer', 'necromancer'])
      expect((['fire', 'frost', 'lightning', 'force'] as const).some((el) => affinity(boss, el) > 1)).toBe(true);
  });
});

describe('high ground', () => {
  it('rewards attacking from above and punishes attacking from below', () => {
    expect(heightMult(0.5, 0)).toBe(HIGH_GROUND_BONUS);
    expect(heightMult(0, 0.5)).toBe(LOW_GROUND_PENALTY);
    expect(heightMult(0.25, 0.25)).toBe(1);
    expect(heightMult(0.1, 0)).toBe(1);
  });
});

describe('stamina', () => {
  it('allows about three rolls from full, then needs a breather', () => {
    const s = newStamina();
    let rolls = 0;
    while (spendStamina(s, DODGE_COST)) rolls++;
    expect(rolls).toBe(Math.floor(STAMINA_MAX / DODGE_COST));
    // Nothing refills during the delay...
    tickStamina(s, STAMINA_DELAY - 0.01);
    tickStamina(s, 0);
    const during = s.value;
    expect(during).toBeLessThan(DODGE_COST);
    // ...then it comes back.
    for (let i = 0; i < 300; i++) tickStamina(s, 1 / 60);
    expect(s.value).toBe(STAMINA_MAX);
  });

  it('refills faster with a higher rate', () => {
    const a = { value: 0, wait: 0 };
    const b = { value: 0, wait: 0 };
    tickStamina(a, 1);
    tickStamina(b, 1, 1.5);
    expect(b.value).toBeGreaterThan(a.value);
  });
});

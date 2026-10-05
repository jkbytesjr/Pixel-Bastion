import { describe, expect, it } from 'vitest';
import { HazardField, type HazardTargets } from '../src/entities/bossHazards';
import type { Player } from '../src/entities/player';

/** Stand-in heroes: only position and radius matter to hazards. */
const hero = (x: number, z: number) => ({ pos: { x, z }, radius: 0.3 }) as unknown as Player;

function targets(heroes: Player[]) {
  const hits: Player[] = [];
  const t: HazardTargets = { heroes: () => heroes, hit: (h) => hits.push(h), burst: () => {} };
  return { t, hits };
}

const run = (field: HazardField, seconds: number, t: HazardTargets) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) field.update(1 / 60, 1, t);
};

describe('boss hazards', () => {
  it('a circle strikes only after its warning, and only heroes inside', () => {
    const inside = hero(0.5, 0);
    const outside = hero(4, 0);
    const { t, hits } = targets([inside, outside]);
    const f = new HazardField();
    f.add({ k: 'circle', x: 0, z: 0, r: 2, delay: 1, base: 10, knock: 0 });
    run(f, 0.9, t);
    expect(hits).toHaveLength(0);
    run(f, 0.2, t);
    expect(hits).toEqual([inside]);
    expect(f.count).toBe(0);
  });

  it('a shockwave hits each hero once as it passes', () => {
    const near = hero(2, 0);
    const far = hero(6, 0);
    const { t, hits } = targets([near, far]);
    const f = new HazardField();
    f.add({ k: 'ring', x: 0, z: 0, r: 8, speed: 6, delay: 0.5, base: 10, knock: 0 });
    run(f, 0.5, t);
    expect(hits).toHaveLength(0);
    run(f, 2, t);
    expect(hits.filter((h) => h === near)).toHaveLength(1);
    expect(hits.filter((h) => h === far)).toHaveLength(1);
    expect(f.count).toBe(0);
  });

  it('a lane hits along its strip, not beside it', () => {
    const onLane = hero(0, 5);
    const beside = hero(2, 5);
    const behind = hero(0, -2);
    const { t, hits } = targets([onLane, beside, behind]);
    const f = new HazardField();
    f.add({ k: 'lane', x: 0, z: 0, a: 0, len: 10, w: 1.5, delay: 0.5, base: 10, knock: 0 });
    run(f, 0.6, t);
    expect(hits).toEqual([onLane]);
  });

  it('shows warnings without hurting anyone when there are no targets (co-op guests)', () => {
    const f = new HazardField();
    f.add({ k: 'circle', x: 0, z: 0, r: 2, delay: 0.5, base: 10, knock: 0 });
    for (let i = 0; i < 60; i++) f.update(1 / 60, 1, null);
    expect(f.count).toBe(0);
  });
});

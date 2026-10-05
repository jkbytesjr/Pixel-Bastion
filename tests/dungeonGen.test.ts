import { describe, expect, it } from 'vitest';
import { BIOMES, floorTheme } from '../src/world/biomes';
import { BOSS_KINDS, STEP, bossForFloor, generateDungeon, type Dungeon } from '../src/world/dungeonGen';

/** A floor far beyond where most runs end. */
const DEEP = 30;
import { Tile } from '../src/world/grid';
import { reachability } from '../src/world/features';

/**
 * Count floor tiles reachable from the player start (4-connected), with
 * every gate open and through the mini-portals: once a floor's shrine,
 * puzzles and secrets are done, everything must be reachable.
 */
function reachableFloor(d: Dungeon): { reachable: number; total: number } {
  const dist = reachability(d.grid, d.playerStart, { gatesOpen: true, portals: d.portals });
  let reachable = 0;
  let total = 0;
  d.grid.tiles.forEach((t, i) => {
    if (t !== Tile.Floor && t !== Tile.Gate) return;
    total++;
    if (dist[i] >= 0) reachable++;
  });
  return { reachable, total };
}

const SEEDS = [1, 2, 3, 42, 1337, 98765, 4_000_000_000];

describe('generateDungeon', () => {
  it('is deterministic for a seed and depth', () => {
    const a = generateDungeon(1234, 1);
    const b = generateDungeon(1234, 1);
    expect(Array.from(a.grid.tiles)).toEqual(Array.from(b.grid.tiles));
    expect(a.spawns).toEqual(b.spawns);
    expect(a.chests).toEqual(b.chests);
    expect(a.playerStart).toEqual(b.playerStart);
  });

  it('differs between seeds and between depths', () => {
    const base = Array.from(generateDungeon(1, 0).grid.tiles).join('');
    expect(Array.from(generateDungeon(2, 0).grid.tiles).join('')).not.toBe(base);
    expect(Array.from(generateDungeon(1, 1).grid.tiles).join('')).not.toBe(base);
  });

  for (const seed of SEEDS) {
    for (const depth of [0, 2, DEEP]) {
      it(`seed ${seed} depth ${depth}: connected, enclosed, sane spawns`, () => {
        const d = generateDungeon(seed, depth);
        const { grid } = d;

        // Every floor tile is reachable from the start.
        const { reachable, total } = reachableFloor(d);
        expect(reachable).toBe(total);

        // Floors never touch the map edge or void: always walled in.
        for (let z = 0; z < grid.height; z++)
          for (let x = 0; x < grid.width; x++) {
            if (grid.get(x, z) !== Tile.Floor) continue;
            for (let dz = -1; dz <= 1; dz++)
              for (let dx = -1; dx <= 1; dx++) expect(grid.get(x + dx, z + dz)).not.toBe(Tile.Void);
          }

        // Rooms don't overlap.
        for (const a of d.rooms)
          for (const b of d.rooms) {
            if (a === b) continue;
            const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.h && a.z + a.h > b.z;
            expect(overlap).toBe(false);
          }

        // Exactly one start and one boss room, and they differ.
        const start = d.rooms.filter((r) => r.kind === 'start');
        const boss = d.rooms.filter((r) => r.kind === 'boss');
        expect(start).toHaveLength(1);
        expect(boss).toHaveLength(1);
        expect(start[0].id).not.toBe(boss[0].id);

        // Spawns: on floor, none in the start room, exactly one boss in the boss room.
        for (const s of d.spawns) {
          expect(grid.isWalkableAt(s.x, s.z)).toBe(true);
          expect(s.roomId).not.toBe(start[0].id);
        }
        const bosses = d.spawns.filter((s) => s.kind === 'boss');
        expect(bosses).toHaveLength(1);
        expect(bosses[0].roomId).toBe(boss[0].id);
        expect(d.spawns.length).toBeGreaterThan(8);

        expect(grid.isWalkableAt(d.playerStart.x, d.playerStart.z)).toBe(true);
        expect(grid.isWalkableAt(d.exit.x, d.exit.z)).toBe(true);
        for (const c of d.chests) expect(grid.isWalkableAt(c.x, c.z)).toBe(true);
      });
    }
  }

  it('deeper floors have more enemies on average', () => {
    const avg = (depth: number) => SEEDS.reduce((n, s) => n + generateDungeon(s, depth).spawns.length, 0) / SEEDS.length;
    expect(avg(2)).toBeGreaterThan(avg(0));
  });

  it('very deep floors still have a sane enemy count', () => {
    for (const seed of SEEDS) expect(generateDungeon(seed, DEEP).spawns.length).toBeLessThan(80);
  });
});

describe('enemy variety', () => {
  const kindsAt = (depth: number) => new Set(Array.from({ length: 30 }, (_, i) => generateDungeon(i + 1, depth).spawns.map((s) => s.kind)).flat());

  it('unlocks new monsters as you go deeper', () => {
    expect(kindsAt(0).has('spider')).toBe(true);
    expect(kindsAt(0).has('shieldbearer')).toBe(false);
    expect(kindsAt(1).has('shieldbearer')).toBe(true);
    expect(kindsAt(1).has('shaman')).toBe(false);
    expect(kindsAt(2).has('shaman')).toBe(true);
    expect(kindsAt(2).has('wraith')).toBe(false);
    for (const k of ['grunt', 'archer', 'exploder', 'spider', 'shieldbearer', 'shaman', 'wraith']) expect(kindsAt(5).has(k as never)).toBe(true);
  });

  it('spawns spiders in packs', () => {
    const d = generateDungeon(7, 2);
    for (const s of d.spawns.filter((x) => x.kind === 'spider')) {
      const inRoom = d.spawns.filter((x) => x.kind === 'spider' && x.roomId === s.roomId).length;
      expect(inRoom).toBeGreaterThanOrEqual(2);
    }
  });

  it('makes elites rarer near the top and more common deeper', () => {
    const rate = (depth: number) => {
      const all = Array.from({ length: 40 }, (_, i) => generateDungeon(i + 100, depth).spawns.filter((s) => s.kind !== 'boss')).flat();
      return all.filter((s) => s.elite).length / all.length;
    };
    expect(rate(0)).toBeGreaterThan(0);
    expect(rate(0)).toBeLessThan(0.1);
    expect(rate(10)).toBeGreaterThan(rate(0));
    expect(generateDungeon(3, 4).spawns.find((s) => s.kind === 'boss')?.elite).toBeFalsy();
  });
});

describe('bossForFloor', () => {
  const order = (seed: number, n: number) => Array.from({ length: n }, (_, d) => bossForFloor(seed, d));

  it('starts with the Colossus and shows every boss on floors 1-4', () => {
    for (let seed = 1; seed < 200; seed++) {
      const o = order(seed, 4);
      expect(o[0]).toBe('colossus');
      expect(new Set(o)).toEqual(new Set(BOSS_KINDS));
    }
  });

  it('keeps going forever without repeating a boss on back-to-back floors', () => {
    for (let seed = 1; seed < 50; seed++) {
      const o = order(seed, 40);
      for (let d = 1; d < o.length; d++) expect(o[d]).not.toBe(o[d - 1]);
      expect(new Set(o.slice(4))).toEqual(new Set(BOSS_KINDS));
    }
  });

  it('varies between seeds and matches the generated floors', () => {
    expect(new Set(Array.from({ length: 50 }, (_, i) => order(i, 8).join())).size).toBeGreaterThan(3);
    const seed = 4242;
    expect(Array.from({ length: 8 }, (_, d) => generateDungeon(seed, d).boss)).toEqual(order(seed, 8));
  });
});

describe('arena layout', () => {
  const inRoom = (d: Dungeon, x: number, z: number) => d.rooms.some((r) => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.h);
  /** Walkable tiles in a straight line through (x, z) along one axis. */
  const span = (d: Dungeon, x: number, z: number, dx: number, dz: number) => {
    let n = 1;
    for (const s of [1, -1]) for (let i = 1; d.grid.isWalkable(x + dx * i * s, z + dz * i * s); i++) n++;
    return n;
  };

  it('corridors are at least 5 tiles wide', () => {
    for (const seed of SEEDS)
      for (const depth of [0, 3]) {
        const d = generateDungeon(seed, depth);
        for (let z = 0; z < d.grid.height; z++)
          for (let x = 0; x < d.grid.width; x++) {
            if (!d.grid.isWalkable(x, z) || inRoom(d, x, z)) continue;
            // A corridor tile is either in a wide horizontal or a wide vertical band.
            expect(Math.max(span(d, x, z, 1, 0), span(d, x, z, 0, 1))).toBeGreaterThanOrEqual(5);
          }
      }
  });

  it('rooms are open arenas', () => {
    for (const seed of SEEDS) {
      const d = generateDungeon(seed, 0);
      // Combat rooms; the small vaults and secret rooms behind walls are meant to be cosy.
      for (const r of d.rooms.filter((x) => !['vault', 'secret'].includes(x.kind))) expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(11);
      expect(d.rooms.find((r) => r.kind === 'boss')!.w).toBeGreaterThanOrEqual(19);
    }
  });

  it('floor heights step at most one STEP between walkable neighbours; edges and boss arena stay flat', () => {
    let raised = 0;
    for (const seed of SEEDS) {
      const d = generateDungeon(seed, 1);
      const { grid } = d;
      const h = (x: number, z: number) => d.heights![z * grid.width + x];
      for (let z = 0; z < grid.height; z++)
        for (let x = 0; x < grid.width; x++) {
          if (!grid.isWalkable(x, z)) continue;
          if (h(x, z) !== 0) raised++;
          if (!inRoom(d, x, z)) expect(h(x, z)).toBe(0);
          for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]])
            if (grid.isWalkable(x + dx, z + dz)) expect(Math.abs(h(x, z) - h(x + dx, z + dz))).toBeLessThanOrEqual(STEP + 1e-6);
        }
      const boss = d.rooms.find((r) => r.kind === 'boss')!;
      for (let z = boss.z; z < boss.z + boss.h; z++) for (let x = boss.x; x < boss.x + boss.w; x++) expect(h(x, z)).toBe(0);
      for (const r of d.rooms)
        for (let x = r.x; x < r.x + r.w; x++) {
          expect(h(x, r.z)).toBe(0);
          expect(h(x, r.z + r.h - 1)).toBe(0);
        }
    }
    expect(raised).toBeGreaterThan(0);
  });

  it('corner props only sit in closed corners and never on spawns or chests', () => {
    for (const seed of SEEDS) {
      const d = generateDungeon(seed, 2);
      for (const s of d.spawns) expect(d.grid.get(Math.floor(s.x), Math.floor(s.z))).toBe(Tile.Floor);
      for (const c of d.chests) expect(d.grid.get(Math.floor(c.x), Math.floor(c.z))).toBe(Tile.Floor);
    }
    const props = SEEDS.reduce((n, s) => n + Array.from(generateDungeon(s, 0).grid.tiles).filter((t) => t === Tile.Prop).length, 0);
    expect(props).toBeGreaterThan(0);
  });
});

describe('floor themes', () => {
  it('never repeats a biome on back-to-back floors, and no two of the first 12 floors look alike', () => {
    for (const seed of SEEDS) {
      const themes = Array.from({ length: 12 }, (_, d) => floorTheme(seed, d));
      for (let d = 1; d < themes.length; d++) expect(themes[d].biome.id).not.toBe(themes[d - 1].biome.id);
      expect(new Set(themes.map((t) => `${t.biome.id}:${t.mood}`)).size).toBe(12);
      // Every biome shows up in the first six floors.
      expect(new Set(themes.slice(0, 6).map((t) => t.biome.id)).size).toBe(BIOMES.length);
    }
  });

  it('is deterministic and varies between runs', () => {
    expect(floorTheme(5, 3)).toEqual(floorTheme(5, 3));
    const firsts = new Set(SEEDS.map((s) => floorTheme(s, 0).biome.id));
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe('floor features', () => {
  it('seal the boss arena behind a shrine that can be reached before the gates open', () => {
    let withShrine = 0;
    for (const seed of SEEDS)
      for (const depth of [0, 3, 9]) {
        const d = generateDungeon(seed, depth);
        const bossGate = d.gates.find((g) => g.kind === 'boss');
        if (!d.capture) {
          expect(bossGate).toBeUndefined();
          continue;
        }
        withShrine++;
        expect(bossGate).toBeDefined();
        const closed = reachability(d.grid, d.playerStart, { gatesOpen: false, portals: d.portals });
        const at = (p: { x: number; z: number }) => closed[Math.floor(p.z) * d.grid.width + Math.floor(p.x)];
        // The shrine is reachable with the gates shut; the boss is not.
        expect(at(d.capture)).toBeGreaterThanOrEqual(0);
        const boss = d.spawns.find((s) => s.kind === 'boss')!;
        expect(at(boss)).toBe(-1);
        // Every gate tile sits where a wall or corridor would be, never inside a room.
        for (const g of d.gates) for (const t of g.tiles) expect(d.grid.get(t.x, t.z)).toBe(Tile.Gate);
      }
    expect(withShrine).toBeGreaterThan(SEEDS.length * 2);
  });

  it('link portals between reachable spots, with the pocket dimension sealed off on foot', () => {
    let pockets = 0;
    for (const seed of SEEDS) {
      const d = generateDungeon(seed, 1);
      const walk = reachability(d.grid, d.playerStart, { gatesOpen: true });
      for (const p of d.portals) {
        expect(d.grid.isWalkableAt(p.a.x, p.a.z)).toBe(true);
        expect(d.grid.isWalkableAt(p.b.x, p.b.z)).toBe(true);
        if (p.kind !== 'pocket') continue;
        pockets++;
        // Only the portal gets you into the pocket dimension.
        expect(walk[Math.floor(p.b.z) * d.grid.width + Math.floor(p.b.x)]).toBe(-1);
        const pocket = d.rooms.find((r) => r.kind === 'pocket')!;
        expect(d.spawns.some((s) => s.roomId === pocket.id)).toBe(true);
        expect(d.chests.some((c) => c.rich && c.x > pocket.x && c.x < pocket.x + pocket.w && c.z > pocket.z && c.z < pocket.z + pocket.h)).toBe(true);
      }
    }
    expect(pockets).toBeGreaterThan(0);
  });

  it('hide one rift per floor behind a cracked wall, sealed by a plate puzzle and a brazier trial', () => {
    let rifts = 0;
    let floors = 0;
    for (const seed of SEEDS)
      for (const depth of [0, 1, 4, 8]) {
        floors++;
        const d = generateDungeon(seed, depth);
        expect(d.portals.filter((p) => p.kind === 'pocket').length).toBeLessThanOrEqual(1);
        const rift = d.rift;
        if (!rift) {
          expect(d.portals.some((p) => p.kind === 'pocket')).toBe(false);
          continue;
        }
        rifts++;
        const w = d.grid.width;
        const at = (dist: Int32Array, p: { x: number; z: number }) => dist[Math.floor(p.z) * w + Math.floor(p.x)];
        const portal = d.portals.find((p) => p.id === rift.portalId)!;
        expect(portal.kind).toBe('pocket');
        // The rift sits in a room behind its cracked wall: out of reach until the wall breaks.
        expect(d.gates.find((g) => g.id === rift.gateId)?.kind).toBe('secret');
        const noPortals = reachability(d.grid, d.playerStart, { gatesOpen: false });
        expect(at(noPortals, portal.a)).toBe(-1);
        expect(at(reachability(d.grid, d.playerStart, { gatesOpen: true }), portal.a)).toBeGreaterThanOrEqual(0);
        // Both seals can be worked on from the start, without breaking any wall.
        const seal = d.puzzles[rift.puzzle];
        expect(seal.gateId).toBeNull();
        for (const p of [...seal.plates, seal.obelisk, ...rift.braziers]) expect(at(noPortals, p)).toBeGreaterThanOrEqual(0);
        expect(rift.braziers).toHaveLength(4);
        expect(rift.burn).toBeGreaterThanOrEqual(4);
        // The braziers can be reached in time at walking speed.
        const b = rift.braziers;
        let run = 0;
        for (let i = 1; i < b.length; i++) run += Math.hypot(b[i].x - b[i - 1].x, b[i].z - b[i - 1].z);
        expect(run / 5).toBeLessThan(rift.burn);
        // Nothing else shares a tile with the seals or the rift.
        const tiles = [...seal.plates, seal.obelisk, ...rift.braziers, portal.a].map((p) => `${Math.floor(p.x)},${Math.floor(p.z)}`);
        expect(new Set(tiles).size).toBe(tiles.length);
        for (const c of d.chests) expect(tiles).not.toContain(`${Math.floor(c.x)},${Math.floor(c.z)}`);
      }
    expect(rifts).toBeGreaterThanOrEqual(floors * 0.9);
  });

  it('hide secret rooms and a plate vault behind single gate tiles, each with rich loot', () => {
    let secrets = 0;
    let vaults = 0;
    for (const seed of SEEDS) {
      const d = generateDungeon(seed, 2);
      for (const g of d.gates) {
        if (g.kind === 'boss') continue;
        expect(g.tiles).toHaveLength(1);
        if (g.kind === 'secret') secrets++;
        else vaults++;
      }
      for (const pz of d.puzzles) {
        expect(pz.plates).toHaveLength(3);
        expect([...pz.order].sort()).toEqual([0, 1, 2]);
        for (const p of pz.plates) expect(d.grid.isWalkableAt(p.x, p.z)).toBe(true);
        if (pz.gateId === null) expect(d.rift?.puzzle).toBe(pz.id);
        else expect(d.gates.find((g) => g.id === pz.gateId)?.kind).toBe('vault');
      }
      const rich = d.chests.filter((c) => c.rich).length;
      expect(rich).toBeGreaterThanOrEqual(d.gates.filter((g) => g.kind !== 'boss').length);
    }
    expect(secrets).toBeGreaterThan(0);
    expect(vaults).toBeGreaterThan(0);
  });
});

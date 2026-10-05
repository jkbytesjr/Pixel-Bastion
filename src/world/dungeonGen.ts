/**
 * Seeded procedural dungeon: rooms joined by corridors (minimum spanning tree
 * plus a few loops). Pure logic, no three.js, so it is unit-tested.
 */
import { Rng, hashSeed } from '../core/rng';
import { Tile, TileGrid } from './grid';
import { placeTorches, type Level } from './level';
import { addFeatures, type CaptureSite, type Gate, type PlatePuzzle, type PortalLink } from './features';

/** pocket: a sealed pocket dimension (via mini-portal). vault / secret: hidden behind a gate. */
export type RoomKind = 'start' | 'normal' | 'treasure' | 'boss' | 'pocket' | 'vault' | 'secret';
export type EnemyKind = 'grunt' | 'archer' | 'exploder' | 'spider' | 'shieldbearer' | 'shaman' | 'wraith' | 'boss';
export type BossKind = 'colossus' | 'huntress' | 'pyromancer' | 'necromancer';
export const BOSS_KINDS: readonly BossKind[] = ['colossus', 'huntress', 'pyromancer', 'necromancer'];

export interface Room {
  id: number;
  x: number;
  z: number;
  w: number;
  h: number;
  kind: RoomKind;
}

export interface EnemySpawn {
  kind: EnemyKind;
  x: number;
  z: number;
  roomId: number;
  /** Elite (champion) variant: tougher, glowing, better loot. */
  elite?: boolean;
}

export interface Dungeon extends Level {
  seed: number;
  depth: number;
  rooms: Room[];
  /** Pairs of room ids joined by a corridor. */
  connections: [number, number][];
  spawns: EnemySpawn[];
  /** `rich` chests (vaults, secret rooms, pocket dimension) hold better loot. */
  chests: { x: number; z: number; rich?: boolean }[];
  /** Where the exit portal appears (inside the boss room). */
  exit: { x: number; z: number };
  /** Which boss guards this floor. */
  boss: BossKind;
  /** Gates: the boss arena (opened by the capture shrine), vault doors and cracked walls. */
  gates: Gate[];
  /** The shrine to capture to open the boss gates (null if the floor has none). */
  capture: CaptureSite | null;
  portals: PortalLink[];
  puzzles: PlatePuzzle[];
  /** The hand-built tutorial floor. */
  tutorial?: boolean;
}

const SIZE = 112;
const ROOM_MARGIN = 5;
/** Corridors are 5 to 7 tiles wide: room to move and fight in. */
const CORRIDOR_MIN = 5;
const CORRIDOR_MAX = 7;
/** One step of visual floor height (raised altars, ledges, pits). */
export const STEP = 0.25;
/**
 * Rooms grew to open arenas; this keeps the number of monsters per room the
 * same as when rooms were a third of the size.
 */
const AREA_PER_ENEMY = 60;

export function roomCenter(r: Room): { x: number; z: number } {
  return { x: Math.floor(r.x + r.w / 2), z: Math.floor(r.z + r.h / 2) };
}

function overlaps(a: Room, b: Room, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w && a.x + a.w + margin > b.x && a.z - margin < b.z + b.h && a.z + a.h + margin > b.z
  );
}

/**
 * Enemy mix per floor. New kinds unlock as you descend: spiders from floor 1,
 * shieldbearers from floor 2, shamans from floor 3, wraiths from floor 4.
 */
export function enemyWeights(depth: number): [EnemyKind, number][] {
  const d = Math.min(depth, 6);
  const w: [EnemyKind, number][] = [
    ['grunt', Math.max(20, 56 - depth * 8)],
    ['archer', 18 + d * 3],
    ['exploder', 16 + d * 3],
    ['spider', 14],
  ];
  if (depth >= 1) w.push(['shieldbearer', 8 + d * 2]);
  if (depth >= 2) w.push(['shaman', 5 + d]);
  if (depth >= 3) w.push(['wraith', 6 + d * 2]);
  return w;
}

/** Chance that a regular enemy spawns as an elite. */
export function eliteChance(depth: number): number {
  return Math.min(0.2, 0.04 + 0.015 * depth);
}

/**
 * The boss guarding floor `depth` (0-based) of a run. Floor 1 is always the
 * Colossus (the gentlest fight); floors 2-4 are the other three in a seeded
 * order, so each boss appears once. After that the floors go on forever, each
 * with a seeded boss that is never the same as the previous floor's.
 */
export function bossForFloor(seed: number, depth: number): BossKind {
  const first: BossKind[] = ['colossus', ...new Rng(hashSeed(`${seed}:bosses`)).shuffle(BOSS_KINDS.filter((b) => b !== 'colossus'))];
  if (depth < first.length) return first[Math.max(0, depth)];
  let prev = first[first.length - 1];
  for (let d = first.length; d <= depth; d++) {
    prev = new Rng(hashSeed(`${seed}:boss:${d}`)).pick(BOSS_KINDS.filter((b) => b !== prev));
  }
  return prev;
}

export function generateDungeon(seed: number, depth: number): Dungeon {
  const rng = new Rng(hashSeed(`${seed}:${depth}`));
  const grid = new TileGrid(SIZE, SIZE);
  const rooms: Room[] = [];
  const targetRooms = 9 + Math.min(depth, 3);

  const tryPlace = (w: number, h: number, kind: RoomKind): Room | null => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const room: Room = { id: rooms.length, x: rng.int(2, SIZE - w - 2), z: rng.int(2, SIZE - h - 2), w, h, kind };
      if (rooms.every((r) => !overlaps(r, room, ROOM_MARGIN))) {
        rooms.push(room);
        return room;
      }
    }
    return null;
  };

  // Boss arena first so it always fits.
  const bossSize = rng.int(19, 23);
  const boss = tryPlace(bossSize, bossSize, 'boss')!;
  for (let attempt = 0; attempt < 400 && rooms.length < targetRooms; attempt++) {
    tryPlace(rng.int(11, 17), rng.int(11, 17), 'normal');
  }

  // Pillars in larger rooms, placed before corridors so corridors can cut through them.
  for (const r of rooms) {
    grid.fillRect(r.x, r.z, r.w, r.h, Tile.Floor);
    if (r.w >= 14 && r.h >= 14 && rng.chance(0.6)) {
      // Chunky 2x2 pillars, well clear of the walls.
      const px = r.x + 3;
      const pz = r.z + 3;
      const qx = r.x + r.w - 5;
      const qz = r.z + r.h - 5;
      for (const [x, z] of [
        [px, pz],
        [qx, pz],
        [px, qz],
        [qx, qz],
      ])
        grid.fillRect(x, z, 2, 2, Tile.Void);
    }
  }

  // Minimum spanning tree over room centres (Prim), then a few extra loops.
  const centers = rooms.map(roomCenter);
  const dist = (a: number, b: number) => Math.hypot(centers[a].x - centers[b].x, centers[a].z - centers[b].z);
  const connections: [number, number][] = [];
  const inTree = new Set([0]);
  while (inTree.size < rooms.length) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const a of inTree)
      for (let b = 0; b < rooms.length; b++) {
        if (inTree.has(b)) continue;
        const d = dist(a, b);
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
    connections.push(best!);
    inTree.add(best![1]);
  }
  for (let a = 0; a < rooms.length; a++)
    for (let b = a + 1; b < rooms.length; b++) {
      const exists = connections.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
      if (!exists && dist(a, b) < 36 && rng.chance(0.15)) connections.push([a, b]);
    }

  for (const [a, b] of connections) carveCorridor(grid, centers[a], centers[b], rng.chance(0.5), rng.int(CORRIDOR_MIN, CORRIDOR_MAX));
  grid.buildWalls();
  placeCornerProps(grid, rooms, rng);

  // Start = room furthest (in corridor hops) from the boss.
  const hops = roomHops(rooms.length, connections, boss.id);
  let start = rooms.find((r) => r.kind === 'normal')!;
  for (const r of rooms) {
    if (r.kind !== 'normal') continue;
    if (hops[r.id] > hops[start.id] || (hops[r.id] === hops[start.id] && dist(r.id, boss.id) > dist(start.id, boss.id)))
      start = r;
  }
  start.kind = 'start';
  const normals = rooms.filter((r) => r.kind === 'normal');
  if (normals.length > 2) rng.pick(normals).kind = 'treasure';

  // Spawns and chests.
  const spawns: EnemySpawn[] = [];
  const chests: { x: number; z: number }[] = [];
  const used = new Set<number>();
  const freeTile = (r: Room, inset: number): { x: number; z: number } | null => {
    for (let i = 0; i < 60; i++) {
      const x = rng.int(r.x + inset, r.x + r.w - 1 - inset);
      const z = rng.int(r.z + inset, r.z + r.h - 1 - inset);
      const key = z * SIZE + x;
      if (grid.get(x, z) === Tile.Floor && !used.has(key)) {
        used.add(key);
        return { x: x + 0.5, z: z + 0.5 };
      }
    }
    return null;
  };

  const bossCenter = roomCenter(boss);
  spawns.push({ kind: 'boss', x: bossCenter.x + 0.5, z: bossCenter.z + 0.5, roomId: boss.id });
  used.add(bossCenter.z * SIZE + bossCenter.x);

  for (const r of rooms) {
    if (r.kind === 'start') continue;
    if (r.kind === 'normal' || r.kind === 'treasure') {
      const area = r.w * r.h;
      // Deeper floors add enemies per room, up to a cap; beyond that they just hit harder.
      const count = Math.round(area / AREA_PER_ENEMY) + Math.min(depth, 3) + rng.int(0, 1);
      for (let i = 0; i < count; i++) {
        const t = freeTile(r, 2);
        if (!t) continue;
        const kind = rng.weighted(enemyWeights(depth));
        spawns.push({ kind, ...t, roomId: r.id, elite: rng.chance(eliteChance(depth)) });
        // Spiders hunt in packs of three; the pack uses up the room's slots.
        if (kind === 'spider') {
          for (let k = 0; k < 2 && i < count; k++, i++) {
            const t2 = freeTile(r, 2);
            if (t2) spawns.push({ kind: 'spider', ...t2, roomId: r.id });
          }
        }
      }
    }
    const chestCount = r.kind === 'treasure' ? 2 : r.kind === 'normal' && rng.chance(0.25) ? 1 : 0;
    for (let i = 0; i < chestCount; i++) {
      const t = freeTile(r, 2);
      if (t) chests.push(t);
    }
  }

  const sc = roomCenter(start);
  const playerStart = { x: sc.x + 0.5, z: sc.z + 0.5 };
  const exit = { x: boss.x + boss.w / 2, z: boss.z + 2.5 };
  // Shrine and boss gates, portals, the plate vault and secret rooms (their own random stream).
  const featureRng = new Rng(hashSeed(`${seed}:${depth}:features`));
  const features = addFeatures({
    grid,
    rooms,
    rng: featureRng,
    start: playerStart,
    taken: used,
    addChest: (p, rich) => chests.push({ x: p.x, z: p.z, ...(rich ? { rich: true } : {}) }),
    addSpawns: (room, spots) =>
      spots.forEach((p, i) => spawns.push({ kind: featureRng.weighted(enemyWeights(depth)), x: p.x, z: p.z, roomId: room.id, elite: i === 0 })),
  });
  return {
    seed,
    depth,
    grid,
    rooms,
    connections,
    spawns,
    chests,
    exit,
    boss: bossForFloor(seed, depth),
    theme: depth,
    heights: floorHeights(grid, rooms, new Rng(hashSeed(`${seed}:${depth}:heights`))),
    torches: placeTorches(grid, 6),
    playerStart,
    ...features,
  };
}

function carveCorridor(
  grid: TileGrid,
  a: { x: number; z: number },
  b: { x: number; z: number },
  horizontalFirst: boolean,
  width: number,
): void {
  const corner = horizontalFirst ? { x: b.x, z: a.z } : { x: a.x, z: b.z };
  carveLine(grid, a, corner, width);
  carveLine(grid, corner, b, width);
}

/** A straight corridor `width` tiles wide, centred on the line between the points. */
function carveLine(grid: TileGrid, a: { x: number; z: number }, b: { x: number; z: number }, width: number): void {
  const half = Math.floor(width / 2);
  const x0 = Math.min(a.x, b.x) - half;
  const z0 = Math.min(a.z, b.z) - half;
  const w = Math.abs(a.x - b.x) + width;
  const h = Math.abs(a.z - b.z) + width;
  grid.fillRect(x0, z0, w, h, Tile.Floor);
}

/**
 * Crates, barrels, urns and planters stacked into room corners. Only corners
 * closed off by wall on both sides get them, so they never narrow a doorway
 * or a path. Returns the prop tiles.
 */
function placeCornerProps(grid: TileGrid, rooms: Room[], rng: Rng): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (const r of rooms) {
    if (r.kind === 'boss') continue;
    for (const [cx, cz, sx, sz] of [
      [r.x, r.z, 1, 1],
      [r.x + r.w - 1, r.z, -1, 1],
      [r.x, r.z + r.h - 1, 1, -1],
      [r.x + r.w - 1, r.z + r.h - 1, -1, -1],
    ]) {
      if (!rng.chance(0.65)) continue;
      // The walls beside the corner must be solid for three tiles each way.
      let closed = true;
      for (let i = -1; i <= 3 && closed; i++) {
        if (grid.get(cx + sx * i, cz - sz) !== Tile.Wall) closed = false;
        if (grid.get(cx - sx, cz + sz * i) !== Tile.Wall) closed = false;
      }
      if (!closed) continue;
      const cluster: [number, number][] = [[0, 0]];
      if (rng.chance(0.7)) cluster.push([1, 0]);
      if (rng.chance(0.7)) cluster.push([0, 1]);
      for (const [dx, dz] of cluster) {
        const x = cx + sx * dx;
        const z = cz + sz * dz;
        if (grid.get(x, z) !== Tile.Floor) continue;
        grid.set(x, z, Tile.Prop);
        out.push({ x, z });
      }
    }
  }
  return out;
}

/**
 * Visual floor heights: some rooms get a raised altar, a stepped ledge or a
 * sunken pit in their interior, ringed by one-step stairs. Room edges, doorways
 * and corridors stay at 0, the boss arena stays flat, and walkable neighbours
 * never differ by more than one STEP.
 */
export function floorHeights(grid: TileGrid, rooms: Room[], rng: Rng): Float32Array {
  const heights = new Float32Array(grid.width * grid.height);
  for (const r of rooms) {
    if (!(r.kind === 'normal' || r.kind === 'treasure' || r.kind === 'start') || r.w < 11 || r.h < 11 || !rng.chance(0.75)) continue;
    // Interior: two tiles in from the walls; the core sits one more tile in so its stairs fit.
    const ix0 = r.x + 3;
    const iz0 = r.z + 3;
    const ix1 = r.x + r.w - 4;
    const iz1 = r.z + r.h - 4;
    const kind = rng.pick(['altar', 'pit', 'ledge'] as const);
    const level = kind === 'pit' ? -2 * STEP : 2 * STEP;
    const core: [number, number, number, number] =
      kind === 'ledge'
        ? rng.chance(0.5)
          ? [ix0, iz0, ix1, iz0 + rng.int(1, 3)]
          : [ix0, iz0, ix0 + rng.int(1, 3), iz1]
        : (() => {
            const hw = Math.max(1, Math.floor((ix1 - ix0) / 4));
            const hh = Math.max(1, Math.floor((iz1 - iz0) / 4));
            const mx = Math.floor((ix0 + ix1) / 2);
            const mz = Math.floor((iz0 + iz1) / 2);
            return [mx - hw, mz - hh, mx + hw, mz + hh];
          })();
    for (let z = core[1] - 1; z <= core[3] + 1; z++)
      for (let x = core[0] - 1; x <= core[2] + 1; x++) {
        if (grid.get(x, z) !== Tile.Floor) continue;
        const inCore = x >= core[0] && x <= core[2] && z >= core[1] && z <= core[3];
        heights[z * grid.width + x] = inCore ? level : level / 2;
      }
  }
  return heights;
}

/** BFS hop count from `from` to every room over the corridor graph. */
function roomHops(count: number, connections: [number, number][], from: number): number[] {
  const hops = new Array<number>(count).fill(Infinity);
  hops[from] = 0;
  const queue = [from];
  while (queue.length) {
    const r = queue.shift()!;
    for (const [a, b] of connections) {
      const n = a === r ? b : b === r ? a : -1;
      if (n >= 0 && hops[n] === Infinity) {
        hops[n] = hops[r] + 1;
        queue.push(n);
      }
    }
  }
  return hops;
}

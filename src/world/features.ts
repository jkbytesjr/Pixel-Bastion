/**
 * Floor features beyond rooms and corridors: a capture shrine that unlocks
 * the gates to the boss arena, a hidden rift into another dimension (sealed
 * until two puzzles are solved), a shortcut portal pair, a pressure-plate
 * puzzle that opens a vault, and cracked walls hiding secret rooms. Pure
 * logic on the tile grid, unit-tested.
 */
import type { Rng } from '../core/rng';
import { Tile, type TileGrid } from './grid';

export interface Point {
  x: number;
  z: number;
}

/** A row of gate tiles that blocks until opened. */
export interface Gate {
  id: number;
  /** boss: opened by the capture shrine. vault: by the plate puzzle. secret: by striking the cracked wall. */
  kind: 'boss' | 'vault' | 'secret';
  /** Tile coordinates. */
  tiles: Point[];
}

/** Stand in the circle to capture it. */
export interface CaptureSite {
  x: number;
  z: number;
  radius: number;
  roomId: number;
}

/** Two linked mini-portals (world positions). */
export interface PortalLink {
  id: number;
  /** pocket: the rift into a sealed pocket dimension and back. shortcut: between two distant rooms. */
  kind: 'pocket' | 'shortcut';
  a: Point;
  b: Point;
}

/** Step on the plates in the order the obelisk shows. */
export interface PlatePuzzle {
  id: number;
  /** The vault gate it opens, or null for one of the rift's seals. */
  gateId: number | null;
  plates: Point[];
  /** Plate indices in the correct order. */
  order: number[];
  obelisk: Point;
}

/**
 * The floor's hidden rift: a dormant portal in a secret room, held shut by
 * two seals. One is a plate puzzle, the other a brazier trial (light every
 * brazier before the first one burns out).
 */
export interface Rift {
  /** The pocket portal it wakes. */
  portalId: number;
  /** The cracked wall hiding it. */
  gateId: number;
  /** Index into `puzzles` of its plate seal. */
  puzzle: number;
  braziers: Point[];
  /** Seconds the braziers burn once the first is lit. */
  burn: number;
}

export interface Features {
  gates: Gate[];
  capture: CaptureSite | null;
  portals: PortalLink[];
  puzzles: PlatePuzzle[];
  rift: Rift | null;
}

/** Hero walking speed (world units per second) the brazier timer is planned around. */
const PLAN_SPEED = 5;

export interface RoomLike {
  id: number;
  x: number;
  z: number;
  w: number;
  h: number;
  kind: string;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const center = (r: RoomLike): Point => ({ x: Math.floor(r.x + r.w / 2) + 0.5, z: Math.floor(r.z + r.h / 2) + 0.5 });

/**
 * Tiles reachable on foot from `start`, optionally passing through gates,
 * and following portal links. Returns BFS distance per tile (-1 = unreachable).
 */
export function reachability(grid: TileGrid, start: Point, opts: { gatesOpen: boolean; portals?: PortalLink[] }): Int32Array {
  const w = grid.width;
  const dist = new Int32Array(w * grid.height).fill(-1);
  const pass = (x: number, z: number) => grid.isWalkable(x, z) || (opts.gatesOpen && grid.get(x, z) === Tile.Gate);
  const links = new Map<number, number[]>();
  for (const p of opts.portals ?? []) {
    const a = Math.floor(p.a.z) * w + Math.floor(p.a.x);
    const b = Math.floor(p.b.z) * w + Math.floor(p.b.x);
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const sx = Math.floor(start.x);
  const sz = Math.floor(start.z);
  if (!pass(sx, sz)) return dist;
  const queue = [sz * w + sx];
  dist[queue[0]] = 0;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % w;
    const z = (idx - x) / w;
    const next: number[] = [];
    for (const [dx, dz] of DIRS) if (pass(x + dx, z + dz)) next.push((z + dz) * w + x + dx);
    next.push(...(links.get(idx) ?? []));
    for (const n of next) {
      if (dist[n] !== -1) continue;
      dist[n] = dist[idx] + 1;
      queue.push(n);
    }
  }
  return dist;
}

/** A room's floor tiles away from the walls and free of anything listed in `taken`. */
function openSpots(grid: TileGrid, r: RoomLike, inset: number, taken: Set<number>): Point[] {
  const out: Point[] = [];
  for (let z = r.z + inset; z < r.z + r.h - inset; z++)
    for (let x = r.x + inset; x < r.x + r.w - inset; x++)
      if (grid.get(x, z) === Tile.Floor && !taken.has(z * grid.width + x)) out.push({ x: x + 0.5, z: z + 0.5 });
  return out;
}

/** Every tile in the rectangle (plus `margin`) is empty void inside the map. */
function clearArea(grid: TileGrid, x: number, z: number, w: number, h: number, margin: number): boolean {
  for (let j = z - margin; j < z + h + margin; j++)
    for (let i = x - margin; i < x + w + margin; i++) if (!grid.inBounds(i, j) || i < 1 || j < 1 || i >= grid.width - 1 || j >= grid.height - 1 || grid.get(i, j) !== Tile.Void) return false;
  return true;
}

export interface FeatureInput {
  grid: TileGrid;
  rooms: RoomLike[];
  rng: Rng;
  start: Point;
  /** Tiles already holding spawns or chests. */
  taken: Set<number>;
  /** Add a chest (rich: vault-grade loot). */
  addChest(p: Point, rich: boolean): void;
  /** Add monsters to a new room. */
  addSpawns(room: RoomLike, spots: Point[]): void;
}

/** Lay out this floor's features. Mutates the grid and room list. */
export function addFeatures(input: FeatureInput): Features {
  const { grid, rooms, rng, start, taken } = input;
  const gates: Gate[] = [];
  const portals: PortalLink[] = [];
  const puzzles: PlatePuzzle[] = [];
  let nextGate = 0;
  const w = grid.width;
  const key = (p: Point) => Math.floor(p.z) * w + Math.floor(p.x);

  // ---- Gates on every way into the boss arena ----
  const boss = rooms.find((r) => r.kind === 'boss');
  if (boss) {
    const tiles: Point[] = [];
    for (let x = boss.x - 1; x <= boss.x + boss.w; x++)
      for (const z of [boss.z - 1, boss.z + boss.h]) if (grid.get(x, z) === Tile.Floor) tiles.push({ x, z });
    for (let z = boss.z; z < boss.z + boss.h; z++)
      for (const x of [boss.x - 1, boss.x + boss.w]) if (grid.get(x, z) === Tile.Floor) tiles.push({ x, z });
    if (tiles.length) {
      for (const t of tiles) grid.set(t.x, t.z, Tile.Gate);
      gates.push({ id: nextGate++, kind: 'boss', tiles });
    }
  }

  // What the hero can reach before the boss gates open.
  let early = reachability(grid, start, { gatesOpen: false });
  const reachable = (r: RoomLike) => early[key(center(r))] >= 0;
  const usable = rooms.filter((r) => (r.kind === 'normal' || r.kind === 'treasure') && reachable(r));

  // ---- The capture shrine: the reachable room furthest from the start ----
  let capture: CaptureSite | null = null;
  const shrineRoom = [...usable].sort((a, b) => early[key(center(b))] - early[key(center(a))])[0];
  if (shrineRoom && gates.length) {
    const c = center(shrineRoom);
    capture = { x: c.x, z: c.z, radius: 2.6, roomId: shrineRoom.id };
    taken.add(key(c));
  } else if (gates.length) {
    // Nothing to capture before the boss: leave the arena open.
    for (const t of gates[0].tiles) grid.set(t.x, t.z, Tile.Floor);
    gates.length = 0;
  }

  // ---- Secret rooms behind cracked walls, and the plate-puzzle vault ----
  /** Carve a small room past one wall of `r`, joined through a single gate tile. Returns it, or null if there's no space. */
  const carveBehind = (r: RoomLike, w2: number, h2: number, kind: 'secret' | 'vault'): { room: RoomLike; gate: Point; inside: Point } | null => {
    const sides = rng.shuffle([0, 1, 2, 3]);
    for (const side of sides) {
      // Gate tile on the wall line, in the middle of that side; the new room starts one tile further out.
      let gx: number, gz: number, rx: number, rz: number, ix: number, iz: number;
      if (side === 0) {
        gx = r.x + Math.floor(r.w / 2);
        gz = r.z - 1;
        rx = gx - Math.floor(w2 / 2);
        rz = gz - h2;
        ix = gx;
        iz = r.z;
      } else if (side === 1) {
        gx = r.x + Math.floor(r.w / 2);
        gz = r.z + r.h;
        rx = gx - Math.floor(w2 / 2);
        rz = gz + 1;
        ix = gx;
        iz = r.z + r.h - 1;
      } else if (side === 2) {
        gx = r.x - 1;
        gz = r.z + Math.floor(r.h / 2);
        rx = gx - w2;
        rz = gz - Math.floor(h2 / 2);
        ix = r.x;
        iz = gz;
      } else {
        gx = r.x + r.w;
        gz = r.z + Math.floor(r.h / 2);
        rx = gx + 1;
        rz = gz - Math.floor(h2 / 2);
        ix = r.x + r.w - 1;
        iz = gz;
      }
      const sideways = side < 2 ? [gx - 1, gx + 1].map((x) => grid.get(x, gz)) : [gz - 1, gz + 1].map((z) => grid.get(gx, z));
      // The wall tile and its neighbours must be plain wall (not a corridor), the inside tile plain floor.
      if (grid.get(gx, gz) !== Tile.Wall || sideways.some((t) => t !== Tile.Wall) || grid.get(ix, iz) !== Tile.Floor) continue;
      // Room plus a one-tile border must be empty, except toward the wall it backs onto.
      const x0 = rx - (side === 3 ? 0 : 1);
      const x1 = rx + w2 + (side === 2 ? 0 : 1);
      const z0 = rz - (side === 1 ? 0 : 1);
      const z1 = rz + h2 + (side === 0 ? 0 : 1);
      if (!clearArea(grid, x0, z0, x1 - x0, z1 - z0, 0)) continue;
      grid.fillRect(rx, rz, w2, h2, Tile.Floor);
      grid.buildWalls();
      grid.set(gx, gz, Tile.Gate);
      const room: RoomLike = { id: rooms.length, x: rx, z: rz, w: w2, h: h2, kind };
      rooms.push(room);
      return { room, gate: { x: gx, z: gz }, inside: { x: ix + 0.5, z: iz + 0.5 } };
    }
    return null;
  };

  /** Three plates in `r`, spread apart and clear of `avoid`. */
  const placePlates = (r: RoomLike, avoid: Point[]): Point[] | null => {
    const plates: Point[] = [];
    for (const s of rng.shuffle(openSpots(grid, r, 3, taken))) {
      if (plates.length === 3) break;
      if (plates.every((p) => Math.hypot(p.x - s.x, p.z - s.z) >= 4) && avoid.every((p) => Math.hypot(p.x - s.x, p.z - s.z) >= 2)) plates.push(s);
    }
    return plates.length === 3 ? plates : null;
  };

  // ---- The hidden rift: a dormant portal behind a cracked wall, two seals elsewhere ----
  let rift: Rift | null = null;
  const busy = new Set<RoomLike>([shrineRoom].filter(Boolean) as RoomLike[]);
  {
    // Hide it behind a wall of any reachable room (the quieter ones first).
    let hidden: ReturnType<typeof carveBehind> = null;
    for (const r of [...rng.shuffle(usable.filter((r) => !busy.has(r))), ...busy]) if ((hidden = carveBehind(r, 5, 5, 'secret'))) break;
    if (hidden) taken.add(key(hidden.inside));
    // The pocket dimension needs open void, away from everything else: as big as fits.
    const spots: Point[] = [];
    let size = 0;
    for (const [s, margin] of [
      [11, 3],
      [9, 2],
      [7, 2],
    ]) {
      if (!hidden || spots.length) break;
      size = s;
      for (let z = margin; z < grid.height - s - margin; z += 2)
        for (let x = margin; x < grid.width - s - margin; x += 2) if (clearArea(grid, x, z, s, s, margin)) spots.push({ x, z });
    }
    // The plate seal: any fair-sized room with space for three plates around an obelisk.
    let plateRoom: RoomLike | undefined;
    let plates: Point[] | null = null;
    if (spots.length)
      for (const r of rng.shuffle(usable.filter((r) => !busy.has(r) && r.w >= 11 && r.h >= 11))) {
        if ((plates = placePlates(r, [center(r)]))) {
          plateRoom = r;
          break;
        }
      }
    // The brazier trial: one brazier near each corner of another room (or a big plate room).
    let corners: Point[] = [];
    if (plateRoom && plates) {
      const plateSpots = [...plates, center(plateRoom)];
      const options = rng.shuffle(usable.filter((r) => !busy.has(r) && r !== plateRoom && r.w >= 9 && r.h >= 9));
      if (plateRoom.w >= 13 && plateRoom.h >= 13) options.push(plateRoom);
      for (const r of options) {
        corners = [];
        for (const [fx, fz] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]) {
          // The free floor tile nearest the corner, two tiles in from the walls.
          const want = { x: fx ? r.x + r.w - 2.5 : r.x + 2.5, z: fz ? r.z + r.h - 2.5 : r.z + 2.5 };
          const best = openSpots(grid, r, 1, taken)
            .filter((p) => plateSpots.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 2) && Math.hypot(p.x - want.x, p.z - want.z) <= 2.3)
            .sort((p, q) => Math.hypot(p.x - want.x, p.z - want.z) - Math.hypot(q.x - want.x, q.z - want.z))[0];
          if (best) corners.push(best);
        }
        if (corners.length === 4) break;
      }
    }
    if (hidden && plateRoom && plates && corners.length === 4) {
      const at = rng.pick(spots);
      grid.fillRect(at.x, at.z, size, size, Tile.Floor);
      grid.buildWalls();
      const pocket: RoomLike = { id: rooms.length, x: at.x, z: at.z, w: size, h: size, kind: 'pocket' };
      rooms.push(pocket);
      const gateId = nextGate++;
      gates.push({ id: gateId, kind: 'secret', tiles: [hidden.gate] });
      const portalAt = center(hidden.room);
      const pc = center(pocket);
      portals.push({ id: portals.length, kind: 'pocket', a: portalAt, b: { x: pc.x, z: pocket.z + size - 2.5 } });
      input.addChest({ x: pc.x - 1.5, z: pocket.z + 2.5 }, true);
      input.addChest({ x: pc.x + 1.5, z: pocket.z + 2.5 }, true);
      input.addSpawns(pocket, [
        { x: pc.x - 2, z: pc.z },
        { x: pc.x + 2, z: pc.z },
        { x: pc.x, z: pc.z - 1 },
      ]);
      const obelisk = center(plateRoom);
      for (const p of [...plates, ...corners, obelisk, portalAt]) taken.add(key(p));
      puzzles.push({ id: puzzles.length, gateId: null, plates, order: rng.shuffle([0, 1, 2]), obelisk });
      // Long enough to run the corners (shortest way round: all but the longest side), with some slack.
      const sides = corners.map((c, i) => Math.hypot(c.x - corners[(i + 1) % 4].x, c.z - corners[(i + 1) % 4].z));
      const run = sides.reduce((a, b) => a + b, 0) - Math.max(...sides);
      rift = { portalId: portals.length - 1, gateId, puzzle: puzzles.length - 1, braziers: corners, burn: Math.round((run / PLAN_SPEED) * 1.6 + 2) };
      busy.add(plateRoom);
      for (const r of usable) if (corners.some((c) => c.x > r.x && c.x < r.x + r.w && c.z > r.z && c.z < r.z + r.h)) busy.add(r);
    } else if (hidden) {
      // The rift couldn't be finished: what was carved is just a secret room.
      gates.push({ id: nextGate++, kind: 'secret', tiles: [hidden.gate] });
      input.addChest(center(hidden.room), true);
    }
  }

  // A plate puzzle in a big reachable room opens a vault behind its wall.
  const puzzleRoom = rng.shuffle(usable.filter((r) => r.w >= 13 && r.h >= 13 && !busy.has(r)))[0];
  if (puzzleRoom && rng.chance(0.8)) {
    const vault = carveBehind(puzzleRoom, 5, 5, 'vault');
    if (vault) {
      const gateId = nextGate++;
      gates.push({ id: gateId, kind: 'vault', tiles: [vault.gate] });
      const plates = placePlates(puzzleRoom, []);
      if (plates) {
        for (const p of plates) taken.add(key(p));
        taken.add(key(vault.inside));
        puzzles.push({ id: puzzles.length, gateId, plates, order: rng.shuffle([0, 1, 2]), obelisk: vault.inside });
        const vc = center(vault.room);
        input.addChest({ x: vc.x - 1, z: vc.z }, true);
        input.addChest({ x: vc.x + 1, z: vc.z }, true);
      } else {
        // No room for the plates: the vault just stays open.
        grid.set(vault.gate.x, vault.gate.z, Tile.Floor);
        gates.pop();
        vault.room.kind = 'secret';
      }
    }
  }

  // One or two secret rooms behind cracked walls.
  const secretCount = rng.int(1, 2);
  for (const r of rng.shuffle(usable.filter((x) => !busy.has(x) && x !== puzzleRoom))) {
    if (gates.filter((g) => g.kind === 'secret' && g.id !== rift?.gateId).length >= secretCount) break;
    const secret = carveBehind(r, 5, 5, 'secret');
    if (!secret) continue;
    gates.push({ id: nextGate++, kind: 'secret', tiles: [secret.gate] });
    input.addChest(center(secret.room), true);
  }

  early = reachability(grid, start, { gatesOpen: false });

  // ---- A shortcut between two far-apart rooms ----
  if (usable.length >= 3 && rng.chance(0.7)) {
    const byDist = [...usable].sort((a, b) => early[key(center(a))] - early[key(center(b))]);
    const near = byDist[Math.min(1, byDist.length - 1)];
    const far = byDist[byDist.length - 1];
    const a = rng.pick(openSpots(grid, near, 2, taken));
    const b = rng.pick(openSpots(grid, far, 2, taken));
    if (a && b && near !== far) {
      taken.add(key(a));
      taken.add(key(b));
      portals.push({ id: portals.length, kind: 'shortcut', a, b });
    }
  }

  return { gates, capture, portals, puzzles, rift };
}

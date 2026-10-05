import * as THREE from 'three';
import { Tile, type TileGrid } from './grid';
import type { Level } from './level';
import { Rng, hashSeed } from '../core/rng';
import { applyWallCutout } from './wallCutout';
import { floorTheme, type Atmosphere, type Biome, type FloorMat, type FloorTheme, type PropKind } from './biomes';

/**
 * The world's look. Gameplay happens on the tile grid (floor, walls, solid
 * props) with optional visual floor heights; everything here is presentation
 * built around that: blended floor materials and mosaics, block-masonry walls
 * with cornices, pillars, alcoves and arches, layered cliffs falling into the
 * chasms, props, crystals and water, plus the list of glowing spots the game
 * lights and haloes.
 */

const WALL_HEIGHT = 2;
/** How far the scenery continues past the map edge (fog hides the end). */
const MARGIN = 36;
/** Level geometry is split into chunks this many tiles across, for culling. */
const CHUNK = 16;

export type { Atmosphere } from './biomes';

type LevelLike = Level & {
  seed?: number;
  rooms?: { x: number; z: number; w: number; h: number; kind: string }[];
};

/** The theme (biome + mood) a floor is dressed in. */
export function themeFor(level: { seed?: number; theme: number }): FloorTheme {
  return floorTheme(level.seed ?? 0, level.theme);
}

/** Lighting, sky and fog for a floor. */
export function atmosphereFor(level: { seed?: number; theme: number }): Atmosphere {
  return themeFor(level).atmosphere;
}

/** A glowing spot: drives a coloured point light (nearest few) and a soft halo. */
export interface GlowSpot {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Halo size in world units (0 = light only). */
  halo: number;
}

/** Collects box instances (position, size, colour, yaw) and turns them into one InstancedMesh. */
class Batch {
  private readonly items: { m: THREE.Matrix4; c: number; k: number }[] = [];
  private static readonly q = new THREE.Quaternion();
  private static readonly tiltQ = new THREE.Quaternion();
  private static readonly up = new THREE.Vector3(0, 1, 0);
  private static readonly side = new THREE.Vector3(1, 0, 0);

  /** `glow` scales the colour past 1 for the bloom pass (emissive batches only). */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, yaw = 0, tilt = 0, glow = 1): void {
    const q = Batch.q.setFromAxisAngle(Batch.up, yaw);
    if (tilt) q.multiply(Batch.tiltQ.setFromAxisAngle(Batch.side, tilt));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
    this.items.push({ m, c: color, k: glow });
  }

  /** A box spanning y0..y1. */
  column(x: number, z: number, y0: number, y1: number, sx: number, sz: number, color: number, yaw = 0): void {
    if (y1 > y0) this.add(x, (y0 + y1) / 2, z, sx, y1 - y0, sz, color, yaw);
  }

  /**
   * One InstancedMesh per CHUNK x CHUNK tiles of ground, so the renderer can
   * skip everything off screen (and outside the shadow camera) by bounding box.
   */
  build(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Group | null {
    if (this.items.length === 0) return null;
    const chunks = new Map<string, { m: THREE.Matrix4; c: number; k: number }[]>();
    for (const it of this.items) {
      const id = `${Math.floor(it.m.elements[12] / CHUNK)},${Math.floor(it.m.elements[14] / CHUNK)}`;
      let list = chunks.get(id);
      if (!list) chunks.set(id, (list = []));
      list.push(it);
    }
    const group = new THREE.Group();
    group.name = name;
    const c = new THREE.Color();
    for (const list of chunks.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        mesh.setColorAt(i, c.setHex(it.c).multiplyScalar(it.k));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = name;
      group.add(mesh);
    }
    return group;
  }
}

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
function vary(hex: number, rng: Rng, lo: number, hi: number): number {
  return tmpColor.setHex(hex).multiplyScalar(rng.range(lo, hi)).getHex();
}
function shade(hex: number, f: number): number {
  return tmpColor.setHex(hex).multiplyScalar(f).getHex();
}
function mix(a: number, b: number, t: number): number {
  return tmpColor.setHex(a).lerp(tmpColor2.setHex(b), t).getHex();
}

/** Deterministic hash in [0, 1). */
function hash2(x: number, z: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise in [0, 1). */
function noise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function canvasTexture(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void, nearest = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  if (nearest) tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Two-tone tile checker for the big ground planes past the map edge (2x2 tiles per repeat). */
function checkerTexture(a: number, b: number): THREE.CanvasTexture {
  return canvasTexture(
    32,
    (c, s) => {
      const h = s / 2;
      c.fillStyle = '#101010';
      c.fillRect(0, 0, s, s);
      for (const [x, y, col] of [
        [0, 0, a],
        [h, h, a],
        [h, 0, b],
        [0, h, b],
      ] as const) {
        c.fillStyle = '#' + new THREE.Color(col).getHexString();
        c.fillRect(x + 0.5, y + 0.5, h - 1, h - 1);
      }
    },
    true,
  );
}

/** Soft white blobs for the sea of clouds under floating islands. */
function cloudTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (c, s) => {
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 40; i++) {
      const x = rand() * s;
      const y = rand() * s;
      const r = 20 + rand() * 50;
      for (const [ox, oy] of [
        [0, 0],
        [s, 0],
        [-s, 0],
        [0, s],
        [0, -s],
      ]) {
        const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  });
}

/** A circle of blocky runes around a star: magic circles and mosaic centres. */
let runeTex: THREE.CanvasTexture | null = null;
function runeTexture(): THREE.CanvasTexture {
  runeTex ??= canvasTexture(256, (c, s) => {
    const r = s / 2;
    c.translate(r, r);
    c.strokeStyle = '#fff';
    c.lineWidth = 5;
    for (const rad of [r * 0.95, r * 0.7, r * 0.3]) {
      c.beginPath();
      c.arc(0, 0, rad, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const b = a + ((Math.PI * 2) / 6) * 2;
      c.moveTo(Math.sin(a) * r * 0.7, Math.cos(a) * r * 0.7);
      c.lineTo(Math.sin(b) * r * 0.7, Math.cos(b) * r * 0.7);
    }
    c.stroke();
    let seed = 3;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    c.lineWidth = 4;
    for (let i = 0; i < 18; i++) {
      c.save();
      c.rotate((i / 18) * Math.PI * 2);
      c.translate(0, -r * 0.825);
      const g = r * 0.05;
      c.beginPath();
      for (let k = 0; k < 3; k++) {
        c.moveTo((Math.floor(rand() * 3) - 1) * g, (Math.floor(rand() * 3) - 1) * g);
        c.lineTo((Math.floor(rand() * 3) - 1) * g, (Math.floor(rand() * 3) - 1) * g);
      }
      c.stroke();
      c.restore();
    }
  });
  return runeTex;
}

const DIRS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;

type RoomRect = { x: number; z: number; w: number; h: number; kind: string };

/** Everything the painters draw into. */
interface Ctx {
  grid: TileGrid;
  rng: Rng;
  seed: number;
  theme: FloorTheme;
  b: Biome;
  heights: Float32Array | null;
  rooms: RoomRect[];
  /** Ground and low details: receives shadows, never hides the hero. */
  floor: Batch;
  /** Low props and clutter (cast small shadows). */
  props: Batch;
  /** Walls and anything tall (cut away around the hero, cast shadows). */
  tall: Batch;
  /** Unlit glowing blocks for the bloom pass. */
  glow: Batch;
  /** Translucent blocks: slime, water. */
  glass: Batch;
  group: THREE.Group;
  spots: GlowSpot[];
  /** Water channel tiles and mosaic tiles. */
  water: Set<number>;
  mosaic: Map<number, { cx: number; cz: number; r: number }>;
}

const key = (grid: TileGrid, x: number, z: number) => z * grid.width + x;
const isVoid = (grid: TileGrid, x: number, z: number) => grid.get(x, z) === Tile.Void;
const isSolid = (t: number) => t === Tile.Wall || t === Tile.Prop;

/** Is every tile within `r` of (x, z) empty? */
function deepVoid(grid: TileGrid, x: number, z: number, r: number): boolean {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (!isVoid(grid, x + dx, z + dz)) return false;
  return true;
}

function heightAt(c: Ctx, x: number, z: number): number {
  if (!c.heights || !c.grid.inBounds(x, z)) return 0;
  return c.heights[key(c.grid, x, z)];
}

/**
 * A box placed relative to one face of a tile. (nx, nz) is the face's outward
 * normal; `lat` slides along the face, `inset` goes into the block from the
 * face (negative pokes out). Sizes are along the face, up, and into the block.
 */
function faceBox(
  b: Batch,
  cx: number,
  cz: number,
  nx: number,
  nz: number,
  lat: number,
  y: number,
  inset: number,
  sLat: number,
  sY: number,
  sDepth: number,
  color: number,
  glow = 1,
): void {
  const d = 0.5 - inset - sDepth / 2;
  const x = cx + nx * d + nz * lat;
  const z = cz + nz * d + nx * lat;
  if (nx !== 0) b.add(x, y, z, sDepth, sY, sLat, color, 0, 0, glow);
  else b.add(x, y, z, sLat, sY, sDepth, color, 0, 0, glow);
}

/** Builds the static level: a handful of InstancedMeshes plus a few planes. Glowing spots are in `userData.spots`. */
export function buildLevelMeshes(level: LevelLike, seed: number): THREE.Group {
  const { grid } = level;
  const theme = themeFor(level);
  const group = new THREE.Group();
  const c: Ctx = {
    grid,
    rng: new Rng(seed ^ 0x9e3779b9),
    seed: hashSeed(`${seed}:look`),
    theme,
    b: theme.biome,
    heights: level.heights ?? null,
    rooms: level.rooms ?? [],
    floor: new Batch(),
    props: new Batch(),
    tall: new Batch(),
    glow: new Batch(),
    glass: new Batch(),
    group,
    spots: [],
    water: new Set(),
    mosaic: new Map(),
  };

  planRooms(c);
  // Pocket dimensions (and their walls) get an otherworldly style of their own.
  const pockets = c.rooms.filter((r) => r.kind === 'pocket');
  const inPocket = (x: number, z: number) => pockets.some((r) => x >= r.x - 1 && x <= r.x + r.w && z >= r.z - 1 && z <= r.z + r.h);
  const base = c.b;
  for (let z = 0; z < grid.height; z++)
    for (let x = 0; x < grid.width; x++) {
      const t = grid.get(x, z);
      c.b = t !== Tile.Void && inPocket(x, z) ? POCKET_BIOME : base;
      // Gates stand on floor; their doors / cracked walls are drawn by the gate itself.
      if (t === Tile.Floor || t === Tile.Gate) floorTile(c, x, z);
      else if (t === Tile.Wall) wallTile(c, x, z);
      else if (t === Tile.Prop) {
        floorTile(c, x, z);
        prop(c, x, z);
      } else voidTile(c, x, z);
      if (c.b === POCKET_BIOME && t === Tile.Floor) {
        // Glowing seams between the tiles.
        const h = heightAt(c, x, z);
        c.glow.add(x + 0.02, h + 0.004, z + 0.5, 0.03, 0.006, 1, 0xa060ff, 0, 0, 1.4);
        c.glow.add(x + 0.5, h + 0.004, z + 0.02, 1, 0.006, 0.03, 0xa060ff, 0, 0, 1.4);
      }
    }
  c.b = base;
  for (const r of pockets) pocketDressing(c, r);
  for (const r of c.rooms) {
    arches(c, r);
    roomDressing(c, r);
  }
  if (c.b.chasm === 'catacomb') walkways(c);
  if (c.b.chasm === 'island') skyBuildings(c);
  margins(c);
  haze(c);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const lit = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const tallMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  applyWallCutout(tallMat);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });
  for (const [batch, mat, name, cast, receive] of [
    [c.floor, lit, 'floor', false, true],
    [c.props, lit, 'props', true, true],
    [c.tall, tallMat, 'walls', true, true],
    [c.glow, glowMat, 'glow', false, false],
    [c.glass, glassMat, 'glass', false, false],
  ] as const) {
    const chunks = batch.build(cube, mat, name);
    if (!chunks) continue;
    for (const mesh of chunks.children) {
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
    }
    group.add(chunks);
  }
  group.userData.spots = c.spots;
  return group;
}

/** A pocket dimension: violet-black stone floating in the void, seams of light. */
const POCKET_BIOME: Biome = {
  id: 'pocket',
  name: 'Pocket Dimension',
  floor: [['slate', 1]],
  corridor: ['slate'],
  floorColors: { slate: [0x241634, 0x2a1a3e, 0x1e1230] },
  wall: 'basalt',
  wallColors: [0x2a1a3e, 0x24163a, 0x30204a, 0x1e1230],
  mortar: 0x0c0614,
  cap: 'cornice',
  capColor: 0x6a3aaa,
  trim: 0x3a2458,
  pillar: 0x5a3a8a,
  chasm: 'island',
  chasmDepth: 7,
  strata: [0x2a1a3e, 0x1e1230, 0x3a2458, 0x14081e],
  lower: [0x14081e],
  ivy: 0,
  banner: null,
  chains: false,
  water: false,
  beams: false,
  railing: null,
  mosaic: [0x6a3aaa, 0x2a1a3e, 0xc8a0ff],
  rune: 0xb060ff,
  crystals: [0xb060ff, 0x6ad8ff],
  props: [['urn', 1]],
  indoor: true,
  moods: ['arcane'],
};

/** Shards of crystal drifting around a pocket dimension, lighting it from outside. */
function pocketDressing(c: Ctx, r: RoomRect): void {
  const { rng, glow } = c;
  for (let i = 0; i < 14; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.max(r.w, r.h) / 2 + rng.range(2, 6);
    const x = r.x + r.w / 2 + Math.sin(a) * d;
    const z = r.z + r.h / 2 + Math.cos(a) * d;
    const y = rng.range(-2, 3);
    const color = rng.pick([0xb060ff, 0x6ad8ff, 0xff6ad8]);
    glow.add(x, y, z, rng.range(0.15, 0.4), rng.range(0.5, 1.4), rng.range(0.15, 0.4), color, rng.range(0, Math.PI), rng.range(-0.5, 0.5), 1.8);
    c.spots.push({ x, y, z, color, halo: 1.6 });
  }
}

/** Decide which rooms get mosaics and which get water channels. */
function planRooms(c: Ctx): void {
  const { grid, rng, b } = c;
  for (const r of c.rooms) {
    let flat = true;
    for (let z = r.z; z < r.z + r.h && flat; z++) for (let x = r.x; x < r.x + r.w; x++) if (heightAt(c, x, z) !== 0) flat = false;
    const major = r.kind === 'boss' || r.kind === 'treasure' || r.kind === 'start' || (r.w * r.h >= 190 && rng.chance(0.5));
    if (major && flat) {
      const radius = Math.min(r.w, r.h) / 2 - (r.kind === 'boss' ? 3 : 2.5);
      const cx = r.x + r.w / 2;
      const cz = r.z + r.h / 2;
      for (let z = r.z; z < r.z + r.h; z++)
        for (let x = r.x; x < r.x + r.w; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= radius + 0.5) c.mosaic.set(key(grid, x, z), { cx, cz, r: radius });
    } else if (b.water && flat && r.kind !== 'boss' && Math.min(r.w, r.h) >= 13 && rng.chance(0.6)) {
      // A shallow channel, two tiles wide, across the middle of the room.
      const horizontal = rng.chance(0.5);
      const mid = horizontal ? r.z + Math.floor(r.h / 2) - 1 : r.x + Math.floor(r.w / 2) - 1;
      for (let i = 2; i < (horizontal ? r.w : r.h) - 2; i++)
        for (let j = 0; j < 2; j++) {
          const x = horizontal ? r.x + i : mid + j;
          const z = horizontal ? mid + j : r.z + i;
          if (grid.get(x, z) === Tile.Floor) c.water.add(key(grid, x, z));
        }
    }
  }
}

/** Which floor material a tile uses: blended noise fields, so materials flow into each other. */
function floorMat(c: Ctx, x: number, z: number, corridor: boolean): FloorMat {
  const list: [FloorMat, number][] = corridor ? c.b.corridor.map((m) => [m, 1]) : c.b.floor;
  const total = list.reduce((s, [, w]) => s + w, 0);
  const n = Math.min(
    0.999,
    Math.max(0, noise(x * 0.16, z * 0.16, c.seed) * 0.75 + noise(x * 0.45, z * 0.45, c.seed + 7) * 0.25 + (hash2(x, z, c.seed + 3) - 0.5) * 0.08),
  );
  let acc = 0;
  for (const [m, w] of list) {
    acc += w / total;
    if (n < acc) return m;
  }
  return list[list.length - 1][0];
}

function floorColor(c: Ctx, m: FloorMat): number {
  const list = c.b.floorColors[m] ?? c.b.floorColors[c.b.floor[0][0]] ?? [0x888888];
  return shade(c.rng.pick(list), 1 + c.theme.tint);
}

function floorTile(c: Ctx, x: number, z: number): void {
  const { grid, rng, floor, props, glow, glass, b } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const h = heightAt(c, x, z);
  const k = key(grid, x, z);
  const room = c.rooms.some((r) => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.h);

  if (c.water.has(k)) {
    // Sunken channel with glowing water and stone curbs on the dry sides.
    floor.add(cx, h - 0.72, cz, 1, 1, 1, shade(b.mortar, 0.6));
    glass.add(cx, h - 0.07, cz, 1, 0.04, 1, 0x3ab8d8);
    glow.add(cx, h - 0.15, cz, 0.6, 0.01, 0.6, 0x2a8ab8, 0, 0, 1.3);
    for (const [dx, dz] of DIRS) {
      if (c.water.has(key(grid, x + dx, z + dz)) || isSolid(grid.get(x + dx, z + dz))) continue;
      floor.add(cx + dx * 0.46, h - 0.01, cz + dz * 0.46, dz ? 1 : 0.08, 0.06, dx ? 1 : 0.08, b.trim);
    }
    if ((x + z) % 5 === 0) c.spots.push({ x: cx, y: h + 0.2, z: cz, color: 0x4ad8ff, halo: 1.6 });
    return;
  }

  // Base slab: its sides show where floors step up or down; its top is the grout.
  floor.add(cx, h - 0.53, cz, 1, 1, 1, shade(b.mortar, 0.9));
  const mos = c.mosaic.get(k);
  if (mos) mosaicTile(c, x, z, h, mos);
  else materialTile(c, cx, cz, h, floorMat(c, x, z, !room));

  // Step nosing: a lighter lip where this tile sits above a walkable neighbour.
  for (const [dx, dz] of DIRS) {
    const nh = heightAt(c, x + dx, z + dz);
    if (grid.isWalkable(x + dx, z + dz) && nh < h - 0.01)
      floor.add(cx + dx * 0.47, h + 0.005, cz + dz * 0.47, dz ? 1 : 0.06, 0.03, dx ? 1 : 0.06, shade(b.pillar, 1.05));
  }

  // Surface wear along wall bases: broken tiles, moss, mud, dirt, crystals, clutter.
  const nearWall = DIRS.some(([dx, dz]) => isSolid(grid.get(x + dx, z + dz)));
  if (!nearWall || mos) return;
  const r = rng.next();
  if (r < 0.1) {
    for (let i = 0; i < 3; i++) {
      const s = rng.range(0.08, 0.18);
      props.add(cx + rng.range(-0.3, 0.3), h + s * 0.3, cz + rng.range(-0.3, 0.3), s, s * 0.6, s, vary(rng.pick(b.wallColors), rng, 0.7, 0.95), rng.range(0, Math.PI));
    }
  } else if (r < 0.2) floor.add(cx + rng.range(-0.15, 0.15), h + 0.012, cz + rng.range(-0.15, 0.15), rng.range(0.4, 0.8), 0.02, rng.range(0.3, 0.7), vary(0x4a7a34, rng, 0.8, 1.1), rng.range(0, 1));
  else if (r < 0.25) {
    floor.add(cx, h + 0.01, cz, 0.7, 0.015, 0.5, 0x3a2a1c, rng.range(0, 1));
    floor.add(cx - 0.1, h + 0.02, cz - 0.05, 0.25, 0.005, 0.12, 0x6a7a8a, rng.range(0, 1));
  } else if (r < 0.32) floor.add(cx + rng.range(-0.2, 0.2), h + 0.01, cz + rng.range(-0.2, 0.2), 0.8, 0.02, 0.35, vary(0x6a5236, rng, 0.85, 1.1), rng.range(0, Math.PI));
  else if (r < 0.355) {
    const color = rng.pick(b.crystals);
    crystals(glow, cx, h, cz, color, rng, 0.7);
    c.spots.push({ x: cx, y: h + 0.4, z: cz, color, halo: 1.4 });
  } else if (r < 0.42) clutter(c, cx, h, cz);
}

function materialTile(c: Ctx, cx: number, cz: number, h: number, m: FloorMat): void {
  const { rng, floor } = c;
  const col = floorColor(c, m);
  const even = (Math.floor(cx) + Math.floor(cz)) % 2 === 0;
  switch (m) {
    case 'cobble':
      for (const ox of [-0.24, 0.24])
        for (const oz of [-0.24, 0.24]) {
          const t = rng.range(0.03, 0.06);
          floor.add(cx + ox + rng.range(-0.02, 0.02), h - 0.03 + t / 2, cz + oz + rng.range(-0.02, 0.02), rng.range(0.4, 0.46), t, rng.range(0.4, 0.46), vary(col, rng, 0.85, 1.12));
        }
      break;
    case 'cracked':
      floor.add(cx, h - 0.02, cz, 0.95, 0.04, 0.95, vary(col, rng, 0.92, 1.06));
      if (rng.chance(0.35)) {
        floor.add(cx + rng.range(-0.15, 0.15), h + 0.001, cz + rng.range(-0.15, 0.15), 0.025, 0.004, rng.range(0.4, 0.75), shade(col, 0.45), rng.range(0, Math.PI));
        if (rng.chance(0.5)) floor.add(cx + 0.38, h - 0.01, cz + 0.38, 0.2, 0.04, 0.2, shade(col, 0.6));
      }
      break;
    case 'slate':
      // Polished: dark tiles with a sheen along one edge.
      floor.add(cx, h - 0.02, cz, 0.97, 0.04, 0.97, vary(col, rng, 0.95, 1.05));
      floor.add(cx - 0.3, h + 0.001, cz, 0.06, 0.004, 0.9, shade(col, 1.45));
      break;
    case 'terracotta':
      floor.add(cx, h - 0.02, cz, 0.94, 0.04, 0.94, vary(col, rng, 0.94, 1.06));
      if (even) floor.add(cx, h + 0.002, cz, 0.42, 0.006, 0.42, shade(col, 1.18), Math.PI / 4);
      break;
    case 'sandstone':
      // Two half bricks, the bond turning tile by tile.
      for (const o of [-0.24, 0.24]) floor.add(cx + (even ? 0 : o), h - 0.02, cz + (even ? o : 0), even ? 0.95 : 0.46, 0.04, even ? 0.46 : 0.95, vary(col, rng, 0.9, 1.08));
      break;
    case 'flagstone':
      floor.add(cx + rng.range(-0.05, 0.05), h - 0.02, cz + rng.range(-0.05, 0.05), rng.range(0.7, 0.92), 0.04, rng.range(0.7, 0.92), vary(col, rng, 0.88, 1.1), rng.range(-0.08, 0.08));
      // Grass sprouting through the joints.
      if (rng.chance(0.45))
        for (let i = 0; i < 3; i++) {
          const e = rng.pick([-0.46, 0.46]);
          const along = rng.range(-0.4, 0.4);
          const side = rng.chance(0.5);
          floor.add(cx + (side ? e : along), h + 0.03, cz + (side ? along : e), 0.07, 0.08, 0.07, vary(0x5a9a3c, rng, 0.8, 1.15));
        }
      break;
    case 'path':
    default:
      floor.add(cx, h - 0.025, cz, 1, 0.03, 1, vary(col, rng, 0.88, 1.08));
      if (rng.chance(0.4)) floor.add(cx + rng.range(-0.35, 0.35), h + 0.01, cz + rng.range(-0.35, 0.35), 0.08, 0.04, 0.07, vary(0x8a8478, rng, 0.8, 1.1), rng.range(0, Math.PI));
  }
}

/** Inlaid circular mosaic: brass rim, a band of coloured tiles, an eight-pointed star, a dark heart. */
function mosaicTile(c: Ctx, x: number, z: number, h: number, m: { cx: number; cz: number; r: number }): void {
  const { floor, theme, b } = c;
  const brass = 0xc8a050;
  const [m0, m1, m2] = [b.mosaic[theme.accent % 3], b.mosaic[(theme.accent + 1) % 3], b.mosaic[(theme.accent + 2) % 3]];
  const edge = shade(b.floorColors[b.floor[0][0]]?.[0] ?? 0x888888, 1 + theme.tint);
  for (const ox of [-0.25, 0.25])
    for (const oz of [-0.25, 0.25]) {
      const px = x + 0.5 + ox;
      const pz = z + 0.5 + oz;
      const dx = px - m.cx;
      const dz = pz - m.cz;
      const d = Math.hypot(dx, dz);
      const wedge = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * 16);
      let col: number;
      if (d > m.r + 0.25) col = edge;
      else if (d > m.r - 0.35) col = brass;
      else if (d > m.r - 1.4) col = wedge % 2 ? m0 : shade(m0, 0.8);
      else if (d > m.r - 1.75) col = brass;
      else if (d > m.r * 0.35) {
        const reach = wedge % 2 === 0 ? m.r - 1.8 : m.r * 0.6;
        col = d < reach ? (wedge % 4 < 2 ? m1 : m2) : shade(m1, 0.75);
      } else col = shade(m2, 0.7);
      floor.add(px, h - 0.02, pz, 0.47, 0.04, 0.47, col);
    }
}

/** Small clutter at wall bases that doesn't block movement. */
function clutter(c: Ctx, cx: number, h: number, cz: number): void {
  const { rng, props, b } = c;
  const px = cx + rng.range(-0.2, 0.2);
  const pz = cz + rng.range(-0.2, 0.2);
  if (b.indoor) {
    for (let i = 0; i < 3; i++) props.add(px + rng.range(-0.2, 0.2), h + 0.03, pz + rng.range(-0.2, 0.2), 0.05, 0.05, 0.3, 0xe8e2d0, rng.range(0, Math.PI));
    props.add(px, h + 0.07, pz, 0.14, 0.13, 0.14, 0xe8e2d0, rng.range(0, Math.PI));
  } else if (b.ivy > 0.25) {
    props.add(px, h + 0.06, pz, 0.34, 0.12, 0.34, vary(0x4f8a3c, rng, 0.9, 1.1));
    for (let i = 0; i < 3; i++) props.add(px + rng.range(-0.15, 0.15), h + 0.15, pz + rng.range(-0.15, 0.15), 0.07, 0.07, 0.07, rng.pick([0xe05a8a, 0xffffff, 0xffd84a, 0x8a5aff]));
  } else {
    props.add(px, h + 0.18, pz, 0.26, 0.36, 0.26, 0xb85a34);
    props.add(px, h + 0.38, pz, 0.3, 0.05, 0.3, 0xc86a40);
    props.add(px, h + 0.45, pz, 0.2, 0.12, 0.2, vary(0x4f8a3c, rng, 0.9, 1.1));
  }
}

/** Solid props in room corners: crate piles, banded barrels, urns, planters. */
function prop(c: Ctx, x: number, z: number): void {
  const { rng, tall, b } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const h = heightAt(c, x, z);
  const total = b.props.reduce((s, [, w]) => s + w, 0);
  let pick = hash2(x, z, c.seed + 11) * total;
  let kind: PropKind = b.props[0][0];
  for (const [k, w] of b.props) {
    if (pick < w) {
      kind = k;
      break;
    }
    pick -= w;
  }
  const wood = vary(0x8a6038, rng, 0.85, 1.1);
  const dark = shade(wood, 0.6);
  if (kind === 'crates') {
    const crate = (px: number, py: number, pz: number, s: number, yaw: number) => {
      tall.add(px, py + s / 2, pz, s, s, s, wood, yaw);
      tall.add(px, py + s - 0.03, pz, s + 0.02, 0.06, s + 0.02, dark, yaw);
      tall.add(px, py + 0.03, pz, s + 0.02, 0.06, s + 0.02, dark, yaw);
      // Diagonal brace on the side the camera sees.
      tall.add(px + Math.cos(yaw) * (s / 2 + 0.01), py + s / 2, pz - Math.sin(yaw) * (s / 2 + 0.01), 0.02, s * 1.25, 0.08, dark, yaw, 0.78);
    };
    crate(cx, h, cz, 0.82, rng.range(-0.1, 0.1));
    if (rng.chance(0.75)) crate(cx + rng.range(-0.08, 0.08), h + 0.82, cz + rng.range(-0.08, 0.08), 0.6, rng.range(-0.4, 0.4));
    if (rng.chance(0.3)) crate(cx + rng.range(-0.05, 0.05), h + 1.42, cz, 0.4, rng.range(-0.5, 0.5));
  } else if (kind === 'barrel') {
    const barrel = (px: number, pz: number, s: number) => {
      for (const yaw of [0, Math.PI / 4]) tall.add(px, h + 0.45 * s, pz, 0.62 * s, 0.9 * s, 0.62 * s, wood, yaw);
      for (const y of [0.2, 0.7]) for (const yaw of [0, Math.PI / 4]) tall.add(px, h + y * s, pz, 0.66 * s, 0.07 * s, 0.66 * s, 0x3a3a40, yaw);
      tall.add(px, h + 0.9 * s + 0.01, pz, 0.5 * s, 0.02, 0.5 * s, dark);
    };
    barrel(cx - 0.12, cz - 0.1, 1);
    if (rng.chance(0.6)) barrel(cx + 0.28, cz + 0.25, 0.75);
  } else if (kind === 'urn') {
    const clay = rng.chance(0.5) ? vary(0xb8603a, rng, 0.9, 1.05) : vary(b.pillar, rng, 0.8, 0.95);
    const urn = (px: number, pz: number, s: number) => {
      tall.add(px, h + 0.06 * s, pz, 0.36 * s, 0.12 * s, 0.36 * s, shade(clay, 0.8));
      for (const yaw of [0, Math.PI / 4]) tall.add(px, h + 0.38 * s, pz, 0.52 * s, 0.5 * s, 0.52 * s, clay, yaw);
      tall.add(px, h + 0.7 * s, pz, 0.26 * s, 0.16 * s, 0.26 * s, clay);
      tall.add(px, h + 0.8 * s, pz, 0.36 * s, 0.06 * s, 0.36 * s, shade(clay, 1.1));
      tall.add(px, h + 0.4 * s, pz, 0.54 * s, 0.06 * s, 0.54 * s, b.mosaic[0], Math.PI / 4);
    };
    urn(cx, cz, 1.1);
    if (rng.chance(0.5)) urn(cx + 0.3, cz - 0.3, 0.7);
  } else {
    // Planter: stone box with soil, foliage and flowers.
    tall.add(cx, h + 0.25, cz, 0.86, 0.5, 0.86, vary(b.pillar, rng, 0.8, 0.95));
    tall.add(cx, h + 0.52, cz, 0.92, 0.06, 0.92, vary(b.pillar, rng, 0.95, 1.05));
    tall.add(cx, h + 0.53, cz, 0.74, 0.04, 0.74, 0x3a2a1c);
    for (let i = 0; i < 4; i++)
      tall.add(cx + rng.range(-0.22, 0.22), h + rng.range(0.7, 1.0), cz + rng.range(-0.22, 0.22), rng.range(0.25, 0.4), rng.range(0.3, 0.5), rng.range(0.25, 0.4), vary(0x4f8a3c, rng, 0.8, 1.15));
    for (let i = 0; i < 5; i++) tall.add(cx + rng.range(-0.3, 0.3), h + rng.range(0.85, 1.15), cz + rng.range(-0.3, 0.3), 0.09, 0.09, 0.09, rng.pick([0xe05a8a, 0xffd84a, 0xffffff, 0xc070ff, 0xff6a3a]));
  }
}

function wallTile(c: Ctx, x: number, z: number): void {
  const { grid, rng, tall, b } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const facesVoid = DIRS.filter(([dx, dz]) => isVoid(grid, x + dx, z + dz));
  const facesFloor = DIRS.filter(([dx, dz]) => grid.isWalkable(x + dx, z + dz) || grid.get(x + dx, z + dz) === Tile.Prop);
  // Only +x and +z faces are seen by the isometric camera, so detail goes there.
  const visible = (dx: number, dz: number) => dx > 0 || dz > 0;

  if (facesVoid.length) cliff(c, x, z, facesVoid);

  const along = facesFloor.length === 1 ? facesFloor[0] : null;
  const pillar = !!along && b.wall !== 'hedge' && (x * 3 + z * 5) % 7 === 0;
  // An alcove: part of a straight run of wall facing the room, on a side the camera sees.
  const alcove =
    !pillar &&
    !!along &&
    visible(along[0], along[1]) &&
    b.wall !== 'hedge' &&
    grid.get(x + along[1], z + along[0]) === Tile.Wall &&
    grid.get(x - along[1], z - along[0]) === Tile.Wall &&
    hash2(x, z, c.seed + 5) < 0.07;

  if (alcove) alcoveTile(c, x, z, along![0], along![1]);
  else if (b.wall === 'hedge') {
    tall.column(cx, cz, 0, 0.35, 1, 1, vary(b.trim, rng, 0.9, 1.05));
    tall.column(cx, cz, 0.35, WALL_HEIGHT, 1.02, 1.02, vary(rng.pick(b.wallColors), rng, 0.9, 1.08));
    for (const [dx, dz] of facesFloor)
      if (visible(dx, dz))
        for (let i = 0; i < 3; i++) if (rng.chance(0.5)) faceBox(tall, cx, cz, dx, dz, rng.range(-0.4, 0.4), rng.range(0.6, 1.8), -0.06, 0.08, 0.08, 0.06, rng.pick([0xe05a8a, 0xffffff, 0xffd84a]));
  } else {
    // Core blocks in mortar colour; the masonry on the visible faces covers them.
    for (let y = 0; y < WALL_HEIGHT; y++) tall.add(cx, y + 0.5, cz, 1, 1, 1, vary(b.mortar, rng, 0.9, 1.1));
    for (const [dx, dz] of DIRS) if (visible(dx, dz) && !isSolid(grid.get(x + dx, z + dz))) masonry(c, cx, cz, dx, dz);
    tall.add(cx, WALL_HEIGHT + 0.01, cz, 0.96, 0.02, 0.96, vary(rng.pick(b.wallColors), rng, 0.95, 1.05));
  }
  if (pillar) pillarAt(c, cx, cz, along![0], along![1], WALL_HEIGHT + 0.4);
  cap(c, x, z, facesFloor);

  // Wall fixtures on the faces the camera sees.
  for (const [dx, dz] of facesFloor) {
    if (!visible(dx, dz) || alcove) continue;
    const roll = hash2(x, z, c.seed + 9);
    if (b.banner !== null && roll < 0.05) banner(c, cx, cz, dx, dz);
    else if (b.chains && roll < 0.1) chain(c, cx, cz, dx, dz);
    if (b.beams) {
      if ((x + z) % 4 === 0) faceBox(tall, cx, cz, dx, dz, 0, 1.0, -0.08, 0.16, 2, 0.1, vary(0x5a3a22, rng, 0.85, 1.05));
      faceBox(tall, cx, cz, dx, dz, 0, 1.86, -0.08, 1, 0.14, 0.1, vary(0x4a2e1a, rng, 0.9, 1.05));
    }
    if (rng.chance(b.ivy * 0.45)) ivy(c, cx, cz, dx, dz, WALL_HEIGHT);
  }
  // Railings along the drops.
  if (b.railing && facesVoid.length) {
    const col = b.railing === 'iron' ? 0x2a2a30 : 0x4a2e1a;
    const t = b.railing === 'iron' ? 0.05 : 0.09;
    const topY = WALL_HEIGHT + 0.13;
    for (const [dx, dz] of facesVoid) {
      const ex = cx + dx * 0.42;
      const ez = cz + dz * 0.42;
      tall.add(ex, topY + 0.42, ez, dx ? t : 1, t, dz ? t : 1, col);
      tall.add(ex, topY + 0.22, ez, dx ? t : 1, t * 0.7, dz ? t : 1, col);
      tall.add(ex, topY + 0.22, ez, t * 1.2, 0.44, t * 1.2, col);
    }
  }
}

/** Masonry on one face: bricks, cobbles, ashlar, basalt columns or plaster with quoins. */
function masonry(c: Ctx, cx: number, cz: number, nx: number, nz: number): void {
  const { rng, tall, b } = c;
  const stone = () => vary(rng.pick(b.wallColors), rng, 0.9, 1.08);
  const mossy = () => (rng.chance(b.ivy * 0.4) ? mix(stone(), 0x4a7a34, 0.45) : stone());
  switch (b.wall) {
    case 'brick':
      for (let row = 0; row < 8; row++) {
        const y = 0.125 + row * 0.25;
        const off = row % 2 ? 0.25 : 0;
        for (const lat of [-0.5 + off, off, 0.5 + off]) {
          const l0 = Math.max(-0.5, lat - 0.245);
          const l1 = Math.min(0.5, lat + 0.245);
          if (l1 - l0 < 0.05) continue;
          faceBox(tall, cx, cz, nx, nz, (l0 + l1) / 2, y, -0.03, l1 - l0 - 0.02, 0.22, 0.06, row === 0 ? shade(stone(), 0.8) : mossy());
        }
      }
      break;
    case 'cobble':
      for (let i = 0; i < 9; i++) {
        const s = rng.range(0.26, 0.42);
        faceBox(tall, cx, cz, nx, nz, rng.range(-0.32, 0.32), rng.range(0.2, 1.8), -rng.range(0.02, 0.05), s, s * rng.range(0.7, 1), 0.08, mossy());
      }
      break;
    case 'ashlar':
      for (let row = 0; row < 4; row++) {
        const y = 0.25 + row * 0.5;
        const split = row % 2 ? 0.15 : -0.15;
        faceBox(tall, cx, cz, nx, nz, (-0.5 + split) / 2, y, -0.02, 0.5 + split - 0.02, 0.47, 0.05, stone());
        faceBox(tall, cx, cz, nx, nz, (0.5 + split) / 2, y, -0.02, 0.5 - split - 0.02, 0.47, 0.05, stone());
      }
      faceBox(tall, cx, cz, nx, nz, 0, 1.25, -0.04, 1, 0.08, 0.06, shade(b.pillar, 0.9));
      break;
    case 'basalt':
      // Columnar basalt: tall narrow slabs of uneven depth.
      for (let i = 0; i < 4; i++) {
        const top = rng.range(1.7, 2);
        faceBox(tall, cx, cz, nx, nz, -0.375 + i * 0.25, top / 2, -rng.range(0.01, 0.06), 0.23, top, 0.08, stone());
      }
      break;
    case 'white':
    default:
      faceBox(tall, cx, cz, nx, nz, 0, 1, -0.01, 0.98, 1.96, 0.03, stone());
      faceBox(tall, cx, cz, nx, nz, 0, 0.15, -0.03, 1, 0.3, 0.05, b.trim);
      for (const y of [0.55, 1.05, 1.55]) if (rng.chance(0.5)) faceBox(tall, cx, cz, nx, nz, 0.38, y, -0.025, 0.24, 0.45, 0.05, shade(b.trim, 1.05));
  }
}

/** Decorative tops: cornice, crenellations, terracotta, hedge, or broken ruin. */
function cap(c: Ctx, x: number, z: number, facesFloor: readonly (readonly [number, number])[]): void {
  const { rng, tall, b, props } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const capCol = vary(b.capColor, rng, 0.94, 1.06);
  switch (b.cap) {
    case 'cornice':
      tall.add(cx, WALL_HEIGHT + 0.06, cz, 1.14, 0.12, 1.14, capCol);
      tall.add(cx, WALL_HEIGHT - 0.05, cz, 1.06, 0.08, 1.06, shade(capCol, 0.8));
      break;
    case 'crenel':
      tall.add(cx, WALL_HEIGHT + 0.07, cz, 1.12, 0.14, 1.12, capCol);
      if ((x + z) % 2 === 0) tall.add(cx, WALL_HEIGHT + 0.4, cz, 0.78, 0.52, 0.78, vary(b.wallColors[0], rng, 0.95, 1.08));
      break;
    case 'terracotta':
      tall.add(cx, WALL_HEIGHT + 0.07, cz, 1.12, 0.14, 1.12, capCol);
      tall.add(cx, WALL_HEIGHT + 0.17, cz, 0.5, 0.08, 0.5, shade(capCol, 0.75));
      for (const [dx, dz] of facesFloor) if (dx > 0 || dz > 0) faceBox(tall, cx, cz, dx, dz, 0, WALL_HEIGHT - 0.12, -0.06, 1, 0.16, 0.08, shade(capCol, 0.9));
      break;
    case 'hedge':
      for (let i = 0; i < 2; i++) if (rng.chance(0.6)) tall.add(cx + rng.range(-0.3, 0.3), WALL_HEIGHT + 0.12, cz + rng.range(-0.3, 0.3), 0.4, 0.24, 0.4, vary(b.capColor, rng, 0.85, 1.05));
      break;
    case 'broken':
    default:
      // Ruined top: ragged leftover courses, moss, and rubble at the foot.
      if (hash2(x, z, c.seed + 2) < 0.55) tall.add(cx + rng.range(-0.1, 0.1), WALL_HEIGHT + 0.15, cz + rng.range(-0.1, 0.1), rng.range(0.5, 0.95), 0.3, rng.range(0.5, 0.95), vary(b.capColor, rng, 0.85, 1.05));
      if (rng.chance(0.4)) tall.add(cx, WALL_HEIGHT + 0.03, cz, 1.02, 0.06, 1.02, mix(capCol, 0x4a7a34, 0.6));
      for (const [dx, dz] of facesFloor)
        if (rng.chance(0.2)) props.add(cx + dx * 0.72 + rng.range(-0.3, 0.3) * dz, 0.1, cz + dz * 0.72 + rng.range(-0.3, 0.3) * dx, 0.22, 0.2, 0.22, vary(b.wallColors[0], rng, 0.7, 0.95), rng.range(0, 1));
  }
}

function pillarAt(c: Ctx, cx: number, cz: number, nx: number, nz: number, top: number): void {
  const { tall, b, rng } = c;
  const col = vary(b.pillar, rng, 0.95, 1.05);
  const px = cx + nx * 0.1;
  const pz = cz + nz * 0.1;
  tall.column(px, pz, 0, 0.25, 1.12, 1.12, shade(col, 0.85));
  tall.column(px, pz, 0.25, top - 0.3, 0.92, 0.92, col);
  // Chiselled flutes on the face toward the room.
  for (const lat of [-0.25, 0, 0.25]) faceBox(tall, px, pz, nx, nz, lat, (top - 0.05) / 2, 0.03, 0.07, top - 0.6, 0.04, shade(col, 0.72));
  tall.column(px, pz, top - 0.3, top - 0.12, 1.08, 1.08, shade(col, 1.06));
  tall.column(px, pz, top - 0.12, top, 1.18, 1.18, shade(col, 0.92));
}

/** A recess in the wall: back wall, jambs and lintel, with an iron gate, an urn or a statue inside. */
function alcoveTile(c: Ctx, x: number, z: number, nx: number, nz: number): void {
  const { tall, b, rng, glow } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const stone = () => vary(rng.pick(b.wallColors), rng, 0.9, 1.05);
  // Back half of the block, jambs, lintel and sill.
  faceBox(tall, cx, cz, nx, nz, 0, 1, 0.5, 1, 2, 0.5, stone());
  faceBox(tall, cx, cz, nx, nz, -0.4, 1, 0, 0.2, 2, 0.5, stone());
  faceBox(tall, cx, cz, nx, nz, 0.4, 1, 0, 0.2, 2, 0.5, stone());
  faceBox(tall, cx, cz, nx, nz, 0, 1.75, 0, 0.6, 0.5, 0.5, stone());
  faceBox(tall, cx, cz, nx, nz, 0, 0.06, 0, 0.6, 0.12, 0.5, shade(b.trim, 0.9));
  faceBox(tall, cx, cz, nx, nz, 0, 0.81, 0.48, 0.6, 1.38, 0.02, shade(b.mortar, 0.45));
  const what = hash2(x, z, c.seed + 6);
  if (what < 0.5) {
    // Iron gate.
    for (const lat of [-0.22, -0.11, 0, 0.11, 0.22]) faceBox(tall, cx, cz, nx, nz, lat, 0.81, 0.04, 0.035, 1.38, 0.035, 0x26262c);
    faceBox(tall, cx, cz, nx, nz, 0, 1.05, 0.04, 0.6, 0.05, 0.04, 0x26262c);
    faceBox(tall, cx, cz, nx, nz, 0, 0.45, 0.04, 0.6, 0.05, 0.04, 0x26262c);
  } else if (what < 0.8) {
    faceBox(tall, cx, cz, nx, nz, 0, 0.37, 0.15, 0.3, 0.5, 0.3, 0xb8603a);
    faceBox(tall, cx, cz, nx, nz, 0, 0.68, 0.21, 0.18, 0.12, 0.18, 0xb8603a);
  } else {
    // A small statue with glowing eyes.
    faceBox(tall, cx, cz, nx, nz, 0, 0.52, 0.18, 0.3, 0.8, 0.25, shade(b.pillar, 0.9));
    faceBox(tall, cx, cz, nx, nz, 0, 1.04, 0.2, 0.22, 0.24, 0.22, shade(b.pillar, 0.95));
    faceBox(glow, cx, cz, nx, nz, 0, 1.07, 0.195, 0.12, 0.03, 0.01, b.rune, 2);
    c.spots.push({ x: cx + nx * 0.1, y: 1.1, z: cz + nz * 0.1, color: b.rune, halo: 0.9 });
  }
}

function banner(c: Ctx, cx: number, cz: number, nx: number, nz: number): void {
  const { props, b, rng } = c;
  const cloth = vary(b.banner ?? 0x7a1e22, rng, 0.9, 1.1);
  faceBox(props, cx, cz, nx, nz, 0, 1.2, -0.08, 0.56, 1.0, 0.03, cloth);
  faceBox(props, cx, cz, nx, nz, 0, 1.28, -0.1, 0.16, 0.16, 0.02, 0xd4a017);
  faceBox(props, cx, cz, nx, nz, 0, 0.72, -0.1, 0.56, 0.06, 0.04, 0xd4a017);
  faceBox(props, cx, cz, nx, nz, 0, 1.74, -0.1, 0.7, 0.05, 0.06, 0x3a2418);
}

/** Iron chain hanging down a wall, ending in a shackle. */
function chain(c: Ctx, cx: number, cz: number, nx: number, nz: number): void {
  const { props } = c;
  const lat = 0.2;
  faceBox(props, cx, cz, nx, nz, lat, 1.85, -0.08, 0.12, 0.08, 0.06, 0x3a3a42);
  for (let i = 0; i < 7; i++) {
    const y = 1.75 - i * 0.12;
    if (i % 2) faceBox(props, cx, cz, nx, nz, lat, y, -0.1, 0.03, 0.12, 0.07, 0x4a4a54);
    else faceBox(props, cx, cz, nx, nz, lat, y, -0.1, 0.07, 0.12, 0.03, 0x4a4a54);
  }
  faceBox(props, cx, cz, nx, nz, lat, 0.82, -0.1, 0.16, 0.05, 0.05, 0x3a3a42);
}

/** Ivy crawling up a wall face. */
function ivy(c: Ctx, cx: number, cz: number, nx: number, nz: number, top: number): void {
  const { tall, rng } = c;
  const lat = rng.range(-0.35, 0.35);
  const height = rng.range(0.8, top + 0.1);
  for (let y = 0.15; y < height; y += 0.22) {
    const l = lat + Math.sin(y * 4 + lat * 9) * 0.12;
    faceBox(tall, cx, cz, nx, nz, l, y, -0.1, rng.range(0.16, 0.3), 0.2, 0.05, vary(0x4a8a34, rng, 0.75, 1.15));
    if (rng.chance(0.4)) faceBox(tall, cx, cz, nx, nz, l + rng.range(-0.18, 0.18), y + 0.08, -0.12, 0.12, 0.12, 0.05, vary(0x3a7a2c, rng, 0.9, 1.2));
  }
}

/**
 * Layered cliff under a wall that drops into the chasm: rock strata stepping
 * in and out, broken bricks, and (for floating islands) a tapering underside
 * with hanging roots. Mana crystals cling to some edges.
 */
function cliff(c: Ctx, x: number, z: number, faces: readonly (readonly [number, number])[]): void {
  const { tall, rng, b, glow } = c;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const island = b.chasm === 'island';
  let y = 0;
  let layer = 0;
  while (y > -b.chasmDepth) {
    const t = rng.range(0.7, 1.3);
    const shrink = island ? Math.min(0.85, layer * 0.13) : 0;
    const size = Math.max(0.15, 1 + rng.range(-0.12, 0.22) - shrink);
    tall.column(cx + rng.range(-0.06, 0.06), cz + rng.range(-0.06, 0.06), Math.max(-b.chasmDepth, y - t), y, size, size, vary(b.strata[layer % b.strata.length], rng, 0.88, 1.08));
    if (!island && rng.chance(0.25))
      for (const [dx, dz] of faces) faceBox(tall, cx, cz, dx, dz, rng.range(-0.3, 0.3), y - t / 2, -0.15, rng.range(0.3, 0.5), 0.22, 0.3, vary(rng.pick(b.wallColors), rng, 0.75, 0.95));
    y -= t;
    layer++;
    if (island && size <= 0.2) break;
  }
  if (island && rng.chance(0.35)) tall.column(cx + rng.range(-0.3, 0.3), cz + rng.range(-0.3, 0.3), y - rng.range(1, 2.5), y + 0.5, 0.06, 0.06, 0x4a6a2a);
  if (rng.chance(0.06)) {
    const [dx, dz] = faces[0];
    const color = rng.pick(b.crystals);
    crystals(glow, cx + dx * 0.6, -0.9, cz + dz * 0.6, color, rng, 0.9);
    c.spots.push({ x: cx + dx * 0.8, y: -0.4, z: cz + dz * 0.8, color, halo: 1.6 });
  }
}

/** The chasm floor (or open air) in empty tiles. */
function voidTile(c: Ctx, x: number, z: number): void {
  const { grid, rng, b, floor, props, tall, glow, glass } = c;
  if (b.chasm === 'island') return;
  const cx = x + 0.5;
  const cz = z + 0.5;
  const lowerY = -b.chasmDepth;
  const base = (x + z) % 2 ? b.lower[0] : (b.lower[1] ?? b.lower[0]);
  floor.add(cx, lowerY - 0.5, cz, 0.98, 1, 0.98, vary(base, rng, 0.9, 1.06));

  if (b.chasm === 'catacomb') {
    if (x % 6 === 0 && z % 6 === 0 && deepVoid(grid, x, z, 1)) {
      tall.column(cx, cz, lowerY, -0.15, 0.7, 0.7, vary(b.wallColors[1], rng, 0.8, 0.95));
      tall.add(cx, -0.1, cz, 0.9, 0.12, 0.9, vary(b.capColor, rng, 0.85, 0.95));
      if (rng.chance(0.5)) {
        glow.add(cx, lowerY + 1.6, cz + 0.37, 0.16, 0.2, 0.06, 0xff9a3c, 0, 0, 2.2);
        c.spots.push({ x: cx, y: lowerY + 1.6, z: cz + 0.6, color: 0xff9a3c, halo: 1.2 });
      }
    } else if (rng.chance(0.03)) {
      const color = rng.pick(b.crystals);
      crystals(glow, cx, lowerY, cz, color, rng, 1.2);
      c.spots.push({ x: cx, y: lowerY + 0.6, z: cz, color, halo: 1.8 });
    } else if (rng.chance(0.012)) slime(glass, glow, cx, lowerY, cz, rng);
    return;
  }

  if (b.chasm === 'garden') {
    const pathLine = x % 9 === 4 || z % 9 === 4;
    if (pathLine) floor.add(cx, lowerY + 0.005, cz, 1, 0.02, 1, vary(0x7a5a3a, rng, 0.9, 1.05));
    else if (rng.chance(0.18))
      for (let i = 0; i < 3; i++) props.add(cx + rng.range(-0.35, 0.35), lowerY + 0.08, cz + rng.range(-0.35, 0.35), 0.1, 0.16, 0.1, rng.pick([0xe05a8a, 0xffffff, 0xffd84a, 0x8a5aff, 0xff6a3a]));
    if (!pathLine && rng.chance(0.06) && deepVoid(grid, x, z, 1)) tree(tall, cx, lowerY, cz, rng, b);
    else if (!pathLine && b.ivy > 0.6 && rng.chance(0.02) && deepVoid(grid, x, z, 2)) ruinArch(c, cx, lowerY, cz);
    else if (!pathLine && rng.chance(0.06)) props.add(cx, lowerY + 0.3, cz, 0.8, 0.6, 0.8, vary(0x3f7a34, rng, 0.85, 1.05));
    else if (!pathLine && rng.chance(0.008)) slime(glass, glow, cx, lowerY, cz, rng);
    return;
  }

  // Rocky chasm floor: rubble, broken columns, glowing crystals; dark water in covered keeps.
  if (b.indoor && (x * 7 + z * 3) % 5 < 2) glass.add(cx, lowerY + 0.05, cz, 1, 0.06, 1, 0x2a2a6a);
  else if (rng.chance(0.05)) {
    const s = rng.range(0.3, 0.6);
    props.add(cx + rng.range(-0.2, 0.2), lowerY + s / 2, cz + rng.range(-0.2, 0.2), s, s, s, vary(b.strata[0], rng, 0.7, 0.9), rng.range(0, Math.PI));
  } else if (rng.chance(0.012) && deepVoid(grid, x, z, 1)) {
    const top = lowerY + rng.range(1, 3.5);
    tall.column(cx, cz, lowerY, top, 0.7, 0.7, vary(b.pillar, rng, 0.7, 0.85));
    tall.add(cx + 0.2, top + 0.1, cz, 0.5, 0.2, 0.4, vary(b.pillar, rng, 0.7, 0.85), rng.range(0, 1), 0.3);
  } else if (rng.chance(0.02)) {
    const color = rng.pick(b.crystals);
    crystals(glow, cx, lowerY, cz, color, rng, 1.3);
    c.spots.push({ x: cx, y: lowerY + 0.6, z: cz, color, halo: 2 });
  }
}

/** A cluster of glowing crystal shards. */
function crystals(glow: Batch, x: number, y: number, z: number, color: number, rng: Rng, scale: number): void {
  for (let i = 0; i < 4; i++) {
    const h = rng.range(0.25, 0.6) * scale;
    glow.add(x + rng.range(-0.2, 0.2) * scale, y + h / 2, z + rng.range(-0.2, 0.2) * scale, 0.1 * scale, h, 0.1 * scale, color, rng.range(0, Math.PI), rng.range(-0.4, 0.4), 1.9);
  }
}

/** A translucent green slime block with a glowing core. */
function slime(glass: Batch, glow: Batch, x: number, y: number, z: number, rng: Rng): void {
  const s = rng.range(0.6, 0.9);
  glass.add(x, y + s / 2, z, s, s, s, 0x6aff5a, rng.range(0, Math.PI / 2));
  glow.add(x, y + s / 2, z, s * 0.5, s * 0.5, s * 0.5, 0x7dff6a, rng.range(0, Math.PI / 2), 0, 1.6);
}

/** A blocky tree: trunk and stacked leaf cubes. */
function tree(t: Batch, x: number, y: number, z: number, rng: Rng, b: Biome): void {
  const h = rng.range(2.2, 3.2);
  t.column(x, z, y, y + h, 0.3, 0.3, 0x5a3a22);
  const leaf = b.wall === 'hedge' ? rng.pick(b.wallColors) : rng.pick([0x3f7a34, 0x46863a, 0x38702f]);
  t.add(x, y + h, z, 1.8, 1.1, 1.8, vary(leaf, rng, 0.85, 1));
  t.add(x + rng.range(-0.2, 0.2), y + h + 0.8, z + rng.range(-0.2, 0.2), 1.2, 0.8, 1.2, vary(leaf, rng, 0.95, 1.1));
  if (rng.chance(0.5)) t.add(x, y + h + 1.35, z, 0.6, 0.5, 0.6, vary(leaf, rng, 1, 1.15));
}

/** A crumbling stone archway standing in the overgrown depths. */
function ruinArch(c: Ctx, x: number, y: number, z: number): void {
  const { tall, rng, b } = c;
  const col = () => vary(b.pillar, rng, 0.75, 0.95);
  tall.column(x - 1, z, y, y + 2.6, 0.6, 0.6, col());
  tall.column(x + 1, z, y, y + rng.range(1.4, 2.6), 0.6, 0.6, col());
  for (const [dx, h] of [
    [-0.8, 2.6],
    [-0.35, 2.85],
    [0.1, 2.9],
  ])
    tall.add(x + dx, y + h, z, 0.5, 0.4, 0.6, col());
}

/** Arches over doorways where corridors enter a room, on chiselled pillars. */
function arches(c: Ctx, r: RoomRect): void {
  const { grid, tall, b, rng } = c;
  if (b.wall === 'hedge') return;
  // [first tile along the side, tile count, fixed coordinate just outside the room, horizontal side?]
  const sides: [number, number, number, boolean][] = [
    [r.x, r.w, r.z - 1, true],
    [r.x, r.w, r.z + r.h, true],
    [r.z, r.h, r.x - 1, false],
    [r.z, r.h, r.x + r.w, false],
  ];
  for (const [s0, count, fixed, horizontal] of sides) {
    let run = -1;
    for (let i = 0; i <= count; i++) {
      const a = s0 + i;
      const [tx, tz] = horizontal ? [a, fixed] : [fixed, a];
      const open = i < count && (grid.isWalkable(tx, tz) || grid.get(tx, tz) === Tile.Gate);
      if (open && run < 0) run = a;
      if (open || run < 0) continue;
      const n = a - run;
      if (n >= 3) {
        const top = WALL_HEIGHT + 0.9;
        for (const end of [run - 1, a]) {
          const [px, pz] = horizontal ? [end, fixed] : [fixed, end];
          if (grid.get(px, pz) !== Tile.Wall) continue;
          tall.column(px + 0.5, pz + 0.5, 0, top, 0.9, 0.9, vary(b.pillar, rng, 0.95, 1.05));
          tall.column(px + 0.5, pz + 0.5, top - 0.15, top + 0.05, 1.1, 1.1, shade(b.pillar, 0.9));
        }
        // Voussoirs rising to a keystone.
        for (let k = 0; k < n; k++) {
          const u = ((k + 0.5) / n) * 2 - 1;
          const under = WALL_HEIGHT + 0.25 + (1 - u * u) * 0.45;
          const [ax, az] = horizontal ? [run + k + 0.5, fixed + 0.5] : [fixed + 0.5, run + k + 0.5];
          tall.column(ax, az, under, top, horizontal ? 1.01 : 0.8, horizontal ? 0.8 : 1.01, vary(b.pillar, rng, 0.9, 1.02));
        }
        const mid = run + n / 2;
        const [kx, kz] = horizontal ? [mid, fixed + 0.5] : [fixed + 0.5, mid];
        tall.column(kx, kz, top - 0.1, top + 0.2, horizontal ? 0.5 : 0.9, horizontal ? 0.9 : 0.5, shade(b.pillar, 1.1));
      }
      run = -1;
    }
  }
}

/** Magic circles, altar candles and the boss carpet. */
function roomDressing(c: Ctx, r: RoomRect): void {
  const { rng, b, floor, glow, group, grid } = c;
  const cx = r.x + r.w / 2;
  const cz = r.z + r.h / 2;
  if (r.kind === 'boss') {
    const len = r.h - 3;
    floor.add(cx, 0.012, cz + 0.5, 2.2, 0.02, len, 0x6a1420);
    floor.add(cx - 1.12, 0.018, cz + 0.5, 0.08, 0.03, len, 0xd4a017);
    floor.add(cx + 1.12, 0.018, cz + 0.5, 0.08, 0.03, len, 0xd4a017);
  }
  // Raised altars get candles at their corners.
  let top = -Infinity;
  for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) top = Math.max(top, heightAt(c, x, z));
  if (top > 0.3) {
    for (let z = r.z; z < r.z + r.h; z++)
      for (let x = r.x; x < r.x + r.w; x++) {
        if (heightAt(c, x, z) !== top || !grid.isWalkable(x, z)) continue;
        if (DIRS.filter(([dx, dz]) => heightAt(c, x + dx, z + dz) < top).length < 2) continue;
        c.props.add(x + 0.5, top + 0.12, z + 0.5, 0.12, 0.24, 0.12, 0xe8e0c8);
        glow.add(x + 0.5, top + 0.3, z + 0.5, 0.06, 0.1, 0.06, 0xffc060, 0, 0, 2.5);
        c.spots.push({ x: x + 0.5, y: top + 0.35, z: z + 0.5, color: 0xffb050, halo: 0.8 });
      }
  }
  // Magic circles on mosaic hearts and altar tops, and (in covered biomes) in many rooms.
  const hasMosaic = c.mosaic.has(key(grid, Math.floor(cx), Math.floor(cz)));
  if (!(hasMosaic || top > 0.3 || (b.indoor && rng.chance(0.55)) || rng.chance(0.15))) return;
  const color = r.kind === 'treasure' ? 0xffd23f : b.rune;
  const size = hasMosaic ? Math.max(1.6, (Math.min(r.w, r.h) / 2 - 3) * 0.55) : top > 0.3 ? 1.4 : Math.min(3.2, Math.min(r.w, r.h) / 2 - 2);
  const y = (top > 0.3 ? top : 0) + 0.025;
  const rune = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(0.95),
      map: runeTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  rune.rotation.x = -Math.PI / 2;
  rune.rotation.z = rng.range(0, Math.PI);
  rune.scale.setScalar(size * 2);
  rune.position.set(cx, y, cz);
  rune.userData.spin = rng.chance(0.5) ? 0.12 : -0.12;
  rune.name = 'rune';
  group.add(rune);
  c.spots.push({ x: cx, y: y + 0.4, z: cz, color, halo: size * 1.4 });
}

/**
 * Raised stone walkways across the catacomb depths, on pillars, with iron
 * railings and a stair flight down to the lower level at one end.
 */
function walkways(c: Ctx): void {
  const { grid, rng, b, tall, props } = c;
  const lowerY = -b.chasmDepth;
  const walkY = -1.1;
  const used = new Set<number>();
  const pathCol = b.floorColors[b.corridor[0]]?.[0] ?? 0x444444;
  for (const horizontal of [true, false]) {
    const outer = horizontal ? grid.height : grid.width;
    const inner = horizontal ? grid.width : grid.height;
    for (let a = 2; a < outer - 2; a++) {
      let start = -1;
      for (let i = 0; i <= inner; i++) {
        const [x, z] = horizontal ? [i, a] : [a, i];
        const ok = i < inner && deepVoid(grid, x, z, 1) && !used.has(z * grid.width + x);
        if (ok && start < 0) start = i;
        if (ok || start < 0) continue;
        const len = i - start;
        if (len >= 8 && rng.chance(0.18)) {
          const stairs = 4;
          const walkEnd = start + len - stairs;
          for (let k = start; k < start + len; k++) {
            const [tx, tz] = horizontal ? [k, a] : [a, k];
            for (let d = -2; d <= 2; d++) used.add((tz + (horizontal ? d : 0)) * grid.width + tx + (horizontal ? 0 : d));
            const cx = tx + 0.5;
            const cz = tz + 0.5;
            if (k < walkEnd) {
              props.add(cx, walkY - 0.12, cz, horizontal ? 1 : 1.3, 0.24, horizontal ? 1.3 : 1, vary(pathCol, rng, 1.1, 1.25));
              for (const side of [-0.6, 0.6]) {
                const rx = horizontal ? cx : cx + side;
                const rz = horizontal ? cz + side : cz;
                tall.add(rx, walkY + 0.45, rz, horizontal ? 1 : 0.05, 0.05, horizontal ? 0.05 : 1, 0x2a2a30);
                tall.add(rx, walkY + 0.22, rz, 0.06, 0.45, 0.06, 0x2a2a30);
              }
              if ((k - start) % 3 === 0) props.column(cx, cz, lowerY, walkY - 0.24, 0.5, 0.5, vary(b.wallColors[2], rng, 0.75, 0.9));
            } else {
              const f = (k - walkEnd + 1) / (stairs + 1);
              const topY = walkY + (lowerY - walkY) * f;
              for (let s2 = 0; s2 < 2; s2++) {
                const off = (s2 - 0.5) * 0.5;
                const sx = horizontal ? cx + off : cx;
                const sz = horizontal ? cz : cz + off;
                props.column(sx, sz, lowerY, topY + ((lowerY - walkY) / (stairs + 1)) * (s2 * 0.5), horizontal ? 0.5 : 1.3, horizontal ? 1.3 : 0.5, vary(pathCol, rng, 1.05, 1.2));
              }
            }
          }
          a += 4;
          break;
        }
        start = -1;
      }
    }
  }
}

/** Floating islands: towers and houses with stepped terracotta roofs rising out of the clouds. */
function skyBuildings(c: Ctx): void {
  const { grid, rng, b, tall, props } = c;
  const taken = new Set<number>();
  for (let z = 2; z < grid.height - 2; z++)
    for (let x = 2; x < grid.width - 2; x++) {
      if (!rng.chance(0.05) || !deepVoid(grid, x, z, 2)) continue;
      if ([-2, -1, 0, 1, 2].some((dz) => [-2, -1, 0, 1, 2].some((dx) => taken.has((z + dz) * grid.width + x + dx)))) continue;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) taken.add((z + dz) * grid.width + x + dx);
      building(tall, props, x + 0.5, z + 0.5, rng, b, rng.chance(0.35));
    }
}

function building(tall: Batch, props: Batch, x: number, z: number, rng: Rng, b: Biome, tower: boolean): void {
  const w = tower ? 2 : rng.pick([2.5, 3]);
  const d = tower ? 2 : rng.pick([2.5, 3]);
  const top = tower ? rng.range(2.5, 4) : rng.range(-0.5, 1.5);
  // The island it stands on: rock tapering away underneath.
  let y = top - 3;
  for (let i = 0; i < 6; i++) {
    const s = Math.max(0.4, 1 - i * 0.16);
    tall.column(x, z, y - 1.1, y, (w + 0.6) * s, (d + 0.6) * s, vary(b.strata[i % b.strata.length], rng, 0.85, 1.05));
    y -= 1.1;
  }
  tall.column(x, z, top - 3, top, w, d, vary(rng.pick(b.wallColors), rng, 0.92, 1.02));
  tall.column(x, z, top - 0.25, top, w + 0.12, d + 0.12, vary(b.trim, rng, 0.95, 1.05));
  for (let wy = top - 1; wy > top - 3; wy -= 1.3) {
    props.add(x + w / 2 + 0.01, wy, z, 0.04, 0.5, 0.32, 0x2a2420);
    props.add(x, wy, z + d / 2 + 0.01, 0.32, 0.5, 0.04, 0x2a2420);
  }
  const steps = tower ? 5 : 4;
  for (let i = 0; i < steps; i++) {
    const shrink = i * (tower ? 0.42 : 0.6);
    const sw = tower ? Math.max(0.3, w + 0.4 - shrink) : w + 0.4;
    const sd = Math.max(0.3, d + 0.4 - shrink);
    tall.add(x, top + 0.13 + i * 0.26, z, sw, 0.26, sd, vary(b.capColor, rng, i % 2 ? 0.88 : 1, i % 2 ? 0.95 : 1.06));
  }
  for (let i = 0; i < 3; i++) {
    const side = rng.chance(0.5);
    const len = rng.range(1, 3);
    const vx = side ? x + w / 2 + 0.03 : x + rng.range(-w / 2 + 0.2, w / 2 - 0.2);
    const vz = side ? z + rng.range(-d / 2 + 0.2, d / 2 - 0.2) : z + d / 2 + 0.03;
    tall.column(vx, vz, top - len, top, side ? 0.06 : 0.24, side ? 0.24 : 0.06, vary(0x4a8a34, rng, 0.8, 1.1));
  }
}

/** The scenery continues past the map edge in every direction. */
function margins(c: Ctx): void {
  const { grid, rng, b, tall, glow, group } = c;
  const W = grid.width;
  const H = grid.height;
  const M = MARGIN;
  const lowerY = -b.chasmDepth;
  const strips: [number, number, number, number][] = [
    [-M, -M, W + M, 0],
    [-M, H, W + M, H + M],
    [-M, 0, 0, H],
    [W, 0, W + M, H],
  ];
  if (b.chasm === 'island') {
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(W + M * 2 + 80, H + M * 2 + 80),
      new THREE.MeshBasicMaterial({ color: 0xffffff, map: cloudTexture(), transparent: true, opacity: 0.9, depthWrite: false }),
    );
    (sea.material as THREE.MeshBasicMaterial).map!.repeat.set(6, 6);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(W / 2, -16, H / 2);
    group.add(sea);
    for (const [x0, z0, x1, z1] of strips)
      for (let i = 0; i < ((x1 - x0) * (z1 - z0)) / 170; i++) building(tall, c.props, rng.range(x0 + 2, x1 - 2), rng.range(z0 + 2, z1 - 2), rng, b, rng.chance(0.5));
    return;
  }
  const tex = checkerTexture(b.lower[0], b.lower[1] ?? b.lower[0]);
  for (const [x0, z0, x1, z1] of strips) {
    const w = x1 - x0;
    const h = z1 - z0;
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / 2, (uv.getY(i) * h) / 2);
    const plane = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, map: tex }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x0 + w / 2, lowerY, z0 + h / 2);
    plane.receiveShadow = true;
    group.add(plane);
    const count = (w * h) / (b.chasm === 'garden' ? 45 : 60);
    for (let i = 0; i < count; i++) {
      const x = rng.range(x0 + 1, x1 - 1);
      const z = rng.range(z0 + 1, z1 - 1);
      if (b.chasm === 'garden') tree(tall, x, lowerY, z, rng, b);
      else {
        tall.column(x, z, lowerY, lowerY + rng.range(1.5, 4.5), 0.8, 0.8, vary(b.strata[i % b.strata.length], rng, 0.7, 0.9));
        if (rng.chance(0.3)) crystals(glow, x + 0.8, lowerY, z, rng.pick(b.crystals), rng, 1.3);
      }
    }
  }
}

/** Translucent layers of haze over the depths: lower things fade into the mist. */
function haze(c: Ctx): void {
  const { grid, b, theme, group } = c;
  const a = theme.atmosphere;
  const lowerY = -b.chasmDepth;
  const heights =
    b.chasm === 'island'
      ? [-5, -9, -13]
      : b.chasmDepth > 3
        ? [lowerY + 0.8, lowerY + 2.2, lowerY + 3.6].filter((y) => y < -1.2)
        : [lowerY + 0.35, lowerY + 0.9];
  const size = Math.max(grid.width, grid.height) + MARGIN * 2;
  for (const y of heights) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: a.haze, transparent: true, opacity: a.hazeOpacity, depthWrite: false, fog: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(grid.width / 2, y, grid.height / 2);
    plane.renderOrder = -1;
    group.add(plane);
  }
}

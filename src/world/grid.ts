/** Tile grid used for collision, generation and rendering. Pure logic: no three.js. */
export const Tile = {
  Void: 0,
  Floor: 1,
  Wall: 2,
  /** Solid furniture (crates, barrels, urns, planters) in room corners: blocks like a wall. */
  Prop: 3,
  /** A closed gate (boss gate, vault door, cracked wall): blocks until opened, then becomes floor. */
  Gate: 4,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

const EPS = 1e-4;

export class TileGrid {
  readonly tiles: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.tiles = new Uint8Array(width * height);
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.width && z < this.height;
  }

  get(x: number, z: number): Tile {
    if (!this.inBounds(x, z)) return Tile.Void;
    return this.tiles[z * this.width + x] as Tile;
  }

  set(x: number, z: number, t: Tile): void {
    if (this.inBounds(x, z)) this.tiles[z * this.width + x] = t;
  }

  isWalkable(x: number, z: number): boolean {
    return this.get(x, z) === Tile.Floor;
  }

  /** Is the tile containing world point (wx, wz) walkable? */
  isWalkableAt(wx: number, wz: number): boolean {
    return this.isWalkable(Math.floor(wx), Math.floor(wz));
  }

  fillRect(x: number, z: number, w: number, h: number, t: Tile): void {
    for (let j = z; j < z + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, t);
  }

  /** Turn every void tile that touches a floor (8-neighbourhood) into a wall. */
  buildWalls(): void {
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        if (this.get(x, z) !== Tile.Void) continue;
        let touchesFloor = false;
        for (let dz = -1; dz <= 1 && !touchesFloor; dz++)
          for (let dx = -1; dx <= 1; dx++)
            if (this.get(x + dx, z + dz) === Tile.Floor) {
              touchesFloor = true;
              break;
            }
        if (touchesFloor) this.set(x, z, Tile.Wall);
      }
    }
  }

  /**
   * Move an axis-aligned square of half-size r (a blocky "circle") by (dx, dz),
   * sliding along walls. Mutates and returns `pos`.
   */
  moveBox(pos: { x: number; z: number }, dx: number, dz: number, r: number): { x: number; z: number } {
    // Sub-step large moves so fast dashes never tunnel through a 1-tile wall.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.4));
    for (let s = 0; s < steps; s++) {
      this.moveAxisX(pos, dx / steps, r);
      this.moveAxisZ(pos, dz / steps, r);
    }
    return pos;
  }

  private moveAxisX(pos: { x: number; z: number }, dx: number, r: number): void {
    if (dx === 0) return;
    let nx = pos.x + dx;
    const z0 = Math.floor(pos.z - r + EPS);
    const z1 = Math.floor(pos.z + r - EPS);
    const tx = dx > 0 ? Math.floor(nx + r) : Math.floor(nx - r);
    for (let tz = z0; tz <= z1; tz++) {
      if (!this.isWalkable(tx, tz)) {
        nx = dx > 0 ? tx - r - EPS : tx + 1 + r + EPS;
        break;
      }
    }
    pos.x = nx;
  }

  private moveAxisZ(pos: { x: number; z: number }, dz: number, r: number): void {
    if (dz === 0) return;
    let nz = pos.z + dz;
    const x0 = Math.floor(pos.x - r + EPS);
    const x1 = Math.floor(pos.x + r - EPS);
    const tz = dz > 0 ? Math.floor(nz + r) : Math.floor(nz - r);
    for (let tx = x0; tx <= x1; tx++) {
      if (!this.isWalkable(tx, tz)) {
        nz = dz > 0 ? tz - r - EPS : tz + 1 + r + EPS;
        break;
      }
    }
    pos.z = nz;
  }

  /** Grid line-of-sight between two world points (DDA). */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / 0.25);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isWalkableAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
}

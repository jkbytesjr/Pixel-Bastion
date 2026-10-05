import type { TileGrid } from '../world/grid';

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/**
 * Breadth-first distance field toward a target tile. Enemies walk downhill on
 * it, which routes them around pillars and through corridors cheaply.
 */
export class FlowField {
  readonly dist: Int16Array;
  private readonly queue: Int32Array;
  private targetKey = '';

  constructor(
    private readonly grid: TileGrid,
    private readonly maxDist = 40,
  ) {
    this.dist = new Int16Array(grid.width * grid.height);
    this.queue = new Int32Array(grid.width * grid.height);
    this.dist.fill(-1);
  }

  /** Force a recompute next update (the walkable tiles changed: a gate opened). */
  invalidate(): void {
    this.targetKey = '';
  }

  /** Recompute only if the target moved to a new tile. */
  update(wx: number, wz: number): void {
    this.updateMany([{ x: wx, z: wz }]);
  }

  /**
   * Distance to the nearest of several targets (co-op: every living player),
   * so monsters head for whoever is closest. Recomputes only when a target
   * changes tile.
   */
  updateMany(targets: readonly { x: number; z: number }[]): void {
    const tiles = targets.map((t) => [Math.floor(t.x), Math.floor(t.z)] as const);
    const key = tiles.map(([x, z]) => `${x},${z}`).join(';');
    if (key === this.targetKey) return;
    this.targetKey = key;
    const { grid, dist, queue } = this;
    const w = grid.width;
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    for (const [tx, tz] of tiles) {
      if (!grid.isWalkable(tx, tz) || dist[tz * w + tx] === 0) continue;
      dist[tz * w + tx] = 0;
      queue[tail++] = tz * w + tx;
    }
    while (head < tail) {
      const idx = queue[head++];
      const d = dist[idx];
      if (d >= this.maxDist) continue;
      const x = idx % w;
      const z = (idx - x) / w;
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = x + dx;
        const nz = z + dz;
        if (!grid.isWalkable(nx, nz)) continue;
        // No diagonal corner cutting.
        if (dx !== 0 && dz !== 0 && (!grid.isWalkable(x + dx, z) || !grid.isWalkable(x, z + dz))) continue;
        const nIdx = nz * w + nx;
        if (dist[nIdx] !== -1) continue;
        dist[nIdx] = d + 1;
        queue[tail++] = nIdx;
      }
    }
  }

  distanceAt(wx: number, wz: number): number {
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    if (!this.grid.inBounds(x, z)) return -1;
    return this.dist[z * this.grid.width + x];
  }

  /**
   * World-space centre of the best next tile from (wx, wz), or null if
   * unreachable / already at the target.
   */
  nextStep(wx: number, wz: number): { x: number; z: number } | null {
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    const here = this.distanceAt(wx, wz);
    if (here <= 0) return null;
    let best = here;
    let bx = 0;
    let bz = 0;
    for (const [dx, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const nz = z + dz;
      if (dx !== 0 && dz !== 0 && (!this.grid.isWalkable(x + dx, z) || !this.grid.isWalkable(x, z + dz))) continue;
      const d = this.distanceAt(nx + 0.5, nz + 0.5);
      if (d >= 0 && d < best) {
        best = d;
        bx = nx;
        bz = nz;
      }
    }
    return best < here ? { x: bx + 0.5, z: bz + 0.5 } : null;
  }
}

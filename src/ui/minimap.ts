import type { GameWorld } from '../core/gameWorld';
import { Tile } from '../world/grid';
import { Exploration } from '../world/exploration';
import { RARITY_COLOR } from '../systems/loot';

const SIZE = 180;
/** Screen pixels per tile. */
const SCALE = 2.6;
const SIGHT = 13;
const REDRAW_INTERVAL = 1 / 20;
/** Enemies further than this (in tiles) are not shown, even on explored ground. */
const ENEMY_RANGE = 22;
const COLORS = { floor: '#5a5368', wall: '#a49cb8', gate: '#c8503a', chest: '#f2c14e', portal: '#b07cff', enemy: '#ff5a4e', boss: '#ff3df2' };

/** Minimap colour for a tile. */
const tileColor = (t: number) => (t === Tile.Wall || t === Tile.Prop ? COLORS.wall : t === Tile.Gate ? COLORS.gate : COLORS.floor);

/**
 * Circular, player-centred minimap with fog of war. Rotated so "up" matches the
 * camera's forward direction, so it reads the same way as the screen.
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** 1 px per tile record of everything explored so far. */
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private explored: Exploration | null = null;
  private lastTile = -1;
  private redrawTimer = 0;
  private time = 0;
  private readonly dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(root: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE * this.dpr;
    wrap.appendChild(this.canvas);
    root.appendChild(wrap);
    this.ctx = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d')!;
  }

  /** Number of explored tiles (smoke-test hook). */
  get seenCount(): number {
    return this.explored ? this.explored.seen.reduce((a, b) => a + b, 0) : 0;
  }

  /** Mark the whole floor as explored (admin). */
  revealAll(): void {
    const ex = this.explored;
    if (!ex) return;
    const { grid } = ex;
    for (let z = 0; z < grid.height; z++)
      for (let x = 0; x < grid.width; x++) {
        const t = grid.get(x, z);
        if (t === Tile.Void) continue;
        ex.seen[z * grid.width + x] = 1;
        this.baseCtx.fillStyle = tileColor(t);
        this.baseCtx.fillRect(x, z, 1, 1);
      }
  }

  /** Redraw tiles that changed (a gate opened), if they've been seen. */
  refreshTiles(tiles: readonly { x: number; z: number }[]): void {
    const ex = this.explored;
    if (!ex) return;
    for (const t of tiles) {
      if (!ex.seen[t.z * ex.grid.width + t.x]) continue;
      this.baseCtx.fillStyle = tileColor(ex.grid.get(t.x, t.z));
      this.baseCtx.fillRect(t.x, t.z, 1, 1);
    }
  }

  load(world: GameWorld): void {
    const { grid } = world.level;
    this.explored = new Exploration(grid);
    this.base.width = grid.width;
    this.base.height = grid.height;
    this.baseCtx.clearRect(0, 0, grid.width, grid.height);
    this.lastTile = -1;
    this.redrawTimer = 0;
  }

  update(dt: number, world: GameWorld): void {
    const ex = this.explored;
    if (!ex) return;
    this.time += dt;
    const { player } = world;
    const tile = Math.floor(player.pos.z) * ex.grid.width + Math.floor(player.pos.x);
    if (tile !== this.lastTile) {
      this.lastTile = tile;
      for (const i of ex.reveal(player.pos.x, player.pos.z, SIGHT)) {
        const x = i % ex.grid.width;
        const z = (i - x) / ex.grid.width;
        this.baseCtx.fillStyle = tileColor(ex.grid.get(x, z));
        this.baseCtx.fillRect(x, z, 1, 1);
      }
    }
    this.redrawTimer -= dt;
    if (this.redrawTimer > 0) return;
    this.redrawTimer = REDRAW_INTERVAL;
    this.draw(world, ex);
  }

  private draw(world: GameWorld, ex: Exploration): void {
    const { ctx } = this;
    const { player } = world;
    const px = player.pos.x;
    const pz = player.pos.z;
    const half = SIZE / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(8, 6, 12, 0.78)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // World space from here on: 1 unit = 1 tile, rotated 45° to match the camera.
    ctx.translate(half, half);
    ctx.rotate(Math.PI / 4);
    ctx.scale(SCALE, SCALE);
    ctx.translate(-px, -pz);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0);

    const seen = (x: number, z: number) => ex.isSeen(Math.floor(x), Math.floor(z));
    const dot = (x: number, z: number, r: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, z, r, 0, Math.PI * 2);
      ctx.fill();
    };

    const portal = world.portal;
    if (seen(portal.x, portal.z)) {
      const pulse = portal.active ? 0.9 + 0.3 * Math.sin(this.time * 6) : 0.6;
      ctx.globalAlpha = portal.active ? 1 : 0.5;
      dot(portal.x, portal.z, pulse, COLORS.portal);
      ctx.globalAlpha = 1;
    }
    for (const c of world.chests) {
      if (c.opened || !seen(c.x, c.z)) continue;
      ctx.fillStyle = COLORS.chest;
      ctx.fillRect(c.x - 0.5, c.z - 0.5, 1, 1);
    }
    // Shrine, mini-portals and closed gates.
    for (const m of world.features.markers()) dot(m.x, m.z, m.size, m.color);
    for (const p of world.pickups) {
      if (!seen(p.pos.x, p.pos.z)) continue;
      dot(p.pos.x, p.pos.z, 0.35, p.drop.type === 'potion' ? '#e2574c' : RARITY_COLOR[p.drop.item.rarity]);
    }
    for (const e of world.enemies) {
      if (!e.alive || !seen(e.pos.x, e.pos.z)) continue;
      if (!e.isBoss && Math.hypot(e.pos.x - px, e.pos.z - pz) > ENEMY_RANGE) continue;
      dot(e.pos.x, e.pos.z, e.isBoss ? 0.9 : 0.45, e.isBoss ? COLORS.boss : COLORS.enemy);
    }

    // Player arrow, pointing along facing.
    const fx = Math.sin(player.facing);
    const fz = Math.cos(player.facing);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.moveTo(px + fx * 1.2, pz + fz * 1.2);
    ctx.lineTo(px - fx * 0.6 + fz * 0.7, pz - fz * 0.6 - fx * 0.7);
    ctx.lineTo(px - fx * 0.2, pz - fz * 0.2);
    ctx.lineTo(px - fx * 0.6 - fz * 0.7, pz - fz * 0.6 + fx * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

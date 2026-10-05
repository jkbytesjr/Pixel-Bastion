import { groundAt } from '../world/terrain';
import * as THREE from 'three';
import type { TileGrid } from '../world/grid';
import type { AttackStats } from './damage';

export type ProjectileOwner = 'player' | 'enemy';

export interface ProjectileSpec {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  range: number;
  attack: AttackStats;
  knockback: number;
  owner: ProjectileOwner;
  /** Override the owner's default colour. */
  color?: number;
  /** Render as a chunky magic bolt instead of an arrow. */
  orb?: boolean;
  /** Player weapon shot: hits can trigger weapon powers. */
  proc?: boolean;
  /** The hero who fired it (co-op: whose stats and powers its hits use). */
  shooter?: import('../entities/player').Player;
  /** Render as a thrown spear (shaft plus head) instead of an arrow. */
  spear?: { shaft: number; head: number };
  /** Leave a trail of sparks in this colour (drawn by the game from `trailPoints`). */
  trail?: number;
}

interface Projectile extends ProjectileSpec {
  life: number;
  alive: boolean;
}

/** Something a projectile can hit. */
export interface ProjectileTarget {
  pos: { x: number; z: number };
  radius: number;
  alive: boolean;
}

const MAX = 192;
/** Spears draw as two instances (shaft and head). */
const MAX_INSTANCES = MAX * 2;
const HEIGHT = 1.0;

/** Pooled arrows rendered with a single InstancedMesh. */
export class Projectiles {
  readonly mesh: THREE.InstancedMesh;
  private readonly list: Projectile[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly orbScale = new THREE.Vector3(3.4, 3.4, 0.42);
  private readonly shaftScale = new THREE.Vector3(1.05, 1.05, 2.3);
  private readonly headScale = new THREE.Vector3(2.3, 1.2, 0.5);
  private readonly fwd = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly playerColor = new THREE.Color(0xf2e6c8);
  private readonly enemyColor = new THREE.Color(0xff5a3c);

  constructor() {
    const geo = new THREE.BoxGeometry(0.07, 0.07, 0.65);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_INSTANCES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Allocate the colour buffer up front so the shader never recompiles.
    this.mesh.setColorAt(0, this.playerColor);
  }

  fire(spec: ProjectileSpec): void {
    if (this.list.length >= MAX) return;
    const len = Math.hypot(spec.dirX, spec.dirZ) || 1;
    this.list.push({ ...spec, dirX: spec.dirX / len, dirZ: spec.dirZ / len, life: spec.range / spec.speed, alive: true });
  }

  /** Projectiles that leave a trail, for the game to draw sparks behind. */
  *trailPoints(): Generator<{ x: number; z: number; color: number }> {
    for (const p of this.list) if (p.trail !== undefined) yield { x: p.x, z: p.z, color: p.trail };
  }

  /** Heroes' shots in flight (monsters that dodge look at these). */
  playerShots(): { x: number; z: number; dirX: number; dirZ: number }[] {
    return this.list.filter((p) => p.owner === 'player');
  }

  /** Everything in flight, for co-op snapshots. */
  toNet(): import('../net/protocol').ProjectileState[] {
    const r = (v: number) => Math.round(v * 100) / 100;
    return this.list.map((p) => ({
      x: r(p.x),
      z: r(p.z),
      dx: r(p.dirX),
      dz: r(p.dirZ),
      s: p.speed,
      ...(p.owner === 'enemy' ? { e: 1 as const } : {}),
      ...(p.color !== undefined ? { c: p.color } : {}),
      ...(p.orb ? { o: 1 as const } : {}),
      ...(p.spear ? { sp: [p.spear.shaft, p.spear.head] as [number, number] } : {}),
      ...(p.trail !== undefined ? { tr: p.trail } : {}),
    }));
  }

  /** Co-op guests: replace what's in flight with the host's view (they then fly on until the next one). */
  setFromNet(list: import('../net/protocol').ProjectileState[]): void {
    const attack = { base: 0, power: 0, critChance: 0, critMultiplier: 1 };
    this.list.length = 0;
    for (const p of list.slice(0, MAX))
      this.list.push({
        x: p.x,
        z: p.z,
        dirX: p.dx,
        dirZ: p.dz,
        speed: p.s,
        range: 30,
        attack,
        knockback: 0,
        owner: p.e ? 'enemy' : 'player',
        color: p.c,
        orb: p.o === 1,
        spear: p.sp ? { shaft: p.sp[0], head: p.sp[1] } : undefined,
        trail: p.tr,
        life: 2,
        alive: true,
      });
  }

  clear(): void {
    this.list.length = 0;
    this.mesh.count = 0;
  }

  /**
   * Advance all projectiles. `onHit` is called for the first target struck;
   * returning true consumes the projectile.
   */
  update(
    dt: number,
    grid: TileGrid,
    targetsFor: (owner: ProjectileOwner) => readonly ProjectileTarget[],
    onHit: (p: ProjectileSpec, target: ProjectileTarget) => boolean,
    /** A projectile flew into a wall tile (heroes' shots can crack secret walls). */
    onWall?: (p: ProjectileSpec, x: number, z: number) => void,
  ): void {
    for (const p of this.list) {
      // Sub-step so fast arrows can't skip past a target.
      const steps = Math.max(1, Math.ceil((p.speed * dt) / 0.3));
      for (let s = 0; s < steps && p.alive; s++) {
        p.x += (p.dirX * p.speed * dt) / steps;
        p.z += (p.dirZ * p.speed * dt) / steps;
        if (!grid.isWalkableAt(p.x, p.z)) {
          p.alive = false;
          onWall?.(p, p.x, p.z);
          break;
        }
        for (const t of targetsFor(p.owner)) {
          if (!t.alive) continue;
          const r = t.radius + 0.12;
          if ((t.pos.x - p.x) ** 2 + (t.pos.z - p.z) ** 2 < r * r && onHit(p, t)) {
            p.alive = false;
            break;
          }
        }
      }
      p.life -= dt;
      if (p.life <= 0) p.alive = false;
    }
    for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].alive) this.list.splice(i, 1);

    let n = 0;
    for (const p of this.list) {
      this.q.setFromAxisAngle(this.up, Math.atan2(p.dirX, p.dirZ));
      const y = HEIGHT + groundAt(p.x, p.z);
      if (p.spear) {
        // Shaft trailing behind the point, then the head at the front.
        this.fwd.set(p.dirX, 0, p.dirZ);
        this.p.set(p.x, y, p.z).addScaledVector(this.fwd, -0.55);
        this.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.shaftScale));
        this.mesh.setColorAt(n++, this.c.setHex(p.spear.shaft));
        this.p.set(p.x, y, p.z).addScaledVector(this.fwd, 0.28);
        this.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.headScale));
        this.mesh.setColorAt(n++, this.c.setHex(p.spear.head));
        continue;
      }
      this.m.compose(this.p.set(p.x, y, p.z), this.q, p.orb ? this.orbScale : this.s);
      this.mesh.setMatrixAt(n, this.m);
      if (p.color !== undefined) this.mesh.setColorAt(n, this.c.setHex(p.color));
      else this.mesh.setColorAt(n, p.owner === 'player' ? this.playerColor : this.enemyColor);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

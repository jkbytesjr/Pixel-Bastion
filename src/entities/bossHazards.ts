import * as THREE from 'three';
import type { Player } from './player';
import type { AttackStats } from '../systems/damage';

/**
 * Telegraphed boss hazards: a red zone appears on the ground and fills up,
 * then it hits every hero standing in it. Rings expand outward instead (roll
 * through them). Specs are plain data so the co-op host can send them to guests.
 */
export type HazardSpec =
  /** Impact zone: a disc that fills over `delay`, then strikes. */
  | { k: 'circle'; x: number; z: number; r: number; delay: number; base: number; knock: number }
  /** Shockwave: after `delay`, a ring expands from (x, z) out to `r` at `speed`. */
  | { k: 'ring'; x: number; z: number; r: number; speed: number; delay: number; base: number; knock: number }
  /** Eruption lane: a strip from (x, z) along angle `a`, `len` long and `w` wide. */
  | { k: 'lane'; x: number; z: number; a: number; len: number; w: number; delay: number; base: number; knock: number };

/** How the field reaches the heroes (absent on co-op guests: they only show the warnings). */
export interface HazardTargets {
  heroes(): readonly Player[];
  hit(hero: Player, attack: AttackStats, knockX: number, knockZ: number): void;
  /** Where a hazard went off, for effects. */
  burst(x: number, z: number, radius: number): void;
}

const outlineMat = new THREE.MeshBasicMaterial({ color: 0xff3a24, transparent: true, opacity: 0.6, depthWrite: false });
const fillMat = new THREE.MeshBasicMaterial({ color: 0xff2a14, transparent: true, opacity: 0.32, depthWrite: false });
const waveMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb04a).multiplyScalar(1.6), transparent: true, opacity: 0.85, depthWrite: false });
const ringGeo = new THREE.RingGeometry(0.93, 1, 56);
const discGeo = new THREE.CircleGeometry(1, 48);
const planeGeo = new THREE.PlaneGeometry(1, 1);
/** Half-width of an expanding shockwave band. */
const WAVE_BAND = 0.4;

interface Live {
  spec: HazardSpec;
  t: number;
  group: THREE.Group;
  fill: THREE.Mesh;
  /** Rings: heroes already hit by this wave. */
  struck: Set<Player>;
}

const flat = (m: THREE.Mesh, y: number) => {
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.renderOrder = 3;
  return m;
};

export class HazardField {
  /** World-space group (the boss adds it to its world effects). */
  readonly group = new THREE.Group();
  private readonly live: Live[] = [];

  get count(): number {
    return this.live.length;
  }

  add(spec: HazardSpec): void {
    const g = new THREE.Group();
    let fill: THREE.Mesh;
    if (spec.k === 'lane') {
      g.position.set(spec.x, 0, spec.z);
      g.rotation.y = spec.a;
      const outline = flat(new THREE.Mesh(planeGeo, outlineMat), 0.04);
      outline.scale.set(spec.w, spec.len, 1);
      outline.position.z = spec.len / 2;
      outline.material = outlineMat.clone();
      (outline.material as THREE.MeshBasicMaterial).opacity = 0.22;
      fill = flat(new THREE.Mesh(planeGeo, fillMat), 0.05);
      fill.scale.set(spec.w, 0.001, 1);
      g.add(outline, fill);
    } else {
      g.position.set(spec.x, 0, spec.z);
      const outline = flat(new THREE.Mesh(ringGeo, outlineMat), 0.04);
      outline.scale.setScalar(spec.k === 'ring' ? 1.2 : spec.r);
      fill = flat(new THREE.Mesh(discGeo, fillMat), 0.05);
      fill.scale.setScalar(0.001);
      g.add(outline, fill);
    }
    this.group.add(g);
    this.live.push({ spec, t: 0, group: g, fill, struck: new Set() });
  }

  clear(): void {
    for (const h of this.live) this.group.remove(h.group);
    this.live.length = 0;
  }

  /** Advance every hazard; `targets` (host / solo only) takes the damage. */
  update(dt: number, power: number, targets: HazardTargets | null): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const h = this.live[i];
      h.t += dt;
      const s = h.spec;
      const attack: AttackStats = { base: s.base, power, critChance: 0, critMultiplier: 1 };
      const warm = Math.min(1, h.t / s.delay);
      if (s.k === 'circle') {
        h.fill.scale.setScalar(Math.max(0.001, s.r * warm));
        if (h.t >= s.delay) {
          if (targets) {
            for (const hero of targets.heroes()) {
              const dx = hero.pos.x - s.x;
              const dz = hero.pos.z - s.z;
              const d = Math.hypot(dx, dz);
              if (d < s.r + hero.radius) targets.hit(hero, attack, (dx / (d || 1)) * s.knock, (dz / (d || 1)) * s.knock);
            }
            targets.burst(s.x, s.z, s.r);
          }
          this.remove(i);
        }
      } else if (s.k === 'lane') {
        h.fill.scale.y = Math.max(0.001, s.len * warm);
        h.fill.position.z = (s.len * warm) / 2;
        if (h.t >= s.delay) {
          if (targets) {
            const fx = Math.sin(s.a);
            const fz = Math.cos(s.a);
            for (const hero of targets.heroes()) {
              const rx = hero.pos.x - s.x;
              const rz = hero.pos.z - s.z;
              const along = rx * fx + rz * fz;
              const across = rx * fz - rz * fx;
              if (along > -hero.radius && along < s.len + hero.radius && Math.abs(across) < s.w / 2 + hero.radius)
                targets.hit(hero, attack, Math.sign(across || 1) * fz * s.knock, -Math.sign(across || 1) * fx * s.knock);
            }
            for (let d = 1; d < s.len; d += 2) targets.burst(s.x + fx * d, s.z + fz * d, s.w / 2);
          }
          this.remove(i);
        }
      } else {
        // Shockwave: pulse during the warning, then a bright band races outward.
        if (h.t < s.delay) {
          h.fill.scale.setScalar(1.2 * warm);
          continue;
        }
        const radius = (h.t - s.delay) * s.speed;
        h.fill.material = waveMat;
        h.fill.geometry = ringGeo;
        h.fill.scale.setScalar(Math.max(0.01, radius));
        if (targets)
          for (const hero of targets.heroes()) {
            if (h.struck.has(hero)) continue;
            const dx = hero.pos.x - s.x;
            const dz = hero.pos.z - s.z;
            const d = Math.hypot(dx, dz);
            if (Math.abs(d - radius) < WAVE_BAND + hero.radius) {
              h.struck.add(hero);
              targets.hit(hero, attack, (dx / (d || 1)) * s.knock, (dz / (d || 1)) * s.knock);
            }
          }
        if (radius > s.r) this.remove(i);
      }
    }
  }

  private remove(i: number): void {
    this.group.remove(this.live[i].group);
    this.live.splice(i, 1);
  }
}

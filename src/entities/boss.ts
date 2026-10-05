import * as THREE from 'three';
import { Enemy, type EnemyContext } from './enemy';
import { HazardField, type HazardSpec } from './bossHazards';
import type { HumanoidParts } from './voxelModel';
import type { BossKind } from '../world/dungeonGen';

/** Shared red ground-warning material for boss attacks. */
export const telegraphMaterial = new THREE.MeshBasicMaterial({
  color: 0xff3020,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
});

/** Flat circle on the ground, radius 1 (scale it). */
export function groundCircle(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(1, 32), telegraphMaterial);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.03;
  m.visible = false;
  return m;
}

/** A boss special: picked when it's off cooldown, cast with a wind-up pose, then `run`. */
export interface BossPower {
  name: string;
  cooldown: number;
  /** Earliest phase it's used in (1 fresh, 2 enraged below half health, 3 desperate below a quarter). */
  minPhase: 1 | 2 | 3;
  /** Wind-up seconds (shortened as the boss speeds up). */
  cast: number;
  run(ctx: EnemyContext): void;
  /** Seconds until it can be used again (start a little in, so not everything opens the fight). */
  timer: number;
}

/**
 * End-of-floor boss. Sleeps until it sees the player (or is hit), then runs
 * its own fight logic. Below half HP it is "enraged" and subclasses escalate.
 */
export abstract class Boss extends Enemy {
  readonly kind = 'boss';
  readonly xp = 150;
  readonly isBoss = true;
  abstract readonly bossKind: BossKind;
  readonly name: string;
  engaged = false;

  get affinityKind(): string {
    return this.bossKind;
  }
  /** Seconds in the current fight state. */
  protected stateTime = 0;
  /** Set when damaged while asleep; engage() runs on the next update (it needs ctx). */
  private wakePending = false;
  /** Telegraphed ground hazards from special powers. */
  readonly hazards = new HazardField();
  /** Special powers (subclasses fill this in). */
  protected readonly powers: BossPower[] = [];
  private casting: BossPower | null = null;
  private castTime = 0;
  private lastPhase = 1;
  /** Decorations that circle the boss (skulls, embers); spun every frame. */
  protected readonly orbiters = new THREE.Group();

  protected constructor(name: string, depth: number, maxHp: number, model: HumanoidParts, barHeight: number) {
    super(maxHp, model, barHeight);
    // Every four floors the returning bosses earn a grander title.
    const tier = Math.floor(depth / 4);
    this.name = tier === 0 ? name : `${name} ${['Reborn', 'Ascendant'][tier - 1] ?? 'Eternal'}`;
    this.knockbackTaken = 0.12;
    this.model.root.add(this.orbiters);
    this.worldFx.add(this.hazards.group);
  }

  /** Bosses get a much bigger health pool and hit harder the deeper they are. */
  scaleForDepth(depth: number): void {
    this.maxHp = Math.round(this.maxHp * 1.45 * (1 + 0.45 * depth));
    this.hp = this.maxHp;
    this.damageMult = 1.15 * (1 + 0.32 * depth);
  }

  /** 1 above half health, 2 enraged below half, 3 desperate below a quarter. */
  get phase(): 1 | 2 | 3 {
    const f = this.hp / this.maxHp;
    return f > 0.5 ? 1 : f > 0.25 ? 2 : 3;
  }

  /**
   * Called from a boss's neutral state: start a special power if one is ready.
   * Returns true when it did (the boss then winds up and casts it).
   */
  protected tryPower(ctx: EnemyContext): boolean {
    if (ctx.remote || this.casting) return false;
    const ready = this.powers.filter((p) => p.timer <= 0 && this.phase >= p.minPhase);
    if (!ready.length) return false;
    this.casting = ctx.rng.pick(ready);
    this.castTime = 0;
    return true;
  }

  /** The heroes a power aims at: every living one (or just the current target). */
  protected heroTargets(ctx: EnemyContext): readonly { pos: { x: number; z: number }; facing: number }[] {
    const all = ctx.heroes();
    return all.length ? all : [ctx.player];
  }

  /** Put a telegraphed hazard down (co-op: the host's are sent to everyone). */
  protected hazard(ctx: EnemyContext, spec: HazardSpec): void {
    if (ctx.remote) return;
    this.hazards.add(spec);
    ctx.events.emit('hazard', { spec });
  }

  /** Add `count` copies of `make()` circling at `radius`, bobbing around `height`. */
  protected addOrbiters(count: number, radius: number, height: number, make: () => THREE.Object3D): void {
    for (let i = 0; i < count; i++) {
      const o = make();
      const a = (i / count) * Math.PI * 2;
      o.position.set(Math.sin(a) * radius, height, Math.cos(a) * radius);
      o.userData.phase = a;
      o.userData.height = height;
      this.orbiters.add(o);
    }
  }

  get enraged(): boolean {
    return this.hp < this.maxHp / 2;
  }

  /** Speed multiplier for timings: quicker reactions, faster still when enraged and desperate. */
  protected get pace(): number {
    return [1.1, 1.3, 1.5][this.phase - 1];
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    if (!this.engaged) {
      this.animateWalk(dt, false);
      if (this.canSeePlayer(ctx, 11)) this.engage(ctx);
      return;
    }
    if (!ctx.player.alive) {
      this.hideTelegraphs();
      this.casting = null;
      this.idle();
      this.animateWalk(dt, false);
      return;
    }
    // Phase changes are announced: the fight is about to get harder.
    const phase = this.phase;
    if (phase > this.lastPhase) {
      this.lastPhase = phase;
      ctx.events.emit('bossPhase', { name: this.name, phase });
      // Desperate bosses use their powers much more often.
      if (phase === 3) for (const p of this.powers) p.timer = Math.min(p.timer, 1);
    }
    for (const p of this.powers) p.timer -= dt * (phase === 3 ? 1.6 : 1);
    if (this.casting) {
      this.castPose(dt, ctx);
      return;
    }
    this.fight(dt, ctx);
  }

  /** Wind-up: rise up, arms raised, glowing; then the power goes off and the boss is briefly open. */
  private castPose(dt: number, ctx: EnemyContext): void {
    const power = this.casting!;
    this.castTime += dt;
    const t = Math.min(1, this.castTime / (power.cast / this.pace));
    this.turnToward(this.angleToPlayer(ctx), 3, dt);
    this.model.armL.rotation.x = this.model.armR.rotation.x = -2.8 * Math.sin(Math.min(1, t * 1.2) * (Math.PI / 2));
    this.model.armL.rotation.z = -0.4 * t;
    this.model.armR.rotation.z = 0.4 * t;
    this.attackLean = -0.25 * t;
    this.animateWalk(dt, false);
    if (t < 1) return;
    power.run(ctx);
    power.timer = power.cooldown;
    this.casting = null;
    this.model.armL.rotation.z = this.model.armR.rotation.z = 0;
    this.expose(0.8);
  }

  /** Per-tick fight logic once engaged and the player is alive. */
  protected abstract fight(dt: number, ctx: EnemyContext): void;

  /** Hide every attack warning (death, player death). */
  protected abstract hideTelegraphs(): void;

  /** Return to a neutral state while the player is dead. */
  protected abstract idle(): void;

  private engage(ctx: EnemyContext): void {
    if (this.engaged) return;
    this.engaged = true;
    this.stateTime = 0;
    ctx.events.emit('bossEngaged', { name: this.name });
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && !this.engaged) this.wakePending = true;
    if (!this.alive) this.hideTelegraphs();
    return hit;
  }

  update(dt: number, ctx: EnemyContext, camera: THREE.Camera): void {
    // Hazards keep running (and hitting) whatever the boss is doing; only the host's deal damage.
    this.hazards.update(
      dt,
      this.damageMult,
      ctx.remote
        ? null
        : {
            heroes: () => ctx.heroes(),
            hit: (hero, attack, kx, kz) => ctx.hitHero(this, hero, attack, kx, kz),
            burst: (x, z, radius) => ctx.events.emit('bossStrike', { x, z, radius, boss: this.bossKind }),
          },
    );
    if (!this.alive) this.hazards.clear();
    if (this.wakePending) {
      this.wakePending = false;
      this.engage(ctx);
    }
    super.update(dt, ctx, camera);
    // Counter the body's facing so orbiters circle in world space, and bob them.
    this.orbiters.rotation.y += dt * 1.6;
    for (const o of this.orbiters.children) {
      o.position.y = (o.userData.height as number) + Math.sin(this.stateTime * 3 + (o.userData.phase as number)) * 0.15;
      o.rotation.y += dt * 2;
    }
    this.orbiters.visible = this.alive;
    // The overhead bar is replaced by the HUD boss bar.
    this.healthBar.group.visible = false;
  }

  /** Eyes on the head's front face. */
  protected addEyes(color: number): void {
    const eyeMat = new THREE.MeshBasicMaterial({ color });
    for (const ex of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.02), eyeMat);
      eye.position.set(ex, 0.03, 0.22);
      eye.scale.divide(this.model.head.scale);
      eye.position.divide(this.model.head.scale);
      this.model.head.add(eye);
    }
  }

  /** Shoot a projectile from the boss toward `angle`. */
  protected shoot(ctx: EnemyContext, angle: number, o: { speed: number; range: number; base: number; color: number; orb?: boolean }): void {
    ctx.fireProjectile({
      x: this.pos.x + Math.sin(angle) * (this.radius + 0.2),
      z: this.pos.z + Math.cos(angle) * (this.radius + 0.2),
      dirX: Math.sin(angle),
      dirZ: Math.cos(angle),
      speed: o.speed,
      range: o.range,
      attack: { base: o.base, power: this.damageMult, critChance: 0, critMultiplier: 1 },
      knockback: 3,
      color: o.color,
      orb: o.orb,
    });
  }

  /** Spawn adds on open floor beside the boss. */
  protected summon(ctx: EnemyContext, kinds: ('grunt' | 'archer' | 'exploder')[]): void {
    kinds.forEach((kind, i) => {
      const a = this.facing + Math.PI / 2 + (i / kinds.length) * Math.PI * 2;
      const x = this.pos.x + Math.sin(a) * 1.8;
      const z = this.pos.z + Math.cos(a) * 1.8;
      if (ctx.grid.isWalkableAt(x, z)) ctx.spawnEnemy(kind, x, z);
    });
  }
}

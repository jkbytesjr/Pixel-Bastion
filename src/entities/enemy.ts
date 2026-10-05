import * as THREE from 'three';
import { Actor } from './actor';
import { HealthBar } from './healthBar';
import { compactModel, type HumanoidParts } from './voxelModel';
import { BodyMotion, ease, span } from './animation';
import { groundAt } from '../world/terrain';
import type { Player } from './player';
import type { TileGrid } from '../world/grid';
import type { FlowField } from '../systems/flowField';
import type { AttackStats } from '../systems/damage';
import type { Rng } from '../core/rng';
import type { ProjectileSpec } from '../systems/projectiles';
import type { EnemyKind } from '../world/dungeonGen';
import type { EventBus } from '../core/events';

export interface EnemyContext {
  player: Player;
  grid: TileGrid;
  flow: FlowField;
  rng: Rng;
  /** Resolve an enemy attack against the player. */
  hitPlayer(source: Enemy, attack: AttackStats, knockback: number): void;
  fireProjectile(spec: Omit<ProjectileSpec, 'owner'>): void;
  /** Area damage to the player (and, at half strength, other enemies). */
  explode(x: number, z: number, radius: number, base: number, source: Enemy): void;
  spawnEnemy(kind: EnemyKind, x: number, z: number): void;
  /** Every enemy on the floor (for healers). */
  allies(): readonly Enemy[];
  /** Every living hero (empty on co-op guests: their copies of monsters deal no damage). */
  heroes(): readonly Player[];
  /** Resolve a monster's attack against a particular hero (boss hazards). */
  hitHero(source: Enemy, hero: Player, attack: AttackStats, knockX: number, knockZ: number): void;
  /** True on co-op guests: this copy of the monster only acts out the host's fight. */
  remote: boolean;
  /** Heroes' arrows and spears in flight (for monsters that sidestep them). */
  threats(): readonly { x: number; z: number; dirX: number; dirZ: number }[];
  events: EventBus;
}

const DEATH_TIME = 0.95;
/** Seconds a summoned enemy takes to climb out of the floor. */
const RISE_TIME = 0.7;

const tintCache = new Map<string, THREE.MeshLambertMaterial>();
const exposedGeo = new THREE.OctahedronGeometry(0.16);
const exposedMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23f).multiplyScalar(1.6) });

const eliteRingMat = new THREE.MeshBasicMaterial({ color: 0xffc23a, transparent: true, opacity: 0.55, depthWrite: false });

export abstract class Enemy extends Actor {
  abstract readonly kind: string;
  abstract readonly xp: number;
  readonly healthBar: HealthBar;
  /** World-space effects (ground telegraphs) that must not move or turn with the model. */
  readonly worldFx = new THREE.Group();
  protected readonly model: HumanoidParts;
  /** Multiplies outgoing damage; raised on deeper floors. */
  damageMult = 1;
  /** False for kills that should not reward XP/loot (e.g. self-detonation). */
  rewardsOnDeath = true;
  /** Set by the world once death has been announced. */
  deathReported = false;
  readonly isBoss: boolean = false;
  /** Weapon-power status effects; timed down here, applied by the world. */
  burnTime = 0;
  burnDps = 0;
  burnAcc = 0;
  chillTime = 0;
  /** Speed multiplier while chilled. */
  chillSlow = 1;
  freezeTime = 0;
  statusFxTimer = 0;
  /** Co-op: the host's id for this enemy (same on every peer for the floor's starting monsters). */
  netId = -1;
  /** Co-op guests: where the host says this enemy is. */
  net: { x: number; z: number; f: number } | null = null;
  /** Elite (champion) enemies: tougher, glowing, worth more. */
  elite = false;
  /** Multiplies XP for the kill (elites). */
  xpMult = 1;
  /** Speeds up everything it does (mod variants and tweaks). */
  tempo = 1;
  /** Display name of a mod variant, if it is one. */
  variantName: string | null = null;
  /** Typical run speed, used to scale lean and bounce. */
  protected moveSpeed = 3;
  protected readonly motion = new BodyMotion();
  private riseTimer = 0;
  /** Seconds left of an exposed window (just attacked, off balance): takes extra damage. */
  private exposedTime = 0;
  /** Yellow marker over the head while exposed. */
  private readonly exposedMark: THREE.Mesh;
  /** Last knockback received, to pick which way the body falls. */
  private readonly lastKnock = { x: 0, z: 0 };
  private fallDir = -1;
  private fallSide = 0;
  protected walkPhase = 0;
  private deathTimer = 0;

  constructor(maxHp: number, model: HumanoidParts, barHeight: number) {
    super(maxHp);
    this.model = model;
    this.healthBar = new HealthBar(barHeight);
    this.exposedMark = new THREE.Mesh(exposedGeo, exposedMat);
    this.exposedMark.position.y = barHeight + 0.35;
    this.exposedMark.visible = false;
    this.exposedMark.userData.noFlash = true;
    model.root.add(this.exposedMark);
  }

  private compacted = false;

  /** Merge the model's boxes for fewer draw calls (once, after subclasses finish building it). */
  compact(): void {
    if (this.compacted) return;
    this.compacted = true;
    compactModel(this.model.root);
  }

  get object(): THREE.Object3D {
    return this.model.root;
  }

  scaleForDepth(depth: number): void {
    this.maxHp = Math.round(this.maxHp * (1 + 0.4 * depth));
    this.hp = this.maxHp;
    this.damageMult = 1 + 0.3 * depth;
  }

  /** True once the death animation has finished and it can be removed. */
  get removable(): boolean {
    return !this.alive && this.deathTimer >= DEATH_TIME;
  }

  update(dt: number, ctx: EnemyContext, camera: THREE.Camera): void {
    this.tickCommon(dt, ctx.grid);
    this.exposedTime = Math.max(0, this.exposedTime - dt);
    this.exposedMark.visible = this.exposedTime > 0 && this.alive;
    if (this.exposedMark.visible) {
      this.exposedMark.rotation.y += dt * 4;
      this.exposedMark.scale.setScalar(1 + Math.sin(this.exposedTime * 18) * 0.15);
    }
    let rootY = 0;
    if (this.alive) {
      this.chillTime = Math.max(0, this.chillTime - dt);
      this.freezeTime = Math.max(0, this.freezeTime - dt);
      if (this.riseTimer > 0) {
        // Summoned: climb out of the floor before doing anything.
        this.riseTimer = Math.max(0, this.riseTimer - dt);
        rootY = -1.7 * ease.inCubic(this.riseTimer / RISE_TIME);
        this.animateWalk(dt, true, 14);
      } else {
        // Frozen enemies stop entirely; chilled ones move and attack in slow motion.
        const timeScale = this.freezeTime > 0 ? 0 : this.chillTime > 0 ? this.chillSlow : 1;
        if (timeScale > 0) this.think(dt * timeScale * this.tempo, ctx);
      }
      this.motion.apply(this.model, dt, this.pos, this.facing, this.walkPhase, this.moveSpeed, this.attackLean);
    } else {
      this.animateDeath(dt);
      rootY = -0.6 * span(this.deathTimer, DEATH_TIME * 0.6, DEATH_TIME);
    }
    // Stand on raised or sunken floors (visual only); ground warnings follow.
    const ground = groundAt(this.pos.x, this.pos.z);
    this.model.root.position.set(this.pos.x, rootY + ground, this.pos.z);
    this.model.root.rotation.y = this.facing;
    this.worldFx.position.y = ground;
    this.healthBar.update(this.pos.x, this.pos.z, this.hp / this.maxHp, camera, ground);
  }

  protected abstract think(dt: number, ctx: EnemyContext): void;

  /** Extra forward lean for attack poses (subclasses set it while attacking). */
  protected attackLean = 0;

  /**
   * Fraction of incoming player damage taken from a hit that came from
   * (fromX, fromZ). 1 unless `blockArc` says it hit a raised shield.
   */
  incomingMult(fromX: number, fromZ: number): number {
    const arc = this.blockArc();
    if (arc === null) return 1;
    let d = Math.abs(Math.atan2(fromX - this.pos.x, fromZ - this.pos.z) - this.facing) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return d < arc.halfAngle ? arc.taken : 1;
  }

  /** Shielded enemies return their guard: hits within `halfAngle` of facing take `taken` of the damage. */
  protected blockArc(): { halfAngle: number; taken: number } | null {
    return null;
  }

  /** Start under the floor and climb out (summoned enemies). */
  rise(): void {
    this.riseTimer = RISE_TIME;
  }

  get rising(): boolean {
    return this.riseTimer > 0;
  }

  /** Multiply a colour over the whole (merged) model: mod variants. Call after `compact`. */
  tint(color: number): void {
    const c = new THREE.Color(color);
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshLambertMaterial)) return;
      if (mesh.material.transparent) {
        // Per-instance material (ghosts): tint in place.
        mesh.material.color.multiply(c);
        return;
      }
      const key = `${mesh.material.uuid}:${color}`;
      let mat = tintCache.get(key);
      if (!mat) {
        mat = mesh.material.clone();
        mat.color.multiply(c);
        tintCache.set(key, mat);
      }
      mesh.material = mat;
    });
  }

  /** Grow or shrink the body. */
  resize(factor: number): void {
    this.model.body.scale.multiplyScalar(factor);
    this.model.bodyBaseY *= factor;
    this.model.body.position.y = this.model.bodyBaseY;
  }

  /** Open an exposed window: hits land harder (EXPOSED_MULT) for `seconds`. */
  protected expose(seconds: number): void {
    this.exposedTime = Math.max(this.exposedTime, seconds);
  }

  get exposed(): boolean {
    return this.exposedTime > 0 && this.alive;
  }

  /** Elements whose weakness / resistance the player has already been told about. */
  readonly affinitiesSeen = new Set<string>();

  /** Kind used for elemental affinities (bosses use their boss kind). */
  get affinityKind(): string {
    return this.kind;
  }

  /** Turn into an elite: more health and damage, bigger, ringed in gold. */
  makeElite(): void {
    if (this.elite) return;
    this.elite = true;
    this.maxHp = Math.round(this.maxHp * 2.5);
    this.hp = this.maxHp;
    this.damageMult *= 1.4;
    this.xpMult = 3;
    const s = this.model.body.scale.x * 1.18;
    this.model.body.scale.setScalar(s);
    this.model.bodyBaseY *= 1.18;
    this.model.body.position.y = this.model.bodyBaseY;
    const ring = new THREE.Mesh(new THREE.RingGeometry(this.radius + 0.12, this.radius + 0.3, 24), eliteRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    this.model.root.add(ring);
    this.healthBar.setElite();
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit) {
      this.lastKnock.x = knockX;
      this.lastKnock.z = knockZ;
      this.motion.hit(Math.min(1, 0.35 + 0.65 * this.knockbackTaken) * (this.elite ? 0.7 : 1));
    }
    return hit;
  }

  protected onDeath(): void {
    // Fall the way the killing blow pushed: backward if hit from the front.
    const fwd = this.lastKnock.x * Math.sin(this.facing) + this.lastKnock.z * Math.cos(this.facing);
    const side = this.lastKnock.x * Math.cos(this.facing) - this.lastKnock.z * Math.sin(this.facing);
    this.fallDir = fwd > 0.01 ? 1 : -1;
    this.fallSide = Math.max(-1, Math.min(1, side * 0.2)) + (Math.random() - 0.5) * 0.4;
  }

  /** Topple with a bounce, limbs flopping, then sink into the floor. */
  private animateDeath(dt: number): void {
    this.deathTimer += dt;
    const { body, bodyBaseY, armL, armR, legL, legR } = this.model;
    const t = ease.outBounce(span(this.deathTimer, 0, DEATH_TIME * 0.55));
    body.rotation.x = this.fallDir * (Math.PI / 2) * t;
    body.rotation.z = this.fallSide * 0.35 * t;
    body.position.y = bodyBaseY * (1 - 0.62 * t);
    armL.rotation.x = armR.rotation.x = -this.fallDir * 1.1 * t;
    armL.rotation.z = -0.7 * t;
    armR.rotation.z = 0.7 * t;
    legL.rotation.x = 0.25 * t;
    legR.rotation.x = -0.15 * t;
  }

  protected distanceToPlayer(ctx: EnemyContext): number {
    return Math.hypot(ctx.player.pos.x - this.pos.x, ctx.player.pos.z - this.pos.z);
  }

  protected angleToPlayer(ctx: EnemyContext): number {
    return Math.atan2(ctx.player.pos.x - this.pos.x, ctx.player.pos.z - this.pos.z);
  }

  /** Is the player visible and within `range`? */
  protected canSeePlayer(ctx: EnemyContext, range: number): boolean {
    const p = ctx.player;
    return p.alive && this.distanceToPlayer(ctx) < range && ctx.grid.lineOfSight(this.pos.x, this.pos.z, p.pos.x, p.pos.z);
  }

  /** Close-combat monster: takes part in surrounding the hero. */
  protected melee = false;
  /** This monster's place in the ring around its target. */
  private readonly flankAngle = Math.random() * Math.PI * 2;
  private evadeTime = 0;
  private evadeDir = 1;
  private evadeCooldown = 0;
  private flankClock = 0;

  get isMelee(): boolean {
    return this.melee && this.alive;
  }

  /**
   * Close in like a pack: from range, path to the hero; up close, take a
   * spot around them instead of queueing behind each other. When three or
   * more are already on the hero, the rest hold back in a wider ring and
   * wait for an opening. Returns whether it moved.
   */
  protected flankToward(ctx: EnemyContext, dt: number, speed: number, attackRange: number): boolean {
    const p = ctx.player;
    const dist = this.distanceToPlayer(ctx);
    this.flankClock += dt;
    if (dist > 5 || !ctx.grid.lineOfSight(this.pos.x, this.pos.z, p.pos.x, p.pos.z)) return this.moveToward(ctx, dt, speed);
    let crowd = 0;
    for (const a of ctx.allies()) {
      if (a === this || !a.isMelee) continue;
      if (Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) < attackRange + 0.9) crowd++;
    }
    const waiting = crowd >= 3 && dist > attackRange + 0.5;
    const ring = waiting ? attackRange + 2.2 : attackRange * 0.75;
    // Slowly rotate the spot so a waiting ring keeps shifting around the hero.
    const a = this.flankAngle + (waiting ? this.flankClock * 0.3 : 0);
    const tx = p.pos.x + Math.sin(a) * ring;
    const tz = p.pos.z + Math.cos(a) * ring;
    if (!ctx.grid.isWalkableAt(tx, tz) || !ctx.grid.lineOfSight(this.pos.x, this.pos.z, tx, tz)) return this.moveToward(ctx, dt, speed);
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const len = Math.hypot(dx, dz);
    this.turnToward(this.angleToPlayer(ctx), 8, dt);
    if (len < 0.2) return false;
    const step = Math.min(len, speed * dt * (waiting ? 0.6 : 1));
    ctx.grid.moveBox(this.pos, (dx / len) * step, (dz / len) * step, this.radius);
    return true;
  }

  /**
   * Ranged and agile monsters sidestep arrows and spears flying at them,
   * though not every time and not twice in a row. Returns true while sidestepping.
   */
  protected evadeShots(ctx: EnemyContext, dt: number, speed: number): boolean {
    this.evadeCooldown -= dt;
    if (this.evadeTime > 0) {
      this.evadeTime -= dt;
      const a = this.angleToPlayer(ctx) + (Math.PI / 2) * this.evadeDir;
      ctx.grid.moveBox(this.pos, Math.sin(a) * speed * 1.8 * dt, Math.cos(a) * speed * 1.8 * dt, this.radius);
      return true;
    }
    if (this.evadeCooldown > 0) return false;
    for (const t of ctx.threats()) {
      const rx = this.pos.x - t.x;
      const rz = this.pos.z - t.z;
      const along = rx * t.dirX + rz * t.dirZ;
      if (along < 0 || along > 4.5) continue;
      const across = rx * t.dirZ - rz * t.dirX;
      if (Math.abs(across) > this.radius + 0.6) continue;
      this.evadeCooldown = 1.6;
      if (!ctx.rng.chance(0.65)) return false;
      this.evadeDir = across >= 0 ? -1 : 1;
      this.evadeTime = 0.3;
      return true;
    }
    return false;
  }

  /** Sidestep perpendicular to the player (kiting). */
  protected strafe(ctx: EnemyContext, dt: number, speed: number, dir: number): void {
    const a = this.angleToPlayer(ctx) + (Math.PI / 2) * dir;
    ctx.grid.moveBox(this.pos, Math.sin(a) * speed * dt, Math.cos(a) * speed * dt, this.radius);
  }

  /**
   * Step toward a goal: straight line if visible, otherwise follow the flow
   * field (which always points at the player).
   */
  protected moveToward(ctx: EnemyContext, dt: number, speed: number, away = false): boolean {
    const { player, grid, flow } = ctx;
    let tx = player.pos.x;
    let tz = player.pos.z;
    if (!away && !grid.lineOfSight(this.pos.x, this.pos.z, tx, tz)) {
      const step = flow.nextStep(this.pos.x, this.pos.z);
      if (!step) return false;
      tx = step.x;
      tz = step.z;
    }
    let dx = tx - this.pos.x;
    let dz = tz - this.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return false;
    dx /= len;
    dz /= len;
    if (away) {
      dx = -dx;
      dz = -dz;
    }
    grid.moveBox(this.pos, dx * speed * dt, dz * speed * dt, this.radius);
    this.turnToward(Math.atan2(dx, dz), 10, dt);
    return true;
  }

  /** Walk cycle (or settle to idle): punchy leg swing, counter-swinging arms, a little idle sway. */
  protected animateWalk(dt: number, moving: boolean, rate = 10): void {
    const { legL, legR, armL, armR } = this.model;
    if (moving) this.walkPhase += dt * rate;
    else this.walkPhase *= Math.pow(0.001, dt);
    const raw = Math.sin(this.walkPhase);
    // Sharper than a sine: legs spend less time crossing, more time planted.
    const s = Math.sign(raw) * Math.abs(raw) ** 0.7 * 0.65;
    legL.rotation.x = s;
    legR.rotation.x = -s;
    armL.rotation.x = -s * 0.75;
    armR.rotation.x = s * 0.75;
    const idle = moving ? 0 : 1;
    armL.rotation.z = -0.06 * idle;
    armR.rotation.z = 0.06 * idle;
    this.attackLean *= Math.exp(-8 * dt);
  }
}

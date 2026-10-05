import * as THREE from 'three';
import { Enemy, type EnemyContext } from './enemy';
import { buildHumanoid, onHead, voxelBox } from './voxelModel';
import { ease, span } from './animation';

type State = 'idle' | 'move' | 'channel' | 'cast' | 'recover';

const SPEED = 2.8;
const AGGRO_RANGE = 12;
const MIN_RANGE = 5.5;
const MAX_RANGE = 9;
const HEAL_RADIUS = 6.5;
const HEAL_FRACTION = 0.3;
const HEAL_COOLDOWN = 6;
const CHANNEL = 0.9;
const CAST_TIME = 0.55;
const BOLT_COOLDOWN = 2.6;

const crystalMat = new THREE.MeshBasicMaterial({ color: 0x6fe07a });

/** Support caster: keeps its distance, heals hurt monsters nearby and lobs poison bolts. Kill it first. */
export class Shaman extends Enemy {
  readonly kind = 'shaman';
  readonly xp = 18;
  readonly radius = 0.32;
  protected moveSpeed = SPEED;
  private state: State = 'idle';
  private stateTime = 0;
  private healTimer = 2;
  private boltTimer = 1.5;
  private strafeDir = 1;
  private readonly crystal: THREE.Mesh;
  private readonly healRing: THREE.Mesh;

  constructor() {
    super(
      30,
      buildHumanoid({ skin: 0x6a7a5a, shirt: 0x5a3a2a, pants: 0x3a2a1e, hair: 0x1a1a14, boots: 0x2a1e14, eyes: 0x9bff6a, hairStyle: 'long' }),
      1.85,
    );
    const { head, armR } = this.model;
    const inner = this.model.body.children[0];
    // Bone mask and a feather headdress.
    onHead(head, [0.38, 0.22, 0.04], 0xe8e2d0, [0, 0.0, 0.22]);
    onHead(head, [0.36, 0.04, 0.02], 0x1a1a14, [0, 0.03, 0.245]);
    for (const [x, c] of [
      [-0.16, 0x9b2a2a],
      [-0.05, 0x2a6a9b],
      [0.05, 0xd4a017],
      [0.16, 0x9b2a2a],
    ] as const)
      onHead(head, [0.06, 0.24, 0.03], c, [x, 0.32, -0.12]).rotateZ(x * -1.5);
    // Bead necklace and fur shoulder wrap.
    inner.add(voxelBox([0.36, 0.06, 0.32], 0x8a6a40, [0, 1.06, 0.02]), voxelBox([0.6, 0.12, 0.36], 0x6b5a44, [0, 1.16, 0]));
    // Gnarled staff with a glowing crystal.
    this.crystal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), crystalMat);
    this.crystal.position.set(0, -0.5, 0.95);
    armR.add(voxelBox([0.06, 0.06, 1.15], 0x4a3220, [0, -0.5, 0.3]), voxelBox([0.12, 0.08, 0.08], 0x4a3220, [0, -0.5, 0.82]), this.crystal);
    // Green ring that grows while channelling a heal (world space, so it stays put).
    this.healRing = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 40),
      new THREE.MeshBasicMaterial({ color: 0x6fe07a, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.healRing.rotation.x = -Math.PI / 2;
    this.healRing.visible = false;
    this.worldFx.add(this.healRing);
  }

  /** Allies in range that could use healing (including itself). */
  private hurtAllies(ctx: EnemyContext): Enemy[] {
    return ctx.allies().filter(
      (a) => a.alive && a.hp < a.maxHp * 0.75 && Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z) < HEAL_RADIUS,
    );
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    this.healTimer -= dt;
    this.boltTimer -= dt;
    const dist = this.distanceToPlayer(ctx);
    const sees = this.canSeePlayer(ctx, AGGRO_RANGE + 3);
    const { armL, armR, body } = this.model;
    this.crystal.scale.setScalar(1 + Math.sin(this.stateTime * 6) * 0.12);

    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (this.canSeePlayer(ctx, AGGRO_RANGE)) this.enter('move');
        break;
      case 'move': {
        if (!ctx.player.alive) return this.enter('idle');
        if (this.evadeShots(ctx, dt, SPEED)) {
          this.animateWalk(dt, true, 8);
          break;
        }
        let moved = true;
        if (dist < MIN_RANGE) moved = this.moveToward(ctx, dt, SPEED, true);
        else if (dist > MAX_RANGE || !sees) moved = this.moveToward(ctx, dt, SPEED);
        else {
          if (this.stateTime > 1.5) {
            this.strafeDir = ctx.rng.chance(0.5) ? 1 : -1;
            this.stateTime = 0;
          }
          this.strafe(ctx, dt, SPEED * 0.5, this.strafeDir);
        }
        this.turnToward(this.angleToPlayer(ctx), 6, dt);
        this.animateWalk(dt, moved, 8);
        armR.rotation.x = -0.5;
        if (this.healTimer <= 0 && this.hurtAllies(ctx).length > 0) this.enter('channel');
        else if (sees && this.boltTimer <= 0 && dist < MAX_RANGE + 2) this.enter('cast');
        break;
      }
      case 'channel': {
        // Staff raised high, both arms up, ring swelling out to the heal radius.
        const t = ease.outCubic(span(this.stateTime, 0, CHANNEL));
        armR.rotation.x = -0.5 - 2.4 * t;
        armL.rotation.x = -2.6 * t;
        armL.rotation.z = -0.4 * t;
        this.attackLean = -0.2 * t;
        body.position.y = this.model.bodyBaseY + Math.sin(this.stateTime * 10) * 0.03;
        this.healRing.visible = true;
        this.healRing.position.set(this.pos.x, 0.05, this.pos.z);
        this.healRing.scale.setScalar(HEAL_RADIUS * t);
        if (this.stateTime >= CHANNEL) {
          const targets = this.hurtAllies(ctx).map((a) => {
            const amount = Math.round(a.maxHp * HEAL_FRACTION);
            const before = a.hp;
            a.hp = Math.min(a.maxHp, a.hp + amount);
            return { x: a.pos.x, z: a.pos.z, amount: a.hp - before };
          });
          if (targets.length) ctx.events.emit('enemyHeal', { x: this.pos.x, z: this.pos.z, targets });
          this.healTimer = HEAL_COOLDOWN;
          this.healRing.visible = false;
          this.enter('recover');
        }
        break;
      }
      case 'cast': {
        // Swing the staff forward and loose a poison bolt at the end of the swing.
        this.turnToward(this.angleToPlayer(ctx), 8, dt);
        const back = ease.outBack(span(this.stateTime, 0, CAST_TIME * 0.6));
        const fwd = ease.inCubic(span(this.stateTime, CAST_TIME * 0.6, CAST_TIME));
        armR.rotation.x = -0.5 - 2.2 * back + 2.1 * fwd;
        body.rotation.y = -0.3 * back + 0.5 * fwd;
        this.attackLean = 0.25 * fwd;
        if (this.stateTime >= CAST_TIME) {
          ctx.fireProjectile({
            x: this.pos.x + Math.sin(this.facing) * 0.6,
            z: this.pos.z + Math.cos(this.facing) * 0.6,
            dirX: Math.sin(this.facing),
            dirZ: Math.cos(this.facing),
            speed: 8,
            range: 13,
            attack: { base: 9, power: this.damageMult, critChance: 0, critMultiplier: 1 },
            knockback: 2,
            color: 0x6fe07a,
            orb: true,
          });
          this.boltTimer = BOLT_COOLDOWN + ctx.rng.range(-0.3, 0.5);
          this.enter('recover');
        }
        break;
      }
      case 'recover': {
        const t = ease.inOutSine(span(this.stateTime, 0, 0.5));
        armR.rotation.x *= 1 - t * 0.5;
        armL.rotation.x *= 1 - t * 0.5;
        body.rotation.y *= 1 - t;
        if (this.stateTime >= 0.5) {
          armL.rotation.z = 0;
          this.enter(ctx.player.alive ? 'move' : 'idle');
        }
        break;
      }
    }
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('move');
    if (!this.alive) this.healRing.visible = false;
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'recover') this.expose(0.5);
    if (state !== 'channel') this.healRing.visible = false;
    this.state = state;
    this.stateTime = 0;
  }
}

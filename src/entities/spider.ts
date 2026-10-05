import * as THREE from 'three';
import { Enemy, type EnemyContext } from './enemy';
import { limb, voxelBox, type HumanoidParts } from './voxelModel';
import { ease, span } from './animation';
import { angleDiff } from '../systems/combat';

type State = 'idle' | 'chase' | 'crouch' | 'lunge' | 'recover';

const SPEED = 5.2;
const AGGRO_RANGE = 10;
const LUNGE_RANGE = 2.6;
const CROUCH = 0.32;
const LUNGE_TIME = 0.24;
const LUNGE_SPEED = 11;
const RECOVER = 0.5;

/**
 * Eight-legged body that fills the same slots as a humanoid: the four leg
 * pairs ride on the limb pivots, so the shared walk cycle makes them skitter.
 */
function buildSpider(color: number, scale: number): HumanoidParts {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const inner = new THREE.Group();
  root.add(body);
  body.add(inner);
  body.scale.setScalar(scale);
  const bodyBaseY = 0.75 * scale;
  body.position.y = bodyBaseY;
  inner.position.y = -0.75;
  const dark = new THREE.Color(color).multiplyScalar(0.6).getHex();

  // Abdomen with a red hourglass, and the front body that serves as the head.
  inner.add(voxelBox([0.5, 0.36, 0.56], color, [0, 0.36, -0.3]), voxelBox([0.14, 0.03, 0.2], 0xc0262b, [0, 0.55, -0.3]));
  const head = voxelBox([0.34, 0.26, 0.32], dark, [0, 0.3, 0.12]);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3a3a });
  for (const [x, y] of [
    [-0.08, 0.05],
    [0.08, 0.05],
    [-0.12, -0.02],
    [0.12, -0.02],
  ]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), eyeMat);
    eye.position.set(x, y, 0.165);
    eye.scale.divide(head.scale);
    eye.position.divide(head.scale);
    head.add(eye);
  }
  // Fangs.
  for (const x of [-0.05, 0.05]) {
    const fang = voxelBox([0.04, 0.1, 0.04], 0xe8e2d0, [x, -0.14, 0.15]);
    fang.scale.divide(head.scale);
    fang.position.divide(head.scale);
    head.add(fang);
  }

  /** A pair of legs on one side: upper segment out, lower segment angled down to the floor. */
  const legPair = (side: number, z: number): THREE.Group => {
    const g = limb([0.01, 0.01, 0.01], color, [side * 0.16, 0.36, z]);
    for (const dz of [-0.09, 0.09]) {
      g.add(voxelBox([0.34, 0.05, 0.05], dark, [side * 0.17, 0.08, dz]).rotateZ(side * 0.5));
      g.add(voxelBox([0.05, 0.4, 0.05], dark, [side * 0.38, -0.12, dz * 1.6]).rotateZ(side * -0.25));
    }
    return g;
  };
  const legL = legPair(-1, 0.06);
  const legR = legPair(1, 0.06);
  const armL = legPair(-1, -0.24);
  const armR = legPair(1, -0.24);
  inner.add(head, legL, legR, armL, armR);
  return { root, body, bodyBaseY, head, armL, armR, legL, legR };
}

/** Small, fast pack hunter: skitters in, crouches, then lunges. */
export class Spider extends Enemy {
  readonly kind = 'spider';
  readonly xp = 6;
  readonly radius = 0.28;
  protected moveSpeed = SPEED;
  protected melee = true;
  /** Seconds spent circling, waiting for an opening. */
  private stalk = 0;
  private state: State = 'idle';
  private stateTime = 0;
  private hitDone = false;
  private readonly lungeDir = { x: 0, z: 0 };
  /** Which way it circles while stalking. */
  private readonly flankSide = Math.random() < 0.5 ? 1 : -1;

  constructor() {
    super(14, buildSpider(0x3a3044, 0.9), 1.0);
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    const dist = this.distanceToPlayer(ctx);
    const { body } = this.model;
    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (this.canSeePlayer(ctx, AGGRO_RANGE)) this.enter('chase');
        break;
      case 'chase': {
        if (!ctx.player.alive) return this.enter('idle');
        if (dist < LUNGE_RANGE + 1 && this.canSeePlayer(ctx, LUNGE_RANGE + 1.5)) {
          // Circle just out of reach and pounce on an opening: the hero busy attacking or
          // looking the other way (or after waiting long enough).
          const p = ctx.player;
          const facingAway = Math.abs(angleDiff(p.facing, Math.atan2(this.pos.x - p.pos.x, this.pos.z - p.pos.z))) > 1.3;
          this.stalk += dt;
          if ((p.busy || facingAway || this.stalk > 1.6) && dist < LUNGE_RANGE) {
            this.stalk = 0;
            this.enter('crouch');
            break;
          }
          this.strafe(ctx, dt, SPEED * 0.55, this.flankSide);
          if (dist < LUNGE_RANGE - 0.8) this.moveToward(ctx, dt, SPEED * 0.4, true);
          this.turnToward(this.angleToPlayer(ctx), 10, dt);
          this.animateWalk(dt, true, 20);
          break;
        }
        this.stalk = 0;
        const moved = this.flankToward(ctx, dt, SPEED, LUNGE_RANGE);
        this.animateWalk(dt, moved, 22);
        break;
      }
      case 'crouch': {
        // Telegraph: sink low and rear the front up.
        this.turnToward(this.angleToPlayer(ctx), 10, dt);
        const t = ease.outCubic(span(this.stateTime, 0, CROUCH));
        body.position.y = this.model.bodyBaseY * (1 - 0.35 * t);
        this.attackLean = -0.45 * t;
        this.animateWalk(dt, false);
        if (this.stateTime >= CROUCH) {
          this.lungeDir.x = Math.sin(this.facing);
          this.lungeDir.z = Math.cos(this.facing);
          this.hitDone = false;
          this.motion.impact(-0.8);
          this.enter('lunge');
        }
        break;
      }
      case 'lunge': {
        const t = span(this.stateTime, 0, LUNGE_TIME);
        ctx.grid.moveBox(this.pos, this.lungeDir.x * LUNGE_SPEED * dt, this.lungeDir.z * LUNGE_SPEED * dt, this.radius);
        // Arc through the air.
        body.position.y = this.model.bodyBaseY * (0.65 + 0.9 * Math.sin(t * Math.PI));
        this.attackLean = 0.4;
        const p = ctx.player;
        if (!this.hitDone && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < this.radius + p.radius + 0.2) {
          this.hitDone = true;
          ctx.hitPlayer(this, { base: 7, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 5);
        }
        if (t >= 1) {
          body.position.y = this.model.bodyBaseY;
          this.motion.impact(0.7);
          this.enter('recover');
        }
        break;
      }
      case 'recover':
        // Skitter back a step before the next attempt.
        this.moveToward(ctx, dt, SPEED * 0.4, true);
        this.animateWalk(dt, true, 18);
        if (this.stateTime >= RECOVER) this.enter(ctx.player.alive ? 'chase' : 'idle');
        break;
    }
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('chase');
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'recover') this.expose(0.5);
    this.state = state;
    this.stateTime = 0;
  }
}

import { Enemy, type EnemyContext } from './enemy';
import { buildHumanoid, onHead, voxelBox } from './voxelModel';
import { ease, span } from './animation';

type State = 'idle' | 'move' | 'aim' | 'release';

const SPEED = 3.2;
const AGGRO_RANGE = 12;
const MIN_RANGE = 4.5;
const MAX_RANGE = 9;
const AIM_TIME = 0.65;
const FIRE_INTERVAL = 1.9;

/** Ranged skirmisher: keeps its distance, telegraphs by drawing the bow, fires arrows. */
export class Archer extends Enemy {
  readonly kind = 'archer';
  readonly xp = 14;
  readonly radius = 0.3;
  protected moveSpeed = SPEED;
  private state: State = 'idle';
  private stateTime = 0;
  private fireTimer = 1;
  private strafeDir = 1;

  constructor() {
    super(
      26,
      buildHumanoid({ skin: 0xc9b9a6, shirt: 0x4a3a66, pants: 0x2a2438, hair: 0x2a2438, boots: 0x1c1826, eyes: 0xb48cff, hairStyle: 'bald' }),
      1.75,
    );
    const { head, armL } = this.model;
    const inner = this.model.body.children[0];
    // Peaked hood with a cloth mask over the lower face.
    onHead(head, [0.5, 0.2, 0.5], 0x3a2d52, [0, 0.22, -0.02]);
    onHead(head, [0.06, 0.4, 0.46], 0x3a2d52, [-0.24, 0.02, -0.03]);
    onHead(head, [0.06, 0.4, 0.46], 0x3a2d52, [0.24, 0.02, -0.03]);
    onHead(head, [0.5, 0.42, 0.06], 0x3a2d52, [0, 0.02, -0.24]);
    onHead(head, [0.18, 0.12, 0.12], 0x3a2d52, [0, 0.36, -0.1]);
    onHead(head, [0.44, 0.16, 0.03], 0x1f1830, [0, -0.11, 0.22]);
    // Short cape and a quiver of arrows.
    inner.add(
      voxelBox([0.5, 0.5, 0.04], 0x2f2445, [0, 0.86, -0.18]),
      voxelBox([0.14, 0.46, 0.14], 0x5a3a1e, [0.14, 1.0, -0.23]),
      voxelBox([0.03, 0.12, 0.03], 0xe8e2d0, [0.11, 1.28, -0.23]),
      voxelBox([0.03, 0.12, 0.03], 0xe8e2d0, [0.17, 1.3, -0.21]),
    );
    // Recurve bow: grip, two angled limbs and a string.
    armL.add(
      voxelBox([0.07, 0.24, 0.08], 0x5a2e1a, [0, -0.5, 0.12]),
      voxelBox([0.06, 0.4, 0.06], 0x7a5530, [0, -0.2, 0.2]).rotateX(-0.35),
      voxelBox([0.06, 0.4, 0.06], 0x7a5530, [0, -0.8, 0.2]).rotateX(0.35),
      voxelBox([0.015, 0.95, 0.015], 0xdddddd, [0, -0.5, 0.06]),
    );
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    this.fireTimer -= dt;
    const dist = this.distanceToPlayer(ctx);
    const sees = this.canSeePlayer(ctx, AGGRO_RANGE + 4);

    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (this.canSeePlayer(ctx, AGGRO_RANGE)) this.enter('move');
        break;
      case 'move': {
        if (!ctx.player.alive) return this.enter('idle');
        let moved = true;
        if (this.evadeShots(ctx, dt, SPEED)) {
          this.animateWalk(dt, true);
          break;
        }
        if (dist < MIN_RANGE) moved = this.moveToward(ctx, dt, SPEED, true);
        else if (dist > MAX_RANGE || !sees) moved = this.moveToward(ctx, dt, SPEED);
        else {
          if (this.stateTime > 1.2) {
            this.strafeDir = ctx.rng.chance(0.5) ? 1 : -1;
            this.stateTime = 0;
          }
          this.strafe(ctx, dt, SPEED * 0.5, this.strafeDir);
          this.turnToward(this.angleToPlayer(ctx), 8, dt);
        }
        this.animateWalk(dt, moved);
        if (sees && dist <= MAX_RANGE + 1 && this.fireTimer <= 0) this.enter('aim');
        break;
      }
      case 'aim': {
        // Telegraph: raise the bow, then draw the string back to the cheek.
        this.turnToward(this.angleToPlayer(ctx), 6, dt);
        const { armL, armR, body } = this.model;
        const raise = ease.outCubic(span(this.stateTime, 0, AIM_TIME * 0.35));
        const draw = ease.inOutSine(span(this.stateTime, AIM_TIME * 0.25, AIM_TIME * 0.9));
        armL.rotation.x = -1.55 * raise;
        armR.rotation.x = -1.45 * raise;
        armR.position.z = -0.28 * draw;
        // Side-on stance as the draw tightens, leaning back slightly.
        body.rotation.y = 0.35 * raise;
        this.attackLean = -0.1 * draw;
        if (this.stateTime >= AIM_TIME) {
          ctx.fireProjectile({
            x: this.pos.x + Math.sin(this.facing) * 0.5,
            z: this.pos.z + Math.cos(this.facing) * 0.5,
            dirX: Math.sin(this.facing),
            dirZ: Math.cos(this.facing),
            speed: 12,
            range: 15,
            attack: { base: 8, power: this.damageMult, critChance: 0, critMultiplier: 1 },
            knockback: 3,
          });
          this.fireTimer = FIRE_INTERVAL + ctx.rng.range(-0.3, 0.4);
          this.enter('release');
        }
        break;
      }
      case 'release': {
        // String hand snaps back past the ear, body recoils, then relaxes.
        const { armL, armR, body } = this.model;
        const snap = ease.outCubic(span(this.stateTime, 0, 0.08));
        const relax = ease.inOutSine(span(this.stateTime, 0.12, 0.35));
        armR.position.z = -0.28 - 0.12 * snap + 0.4 * relax;
        armR.rotation.x = -1.45 - 0.3 * snap + 1.75 * relax;
        armL.rotation.x = -1.55 + 0.15 * snap + 1.4 * relax;
        body.rotation.y = 0.35 * (1 - relax);
        this.attackLean = -0.18 * snap * (1 - relax);
        if (this.stateTime > 0.35) {
          armR.position.z = 0;
          body.rotation.y = 0;
          this.enter('move');
        }
        break;
      }
    }
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('move');
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'release') this.expose(0.5);
    this.state = state;
    this.stateTime = 0;
  }
}

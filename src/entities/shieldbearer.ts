import { Enemy, type EnemyContext } from './enemy';
import { buildHumanoid, onHead, voxelBox } from './voxelModel';
import { ease, span } from './animation';

type State = 'idle' | 'advance' | 'windup' | 'bash' | 'recover';

const SPEED = 2.3;
const AGGRO_RANGE = 11;
const BASH_RANGE = 1.8;
const WINDUP = 0.55;
const BASH_TIME = 0.2;
const BASH_SPEED = 8;
const RECOVER = 0.85;
/** Hits arriving within this angle of where the shield faces are blocked. */
const BLOCK_ARC = (65 * Math.PI) / 180;
const BLOCKED_FRACTION = 0.2;

/**
 * Armoured soldier behind a tower shield. Blocks most damage from the front
 * and turns slowly, so flanking it works; it's open while recovering from a bash.
 */
export class Shieldbearer extends Enemy {
  readonly kind = 'shieldbearer';
  readonly xp = 20;
  readonly radius = 0.4;
  protected moveSpeed = SPEED;
  private state: State = 'idle';
  private stateTime = 0;
  private hitDone = false;
  /** Seconds of a fast turn after being hit from behind. */
  private brace = 0;
  protected melee = true;

  constructor() {
    super(
      70,
      buildHumanoid({ skin: 0xc9a07a, shirt: 0x5a6070, pants: 0x3a3f4a, hair: 0x2a2a2a, boots: 0x22252c, hairStyle: 'bald' }, 1.12),
      2.1,
    );
    this.knockbackTaken = 0.5;
    const { head, armL, armR } = this.model;
    const inner = this.model.body.children[0];
    // Great helm with a visor slit and plume.
    onHead(head, [0.48, 0.44, 0.48], 0x8a909c, [0, 0.03, 0]);
    onHead(head, [0.36, 0.05, 0.02], 0x1a1c22, [0, 0.03, 0.245]);
    onHead(head, [0.06, 0.16, 0.34], 0x9b2a2a, [0, 0.32, -0.04]);
    // Breastplate and pauldrons.
    inner.add(voxelBox([0.54, 0.44, 0.34], 0x8a909c, [0, 0.95, 0]), voxelBox([0.12, 0.3, 0.02], 0x9b2a2a, [0, 0.92, 0.175]));
    for (const arm of [armL, armR]) arm.add(voxelBox([0.28, 0.14, 0.3], 0x7a808c, [0, -0.02, 0]));
    // Tower shield on the left arm, short sword in the right.
    armL.add(
      voxelBox([0.62, 0.95, 0.08], 0x6b4524, [0.12, -0.45, 0.24]),
      voxelBox([0.66, 0.06, 0.1], 0x8a909c, [0.12, 0.02, 0.24]),
      voxelBox([0.66, 0.06, 0.1], 0x8a909c, [0.12, -0.92, 0.24]),
      voxelBox([0.18, 0.18, 0.04], 0xd4a017, [0.12, -0.45, 0.29]),
    );
    armR.add(voxelBox([0.06, 0.06, 0.5], 0xcfd6dd, [0, -0.5, 0.32]), voxelBox([0.2, 0.06, 0.06], 0x6b4524, [0, -0.5, 0.06]));
  }

  /** Raised shield: is the hit coming from in front of it? */
  private shieldUp(): boolean {
    return this.alive && this.state !== 'recover' && this.state !== 'idle';
  }

  protected blockArc(): { halfAngle: number; taken: number } | null {
    return this.shieldUp() ? { halfAngle: BLOCK_ARC, taken: BLOCKED_FRACTION } : null;
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    const dist = this.distanceToPlayer(ctx);
    const { armL, armR, body } = this.model;
    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (this.canSeePlayer(ctx, AGGRO_RANGE)) this.enter('advance');
        break;
      case 'advance': {
        if (!ctx.player.alive) return this.enter('idle');
        // Turns slowly: circle around it to get past the shield.
        const moved = dist > BASH_RANGE * 0.8 ? this.moveToward(ctx, dt, SPEED) : false;
        // Turns slowly, unless it was just struck from behind and spins to face it.
        this.brace = Math.max(0, this.brace - dt);
        this.turnToward(this.angleToPlayer(ctx), this.brace > 0 ? 7 : 2.2, dt);
        this.animateWalk(dt, moved, 7);
        // Shield held up in front while walking.
        armL.rotation.x = -1.1;
        armL.rotation.y = 0.5;
        if (dist < BASH_RANGE && Math.abs(this.angleDelta(this.angleToPlayer(ctx))) < 0.5) this.enter('windup');
        break;
      }
      case 'windup': {
        // Draw the shield back and crouch behind it.
        this.turnToward(this.angleToPlayer(ctx), 1.5, dt);
        const t = ease.outBack(span(this.stateTime, 0, WINDUP * 0.8));
        armL.rotation.x = -1.1 + 0.5 * t;
        armL.rotation.y = 0.5 + 0.4 * t;
        body.rotation.y = 0.35 * t;
        this.attackLean = -0.15 * t;
        if (this.stateTime >= WINDUP) {
          this.hitDone = false;
          this.enter('bash');
        }
        break;
      }
      case 'bash': {
        // Drive forward behind the shield.
        const t = span(this.stateTime, 0, BASH_TIME);
        ctx.grid.moveBox(this.pos, Math.sin(this.facing) * BASH_SPEED * dt, Math.cos(this.facing) * BASH_SPEED * dt, this.radius);
        armL.rotation.x = -1.4;
        armL.rotation.y = 0.1;
        body.rotation.y = 0.35 * (1 - t);
        this.attackLean = 0.35;
        const p = ctx.player;
        if (!this.hitDone && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < this.radius + p.radius + 0.45) {
          this.hitDone = true;
          ctx.hitPlayer(this, { base: 12, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 10);
          this.motion.impact(0.5);
        }
        if (t >= 1) this.enter('recover');
        break;
      }
      case 'recover': {
        // Shield lowered, sword arm hanging: the opening.
        const t = ease.inOutSine(span(this.stateTime, 0, RECOVER));
        armL.rotation.x = -0.2 - 0.9 * t;
        armL.rotation.y = 0.5 * t;
        armR.rotation.x = 0.3 * (1 - t);
        this.attackLean = 0.2 * (1 - t);
        this.animateWalk(dt, false);
        armL.rotation.x = -0.2 - 0.9 * t;
        if (this.stateTime >= RECOVER) this.enter(ctx.player.alive ? 'advance' : 'idle');
        break;
      }
    }
  }

  private angleDelta(target: number): number {
    let d = (target - this.facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    // Knocked forward means the blow came from behind: brace and turn.
    const fwd = knockX * Math.sin(this.facing) + knockZ * Math.cos(this.facing);
    if (fwd > 0.5) this.brace = 1.2;
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('advance');
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'recover') this.expose(0.85);
    this.state = state;
    this.stateTime = 0;
  }
}

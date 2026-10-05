import { Enemy, type EnemyContext } from './enemy';
import { buildHumanoid, onHead, shade, voxelBox } from './voxelModel';
import { inArc } from '../systems/combat';
import { ease, span } from './animation';

type State = 'idle' | 'chase' | 'windup' | 'strike' | 'recover';

const SPEED = 3.1;
const AGGRO_RANGE = 11;
const ATTACK_RANGE = 1.35;
const WINDUP = 0.5;
const STRIKE = 0.14;
const RECOVER = 0.65;

/** Melee brute: chases, telegraphs with raised arms, then slams. */
export class Grunt extends Enemy {
  readonly kind = 'grunt';
  readonly xp = 12;
  readonly radius = 0.35;
  protected moveSpeed = SPEED;
  protected melee = true;
  private state: State = 'idle';
  private stateTime = 0;

  constructor() {
    super(
      40,
      buildHumanoid({ skin: 0x6f8f52, shirt: 0x6b4a2e, pants: 0x3c3a2c, hair: 0x2d3a22, boots: 0x231a12, eyes: 0xd8c040, hairStyle: 'bald' }, 1.08),
      1.95,
    );
    const { head, armL, armR } = this.model;
    const inner = this.model.body.children[0];
    // Orc brute: mohawk, heavy brow, tusks, spiked leather pauldron.
    onHead(head, [0.1, 0.14, 0.4], 0x2d3a22, [0, 0.27, -0.02]);
    onHead(head, [0.42, 0.06, 0.06], shade(0x6f8f52, 0.7), [0, 0.09, 0.2]);
    onHead(head, [0.05, 0.1, 0.05], 0xf0ead6, [-0.1, -0.09, 0.23]);
    onHead(head, [0.05, 0.1, 0.05], 0xf0ead6, [0.1, -0.09, 0.23]);
    armL.add(voxelBox([0.28, 0.16, 0.3], 0x4a3220, [0, -0.02, 0]), voxelBox([0.06, 0.1, 0.06], 0xbfbfbf, [0, 0.1, 0]));
    // Loincloth flap and a bone necklace.
    inner.add(voxelBox([0.22, 0.24, 0.04], 0x4a3220, [0, 0.52, 0.16]), voxelBox([0.34, 0.05, 0.05], 0xe8e2d0, [0, 1.06, 0.16]));
    // Club studded with nails.
    armR.add(
      voxelBox([0.08, 0.08, 0.45], 0x5b3b1f, [0, -0.5, 0.2]),
      voxelBox([0.18, 0.18, 0.4], 0x6b4524, [0, -0.5, 0.6]),
      voxelBox([0.24, 0.04, 0.04], 0xbfbfbf, [0, -0.5, 0.55]),
      voxelBox([0.04, 0.24, 0.04], 0xbfbfbf, [0, -0.5, 0.68]),
    );
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    const dist = this.distanceToPlayer(ctx);
    const playerAlive = ctx.player.alive;

    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (playerAlive && dist < AGGRO_RANGE && ctx.grid.lineOfSight(this.pos.x, this.pos.z, ctx.player.pos.x, ctx.player.pos.z))
          this.enter('chase');
        break;
      case 'chase': {
        if (!playerAlive) {
          this.enter('idle');
          break;
        }
        if (dist < ATTACK_RANGE) {
          this.enter('windup');
          break;
        }
        // Badly hurt with a healer nearby: fall back to it and get patched up.
        const healer = this.hp < this.maxHp * 0.3 ? this.nearestHealer(ctx) : null;
        if (healer) {
          const hx = healer.pos.x - this.pos.x;
          const hz = healer.pos.z - this.pos.z;
          const hd = Math.hypot(hx, hz);
          if (hd > 2) {
            ctx.grid.moveBox(this.pos, (hx / hd) * SPEED * dt, (hz / hd) * SPEED * dt, this.radius);
            this.turnToward(Math.atan2(hx, hz), 8, dt);
          }
          this.animateWalk(dt, hd > 2);
          break;
        }
        const moved = this.flankToward(ctx, dt, SPEED, ATTACK_RANGE);
        this.animateWalk(dt, moved);
        break;
      }
      case 'windup': {
        // Track the player slowly during the telegraph so it can be sidestepped.
        this.turnToward(this.angleToPlayer(ctx), 3, dt);
        // Cock the club back over the shoulder, twist and rear back; the off hand reaches forward.
        const t = ease.outBack(span(this.stateTime, 0, WINDUP * 0.7));
        const { armL, armR, body } = this.model;
        armR.rotation.x = -3.0 * t;
        armR.rotation.z = 0.35 * t;
        armL.rotation.x = -0.9 * t;
        body.rotation.y = -0.45 * t;
        this.attackLean = -0.22 * t;
        // A little tremble right before the swing.
        if (this.stateTime > WINDUP * 0.75) body.rotation.y += Math.sin(this.stateTime * 60) * 0.03;
        if (this.stateTime >= WINDUP) this.enter('strike');
        break;
      }
      case 'strike': {
        // Fast overhead slam that follows through past horizontal, lunging into it.
        const t = ease.inCubic(span(this.stateTime, 0, STRIKE));
        const { armL, armR, body } = this.model;
        armR.rotation.x = -3.0 + 3.5 * t;
        armR.rotation.z = 0.35 * (1 - t);
        armL.rotation.x = -0.9 + 1.2 * t;
        body.rotation.y = -0.45 + 0.75 * t;
        this.attackLean = -0.22 + 0.55 * t;
        if (this.stateTime >= STRIKE) {
          this.motion.impact(0.6);
          const p = ctx.player;
          if (inArc(this.pos.x, this.pos.z, this.facing, p.pos.x, p.pos.z, ATTACK_RANGE + 0.35, Math.PI * 0.6, p.radius)) {
            ctx.hitPlayer(this, { base: 10, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 6);
          }
          this.enter('recover');
        }
        break;
      }
      case 'recover': {
        // Heave the club back up and settle.
        const t = ease.inOutSine(span(this.stateTime, 0, RECOVER));
        const { armL, armR, body } = this.model;
        armR.rotation.x = 0.5 * (1 - t);
        armL.rotation.x = 0.3 * (1 - t);
        body.rotation.y = 0.3 * (1 - t);
        this.attackLean = 0.33 * (1 - t);
        if (this.stateTime >= RECOVER) {
          armR.rotation.z = 0;
          body.rotation.y = 0;
          this.enter(playerAlive ? 'chase' : 'idle');
        }
        break;
      }
    }
  }

  /** A living shaman within reach to fall back to. */
  private nearestHealer(ctx: EnemyContext): Enemy | null {
    let best: Enemy | null = null;
    let bestD = 14;
    for (const a of ctx.allies()) {
      if (a.kind !== 'shaman' || !a.alive) continue;
      const d = Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** Taking damage always wakes it up. */
  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('chase');
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'recover') this.expose(0.7);
    this.state = state;
    this.stateTime = 0;
  }
}

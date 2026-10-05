import * as THREE from 'three';
import { Enemy, type EnemyContext } from './enemy';
import { buildHumanoid, onHead, voxelBox } from './voxelModel';
import { ease, span } from './animation';

type State = 'idle' | 'drift' | 'fadeOut' | 'fadeIn' | 'slash' | 'retreat';

const SPEED = 3.3;
const AGGRO_RANGE = 12;
const BLINK_RANGE = 7;
const BLINK_COOLDOWN = 3.5;
const FADE = 0.3;
const SLASH_WINDUP = 0.38;
const SLASH = 0.12;
const RETREAT = 1.1;
const HOVER = 0.35;

/** Floating, see-through ghost: drifts in, blinks behind you, slashes, then backs off. */
export class Wraith extends Enemy {
  readonly kind = 'wraith';
  readonly xp = 22;
  readonly radius = 0.34;
  protected moveSpeed = SPEED;
  private state: State = 'idle';
  private stateTime = 0;
  private blinkTimer = 1.5;
  private material: THREE.MeshLambertMaterial | null = null;

  constructor() {
    super(
      32,
      buildHumanoid({ skin: 0x9fb4c8, shirt: 0x2a3a4a, pants: 0x2a3a4a, hair: 0x1a2430, boots: 0x2a3a4a, eyes: 0x7ff0ff, hairStyle: 'bald' }),
      2.0,
    );
    const { head, armL, armR, legL, legR } = this.model;
    const inner = this.model.body.children[0];
    // No feet: a tattered robe that trails off into tatters.
    legL.visible = legR.visible = false;
    inner.add(
      voxelBox([0.56, 0.5, 0.38], 0x2a3a4a, [0, 0.45, 0]),
      voxelBox([0.16, 0.24, 0.12], 0x23303c, [-0.18, 0.12, 0.08]),
      voxelBox([0.14, 0.32, 0.12], 0x23303c, [0.06, 0.08, -0.06]),
      voxelBox([0.14, 0.2, 0.12], 0x23303c, [0.2, 0.15, 0.1]),
    );
    // Deep hood shadowing the face.
    onHead(head, [0.5, 0.18, 0.5], 0x1e2a36, [0, 0.22, -0.02]);
    onHead(head, [0.06, 0.42, 0.46], 0x1e2a36, [-0.24, 0.02, -0.02]);
    onHead(head, [0.06, 0.42, 0.46], 0x1e2a36, [0.24, 0.02, -0.02]);
    onHead(head, [0.5, 0.42, 0.06], 0x1e2a36, [0, 0.02, -0.24]);
    // Long spectral claws.
    for (const arm of [armL, armR]) {
      for (const x of [-0.05, 0, 0.05]) arm.add(voxelBox([0.025, 0.025, 0.28], 0xcfe8ff, [x, -0.56, 0.12]));
    }
  }

  /** Swap in a translucent copy of the merged material so only this ghost fades. */
  compact(): void {
    super.compact();
    if (this.material) return;
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshLambertMaterial)) return;
      if (!this.material) {
        this.material = mesh.material.clone();
        this.material.transparent = true;
        this.material.opacity = 0.72;
        this.material.depthWrite = false;
      }
      if (mesh.material.vertexColors) mesh.material = this.material;
    });
  }

  private setOpacity(o: number): void {
    if (this.material) this.material.opacity = 0.72 * o;
  }

  protected think(dt: number, ctx: EnemyContext): void {
    this.stateTime += dt;
    this.blinkTimer -= dt;
    const dist = this.distanceToPlayer(ctx);
    const { armL, armR, body } = this.model;
    // Hover and sway; arms trail behind while drifting.
    body.position.y = this.model.bodyBaseY + HOVER + Math.sin(this.stateTime * 2.6 + this.pos.x) * 0.08;

    switch (this.state) {
      case 'idle':
        this.animateWalk(dt, false);
        if (this.canSeePlayer(ctx, AGGRO_RANGE)) this.enter('drift');
        break;
      case 'drift': {
        if (!ctx.player.alive) return this.enter('idle');
        const moved = this.evadeShots(ctx, dt, SPEED) || this.moveToward(ctx, dt, SPEED);
        this.animateWalk(dt, false);
        armL.rotation.x = armR.rotation.x = moved ? 0.6 : 0.2;
        this.attackLean = moved ? 0.3 : 0;
        if (this.blinkTimer <= 0 && dist < BLINK_RANGE && this.canSeePlayer(ctx, BLINK_RANGE)) {
          ctx.events.emit('teleport', { ...this.pos });
          this.enter('fadeOut');
        } else if (dist < 1.4) this.enter('slash');
        break;
      }
      case 'fadeOut': {
        const t = span(this.stateTime, 0, FADE);
        this.setOpacity(1 - t);
        this.model.root.scale.set(1 - 0.5 * t, 1 + 0.5 * t, 1 - 0.5 * t);
        if (t >= 1) {
          this.blinkBehind(ctx);
          ctx.events.emit('teleport', { ...this.pos });
          this.enter('fadeIn');
        }
        break;
      }
      case 'fadeIn': {
        const t = span(this.stateTime, 0, FADE);
        this.setOpacity(t);
        this.model.root.scale.set(0.5 + 0.5 * t, 1.5 - 0.5 * t, 0.5 + 0.5 * t);
        this.turnToward(this.angleToPlayer(ctx), 20, dt);
        if (t >= 1) {
          this.model.root.scale.setScalar(1);
          this.blinkTimer = BLINK_COOLDOWN;
          this.enter('slash');
        }
        break;
      }
      case 'slash': {
        // Rear back with both claws, then rake down and forward.
        this.turnToward(this.angleToPlayer(ctx), 6, dt);
        const up = ease.outBack(span(this.stateTime, 0, SLASH_WINDUP));
        const down = ease.inCubic(span(this.stateTime, SLASH_WINDUP, SLASH_WINDUP + SLASH));
        armL.rotation.x = armR.rotation.x = -2.8 * up + 3.4 * down;
        armL.rotation.z = -0.5 * up * (1 - down);
        armR.rotation.z = 0.5 * up * (1 - down);
        this.attackLean = -0.25 * up + 0.6 * down;
        if (this.stateTime >= SLASH_WINDUP + SLASH) {
          const p = ctx.player;
          if (Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < 1.7 + p.radius) {
            ctx.hitPlayer(this, { base: 11, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 6);
          }
          this.enter('retreat');
        }
        break;
      }
      case 'retreat': {
        this.moveToward(ctx, dt, SPEED * 0.8, true);
        const t = ease.inOutSine(span(this.stateTime, 0, 0.4));
        armL.rotation.x = armR.rotation.x = 0.6 * (1 - t) + 0.6 * t;
        armL.rotation.z = armR.rotation.z = 0;
        this.attackLean = -0.2;
        if (this.stateTime >= RETREAT) this.enter(ctx.player.alive ? 'drift' : 'idle');
        break;
      }
    }
  }

  /** Reappear on open floor just behind the player. */
  private blinkBehind(ctx: EnemyContext): void {
    const p = ctx.player;
    for (const off of [Math.PI, Math.PI * 0.7, Math.PI * 1.3, Math.PI / 2, -Math.PI / 2]) {
      const a = p.facing + off;
      const x = p.pos.x + Math.sin(a) * 1.6;
      const z = p.pos.z + Math.cos(a) * 1.6;
      if (ctx.grid.isWalkableAt(x, z) && ctx.grid.isWalkableAt(x + 0.3, z) && ctx.grid.isWalkableAt(x - 0.3, z)) {
        this.setPosition(x, z);
        return;
      }
    }
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    // Can't be hit while it's mostly faded out.
    if (this.state === 'fadeOut' && this.stateTime > FADE * 0.5) return false;
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit && this.state === 'idle') this.enter('drift');
    if (!this.alive) {
      this.setOpacity(1);
      this.model.root.scale.setScalar(1);
    }
    return hit;
  }

  private enter(state: State): void {
    // Off balance after attacking: a window to punish.
    if (state === 'retreat') this.expose(0.6);
    if (state !== 'fadeOut' && state !== 'fadeIn') this.setOpacity(1);
    this.state = state;
    this.stateTime = 0;
  }
}

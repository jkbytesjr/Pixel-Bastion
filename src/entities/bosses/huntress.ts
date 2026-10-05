import * as THREE from 'three';
import type { EnemyContext } from '../enemy';
import { Boss, telegraphMaterial } from '../boss';
import { buildHumanoid, onHead, voxelBox } from '../voxelModel';

type State = 'move' | 'fanAim' | 'rapid' | 'dash' | 'recover';

const FAN_RANGE = 15;
const FAN_SPREAD = (55 * Math.PI) / 180;
const FAN_AIM = 0.75;
const RAPID_GAP = 0.26;
const DASH_TIME = 0.3;
const DASH_SPEED = 15;
const ARROW = { speed: 14, range: FAN_RANGE, base: 11, color: 0x9be34a };

/** Agile archer: keeps her distance, fires telegraphed arrow fans and rapid shots, dashes away when cornered. */
export class Huntress extends Boss {
  readonly bossKind = 'huntress';
  readonly radius = 0.55;
  private state: State = 'move';
  private attackCooldown = 1.2;
  private dashCooldown = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private shotsLeft = 0;
  private recoverTime = 0.6;
  private readonly dashDir = { x: 0, z: 0 };
  private readonly fanCone: THREE.Mesh;

  constructor(depth: number) {
    super(
      'Vesh the Thornhuntress',
      depth,
      300,
      buildHumanoid({ skin: 0xd9b38c, shirt: 0x2f5a2a, pants: 0x24331f, hair: 0x7a4a1c, boots: 0x1f1a12 }, 1.6),
      3.2,
    );
    this.addEyes(0xc8ff5a);
    const { head, armL, armR } = this.model;
    const inner = this.model.body.children[0];
    // Antler crown, war paint and a leaf cloak.
    for (const side of [-1, 1]) {
      onHead(head, [0.05, 0.26, 0.05], 0xd9c7a0, [side * 0.14, 0.32, -0.02]).rotateZ(-side * 0.4);
      onHead(head, [0.04, 0.12, 0.04], 0xd9c7a0, [side * 0.24, 0.42, -0.02]).rotateZ(side * 0.5);
      onHead(head, [0.04, 0.1, 0.04], 0xd9c7a0, [side * 0.12, 0.44, 0.02]);
      onHead(head, [0.04, 0.12, 0.02], 0x9be34a, [side * 0.12, -0.04, 0.215]);
    }
    inner.add(
      voxelBox([0.56, 0.7, 0.05], 0x24452a, [0, 0.85, -0.2]),
      voxelBox([0.16, 0.5, 0.14], 0x5a3a1e, [0.12, 1.0, -0.26]),
      voxelBox([0.04, 0.14, 0.04], 0x9be34a, [0.09, 1.3, -0.26]),
      voxelBox([0.04, 0.14, 0.04], 0x9be34a, [0.15, 1.32, -0.24]),
    );
    for (const arm of [armL, armR]) arm.add(voxelBox([0.26, 0.1, 0.28], 0x3f7a2a, [0, -0.02, 0]).rotateZ(arm === armL ? 0.2 : -0.2));
    this.model.armL.add(
      voxelBox([0.06, 0.06, 1.1], 0x5a2e1a, [0, -0.5, 0.06]),
      voxelBox([0.06, 0.14, 0.08], 0x9be34a, [0, -0.43, 0.6]),
      voxelBox([0.06, 0.14, 0.08], 0x9be34a, [0, -0.43, -0.48]),
    );
    // Wedge-shaped warning in front of her: the arc the fan will cover.
    this.fanCone = new THREE.Mesh(
      new THREE.CircleGeometry(FAN_RANGE * 0.6, 24, -Math.PI / 2 - FAN_SPREAD / 2, FAN_SPREAD),
      telegraphMaterial,
    );
    this.fanCone.rotation.x = -Math.PI / 2;
    this.fanCone.position.y = 0.03;
    this.fanCone.visible = false;
    this.model.root.add(this.fanCone);
    this.powers.push(
      {
        // A volley falls around every hero: marked circles, a moment to step clear.
        name: 'Arrow Rain',
        cooldown: 7,
        minPhase: 1,
        cast: 0.7,
        timer: 2.5,
        run: (ctx) => {
          for (const h of this.heroTargets(ctx)) {
            this.hazard(ctx, { k: 'circle', x: h.pos.x, z: h.pos.z, r: 1.4, delay: 1.0, base: 14, knock: 4 });
            for (let i = 0; i < 5; i++) {
              const a = ctx.rng.range(0, Math.PI * 2);
              const d = ctx.rng.range(1.5, 3.5);
              const x = h.pos.x + Math.sin(a) * d;
              const z = h.pos.z + Math.cos(a) * d;
              if (ctx.grid.isWalkableAt(x, z)) this.hazard(ctx, { k: 'circle', x, z, r: 1.4, delay: 1.1 + i * 0.12, base: 14, knock: 4 });
            }
          }
        },
      },
      {
        // Enraged: vanishes and reappears behind her target, a spinning slash marked around her.
        name: 'Shadow Step',
        cooldown: 9,
        minPhase: 2,
        cast: 0.5,
        timer: 1.5,
        run: (ctx) => {
          const p = ctx.player;
          let x = p.pos.x - Math.sin(p.facing) * 1.8;
          let z = p.pos.z - Math.cos(p.facing) * 1.8;
          if (!ctx.grid.isWalkableAt(x, z)) {
            x = p.pos.x;
            z = p.pos.z;
          }
          ctx.events.emit('teleport', { ...this.pos });
          this.setPosition(x, z);
          this.facing = Math.atan2(p.pos.x - x, p.pos.z - z);
          ctx.events.emit('teleport', { x, z });
          this.hazard(ctx, { k: 'circle', x, z, r: 2.2, delay: 0.9, base: 24, knock: 8 });
        },
      },
    );
  }

  protected fight(dt: number, ctx: EnemyContext): void {
    this.attackCooldown -= dt;
    this.dashCooldown -= dt;
    const dist = this.distanceToPlayer(ctx);
    const pace = this.pace;
    const p = ctx.player;
    const sees = ctx.grid.lineOfSight(this.pos.x, this.pos.z, p.pos.x, p.pos.z);

    switch (this.state) {
      case 'move': {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = ctx.rng.range(1, 2);
          this.strafeDir = ctx.rng.chance(0.5) ? 1 : -1;
        }
        const speed = 3.4 * pace;
        if (dist < 4.5) this.moveToward(ctx, dt, speed, true);
        else if (dist > 9 || !sees) this.moveToward(ctx, dt, speed);
        else this.strafe(ctx, dt, speed * 0.8, this.strafeDir);
        this.turnToward(this.angleToPlayer(ctx), 8, dt);
        this.animateWalk(dt, true, 11);
        this.model.armL.rotation.x = -0.6;
        if (dist < 3.2 && this.dashCooldown <= 0) this.startDash(ctx);
        else if (this.attackCooldown <= 0 && sees) {
          if (this.tryPower(ctx)) this.attackCooldown = 1;
          else if (ctx.rng.chance(0.55)) this.enter('fanAim');
          else {
            this.shotsLeft = this.enraged ? 5 : 3;
            this.enter('rapid');
          }
        }
        break;
      }
      case 'fanAim': {
        this.turnToward(this.angleToPlayer(ctx), 3, dt);
        this.fanCone.visible = true;
        this.drawPose(Math.min(1, this.stateTime / (FAN_AIM / pace)));
        if (this.stateTime >= FAN_AIM / pace) {
          const n = this.enraged ? 9 : 6;
          for (let i = 0; i < n; i++) this.shoot(ctx, this.facing + (i / (n - 1) - 0.5) * FAN_SPREAD, ARROW);
          this.recover(0.7);
        }
        break;
      }
      case 'rapid': {
        // Quick aimed shots, re-aiming between each.
        this.turnToward(this.angleToPlayer(ctx), 12, dt);
        this.drawPose(Math.min(1, this.stateTime / RAPID_GAP));
        if (this.stateTime >= RAPID_GAP / pace) {
          this.shoot(ctx, this.angleToPlayer(ctx), { ...ARROW, speed: 17 });
          this.shotsLeft--;
          this.stateTime = 0;
          if (this.shotsLeft <= 0) this.recover(0.6);
        }
        break;
      }
      case 'dash': {
        const t = this.stateTime / DASH_TIME;
        ctx.grid.moveBox(this.pos, this.dashDir.x * DASH_SPEED * dt * (1 - 0.5 * t), this.dashDir.z * DASH_SPEED * dt * (1 - 0.5 * t), this.radius);
        this.model.body.rotation.x = 0.4;
        if (t >= 1) {
          this.model.body.rotation.x = 0;
          // Punish chasers: snap off a shot right after landing.
          this.shoot(ctx, this.angleToPlayer(ctx), { ...ARROW, speed: 17 });
          this.recover(0.3);
        }
        break;
      }
      case 'recover': {
        this.model.armR.rotation.x *= 0.85;
        this.model.armL.rotation.x = -0.6;
        if (this.stateTime >= this.recoverTime) this.enter('move');
        break;
      }
    }
  }

  private startDash(ctx: EnemyContext): void {
    // Away from the player, veering to one side.
    const a = this.angleToPlayer(ctx) + Math.PI + ctx.rng.range(-0.9, 0.9);
    this.dashDir.x = Math.sin(a);
    this.dashDir.z = Math.cos(a);
    this.dashCooldown = this.enraged ? 2.5 : 4;
    ctx.events.emit('dodge', { ...this.pos });
    this.enter('dash');
  }

  private drawPose(t: number): void {
    this.model.armL.rotation.x = -Math.PI / 2;
    this.model.armR.rotation.x = -Math.PI / 2 * t;
  }

  private recover(time: number): void {
    // The recovery after every attack is the boss's vulnerable window.
    this.expose(time);
    this.recoverTime = time;
    this.attackCooldown = this.enraged ? 0.7 : 1.3;
    this.enter('recover');
  }

  protected idle(): void {
    if (this.state !== 'move') this.enter('move');
  }

  protected hideTelegraphs(): void {
    this.fanCone.visible = false;
  }

  private enter(state: State): void {
    this.hideTelegraphs();
    this.state = state;
    this.stateTime = 0;
  }
}

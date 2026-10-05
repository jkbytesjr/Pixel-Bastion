import * as THREE from 'three';
import type { EnemyContext } from '../enemy';
import { Boss, groundCircle, telegraphMaterial } from '../boss';
import { buildHumanoid, onHead, voxelBox } from '../voxelModel';

type State = 'walk' | 'slamWindup' | 'slam' | 'chargeWindup' | 'charge' | 'summon' | 'recover';

const SLAM_WINDUP = 0.9;
const SLAM_RADIUS = 2.7;
const SLAM_REACH = 1.9;
const CHARGE_WINDUP = 0.75;
const CHARGE_SPEED = 11;
const CHARGE_TIME = 0.85;
const CHARGE_LENGTH = CHARGE_SPEED * CHARGE_TIME;
const SUMMON_TIME = 1.0;
const SUMMON_INTERVAL = 11;

/** Stone brute: telegraphed ground slam and charge; below half HP, summons adds and speeds up. */
export class Colossus extends Boss {
  readonly bossKind = 'colossus';
  readonly radius = 0.8;
  private state: State = 'walk';
  private attackCooldown = 1.5;
  private summonTimer = 4;
  private chargeHit = false;
  private recoverTime = 1;
  private readonly slamRing: THREE.Mesh;
  private readonly chargeLane: THREE.Mesh;

  constructor(depth: number) {
    super(
      'The Ashen Colossus',
      depth,
      380,
      buildHumanoid({ skin: 0x4c4b55, shirt: 0x2c2b33, pants: 0x232229, hair: 0x18171c, boots: 0x141317 }, 2.1),
      4.0,
    );
    this.addEyes(0xff8a2a);
    const { head, armL, armR } = this.model;
    const inner = this.model.body.children[0];
    // Curling horns and a stone jaw.
    onHead(head, [0.08, 0.2, 0.08], 0xd8cfb8, [-0.2, 0.26, 0.02]).rotateZ(0.5);
    onHead(head, [0.08, 0.2, 0.08], 0xd8cfb8, [0.2, 0.26, 0.02]).rotateZ(-0.5);
    onHead(head, [0.06, 0.1, 0.06], 0xd8cfb8, [-0.29, 0.37, 0.02]).rotateZ(-0.4);
    onHead(head, [0.06, 0.1, 0.06], 0xd8cfb8, [0.29, 0.37, 0.02]).rotateZ(0.4);
    onHead(head, [0.36, 0.1, 0.06], 0x3a3940, [0, -0.15, 0.21]);
    // Spiked shoulder plates.
    for (const [arm, side] of [
      [armL, -1],
      [armR, 1],
    ] as const) {
      arm.add(voxelBox([0.3, 0.16, 0.32], 0x6e6a74, [0, -0.02, 0]));
      arm.add(voxelBox([0.06, 0.16, 0.06], 0xbfbfbf, [side * 0.06, 0.12, 0]), voxelBox([0.06, 0.12, 0.06], 0xbfbfbf, [side * 0.06, 0.08, 0.1]));
    }
    // Molten crack in the chest, and a chain belt.
    const ember = new THREE.MeshBasicMaterial({ color: 0xff7a1a });
    for (const [w, h, x, y] of [
      [0.06, 0.22, -0.04, 0.92],
      [0.14, 0.05, 0.03, 1.02],
      [0.05, 0.12, 0.08, 0.84],
    ]) {
      const crack = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), ember);
      crack.position.set(x, y, 0.16);
      inner.add(crack);
    }
    inner.add(voxelBox([0.54, 0.09, 0.34], 0x77777f, [0, 0.66, 0]));
    // Banded stone maul.
    armR.add(
      voxelBox([0.07, 0.07, 1.0], 0x4a3220, [0, -0.5, 0.42]),
      voxelBox([0.36, 0.3, 0.34], 0x77777f, [0, -0.5, 0.9]),
      voxelBox([0.38, 0.06, 0.36], 0x4a4a52, [0, -0.5, 0.78]),
      voxelBox([0.38, 0.06, 0.36], 0x4a4a52, [0, -0.5, 1.02]),
    );

    this.slamRing = groundCircle();
    this.slamRing.position.z = SLAM_REACH;
    this.chargeLane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, CHARGE_LENGTH), telegraphMaterial);
    this.chargeLane.rotation.x = -Math.PI / 2;
    this.chargeLane.position.set(0, 0.03, CHARGE_LENGTH / 2);
    this.chargeLane.visible = false;
    this.model.root.add(this.slamRing, this.chargeLane);
    this.powers.push(
      {
        // Enraged: stamps the ground and sends three shockwaves rolling out; roll through them.
        name: 'Earthquake',
        cooldown: 10,
        minPhase: 2,
        cast: 1.0,
        timer: 2,
        run: (ctx) => {
          for (let i = 0; i < 3; i++) this.hazard(ctx, { k: 'ring', x: this.pos.x, z: this.pos.z, r: 11, speed: 6.5, delay: 0.5 + i * 0.8, base: 18, knock: 9 });
        },
      },
      {
        // Hurls boulders at every hero: get out of the marked circle.
        name: 'Boulder Toss',
        cooldown: 6.5,
        minPhase: 1,
        cast: 0.8,
        timer: 3,
        run: (ctx) => {
          for (const h of this.heroTargets(ctx)) this.hazard(ctx, { k: 'circle', x: h.pos.x, z: h.pos.z, r: 1.9, delay: 1.15, base: 26, knock: 10 });
        },
      },
    );
  }

  protected fight(dt: number, ctx: EnemyContext): void {
    this.attackCooldown -= dt;
    const dist = this.distanceToPlayer(ctx);
    const pace = this.pace;
    if (this.enraged) this.summonTimer -= dt;

    switch (this.state) {
      case 'walk': {
        const moved = dist > 1.6 ? this.moveToward(ctx, dt, 2.6 * pace) : false;
        if (!moved) this.turnToward(this.angleToPlayer(ctx), 4, dt);
        this.animateWalk(dt, moved, 6);
        if (this.attackCooldown > 0) break;
        if (this.tryPower(ctx)) {
          this.attackCooldown = 1;
          break;
        }
        if (this.enraged && this.summonTimer <= 0) this.enter('summon');
        else if (dist < 3.6) this.enter('slamWindup');
        else if (dist < 12 && ctx.grid.lineOfSight(this.pos.x, this.pos.z, ctx.player.pos.x, ctx.player.pos.z))
          this.enter('chargeWindup');
        break;
      }
      case 'slamWindup': {
        this.turnToward(this.angleToPlayer(ctx), 2.5, dt);
        const t = Math.min(1, this.stateTime / (SLAM_WINDUP / pace));
        this.model.armL.rotation.x = this.model.armR.rotation.x = -2.9 * Math.min(1, t * 1.5);
        this.model.body.rotation.x = -0.25 * t;
        this.slamRing.visible = true;
        this.slamRing.scale.setScalar(SLAM_RADIUS * (0.3 + 0.7 * t));
        if (t >= 1) {
          const cx = this.pos.x + Math.sin(this.facing) * SLAM_REACH;
          const cz = this.pos.z + Math.cos(this.facing) * SLAM_REACH;
          const p = ctx.player;
          if (Math.hypot(p.pos.x - cx, p.pos.z - cz) < SLAM_RADIUS + p.radius) {
            ctx.hitPlayer(this, { base: 24, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 11);
          }
          ctx.events.emit('slam', { x: cx, z: cz, radius: SLAM_RADIUS });
          this.enter('slam');
        }
        break;
      }
      case 'slam': {
        const t = Math.min(1, this.stateTime / 0.12);
        this.model.armL.rotation.x = this.model.armR.rotation.x = -2.9 + 2.6 * t;
        this.model.body.rotation.x = 0.3 * t;
        if (this.stateTime > 0.12) this.recover(1.0 / pace);
        break;
      }
      case 'chargeWindup': {
        this.turnToward(this.angleToPlayer(ctx), 3.5, dt);
        this.chargeLane.visible = true;
        this.model.body.rotation.x = -0.3 * Math.min(1, this.stateTime / CHARGE_WINDUP);
        if (this.stateTime >= CHARGE_WINDUP / pace) {
          this.chargeHit = false;
          this.enter('charge');
        }
        break;
      }
      case 'charge': {
        this.model.body.rotation.x = 0.35;
        const bx = this.pos.x;
        const bz = this.pos.z;
        const dx = Math.sin(this.facing) * CHARGE_SPEED * dt;
        const dz = Math.cos(this.facing) * CHARGE_SPEED * dt;
        ctx.grid.moveBox(this.pos, dx, dz, this.radius);
        this.animateWalk(dt, true, 18);
        const blocked = Math.hypot(this.pos.x - bx, this.pos.z - bz) < Math.hypot(dx, dz) * 0.3;
        const p = ctx.player;
        if (!this.chargeHit && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < this.radius + p.radius + 0.25) {
          this.chargeHit = true;
          ctx.hitPlayer(this, { base: 20, power: this.damageMult, critChance: 0, critMultiplier: 1 }, 13);
        }
        if (blocked) ctx.events.emit('slam', { x: this.pos.x, z: this.pos.z, radius: 1.5 });
        if (blocked || this.stateTime >= CHARGE_TIME) this.recover(blocked ? 1.6 : 1.0);
        break;
      }
      case 'summon': {
        const t = Math.min(1, this.stateTime / SUMMON_TIME);
        this.model.armL.rotation.x = this.model.armR.rotation.x = -3.0 * Math.sin(t * Math.PI);
        if (this.stateTime >= SUMMON_TIME) {
          this.summon(ctx, [ctx.rng.chance(0.6) ? 'grunt' : 'exploder', ctx.rng.chance(0.6) ? 'grunt' : 'exploder']);
          this.summonTimer = SUMMON_INTERVAL;
          this.recover(0.6);
        }
        break;
      }
      case 'recover': {
        // Vulnerable window after every attack.
        const ease = Math.max(0, 1 - Math.min(1, this.stateTime / 0.4));
        this.model.armL.rotation.x = this.model.armR.rotation.x = this.model.armR.rotation.x * ease;
        this.model.body.rotation.x *= ease;
        if (this.stateTime >= this.recoverTime) this.enter('walk');
        break;
      }
    }
  }

  protected idle(): void {
    if (this.state !== 'walk') this.enter('walk');
  }

  protected hideTelegraphs(): void {
    this.slamRing.visible = false;
    this.chargeLane.visible = false;
  }

  private recover(time: number): void {
    // The recovery after every attack is the boss's vulnerable window.
    this.expose(time);
    this.recoverTime = time;
    this.attackCooldown = this.enraged ? 0.6 : 1.1;
    this.enter('recover');
  }

  private enter(state: State): void {
    this.hideTelegraphs();
    this.state = state;
    this.stateTime = 0;
  }
}

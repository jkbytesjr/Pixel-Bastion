import * as THREE from 'three';
import type { EnemyContext } from '../enemy';
import { Boss, groundCircle } from '../boss';
import { buildHumanoid, onHead, voxelBox } from '../voxelModel';

type State = 'drift' | 'bolts' | 'ringWindup' | 'blinkOut' | 'blinkIn' | 'summon' | 'recover';

const BOLT = { speed: 7.5, range: 15, base: 12, color: 0xb07cff, orb: true };
const BOLT_GAP = 0.38;
const RING_WINDUP = 0.7;
const BLINK_TIME = 0.3;
const SUMMON_TIME = 1.1;

/** Caster who keeps raising minions, teleports away when approached, and fills the room with bolts. */
export class Necromancer extends Boss {
  readonly bossKind = 'necromancer';
  readonly radius = 0.55;
  private state: State = 'drift';
  private attackCooldown = 1.0;
  private blinkCooldown = 0;
  private summonTimer = 5;
  private volleysLeft = 0;
  private recoverTime = 0.6;
  private ringWaves = 0;
  private readonly ringMark: THREE.Mesh;
  private readonly skull: THREE.Mesh;

  constructor(depth: number) {
    super(
      'The Hollow Lich',
      depth,
      360,
      buildHumanoid({ skin: 0xbfc6b8, shirt: 0x2a1f3a, pants: 0x1f1729, hair: 0x0f0c14, boots: 0x120e18 }, 1.75),
      3.4,
    );
    this.addEyes(0xd18bff);
    const inner = this.model.body.children[0];
    // Hood, long robe and a skull-topped staff.
    inner.add(
      voxelBox([0.5, 0.24, 0.5], 0x1a1326, [0, 1.56, -0.03]),
      voxelBox([0.05, 0.36, 0.42], 0x1a1326, [-0.25, 1.38, -0.04]),
      voxelBox([0.05, 0.36, 0.42], 0x1a1326, [0.25, 1.38, -0.04]),
      voxelBox([0.56, 0.5, 0.36], 0x1f1729, [0, 0.4, 0]),
    );
    this.skull = voxelBox([0.2, 0.2, 0.2], 0xe8e2d0, [0, -0.5, 1.0]);
    this.model.armR.add(voxelBox([0.06, 0.06, 1.2], 0x2a2230, [0, -0.5, 0.35]), this.skull);
    // Bone crown and ribbed robe front.
    const { head } = this.model;
    onHead(head, [0.48, 0.07, 0.48], 0xe8e2d0, [0, 0.3, 0]);
    for (const x of [-0.16, 0, 0.16]) onHead(head, [0.06, 0.14, 0.06], 0xe8e2d0, [x, 0.4, 0.2]);
    for (const y of [0.98, 0.88, 0.78]) inner.add(voxelBox([0.32, 0.04, 0.02], 0xbfb8a4, [0, y, 0.17]));
    // Floating skulls circling him, eyes glowing.
    this.addOrbiters(3, 1.4, 1.9, () => {
      const g = new THREE.Group();
      g.add(voxelBox([0.24, 0.22, 0.22], 0xe8e2d0), voxelBox([0.18, 0.06, 0.18], 0xbfb8a4, [0, -0.13, 0.01]));
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xd18bff });
      for (const ex of [-0.05, 0.05]) {
        const e = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), eyeMat);
        e.position.set(ex, 0.02, 0.115);
        g.add(e);
      }
      return g;
    });
    this.ringMark = groundCircle();
    this.model.root.add(this.ringMark);
    this.powers.push(
      {
        // Bones burst up in a ring around his target with one gap, then the middle: find the way out.
        name: 'Bone Prison',
        cooldown: 9,
        minPhase: 1,
        cast: 0.8,
        timer: 3,
        run: (ctx) => {
          const p = ctx.player;
          const gap = ctx.rng.int(0, 7);
          for (let i = 0; i < 8; i++) {
            if (i === gap) continue;
            const a = (i / 8) * Math.PI * 2;
            const x = p.pos.x + Math.sin(a) * 2.4;
            const z = p.pos.z + Math.cos(a) * 2.4;
            if (ctx.grid.isWalkableAt(x, z)) this.hazard(ctx, { k: 'circle', x, z, r: 1.1, delay: 1.3, base: 16, knock: 4 });
          }
          this.hazard(ctx, { k: 'circle', x: p.pos.x, z: p.pos.z, r: 1.4, delay: 1.9, base: 22, knock: 6 });
        },
      },
      {
        // Enraged: a death wave rolls out and a spiral of bolts follows it.
        name: 'Death Spiral',
        cooldown: 11,
        minPhase: 2,
        cast: 1.0,
        timer: 2,
        run: (ctx) => {
          this.hazard(ctx, { k: 'ring', x: this.pos.x, z: this.pos.z, r: 10, speed: 7, delay: 0.4, base: 16, knock: 7 });
          for (let i = 0; i < 20; i++) this.shoot(ctx, this.facing + (i / 20) * Math.PI * 2, { speed: 6 + (i % 2) * 2, range: 14, base: 9, color: 0xa070ff, orb: true });
        },
      },
    );
  }

  protected fight(dt: number, ctx: EnemyContext): void {
    this.attackCooldown -= dt;
    this.blinkCooldown -= dt;
    this.summonTimer -= dt;
    const dist = this.distanceToPlayer(ctx);
    const pace = this.pace;
    // Hover: a gentle bob instead of a walk cycle.
    this.model.body.position.y = this.model.bodyBaseY + 0.12 + Math.sin(this.stateTime * 3) * 0.06;

    switch (this.state) {
      case 'drift': {
        let moved = false;
        if (dist > 8) moved = this.moveToward(ctx, dt, 2.2 * pace);
        else if (dist < 5) moved = this.moveToward(ctx, dt, 1.8 * pace, true);
        this.turnToward(this.angleToPlayer(ctx), 5, dt);
        this.animateWalk(dt, moved, 4);
        if (dist < 3 && this.blinkCooldown <= 0) {
          this.enter('blinkOut');
          ctx.events.emit('teleport', { ...this.pos });
          break;
        }
        if (this.attackCooldown > 0) break;
        if (this.tryPower(ctx)) {
          this.attackCooldown = 1;
          break;
        }
        if (this.summonTimer <= 0) this.enter('summon');
        else if (ctx.rng.chance(0.5)) {
          this.volleysLeft = 3;
          this.enter('bolts');
        } else {
          this.ringWaves = this.enraged ? 2 : 1;
          this.enter('ringWindup');
        }
        break;
      }
      case 'bolts': {
        // Aimed fans of bolts, a few in a row.
        this.turnToward(this.angleToPlayer(ctx), 10, dt);
        this.model.armR.rotation.x = -1.4;
        if (this.stateTime >= BOLT_GAP / pace) {
          const n = this.enraged ? 5 : 3;
          const spread = (40 * Math.PI) / 180;
          const aim = this.angleToPlayer(ctx);
          for (let i = 0; i < n; i++) this.shoot(ctx, aim + (i / (n - 1) - 0.5) * spread, BOLT);
          this.stateTime = 0;
          if (--this.volleysLeft <= 0) this.recover(0.7);
        }
        break;
      }
      case 'ringWindup': {
        const t = Math.min(1, this.stateTime / (RING_WINDUP / pace));
        this.ringMark.visible = true;
        this.ringMark.scale.setScalar(1.5 * t);
        this.model.armL.rotation.x = this.model.armR.rotation.x = -2.8 * t;
        if (t >= 1) {
          const n = this.enraged ? 18 : 12;
          // Second wave is offset so the gaps close.
          const offset = (this.ringWaves % 2) * (Math.PI / n);
          for (let i = 0; i < n; i++) this.shoot(ctx, offset + (i / n) * Math.PI * 2, BOLT);
          if (--this.ringWaves > 0) this.stateTime = RING_WINDUP * 0.5;
          else this.recover(0.9);
        }
        break;
      }
      case 'blinkOut': {
        this.model.root.scale.setScalar(Math.max(0.05, 1 - this.stateTime / BLINK_TIME));
        if (this.stateTime >= BLINK_TIME) {
          this.blinkAway(ctx);
          ctx.events.emit('teleport', { ...this.pos });
          this.enter('blinkIn');
        }
        break;
      }
      case 'blinkIn': {
        this.model.root.scale.setScalar(Math.min(1, this.stateTime / BLINK_TIME));
        if (this.stateTime >= BLINK_TIME) {
          this.model.root.scale.setScalar(1);
          this.blinkCooldown = this.enraged ? 3 : 5;
          // Reappear swinging: an instant bolt fan.
          this.volleysLeft = 1;
          this.stateTime = BOLT_GAP;
          this.state = 'bolts';
        }
        break;
      }
      case 'summon': {
        const t = Math.min(1, this.stateTime / SUMMON_TIME);
        this.model.armL.rotation.x = this.model.armR.rotation.x = -3 * Math.sin(t * Math.PI);
        if (t >= 1) {
          const kinds: ('grunt' | 'archer')[] = this.enraged ? ['grunt', 'grunt', 'archer'] : ['grunt', 'grunt'];
          this.summon(ctx, kinds);
          this.summonTimer = this.enraged ? 8 : 11;
          this.recover(0.5);
        }
        break;
      }
      case 'recover': {
        this.model.armL.rotation.x *= 0.85;
        this.model.armR.rotation.x *= 0.85;
        if (this.stateTime >= this.recoverTime) this.enter('drift');
        break;
      }
    }
  }

  /** Teleport to open floor 6-9 tiles from the player, in sight of them. */
  private blinkAway(ctx: EnemyContext): void {
    const p = ctx.player.pos;
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = ctx.rng.range(6, 9);
      const x = p.x + Math.sin(a) * r;
      const z = p.z + Math.cos(a) * r;
      if (ctx.grid.isWalkableAt(x, z) && ctx.grid.lineOfSight(x, z, p.x, p.z)) {
        this.setPosition(x, z);
        return;
      }
    }
  }

  private recover(time: number): void {
    // The recovery after every attack is the boss's vulnerable window.
    this.expose(time);
    this.recoverTime = time;
    this.attackCooldown = this.enraged ? 0.6 : 1.1;
    this.enter('recover');
  }

  protected idle(): void {
    this.model.root.scale.setScalar(1);
    if (this.state !== 'drift') this.enter('drift');
  }

  protected hideTelegraphs(): void {
    this.ringMark.visible = false;
  }

  private enter(state: State): void {
    this.hideTelegraphs();
    this.state = state;
    this.stateTime = 0;
  }
}

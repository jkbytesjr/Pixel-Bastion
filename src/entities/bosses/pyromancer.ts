import * as THREE from 'three';
import type { EnemyContext } from '../enemy';
import { Boss, groundCircle } from '../boss';
import { buildHumanoid, voxelBox } from '../voxelModel';

type State = 'walk' | 'bombCast' | 'novaWindup' | 'summon' | 'recover';

const BOMB_RADIUS = 1.7;
const BOMB_FUSE = 1.3;
const MAX_BOMBS = 6;
const NOVA_WINDUP = 0.8;
const NOVA_RADIUS = 3.2;
const SUMMON_INTERVAL = 12;
const FIRE = 0xff8a2c;

/** Fire caster: rains telegraphed bombs on and around the player, and blasts a fire nova when crowded. */
export class Pyromancer extends Boss {
  readonly bossKind = 'pyromancer';
  readonly radius = 0.6;
  private state: State = 'walk';
  private attackCooldown = 1.0;
  private summonTimer = 3;
  private recoverTime = 0.8;
  private readonly bombs: THREE.Mesh[] = [];
  private bombCount = 0;
  private readonly novaRing: THREE.Mesh;
  private readonly orb: THREE.Mesh;

  constructor(depth: number) {
    super(
      'The Cinder King',
      depth,
      420,
      buildHumanoid({ skin: 0x3a2a2a, shirt: 0x7a1e14, pants: 0x5a160f, hair: 0xff6a1a, boots: 0x1e0f0c }, 1.8),
      3.5,
    );
    this.addEyes(0xffd23f);
    const inner = this.model.body.children[0];
    // Flame crown and robe skirt.
    inner.add(
      voxelBox([0.46, 0.08, 0.46], 0xd4a017, [0, 1.62, 0]),
      voxelBox([0.08, 0.14, 0.08], 0xffb347, [-0.16, 1.72, 0.16]),
      voxelBox([0.08, 0.14, 0.08], 0xffb347, [0.16, 1.72, 0.16]),
      voxelBox([0.08, 0.18, 0.08], 0xffd23f, [0, 1.74, 0.18]),
      voxelBox([0.56, 0.4, 0.36], 0x5a160f, [0, 0.45, 0]),
    );
    // Glowing runes down the robe and flaming shoulders.
    const rune = new THREE.MeshBasicMaterial({ color: 0xff9a3c });
    for (const [x, y] of [
      [0, 0.95],
      [-0.12, 0.6],
      [0.12, 0.4],
      [0, 0.3],
    ]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.02), rune);
      r.position.set(x, y, 0.19);
      inner.add(r);
    }
    for (const arm of [this.model.armL, this.model.armR]) {
      const flame = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.16), new THREE.MeshBasicMaterial({ color: 0xff6a1a }));
      flame.position.set(0, 0.1, 0);
      arm.add(voxelBox([0.26, 0.1, 0.28], 0x3a0f0a, [0, -0.02, 0]), flame);
    }
    // Embers circling him.
    this.addOrbiters(4, 1.3, 1.6, () => new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: 0xffb347 })));
    // Staff with a glowing ember.
    this.orb = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    this.orb.position.set(0, -0.5, 0.95);
    this.model.armR.add(voxelBox([0.06, 0.06, 1.1], 0x3a2418, [0, -0.5, 0.35]), this.orb);

    for (let i = 0; i < MAX_BOMBS; i++) {
      const c = groundCircle();
      this.bombs.push(c);
      this.worldFx.add(c);
    }
    this.novaRing = groundCircle();
    this.model.root.add(this.novaRing);
    this.powers.push(
      {
        // Three lanes of fire erupt toward his target: stand between them.
        name: 'Flame Walls',
        cooldown: 8,
        minPhase: 1,
        cast: 0.8,
        timer: 3,
        run: (ctx) => {
          const a = this.angleToPlayer(ctx);
          for (const off of [-0.45, 0, 0.45]) this.hazard(ctx, { k: 'lane', x: this.pos.x, z: this.pos.z, a: a + off, len: 13, w: 1.5, delay: 1.1, base: 20, knock: 6 });
        },
      },
      {
        // Enraged: calls down a meteor on every hero, with embers scattering after.
        name: 'Meteor',
        cooldown: 12,
        minPhase: 2,
        cast: 1.2,
        timer: 2,
        run: (ctx) => {
          for (const h of this.heroTargets(ctx)) {
            this.hazard(ctx, { k: 'circle', x: h.pos.x, z: h.pos.z, r: 3.2, delay: 1.9, base: 38, knock: 12 });
            for (let i = 0; i < 4; i++) {
              const a = (i / 4) * Math.PI * 2 + 0.4;
              const x = h.pos.x + Math.sin(a) * 4;
              const z = h.pos.z + Math.cos(a) * 4;
              if (ctx.grid.isWalkableAt(x, z)) this.hazard(ctx, { k: 'circle', x, z, r: 1.2, delay: 2.3, base: 14, knock: 4 });
            }
          }
        },
      },
    );
  }

  protected fight(dt: number, ctx: EnemyContext): void {
    this.attackCooldown -= dt;
    if (this.enraged) this.summonTimer -= dt;
    const dist = this.distanceToPlayer(ctx);
    const pace = this.pace;
    this.orb.scale.setScalar(1 + 0.25 * Math.sin(this.stateTime * 12));

    switch (this.state) {
      case 'walk': {
        let moved = false;
        if (dist > 7) moved = this.moveToward(ctx, dt, 2.0 * pace);
        else if (dist < 3.5) moved = this.moveToward(ctx, dt, 1.6 * pace, true);
        this.turnToward(this.angleToPlayer(ctx), 5, dt);
        this.animateWalk(dt, moved, 6);
        if (this.attackCooldown > 0) break;
        if (this.tryPower(ctx)) {
          this.attackCooldown = 1;
          break;
        }
        if (this.enraged && this.summonTimer <= 0) this.enter('summon');
        else if (dist < 3.4) this.enter('novaWindup');
        else if (dist < 15) this.startBombs(ctx);
        break;
      }
      case 'bombCast': {
        this.turnToward(this.angleToPlayer(ctx), 4, dt);
        const t = Math.min(1, this.stateTime / (BOMB_FUSE / pace));
        this.model.armL.rotation.x = this.model.armR.rotation.x = -2.6 * Math.min(1, t * 3);
        for (let i = 0; i < this.bombCount; i++) {
          // Grows to full size and flickers faster as the fuse runs out.
          this.bombs[i].scale.setScalar(BOMB_RADIUS * (0.35 + 0.65 * t));
          this.bombs[i].visible = t < 0.7 || Math.floor(this.stateTime * 20) % 2 === 0;
        }
        if (t >= 1) {
          for (let i = 0; i < this.bombCount; i++) {
            const b = this.bombs[i];
            ctx.explode(b.position.x, b.position.z, BOMB_RADIUS, 22 * this.damageMult, this);
          }
          this.recover(0.8);
        }
        break;
      }
      case 'novaWindup': {
        const t = Math.min(1, this.stateTime / (NOVA_WINDUP / pace));
        this.novaRing.visible = true;
        this.novaRing.scale.setScalar(NOVA_RADIUS * t);
        this.model.body.rotation.x = -0.3 * t;
        this.model.armL.rotation.x = this.model.armR.rotation.x = -1.5 * t;
        if (t >= 1) {
          const n = this.enraged ? 20 : 14;
          const offset = ctx.rng.range(0, Math.PI * 2);
          for (let i = 0; i < n; i++) this.shoot(ctx, offset + (i / n) * Math.PI * 2, { speed: 8, range: 10, base: 13, color: FIRE, orb: true });
          ctx.explode(this.pos.x, this.pos.z, NOVA_RADIUS * 0.6, 16 * this.damageMult, this);
          this.model.body.rotation.x = 0;
          this.recover(1.0);
        }
        break;
      }
      case 'summon': {
        const t = Math.min(1, this.stateTime / 0.9);
        this.model.armL.rotation.x = this.model.armR.rotation.x = -3 * Math.sin(t * Math.PI);
        if (t >= 1) {
          this.summon(ctx, ['exploder', 'exploder']);
          this.summonTimer = SUMMON_INTERVAL;
          this.recover(0.5);
        }
        break;
      }
      case 'recover': {
        this.model.armL.rotation.x *= 0.85;
        this.model.armR.rotation.x *= 0.85;
        this.animateWalk(dt, false);
        if (this.stateTime >= this.recoverTime) this.enter('walk');
        break;
      }
    }
  }

  /** Mark bomb spots: one on the player, the rest scattered around them. */
  private startBombs(ctx: EnemyContext): void {
    const p = ctx.player.pos;
    const n = this.enraged ? MAX_BOMBS : 3;
    let placed = 0;
    for (let attempt = 0; attempt < n * 6 && placed < n; attempt++) {
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = placed === 0 ? 0 : ctx.rng.range(1.8, 4);
      const x = p.x + Math.sin(a) * r;
      const z = p.z + Math.cos(a) * r;
      if (!ctx.grid.isWalkableAt(x, z)) continue;
      this.bombs[placed].position.set(x, 0.04, z);
      this.bombs[placed].visible = true;
      placed++;
    }
    this.bombCount = placed;
    this.enter('bombCast');
  }

  private recover(time: number): void {
    // The recovery after every attack is the boss's vulnerable window.
    this.expose(time);
    this.recoverTime = time;
    this.attackCooldown = this.enraged ? 0.5 : 1.0;
    this.enter('recover');
  }

  protected idle(): void {
    if (this.state !== 'walk') this.enter('walk');
  }

  protected hideTelegraphs(): void {
    for (const b of this.bombs) b.visible = false;
    this.novaRing.visible = false;
  }

  private enter(state: State): void {
    // Bomb markers stay up through their own cast.
    if (state !== 'bombCast') this.hideTelegraphs();
    else this.novaRing.visible = false;
    this.state = state;
    this.stateTime = 0;
  }
}

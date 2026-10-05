import * as THREE from 'three';
import { Actor } from './actor';
import { buildHumanoid, compactModel, voxelBox, type HumanoidParts } from './voxelModel';
import { animateAura, animateCape, attachArmor, buildWeaponMesh, removeArmor, type WornArmor } from './gearModel';
import { DEFAULT_APPEARANCE, type Appearance } from '../systems/appearance';
import { activeMods } from '../systems/mods';
import { MAX_POTIONS } from '../systems/inventory';
import { BodyMotion, ease, span } from './animation';
import { groundAt } from '../world/terrain';
import type { TileGrid } from '../world/grid';
import { BASE_WEAPONS, type WeaponDef, type WeaponKind } from '../systems/weapons';
import type { AttackStats } from '../systems/damage';
import { Inventory, computeStats, type DerivedStats } from '../systems/inventory';
import { MAX_LEVEL, addXp, newProgress, type Progress } from '../systems/progression';
import type { ArmorItem, WeaponItem } from '../systems/loot';
import { applyPerk, type PerkId } from '../systems/perks';
import { DODGE_COST, newStamina, spendStamina, tickStamina } from '../systems/stamina';
import type { WeaponPower } from '../systems/powers';

export interface PlayerInput {
  /** Desired move direction on XZ (not necessarily normalized). */
  moveX: number;
  moveZ: number;
  /** World point the mouse is aiming at. */
  aimX: number;
  aimZ: number;
  attack: boolean;
  dodge: boolean;
  slam: boolean;
  volley: boolean;
  potion: boolean;
}

const SWING_TIME: Record<WeaponKind, number> = { sword: 0.26, spear: 0.3, bow: 0.3 };
const DODGE_TIME = 0.32;
const DODGE_SPEED = 13;
/** Short gap between rolls; stamina is what limits how many you can chain. */
const DODGE_COOLDOWN = 0.3;
const HURT_IFRAMES = 0.35;
const SLAM_TIME = 0.42;
export const SLAM_COOLDOWN = 6;
export const VOLLEY_COOLDOWN = 8;
const POTION_COOLDOWN = 1;
const DRINK_TIME = 0.55;
/** Swings shorter than this (very high attack speed) use the continuous flurry pose. */
const FLURRY_SWING = 0.15;

export class Player extends Actor {
  readonly radius = 0.3;
  readonly model: HumanoidParts;
  inventory = new Inventory();
  progress: Progress = newProgress();
  stats: DerivedStats = computeStats({}, this.inventory);

  /**
   * How many times each action has started (strike, dodge, slam, volley,
   * drink). Co-op sends these so other players see the same animations.
   */
  readonly actions: [number, number, number, number, number] = [0, 0, 0, 0, 0];

  /** Dodge-roll stamina: each roll spends some, and it refills after a short pause. */
  readonly stamina = newStamina();

  /** Admin cheats. */
  godMode = false;
  speedMult = 1;
  /** Highest level XP can reach (raised while logged in as admin). */
  levelCap = MAX_LEVEL;

  /** Single-frame flags consumed by the world. */
  strikeReady = false;
  slamReady = false;
  volleyReady = false;
  /** HP restored by a potion this tick (0 if none). */
  potionHealed = 0;
  attackCooldown = 0;
  dodgeCooldown = 0;
  slamCooldown = 0;
  volleyCooldown = 0;
  potionCooldown = 0;
  private swingTimer = 0;
  /** Length of the current swing: shorter than normal when attacks are very fast. */
  private swingDuration = 0.26;
  private struck = true;
  private dodgeTimer = 0;
  private readonly dodgeDir = { x: 0, z: 0 };
  private hurtTimer = 0;
  private slamTimer = 0;
  private walkPhase = 0;
  private deathTimer = 0;
  private readonly motion = new BodyMotion();
  private swingIndex = 0;
  private slamPhase = 0;
  private drinkTimer = 0;
  private idleTime = 0;
  private heldWeapon: THREE.Group | null = null;
  private heldItem: WeaponItem | null = null;
  private wornItem: ArmorItem | null = null;
  private worn: WornArmor | null = null;
  private moveBlend = 0;
  /** Clock for the admin aura. */
  private auraTime = 0;
  /** 0..1: how far into the admin float the hero is (eases in and out). */
  private floatBlend = 0;
  /** Seconds left of the fast-attack flurry pose, and its running clock. */
  private flurryHold = 0;
  private flurryClock = 0;
  appearance: Appearance = DEFAULT_APPEARANCE;

  constructor() {
    super(100);
    this.model = Player.buildModel(this.appearance);
    this.refreshEquipment();
  }

  /** The hero's body for a look, boxes merged (gear is attached separately and swapped later). */
  private static buildModel(look: Appearance): HumanoidParts {
    const model = buildHumanoid({
      skin: look.skin,
      shirt: look.shirt,
      pants: look.pants,
      hair: look.hair,
      boots: look.boots,
      belt: 0x5a3a1e,
      eyes: look.eyes,
      hairStyle: look.hairStyle,
      beard: look.beard ?? undefined,
    });
    // Adventurer's kit: a scarf, satchel strap and a pouch on the belt.
    const inner = model.body.children[0];
    inner.add(
      voxelBox([0.36, 0.08, 0.34], look.scarf, [0, 1.12, 0]),
      voxelBox([0.1, 0.18, 0.04], look.scarf, [0.1, 1.02, 0.17]),
      voxelBox([0.06, 0.62, 0.32], 0x5a3a1e, [0, 0.9, 0]).rotateZ(0.7),
      voxelBox([0.14, 0.12, 0.08], 0x6b4524, [0.18, 0.62, 0.15]),
    );
    compactModel(model.root);
    return model;
  }

  /** Rebuild the body for a new look, keeping the same root object in the scene and re-dressing the gear. */
  setAppearance(look: Appearance): void {
    this.appearance = look;
    const root = this.model.root;
    const fresh = Player.buildModel(look);
    root.remove(this.model.body);
    root.add(fresh.body);
    Object.assign(this.model, { ...fresh, root });
    this.heldWeapon?.removeFromParent();
    this.heldWeapon = null;
    this.heldItem = null;
    this.wornItem = null;
    this.worn = null;
    this.refreshEquipment();
  }

  /** Title-screen preview: breathe and idle in place without simulating anything. */
  previewIdle(dt: number): void {
    this.auraTime += dt;
    this.animate(dt, false);
    this.syncTransform();
  }

  get object(): THREE.Object3D {
    return this.model.root;
  }

  get weapon(): WeaponDef {
    return BASE_WEAPONS[this.inventory.weapon.weapon];
  }

  get weaponPowers(): readonly WeaponPower[] {
    return this.inventory.weapon.powers ?? [];
  }

  get dodgeCooldownMax(): number {
    return DODGE_COOLDOWN / this.stats.cooldownRate;
  }

  get slamCooldownMax(): number {
    return SLAM_COOLDOWN / this.stats.cooldownRate;
  }

  get volleyCooldownMax(): number {
    return VOLLEY_COOLDOWN / this.stats.cooldownRate;
  }

  /** Wearing admin armor (the aura, the float and the special Q/E effects). */
  get ascendedArmor(): boolean {
    return this.inventory.armor?.rarity === 'admin';
  }

  /** In the middle of an attack, slam or drink: an opening monsters can exploit. */
  get busy(): boolean {
    return this.swingTimer > 0 || this.slamTimer > 0 || this.drinkTimer > 0;
  }

  get dodging(): boolean {
    return this.dodgeTimer > 0;
  }

  get invulnerable(): boolean {
    return this.dodgeTimer > 0 || this.hurtTimer > 0;
  }

  get attackStats(): AttackStats {
    return {
      base: this.stats.weaponDamage,
      power: this.stats.power,
      critChance: this.stats.critChance,
      critMultiplier: this.stats.critMultiplier,
    };
  }

  /** Start a brand-new run: fresh gear and level 1. */
  resetProgress(): void {
    this.inventory = new Inventory();
    this.inventory.potions = Math.min(MAX_POTIONS, this.inventory.potions + activeMods().tweaks.bonusPotions);
    this.progress = newProgress();
    this.refreshEquipment();
  }

  /** Recompute stats after gear or level changes, keeping the HP fraction. */
  refreshEquipment(): void {
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = computeStats(this.progress.perks, this.inventory);
    // Mod rule tweaks on top of gear and attributes.
    const t = activeMods().tweaks;
    this.stats.maxHp = Math.max(10, this.stats.maxHp + t.playerHpBonus);
    this.stats.power *= t.playerDamageMult;
    this.stats.moveSpeed *= t.playerSpeedMult;
    this.stats.potionHeal *= t.potionHealMult;
    this.maxHp = this.stats.maxHp;
    this.hp = Math.min(this.maxHp, Math.max(1, Math.round(this.maxHp * ratio)));
    this.armor = this.stats.armor;
    const weapon = this.inventory.weapon;
    if (weapon !== this.heldItem) {
      if (this.heldWeapon) this.heldWeapon.removeFromParent();
      this.heldWeapon = buildWeaponMesh(weapon);
      (weapon.weapon === 'bow' ? this.model.armL : this.model.armR).add(this.heldWeapon);
      this.heldItem = weapon;
    }
    const armor = this.inventory.armor;
    if (armor !== this.wornItem) {
      if (this.worn) removeArmor(this.model, this.worn);
      this.worn = armor ? attachArmor(this.model, armor) : null;
      this.wornItem = armor;
    }
    // Solid parts cast shadows; the aura and glowing gear don't.
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = mesh.material instanceof THREE.MeshLambertMaterial;
    });
  }

  /** Spend a pending level-up pick on `id`. */
  choosePerk(id: PerkId): void {
    if (this.progress.pendingPicks <= 0) return;
    this.progress.pendingPicks--;
    applyPerk(this.progress.perks, id);
    if (id === 'alchemy') this.inventory.addPotion();
    const missing = this.maxHp - this.hp;
    this.refreshEquipment();
    // New max HP from Vitality arrives filled, rather than as a scaled fraction.
    this.hp = Math.max(1, this.maxHp - missing);
  }

  /** Returns levels gained. Level-ups fully heal. */
  gainXp(amount: number): number {
    const gained = addXp(this.progress, amount, this.levelCap);
    if (gained > 0) {
      this.refreshEquipment();
      this.hp = this.maxHp;
    }
    return gained;
  }

  heal(amount: number): void {
    if (this.alive) this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** Restore to full HP at (x, z) — used on floor load and restart. */
  respawn(x: number, z: number): void {
    this.refreshEquipment();
    this.hp = this.maxHp;
    this.alive = true;
    this.knock.x = this.knock.z = 0;
    this.stamina.value = 100;
    this.stamina.wait = 0;
    this.swingTimer = this.dodgeTimer = this.hurtTimer = this.deathTimer = this.slamTimer = 0;
    this.attackCooldown = this.dodgeCooldown = this.slamCooldown = this.volleyCooldown = this.potionCooldown = 0;
    this.strikeReady = this.slamReady = this.volleyReady = false;
    this.struck = true;
    this.model.body.rotation.set(0, 0, 0);
    this.model.armR.position.z = 0;
    this.model.armL.rotation.set(0, 0, 0);
    this.model.armR.rotation.set(0, 0, 0);
    this.drinkTimer = 0;
    this.setPosition(x, z);
  }

  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    if (this.godMode && this.alive) return false;
    const hit = super.applyDamage(amount, knockX, knockZ);
    if (hit) {
      this.hurtTimer = HURT_IFRAMES;
      this.motion.hit(0.9);
    }
    return hit;
  }

  update(dt: number, input: PlayerInput, grid: TileGrid): void {
    this.strikeReady = this.slamReady = this.volleyReady = false;
    this.potionHealed = 0;
    this.auraTime += dt;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.slamCooldown = Math.max(0, this.slamCooldown - dt);
    this.volleyCooldown = Math.max(0, this.volleyCooldown - dt);
    this.potionCooldown = Math.max(0, this.potionCooldown - dt);
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    tickStamina(this.stamina, dt, this.stats.cooldownRate);
    this.tickCommon(dt, grid);

    this.drinkTimer = Math.max(0, this.drinkTimer - dt);
    if (!this.alive) {
      this.animateDeath(dt);
      this.syncTransform();
      return;
    }

    let mx = input.moveX;
    let mz = input.moveZ;
    const len = Math.hypot(mx, mz);
    const moving = len > 0.01;
    // Inputs shorter than 1 move slower (easing in to a stop at the cursor); longer ones are capped.
    const throttle = Math.min(1, len);
    if (moving) {
      mx /= len;
      mz /= len;
    }

    if (input.potion && this.potionCooldown <= 0 && this.inventory.potions > 0 && this.hp < this.maxHp) {
      this.inventory.potions--;
      this.potionCooldown = POTION_COOLDOWN;
      const before = this.hp;
      this.heal(Math.round(this.maxHp * this.stats.potionHeal));
      this.potionHealed = this.hp - before;
      this.drinkTimer = DRINK_TIME;
      this.actions[4]++;
    }

    // Dodge roll: commit to a direction (movement, else aim), brief i-frames.
    if (input.dodge && this.dodgeCooldown <= 0 && this.dodgeTimer <= 0 && this.slamTimer <= 0 && spendStamina(this.stamina, DODGE_COST)) {
      const ax = input.aimX - this.pos.x;
      const az = input.aimZ - this.pos.z;
      const al = Math.hypot(ax, az) || 1;
      this.dodgeDir.x = moving ? mx : ax / al;
      this.dodgeDir.z = moving ? mz : az / al;
      this.dodgeTimer = DODGE_TIME;
      this.actions[1]++;
      this.dodgeCooldown = this.dodgeCooldownMax;
      this.swingTimer = 0;
      this.struck = true;
      this.motion.impact(0.5);
    }

    if (this.dodgeTimer > 0) {
      this.dodgeTimer = Math.max(0, this.dodgeTimer - dt);
      const speed = DODGE_SPEED * (0.5 + 0.5 * (this.dodgeTimer / DODGE_TIME));
      grid.moveBox(this.pos, this.dodgeDir.x * speed * dt, this.dodgeDir.z * speed * dt, this.radius);
      this.facing = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
      const t = 1 - this.dodgeTimer / DODGE_TIME;
      const tuck = Math.sin(t * Math.PI);
      const { body, bodyBaseY, armL, armR, legL, legR } = this.model;
      if (this.worn?.aura) {
        // Admin dash: stay aloft and corkscrew through the air, arms swept back.
        body.rotation.x = 0;
        body.rotation.z = -ease.inOutSine(t) * Math.PI * 2;
        body.position.y = bodyBaseY + 0.45 + 0.25 * tuck;
        armL.rotation.x = armR.rotation.x = 1.3 * tuck;
        armL.rotation.z = -0.5 * tuck;
        armR.rotation.z = 0.5 * tuck;
        legL.rotation.x = legR.rotation.x = 0.5 * tuck;
        this.floatBlend = 1;
      } else {
        // Forward roll: tuck arms and knees, flip once, come up ready.
        body.rotation.x = ease.inOutSine(t) * Math.PI * 2;
        body.position.y = bodyBaseY * (1 - 0.4 * tuck);
        armL.rotation.x = armR.rotation.x = -1.9 * tuck;
        armL.rotation.z = armR.rotation.z = 0;
        legL.rotation.x = legR.rotation.x = -1.3 * tuck;
      }
      this.motion.apply(this.model, dt, this.pos, this.facing, 0, DODGE_SPEED);
      if (this.dodgeTimer === 0) this.motion.impact(0.4);
      this.syncTransform();
      return;
    }
    this.model.body.rotation.x = 0;
    this.model.body.rotation.z = 0;

    const ax = input.aimX - this.pos.x;
    const az = input.aimZ - this.pos.z;
    if (ax * ax + az * az > 0.01) this.facing = Math.atan2(ax, az);

    // Abilities.
    if (input.slam && this.slamCooldown <= 0 && this.slamTimer <= 0) {
      this.slamCooldown = this.slamCooldownMax;
      this.slamTimer = SLAM_TIME;
      this.actions[2]++;
      this.slamPhase = 0;
      this.motion.impact(0.5);
      this.swingTimer = 0;
      this.struck = true;
    }
    if (input.volley && this.volleyCooldown <= 0) {
      this.volleyCooldown = this.volleyCooldownMax;
      this.volleyReady = true;
      this.actions[3]++;
    }

    // Slower while attacking, so attacks have weight.
    const busy = this.swingTimer > 0 || this.slamTimer > 0;
    const speed = this.stats.moveSpeed * this.speedMult * (busy ? 0.45 : 1);
    if (moving) grid.moveBox(this.pos, mx * speed * throttle * dt, mz * speed * throttle * dt, this.radius);

    if (this.slamTimer > 0) {
      this.slamTimer = Math.max(0, this.slamTimer - dt);
      if (this.slamTimer === 0) {
        this.slamReady = true;
        this.motion.impact(1.1);
      }
    } else if (input.attack && this.attackCooldown <= 0) {
      this.attackCooldown = this.weapon.cooldown / this.stats.attackSpeed;
      // Very high attack speed shortens the swing so the hit still lands before the next one starts.
      this.swingDuration = Math.min(SWING_TIME[this.weapon.kind], this.attackCooldown * 0.9);
      this.swingTimer = this.swingDuration;
      this.struck = false;
      // Swords alternate a horizontal slash and an overhead chop.
      this.swingIndex ^= 1;
      this.actions[0]++;
    }
    if (this.swingTimer > 0) {
      this.swingTimer = Math.max(0, this.swingTimer - dt);
      const progress = 1 - this.swingTimer / this.swingDuration;
      if (!this.struck && progress >= this.weapon.impactAt) {
        this.struck = true;
        this.strikeReady = true;
      }
    }

    this.animate(dt, moving);
    this.syncTransform();
  }

  private animate(dt: number, moving: boolean): void {
    const { legL, legR, armL, armR, body, bodyBaseY } = this.model;
    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * Math.min(1, dt * 6);
    if (this.worn?.cape) animateCape(this.worn.cape, this.moveBlend, this.walkPhase, this.idleTime);
    if (moving) this.walkPhase += dt * 11;
    else this.walkPhase *= Math.pow(0.001, dt);
    this.idleTime += dt;
    const raw = Math.sin(this.walkPhase);
    const swing = Math.sign(raw) * Math.abs(raw) ** 0.7 * 0.7;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    body.position.y = bodyBaseY;
    body.rotation.y = 0;
    armR.position.z = 0;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.8 - 0.3;
    // Idle: arms hang slightly out and sway with the breath.
    const idle = moving ? 0 : 1;
    armL.rotation.z = -(0.07 + Math.sin(this.idleTime * 2.3) * 0.03) * idle;
    armR.rotation.z = (0.07 + Math.sin(this.idleTime * 2.3) * 0.03) * idle;
    let lean = 0;

    if (this.drinkTimer > 0) {
      // Lift the flask to the mouth and tip the head back.
      const d = 1 - this.drinkTimer / DRINK_TIME;
      const up = ease.outCubic(span(d, 0, 0.35)) * (1 - ease.inOutSine(span(d, 0.75, 1)));
      armL.rotation.x = -2.5 * up;
      armL.rotation.z = 0.5 * up;
      lean = -0.15 * up;
    }

    if (this.slamTimer > 0) {
      // Crouch, leap with arms overhead, then crash down.
      const p = 1 - this.slamTimer / SLAM_TIME;
      const crouch = span(p, 0, 0.2);
      const air = span(p, 0.2, 0.75);
      const crash = span(p, 0.75, 1);
      if (this.slamPhase === 0 && p >= 0.2) {
        this.slamPhase = 1;
        this.motion.impact(-0.7);
      }
      body.position.y = bodyBaseY - 0.15 * Math.sin(crouch * Math.PI) + Math.sin(air * Math.PI) * 1.0;
      const arms = p < 0.2 ? 0.8 * ease.outCubic(crouch) : p < 0.75 ? 0.8 - 3.8 * ease.outBack(air) : -3 + 3.3 * ease.inCubic(crash);
      armL.rotation.x = armR.rotation.x = arms;
      armL.rotation.z = armR.rotation.z = 0;
      legL.rotation.x = legR.rotation.x = p < 0.75 ? -0.5 * Math.sin(air * Math.PI) : 0;
      lean = p < 0.2 ? 0.25 * crouch : p < 0.75 ? -0.1 : 0.45 * crash;
      this.motion.apply(this.model, dt, this.pos, this.facing, this.walkPhase, this.stats.moveSpeed, lean);
      return;
    }

    if (this.swingTimer > 0 && this.swingDuration < FLURRY_SWING) this.flurryHold = 0.15;
    if (this.flurryHold > 0) {
      // Attacks too fast to animate one by one: a steady flurry on a running
      // clock, so the pose doesn't restart (and strobe) on every swing.
      this.flurryHold -= dt;
      this.flurryClock += dt;
      const c = this.flurryClock * 26;
      armL.rotation.z = armR.rotation.z = 0;
      if (this.weapon.kind === 'sword') {
        armR.rotation.x = -Math.PI / 2 + 0.15;
        armR.rotation.z = Math.sin(c) * 0.9;
        body.rotation.y = Math.sin(c) * 0.25;
        lean = 0.1;
      } else if (this.weapon.kind === 'spear') {
        armR.rotation.x = -0.25;
        armR.position.z = 0.25 + Math.sin(c) * 0.35;
        lean = 0.15;
      } else {
        armL.rotation.x = armR.rotation.x = -Math.PI / 2;
        armR.position.z = -0.2 + Math.sin(c) * 0.12;
        body.rotation.y = 0.35;
      }
    } else if (this.swingTimer > 0) {
      const p = 1 - this.swingTimer / this.swingDuration;
      armL.rotation.z = armR.rotation.z = 0;
      switch (this.weapon.kind) {
        case 'sword': {
          if (this.swingIndex === 0) {
            // Horizontal slash: wind to the sword side, whip across, follow through.
            const wind = ease.outCubic(span(p, 0, 0.3));
            const cut = ease.inCubic(span(p, 0.3, 0.6));
            const settle = ease.inOutSine(span(p, 0.6, 1));
            armR.rotation.x = -Math.PI / 2 + 0.25 * (1 - wind) - 0.25 * settle;
            armR.rotation.z = 1.2 * wind - 2.4 * cut + 0.6 * settle;
            body.rotation.y = 0.55 * wind - 1.15 * cut + 0.6 * settle;
            armL.rotation.x = -0.6 * wind + 0.4 * cut;
            lean = 0.12 * cut * (1 - settle);
          } else {
            // Overhead chop: raise fast past the head, slam down past the impact point.
            const raise = ease.outBack(span(p, 0, 0.3));
            const chop = ease.inCubic(span(p, 0.3, 0.6));
            const settle = ease.inOutSine(span(p, 0.6, 1));
            armR.rotation.x = -2.8 * raise + 3.1 * chop - 0.6 * settle;
            body.rotation.y = 0.3 * raise - 0.3 * chop;
            lean = -0.18 * raise + 0.4 * chop * (1 - settle);
          }
          break;
        }
        case 'spear': {
          // Pull back, then a lunging thrust with a step forward.
          const pull = ease.outCubic(span(p, 0, 0.35));
          const thrust = ease.inCubic(span(p, 0.35, 0.55));
          const back = ease.inOutSine(span(p, 0.6, 1));
          armR.rotation.x = -0.25;
          armR.position.z = -0.3 * pull + 0.9 * thrust - 0.6 * back;
          body.rotation.y = 0.35 * pull - 0.6 * thrust + 0.25 * back;
          legL.rotation.x = -0.6 * thrust * (1 - back);
          legR.rotation.x = 0.4 * thrust * (1 - back);
          lean = -0.12 * pull + 0.35 * thrust * (1 - back);
          break;
        }
        case 'bow': {
          // Raise, draw to the cheek in a side-on stance, release with a snap and recoil.
          const at = this.weapon.impactAt;
          const raise = ease.outCubic(span(p, 0, 0.25));
          const draw = ease.inOutSine(span(p, 0.15, at));
          const snap = ease.outCubic(span(p, at, at + 0.08));
          const relax = ease.inOutSine(span(p, at + 0.15, 1));
          armL.rotation.x = -Math.PI / 2 * raise + 0.2 * snap * (1 - relax);
          armR.rotation.x = -Math.PI / 2 * raise - 0.3 * snap * (1 - relax);
          armR.position.z = -0.32 * draw * (1 - snap) - 0.42 * snap * (1 - relax);
          body.rotation.y = 0.45 * raise * (1 - relax);
          lean = -0.08 * draw - 0.12 * snap * (1 - relax);
          break;
        }
      }
    } else if (this.weapon.kind === 'bow' && this.drinkTimer <= 0) {
      armL.rotation.x = -0.6;
    }
    this.applyFloat(dt, moving);
    this.motion.apply(this.model, dt, this.pos, this.facing, this.walkPhase, this.stats.moveSpeed, lean);
  }

  /**
   * Admin armor: glide above the floor instead of walking. Rises when moving,
   * sinks to a low hover when standing, and the legs hang and sway instead of striding.
   */
  private applyFloat(dt: number, moving: boolean): void {
    const target = this.worn?.aura ? (moving ? 1 : 0.35) : 0;
    this.floatBlend += (target - this.floatBlend) * Math.min(1, dt * 4);
    const f = this.floatBlend;
    if (f < 0.001) return;
    const { body, legL, legR } = this.model;
    body.position.y += f * (0.45 + Math.sin(this.auraTime * 2.2) * 0.06);
    // Legs drift back and hang loose, toes pointed.
    const sway = Math.sin(this.auraTime * 2.2) * 0.08;
    legL.rotation.x += (0.35 + sway - legL.rotation.x) * f;
    legR.rotation.x += (0.25 - sway - legR.rotation.x) * f;
  }

  /** Fall backward with a bounce, arms flung out. */
  private animateDeath(dt: number): void {
    this.deathTimer = Math.min(1, this.deathTimer + dt * 1.6);
    const { body, bodyBaseY, armL, armR, legL, legR } = this.model;
    body.rotation.z = 0;
    const t = ease.outBounce(this.deathTimer);
    body.rotation.x = -(Math.PI / 2) * t;
    body.position.y = bodyBaseY * (1 - 0.62 * t);
    armL.rotation.x = armR.rotation.x = 1.1 * t;
    armL.rotation.z = -0.8 * t;
    armR.rotation.z = 0.8 * t;
    legL.rotation.x = 0.2 * t;
    legR.rotation.x = -0.15 * t;
  }

  /** Play the drinking animation without using a potion (other players' heroes). */
  playDrink(): void {
    this.drinkTimer = DRINK_TIME;
  }

  protected syncTransform(): void {
    this.model.root.position.set(this.pos.x, groundAt(this.pos.x, this.pos.z), this.pos.z);
    this.model.root.rotation.y = this.facing;
    if (this.worn?.aura) animateAura(this.worn.aura, this.auraTime);
  }
}

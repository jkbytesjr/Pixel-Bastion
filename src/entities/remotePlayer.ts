import { Player, type PlayerInput } from './player';
import type { TileGrid } from '../world/grid';
import type { PlayerState, Profile } from '../net/protocol';

/** Past this distance the hero jumps to its reported position instead of gliding there. */
const SNAP_DISTANCE = 2.5;

/**
 * Another player's hero in a co-op game. It replays their reported position,
 * facing and actions through the normal Player animation code. On the host it
 * also stands in for them in combat: monsters target it, and damage, healing
 * and loot meant for it are queued to be sent to its owner, who owns its HP.
 */
export class RemotePlayer extends Player {
  name = 'Adventurer';
  /** Damage the host has dealt this hero since the last send. */
  readonly pendingDamage: { amount: number; kx: number; kz: number }[] = [];
  pendingHeal = 0;
  /** Reported: bag full / potions full. */
  bagFull = false;
  potionsFull = false;
  private netInvulnerable = false;
  private readonly target = { x: 0, z: 0, f: 0 };
  private seen: number[] | null = null;
  private pending = { strike: false, dodge: false, slam: false, volley: false };
  private hasState = false;

  constructor(readonly netId: number) {
    super();
  }

  get invulnerable(): boolean {
    return this.netInvulnerable || super.invulnerable;
  }

  /** Look and gear (which also sets the stats the host fights with). */
  applyProfile(p: Profile): void {
    this.name = p.name;
    this.setAppearance(p.look);
    this.inventory.weapon = p.weapon;
    this.inventory.armor = p.armor;
    this.progress.perks = { ...p.perks };
    this.progress.level = p.level;
    this.refreshEquipment();
  }

  /** Latest reported state. Action counters that went up replay those actions. */
  applyState(s: PlayerState): void {
    this.target.x = s.x;
    this.target.z = s.z;
    this.target.f = s.f;
    if (!this.hasState) {
      this.hasState = true;
      this.setPosition(s.x, s.z);
      this.facing = s.f;
    }
    if (s.alive && !this.alive) this.respawn(s.x, s.z);
    this.alive = s.alive;
    this.hp = s.hp;
    this.maxHp = s.mhp;
    this.netInvulnerable = s.inv;
    this.bagFull = s.bag;
    this.potionsFull = s.pot;
    if (this.seen) {
      if (s.c[0] > this.seen[0]) this.pending.strike = true;
      if (s.c[1] > this.seen[1]) this.pending.dodge = true;
      if (s.c[2] > this.seen[2]) this.pending.slam = true;
      if (s.c[3] > this.seen[3]) this.pending.volley = true;
      if (s.c[4] > this.seen[4]) this.playDrink();
    }
    this.seen = [...s.c];
  }

  /** Animate toward the reported state. */
  netUpdate(dt: number, grid: TileGrid): void {
    const dx = this.target.x - this.pos.x;
    const dz = this.target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const moving = dist > 0.12;
    // Clear cooldowns so a reported action always plays, whatever this copy's timers say.
    if (this.pending.strike) this.attackCooldown = 0;
    if (this.pending.dodge) {
      this.dodgeCooldown = 0;
      this.stamina.value = 100;
    }
    if (this.pending.slam) this.slamCooldown = 0;
    if (this.pending.volley) this.volleyCooldown = 0;
    const input: PlayerInput = {
      moveX: moving ? dx : 0,
      moveZ: moving ? dz : 0,
      aimX: this.pos.x + Math.sin(this.target.f) * 3,
      aimZ: this.pos.z + Math.cos(this.target.f) * 3,
      attack: this.pending.strike,
      dodge: this.pending.dodge,
      slam: this.pending.slam,
      volley: this.pending.volley,
      potion: false,
    };
    this.pending = { strike: false, dodge: false, slam: false, volley: false };
    super.update(dt, input, grid);
    // Stay on the reported track: glide when close, jump when far behind.
    const ex = this.target.x - this.pos.x;
    const ez = this.target.z - this.pos.z;
    if (Math.hypot(ex, ez) > SNAP_DISTANCE) {
      this.pos.x = this.target.x;
      this.pos.z = this.target.z;
    } else {
      const k = Math.min(1, dt * 10);
      this.pos.x += ex * k;
      this.pos.z += ez * k;
    }
    if (this.alive && !this.dodging) this.facing = this.target.f;
    this.syncTransform();
  }

  /** Host: monsters hit this hero. The damage goes to its owner; it isn't applied here. */
  applyDamage(amount: number, knockX: number, knockZ: number): boolean {
    if (!this.alive || this.invulnerable) return false;
    this.pendingDamage.push({ amount, kx: knockX, kz: knockZ });
    return true;
  }

  /** Host: life-on-hit and the like, forwarded to the owner. */
  heal(amount: number): void {
    if (this.alive) this.pendingHeal += amount;
  }
}

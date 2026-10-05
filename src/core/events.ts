import type { Item } from '../systems/loot';
import type { PowerId } from '../systems/powers';

/** Minimal typed event bus so audio, particles and HUD can react without coupling. */
export interface GameEvents {
  /** `who`: the player behind it (co-op), so each player's own effects aren't played twice. */
  swing: { x: number; z: number; who?: number };
  shoot: { x: number; z: number; owner: 'player' | 'enemy' };
  /**
   * `tag` marks why a hit landed harder or softer: an exposed enemy, high
   * ground, or an elemental weakness / resistance.
   */
  hit: { x: number; z: number; amount: number; crit: boolean; target: 'enemy' | 'player'; who?: number; tag?: 'exposed' | 'high' | 'weak' | 'resist' };
  /** First time an element finds a monster's weakness or resistance. */
  affinity: { x: number; z: number; element: string; label: 'weak' | 'resist' };
  enemyDied: { x: number; z: number; kind: string; xp: number };
  explosion: { x: number; z: number; radius: number };
  bossEngaged: { name: string };
  bossDefeated: { x: number; z: number; name: string };
  /** Capture shrine changed state (capturing / contested / idle). */
  captureState: { state: string };
  /** The shrine is captured. */
  captured: { x: number; z: number };
  /** A gate opened (boss gate, vault door, cracked wall). */
  gateOpened: { kind: string; x: number; z: number; tiles: { x: number; z: number }[] };
  /** A cracked wall took a hit, and when it broke open. */
  wallCracked: { x: number; z: number };
  secretFound: { x: number; z: number };
  /** A pressure plate was stepped on (in order or not), and the whole puzzle solved. */
  plate: { x: number; z: number; ok: boolean };
  puzzleSolved: { x: number; z: number };
  /** This player's hero went through a mini-portal (`pocket`: into a pocket dimension). */
  warp: { x: number; z: number; pocket: boolean };
  /** A boss entered a harder phase (2: enraged, 3: desperate). */
  bossPhase: { name: string; phase: number };
  /** A boss hazard was placed (co-op guests draw the host's). */
  hazard: { spec: import('../entities/bossHazards').HazardSpec };
  /** A boss hazard went off. */
  bossStrike: { x: number; z: number; radius: number; boss: string };
  /** `admin`: thrown in admin armor, which gets its own effects. */
  slam: { x: number; z: number; radius: number; admin?: boolean; who?: number };
  /** Spear volley thrown (E). */
  volley: { x: number; z: number; facing: number; admin: boolean; who?: number };
  /** `admin`: an admin-armor dash, which gets its own effects. */
  dodge: { x: number; z: number; admin?: boolean; who?: number };
  teleport: { x: number; z: number };
  /** A shield soaked up most of a hit. */
  blocked: { x: number; z: number };
  /** A shaman healed some monsters. */
  enemyHeal: { x: number; z: number; targets: { x: number; z: number; amount: number }[] };
  /** A summoned monster is climbing out of the floor. */
  rise: { x: number; z: number };
  /** A weapon power went off. `points` is the chain-lightning path. */
  power: { id: PowerId; x: number; z: number; radius?: number; points?: { x: number; z: number }[] };
  /** Damage-over-time tick (burning). */
  burnTick: { x: number; z: number; amount: number };
  /** Periodic cue to draw a status effect on an enemy. */
  status: { x: number; z: number; kind: 'burn' | 'chill' | 'freeze' };
  levelUp: { level: number };
  itemPicked: { item: Item };
  potionPicked: Record<string, never>;
  heal: { x: number; z: number; amount: number };
  bagFull: Record<string, never>;
  chestOpened: { x: number; z: number };
  playerDied: Record<string, never>;
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Handler<never>[]>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): void {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    for (const h of this.handlers.get(type) ?? []) (h as Handler<GameEvents[K]>)(payload);
  }
}

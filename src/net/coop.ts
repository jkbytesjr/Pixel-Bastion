/**
 * A co-op session: the lobby, and keeping every player's copy of the run in
 * step. The host runs the real dungeon; guests run their own hero and a
 * look-alike copy of the floor that follows the host's snapshots.
 */
import type { GameWorld } from '../core/gameWorld';
import type { EventBus, GameEvents } from '../core/events';
import { RemotePlayer } from '../entities/remotePlayer';
import type { Player } from '../entities/player';
import { MAX_POTIONS } from '../systems/inventory';
import type { Appearance } from '../systems/appearance';
import {
  HOST_ID,
  MAX_PLAYERS,
  NET_VERSION,
  q2,
  readToHost,
  type NetEvent,
  type PlayerState,
  type Profile,
  type ToGuest,
} from './protocol';
import { hostRoom, joinRoom, type Transport } from './transport';

/** State and snapshot rate (per second). */
const SEND_RATE = 20;

/** Effects that guests replay from the host. Each player plays their own hits, swings and so on locally. */
const FORWARDED: (keyof GameEvents)[] = [
  'hit',
  'swing',
  'slam',
  'volley',
  'dodge',
  'shoot',
  'enemyDied',
  'explosion',
  'bossEngaged',
  'bossDefeated',
  'blocked',
  'enemyHeal',
  'rise',
  'teleport',
  'power',
  'burnTick',
  'status',
  'chestOpened',
  'affinity',
  'hazard',
  'bossStrike',
  'bossPhase',
  'captured',
  'captureState',
  'wallCracked',
  'secretFound',
  'plate',
  'puzzleSolved',
  'brazier',
  'braziersOut',
  'riftSeal',
  'riftOpen',
];

/** What the session needs from the game. */
export interface CoopGame {
  world: GameWorld;
  events: EventBus;
  /** This player's look (for their profile). */
  look(): Appearance;
  /** Host: the running seed and floor. */
  seed(): number;
  depth(): number;
  /** Guest: the host started a run or moved to a floor. `fresh` = a new run (start over at level 1). */
  playFloor(seed: number, depth: number, fresh: boolean): void;
  /** Everyone is down. */
  partyWiped(): void;
  /** The lobby (players, started) changed. */
  lobbyChanged(): void;
  /** The session ended (host left, kicked, connection lost). */
  ended(reason: string): void;
  toast(text: string, tone?: 'info' | 'good' | 'danger'): void;
}

export interface LobbyPlayer {
  id: number;
  name: string;
}

export class CoopSession {
  readonly players = new Map<number, LobbyPlayer>();
  started = false;
  /** Bumped on every floor load so stale messages from the last floor are ignored. */
  private token = 0;
  private sendTimer = 0;
  private readonly eventBatch: NetEvent[] = [];
  private lastProfile = '';
  // Host bookkeeping.
  private readonly peerIds = new Map<string, number>();
  private readonly idPeers = new Map<number, string>();
  private readonly profiles = new Map<number, Profile>();
  private wiped = false;

  private constructor(
    readonly role: 'host' | 'guest',
    readonly code: string,
    readonly name: string,
    private readonly game: CoopGame,
    private readonly transport: Transport,
    public localId: number,
  ) {}

  /** Open a room under `code`. */
  static async host(code: string, name: string, game: CoopGame): Promise<CoopSession> {
    const t = await hostRoom(code);
    const s = new CoopSession('host', code, name, game, t, HOST_ID);
    s.players.set(HOST_ID, { id: HOST_ID, name });
    s.wireHost();
    return s;
  }

  /** Join the room `code`. Resolves once the host has let us in. */
  static async join(code: string, name: string, game: CoopGame): Promise<CoopSession> {
    const t = await joinRoom(code);
    const s = new CoopSession('guest', code, name, game, t, -1);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The host did not answer.')), 10000);
      t.onMessage = (_peer, raw) => {
        const msg = raw as ToGuest;
        if (msg?.t === 'welcome') {
          clearTimeout(timer);
          s.localId = msg.you;
          resolve();
        } else if (msg?.t === 'reject') {
          clearTimeout(timer);
          reject(new Error(msg.reason));
        }
      };
      t.broadcast({ t: 'hello', v: NET_VERSION, name });
    });
    s.wireGuest();
    return s;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  /** Leave the session (closes the room for everyone if hosting). */
  close(): void {
    this.transport.onClose = () => {};
    this.transport.onPeerLeave = () => {};
    this.transport.close();
    this.game.world.net = null;
    this.game.world.clearRemotes();
  }

  // ---------------------------------------------------------------- host

  private wireHost(): void {
    const t = this.transport;
    const world = this.game.world;
    t.onPeerJoin = () => {};
    t.onPeerLeave = (peer) => {
      const id = this.peerIds.get(peer);
      if (id === undefined) return;
      this.peerIds.delete(peer);
      this.idPeers.delete(id);
      this.profiles.delete(id);
      const name = this.players.get(id)?.name ?? 'A player';
      this.players.delete(id);
      const r = world.remotes.find((x) => x.netId === id);
      if (r) world.removeRemote(r);
      this.game.toast(`${name} left`, 'info');
      this.sendLobby();
      this.game.lobbyChanged();
    };
    t.onMessage = (peer, raw) => {
      const msg = readToHost(raw);
      if (!msg) return;
      if (msg.t === 'hello') return this.admit(peer, msg.v, msg.name);
      const id = this.peerIds.get(peer);
      if (id === undefined) return;
      const r = world.remotes.find((x) => x.netId === id);
      if (msg.t === 'profile') {
        this.profiles.set(id, msg.p);
        const p = this.players.get(id);
        if (p) p.name = msg.p.name;
        r?.applyProfile(msg.p);
        this.broadcastProfiles();
      } else if (msg.t === 'state') r?.applyState({ ...msg.s, id });
      else if (msg.t === 'act' && r && this.started) world.remoteAction(r, msg.a, msg.x, msg.z, msg.f);
    };
    world.net = {
      pickupSpawned: (p) => this.toGuests({ t: 'drop', k: this.token, id: p.netId, drop: p.drop, x: q2(p.pos.x), z: q2(p.pos.z), a: 0 }),
      pickupTaken: (p) => this.toGuests({ t: 'take', k: this.token, id: p.netId }),
      remoteLoot: (r, drop) => this.sendTo(r.netId, { t: 'loot', drop }),
      sharedXp: (amount) => this.toGuests({ t: 'xp', amount }),
      chestOpened: (i) => this.toGuests({ t: 'chest', k: this.token, i }),
      localAction: () => {},
    };
    this.listenForEvents();
  }

  private admit(peer: string, version: number, name: string): void {
    const t = this.transport;
    if (version !== NET_VERSION) {
      t.send(peer, { t: 'reject', reason: 'The host is on a different version of the game. Reload the page and try again.' });
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      t.send(peer, { t: 'reject', reason: `That game is full (${MAX_PLAYERS} players).` });
      return;
    }
    let id = 1;
    while (this.players.has(id)) id++;
    this.peerIds.set(peer, id);
    this.idPeers.set(id, peer);
    this.players.set(id, { id, name });
    const r = new RemotePlayer(id);
    r.name = name;
    this.game.world.addRemote(r);
    t.send(peer, { t: 'welcome', v: NET_VERSION, you: id });
    if (this.started) t.send(peer, { t: 'run', seed: this.game.seed(), depth: this.game.depth(), token: this.token, fresh: true });
    this.broadcastProfiles();
    this.sendLobby();
    this.game.toast(`${name} joined`, 'good');
    this.game.lobbyChanged();
  }

  /** Host: a run started, or the party moved to a floor. */
  floorLoaded(fresh: boolean): void {
    if (!this.isHost) return;
    this.started = true;
    this.wiped = false;
    this.token++;
    this.toGuests({ t: 'run', seed: this.game.seed(), depth: this.game.depth(), token: this.token, fresh });
    this.sendLobby();
  }

  private sendLobby(): void {
    this.toGuests({ t: 'lobby', players: [...this.players.values()], started: this.started });
  }

  private broadcastProfiles(): void {
    const list = [...this.profiles.entries()].map(([id, p]) => ({ id, p }));
    const mine = this.myProfile();
    list.push({ id: this.localId, p: mine });
    this.toGuests({ t: 'profiles', list });
  }

  private toGuests(msg: ToGuest): void {
    this.transport.broadcast(msg);
  }

  private sendTo(id: number, msg: ToGuest): void {
    const peer = this.idPeers.get(id);
    if (peer) this.transport.send(peer, msg);
  }

  private listenForEvents(): void {
    for (const type of FORWARDED)
      this.game.events.on(type, (payload) => {
        if (this.isHost) this.eventBatch.push([type, payload, (payload as { who?: number }).who ?? -1]);
      });
  }

  // ---------------------------------------------------------------- guest

  private wireGuest(): void {
    const t = this.transport;
    const { world, events } = this.game;
    t.onClose = () => this.game.ended('The host left the game.');
    world.net = {
      pickupSpawned: () => {},
      pickupTaken: () => {},
      remoteLoot: () => {},
      sharedXp: () => {},
      chestOpened: () => {},
      localAction: (kind) => {
        const p = world.player;
        t.broadcast({ t: 'act', a: kind, x: q2(p.pos.x), z: q2(p.pos.z), f: q2(p.facing) });
      },
    };
    t.onMessage = (_peer, raw) => {
      const msg = raw as ToGuest;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'lobby':
          this.players.clear();
          for (const p of msg.players) this.players.set(p.id, p);
          this.started = msg.started;
          this.game.lobbyChanged();
          break;
        case 'run':
          this.token = msg.token;
          this.started = true;
          this.game.playFloor(msg.seed, msg.depth, msg.fresh);
          break;
        case 'profiles':
          for (const { id, p } of msg.list) {
            if (id === this.localId) continue;
            this.remote(id).applyProfile(p);
          }
          break;
        case 'snap':
          if (msg.k !== this.token) break;
          this.applySnapshot(msg.pl);
          world.applyEnemySnapshot(msg.en);
          if (msg.ft) world.features.applySnapshot(msg.ft);
          world.projectiles.setFromNet(msg.pr);
          break;
        case 'ev':
          if (msg.k !== this.token) break;
          for (const [type, payload, origin] of msg.list) {
            // Our own swings, dodges and the hits we took already played here.
            if (origin === this.localId) continue;
            events.emit(type as keyof GameEvents, payload as never);
          }
          break;
        case 'dmg':
          if (world.player.applyDamage(msg.amount, msg.kx, msg.kz)) {
            world.calmTime = 0;
            events.emit('hit', { ...world.player.pos, amount: msg.amount, crit: false, target: 'player' });
          }
          break;
        case 'heal':
          world.player.heal(msg.amount);
          break;
        case 'xp': {
          const levels = world.player.gainXp(msg.amount);
          if (levels > 0) events.emit('levelUp', { level: world.player.progress.level });
          break;
        }
        case 'loot':
          if (msg.drop.type === 'potion') {
            if (world.player.inventory.addPotion()) events.emit('potionPicked', {});
          } else if (world.player.inventory.add(msg.drop.item)) events.emit('itemPicked', { item: msg.drop.item });
          break;
        case 'drop':
          if (msg.k === this.token) world.addNetPickup(msg.id, msg.drop, msg.x, msg.z, msg.a);
          break;
        case 'take':
          if (msg.k === this.token) world.removeNetPickup(msg.id);
          break;
        case 'chest':
          if (msg.k === this.token) world.openChestNet(msg.i);
          break;
        case 'wipe':
          this.game.partyWiped();
          break;
      }
    };
    this.sendProfileIfChanged();
  }

  /** Guest: other heroes from the host's snapshot. */
  private applySnapshot(list: PlayerState[]): void {
    const world = this.game.world;
    const seen = new Set<number>();
    for (const s of list) {
      if (s.id === this.localId) continue;
      seen.add(s.id);
      this.remote(s.id).applyState(s);
    }
    for (const r of [...world.remotes]) if (!seen.has(r.netId)) world.removeRemote(r);
  }

  /** Guest: the hero for player `id`, made on first sight. */
  private remote(id: number): RemotePlayer {
    const world = this.game.world;
    let r = world.remotes.find((x) => x.netId === id);
    if (!r) {
      r = new RemotePlayer(id);
      r.name = this.players.get(id)?.name ?? 'Adventurer';
      world.addRemote(r);
    }
    return r;
  }

  // ---------------------------------------------------------------- both

  private myProfile(): Profile {
    const p = this.game.world.player;
    return {
      name: this.name,
      look: this.game.look(),
      weapon: p.inventory.weapon,
      armor: p.inventory.armor,
      perks: { ...p.progress.perks },
      level: p.progress.level,
    };
  }

  private sendProfileIfChanged(): void {
    const profile = this.myProfile();
    const key = JSON.stringify(profile);
    if (key === this.lastProfile) return;
    this.lastProfile = key;
    if (this.isHost) this.broadcastProfiles();
    else this.transport.broadcast({ t: 'profile', p: profile });
  }

  private stateOf(p: Player, id: number): PlayerState {
    const inv = p.inventory;
    return {
      id,
      x: q2(p.pos.x),
      z: q2(p.pos.z),
      f: q2(p.facing),
      hp: Math.ceil(p.hp),
      mhp: p.maxHp,
      alive: p.alive,
      inv: p.invulnerable || p.godMode,
      c: [...p.actions],
      bag: inv.full,
      pot: inv.potions >= MAX_POTIONS,
    };
  }

  /** Call every rendered frame with real seconds. */
  update(dt: number): void {
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 1 / SEND_RATE;
    this.sendProfileIfChanged();
    const world = this.game.world;
    if (!this.isHost) {
      if (this.started) this.transport.broadcast({ t: 'state', s: this.stateOf(world.player, this.localId) });
      return;
    }
    if (!this.started) return;
    // Host: deliver damage and healing to the guests who own those heroes.
    for (const r of world.remotes) {
      for (const d of r.pendingDamage.splice(0)) this.sendTo(r.netId, { t: 'dmg', amount: d.amount, kx: q2(d.kx), kz: q2(d.kz) });
      if (r.pendingHeal > 0) {
        this.sendTo(r.netId, { t: 'heal', amount: Math.round(r.pendingHeal) });
        r.pendingHeal = 0;
      }
    }
    const players = [this.stateOf(world.player, HOST_ID), ...world.remotes.map((r) => this.stateOf(r, r.netId))];
    // Guests own their HP: report what they told us, not this copy's numbers.
    for (const [i, r] of world.remotes.entries()) Object.assign(players[i + 1], { hp: Math.ceil(r.hp), mhp: r.maxHp, alive: r.alive });
    this.toGuests({ t: 'snap', k: this.token, pl: players, en: world.enemySnapshot(), pr: world.projectiles.toNet(), ft: world.features.snapshot() });
    if (this.eventBatch.length) this.toGuests({ t: 'ev', k: this.token, list: this.eventBatch.splice(0) });
    // Everyone down: the run is over for the whole party.
    if (!this.wiped && world.heroes.every((h) => !h.alive)) {
      this.wiped = true;
      this.toGuests({ t: 'wipe' });
      this.game.partyWiped();
    }
  }
}

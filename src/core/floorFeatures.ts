import * as THREE from 'three';
import type { Dungeon } from '../world/dungeonGen';
import { Tile } from '../world/grid';
import type { Gate, PortalLink } from '../world/features';
import { GateView, MiniPortalView, PlatesView, ShrineView } from '../entities/fixtures';
import { PlateSequence, newCapture, tickCapture, CAPTURE_STATES, type Capture } from '../systems/objectives';
import { themeFor } from '../world/voxelBuilder';
import type { Player } from '../entities/player';
import type { Enemy } from '../entities/enemy';
import type { EventBus } from './events';
import type { EnemyKind } from '../world/dungeonGen';

/** How close (world units) a hero must be to step into a mini-portal. */
const PORTAL_REACH = 0.65;
/** Distance a hero must move away from a portal before it can carry them again. */
const PORTAL_CLEAR = 1.5;
/** Hits a cracked wall takes before it gives way. */
const SECRET_HITS = 2;
/** During a capture, monsters come at the shrine every few seconds. */
const WAVE_INTERVAL = 6.5;
const MAX_WAVE_SPAWNS = 8;

/** What the features need from the world. */
export interface FeatureWorld {
  readonly level: Dungeon;
  readonly player: Player;
  readonly heroes: Player[];
  readonly enemies: Enemy[];
  readonly role: 'solo' | 'host' | 'guest';
  readonly events: EventBus;
  /** Spawn a monster that climbs out of the floor (capture waves). */
  spawnRising(kind: EnemyKind, x: number, z: number): void;
  /** Recompute pathing after gates open. */
  pathsChanged(): void;
}

/** Network snapshot of the features (host → guests). */
export interface FeatureState {
  /** Capture progress and state index. */
  cp: number;
  cs: number;
  /** Ids of open gates. */
  g: number[];
  /** Plate puzzle steps. */
  pz: number[];
}

/**
 * The shrine, gates, plate puzzles, cracked walls and mini-portals of one
 * floor: their rules (on the host or alone) and their visuals (everywhere).
 */
export class FloorFeatures {
  readonly group = new THREE.Group();
  readonly capture: Capture = newCapture();
  private shrine: ShrineView | null = null;
  private readonly gateViews = new Map<number, GateView>();
  private readonly openGates = new Set<number>();
  private readonly puzzles: { seq: PlateSequence; view: PlatesView; gateId: number; plates: { x: number; z: number }[]; held: boolean[] }[] = [];
  private readonly portals: { view: MiniPortalView; link: PortalLink; end: 'a' | 'b' }[] = [];
  private readonly secretHits = new Map<number, number>();
  /** Portal ends the local hero must step away from before they work again. */
  private portalLock: { x: number; z: number } | null = null;
  /** Where the local hero stepped into each pocket-dimension portal (they come back to exactly there). */
  private readonly returnTo = new Map<number, { x: number; z: number }>();
  private waveTimer = WAVE_INTERVAL;
  private waveSpawns = 0;

  constructor(private readonly world: FeatureWorld) {}

  /** Build everything for a freshly loaded floor. */
  load(): void {
    const { level } = this.world;
    this.group.clear();
    this.gateViews.clear();
    this.openGates.clear();
    this.puzzles.length = 0;
    this.portals.length = 0;
    this.secretHits.clear();
    this.returnTo.clear();
    this.portalLock = null;
    Object.assign(this.capture, newCapture());
    this.waveTimer = WAVE_INTERVAL;
    this.waveSpawns = 0;
    const biome = themeFor(level).biome;
    for (const g of level.gates ?? []) {
      const v = new GateView(g, level.grid, { stone: biome.wallColors[0], cap: biome.capColor });
      this.gateViews.set(g.id, v);
      this.group.add(v.group);
    }
    this.shrine = level.capture ? new ShrineView(level.capture.x, level.capture.z, level.capture.radius) : null;
    if (this.shrine) this.group.add(this.shrine.group);
    for (const p of level.puzzles ?? []) {
      const view = new PlatesView(p.plates, p.obelisk, p.order);
      this.group.add(view.group);
      this.puzzles.push({ seq: new PlateSequence(p.order), view, gateId: p.gateId, plates: p.plates, held: p.plates.map(() => false) });
    }
    for (const link of level.portals ?? []) {
      for (const end of ['a', 'b'] as const) {
        const view = new MiniPortalView(link[end].x, link[end].z, link);
        this.group.add(view.group);
        this.portals.push({ view, link, end });
      }
    }
  }

  get hasShrine(): boolean {
    return !!this.world.level.capture;
  }

  /** Is the boss gate open (or does this floor have none)? */
  get bossOpen(): boolean {
    const g = this.world.level.gates?.find((x) => x.kind === 'boss');
    return !g || this.openGates.has(g.id);
  }

  update(dt: number): void {
    const authority = this.world.role !== 'guest';
    if (authority) {
      this.updateCapture(dt);
      this.updatePlates();
    }
    for (const v of this.gateViews.values()) v.update(dt);
    this.puzzles.forEach((p) => {
      p.view.update(dt, p.seq.step, p.seq.solved);
      this.gateViews.get(p.gateId)?.setProgress(p.seq.solved ? 3 : p.seq.step);
    });
    if (this.shrine) this.shrine.update(dt, this.capture.state, this.capture.progress);
    for (const p of this.portals) p.view.update(dt);
    this.updatePortals();
  }

  // ---- Capture shrine ----

  private updateCapture(dt: number): void {
    const site = this.world.level.capture;
    if (!site || this.capture.state === 'captured') return;
    const inside = (p: { pos: { x: number; z: number } }) => Math.hypot(p.pos.x - site.x, p.pos.z - site.z) < site.radius;
    const heroes = this.world.heroes.filter((h) => h.alive && inside(h)).length;
    const enemies = this.world.enemies.filter((e) => e.alive && !e.isBoss && inside(e)).length;
    const before = this.capture.state;
    if (tickCapture(this.capture, dt, heroes, enemies)) {
      this.world.events.emit('captured', { x: site.x, z: site.z });
      const gate = this.world.level.gates.find((g) => g.kind === 'boss');
      if (gate) this.openGate(gate.id);
    } else if (this.capture.state !== before) this.world.events.emit('captureState', { state: this.capture.state });
    // While it's being taken, monsters climb out around the shrine to contest it.
    if (this.capture.state === 'capturing' || this.capture.state === 'contested') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0 && this.waveSpawns < MAX_WAVE_SPAWNS) {
        this.waveTimer = WAVE_INTERVAL;
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const x = site.x + Math.sin(a) * (site.radius + 2.5);
          const z = site.z + Math.cos(a) * (site.radius + 2.5);
          if (!this.world.level.grid.isWalkableAt(x, z)) continue;
          this.world.spawnRising(Math.random() < 0.6 ? 'grunt' : 'spider', x, z);
          this.waveSpawns++;
        }
      }
    }
  }

  // ---- Gates ----

  /** Open a gate: its tiles become floor and its door moves out of the way. */
  openGate(id: number): void {
    if (this.openGates.has(id)) return;
    const gate = this.world.level.gates.find((g) => g.id === id);
    if (!gate) return;
    this.openGates.add(id);
    for (const t of gate.tiles) this.world.level.grid.set(t.x, t.z, Tile.Floor);
    this.gateViews.get(id)?.open();
    this.world.pathsChanged();
    const mid = gate.tiles[Math.floor(gate.tiles.length / 2)];
    this.world.events.emit('gateOpened', { kind: gate.kind, x: mid.x + 0.5, z: mid.z + 0.5, tiles: gate.tiles });
  }

  isOpen(id: number): boolean {
    return this.openGates.has(id);
  }

  /** A hero's attack reached tile (x, z): a cracked wall there takes a hit. Returns true if it was one. */
  strikeTile(x: number, z: number): boolean {
    if (this.world.role === 'guest') return false;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const gate = this.world.level.gates?.find((g) => g.kind === 'secret' && !this.openGates.has(g.id) && g.tiles.some((t) => t.x === tx && t.z === tz));
    if (!gate) return false;
    const hits = (this.secretHits.get(gate.id) ?? 0) + 1;
    this.secretHits.set(gate.id, hits);
    this.gateViews.get(gate.id)?.crack();
    this.world.events.emit('wallCracked', { x: tx + 0.5, z: tz + 0.5 });
    if (hits >= SECRET_HITS) {
      this.openGate(gate.id);
      this.world.events.emit('secretFound', { x: tx + 0.5, z: tz + 0.5 });
    }
    return true;
  }

  /** Cracked walls within `radius` of (x, z) (slams). */
  strikeArea(x: number, z: number, radius: number): void {
    for (const g of this.world.level.gates ?? []) {
      if (g.kind !== 'secret' || this.openGates.has(g.id)) continue;
      const t = g.tiles[0];
      if (Math.hypot(t.x + 0.5 - x, t.z + 0.5 - z) < radius + 0.7) this.strikeTile(t.x, t.z);
    }
  }

  /** Cracked walls in front of a melee swing. */
  strikeArc(x: number, z: number, facing: number, range: number): void {
    for (let d = 0.6; d <= range + 0.4; d += 0.4) this.strikeTileOnce(x + Math.sin(facing) * d, z + Math.cos(facing) * d);
    this.lastStruck = null;
  }

  private lastStruck: string | null = null;
  private strikeTileOnce(x: number, z: number): void {
    const k = `${Math.floor(x)},${Math.floor(z)}`;
    if (k === this.lastStruck) return;
    if (this.strikeTile(x, z)) this.lastStruck = k;
  }

  // ---- Plate puzzles ----

  private updatePlates(): void {
    for (const pz of this.puzzles) {
      if (pz.seq.solved) continue;
      pz.plates.forEach((plate, i) => {
        const on = this.world.heroes.some((h) => h.alive && Math.hypot(h.pos.x - plate.x, h.pos.z - plate.z) < 0.55);
        // React when a hero steps onto the plate, not while they stand there.
        if (on && !pz.held[i]) {
          const result = pz.seq.press(i);
          if (result === 'wrong') {
            pz.view.wrong();
            this.world.events.emit('plate', { x: plate.x, z: plate.z, ok: false });
          } else if (result === 'next') this.world.events.emit('plate', { x: plate.x, z: plate.z, ok: true });
          else if (result === 'solved') {
            this.world.events.emit('plate', { x: plate.x, z: plate.z, ok: true });
            this.world.events.emit('puzzleSolved', { x: plate.x, z: plate.z });
            this.openGate(pz.gateId);
          }
        }
        pz.held[i] = on;
      });
    }
  }

  // ---- Mini-portals (each player moves their own hero) ----

  private updatePortals(): void {
    const hero = this.world.player;
    if (!hero.alive || hero.dodging) return;
    const { x, z } = hero.pos;
    if (this.portalLock) {
      if (Math.hypot(x - this.portalLock.x, z - this.portalLock.z) > PORTAL_CLEAR) this.portalLock = null;
      else return;
    }
    for (const { link, end } of this.portals) {
      const here = link[end];
      if (Math.hypot(x - here.x, z - here.z) > PORTAL_REACH) continue;
      const other = end === 'a' ? link.b : link.a;
      let dest = other;
      if (link.kind === 'pocket') {
        if (end === 'a') this.returnTo.set(link.id, { x, z });
        // Coming back out of a pocket dimension puts you exactly where you stepped in.
        else dest = this.returnTo.get(link.id) ?? link.a;
      }
      this.world.events.emit('teleport', { x, z });
      hero.setPosition(dest.x, dest.z);
      hero.knock.x = hero.knock.z = 0;
      // Arriving on (or next to) a portal must not send you straight back.
      this.portalLock = { x: dest.x, z: dest.z };
      this.world.events.emit('teleport', { x: dest.x, z: dest.z });
      this.world.events.emit('warp', { x: dest.x, z: dest.z, pocket: link.kind === 'pocket' && end === 'a' });
      return;
    }
  }

  // ---- Co-op ----

  snapshot(): FeatureState {
    return {
      cp: Math.round(this.capture.progress * 1000) / 1000,
      cs: CAPTURE_STATES.indexOf(this.capture.state),
      g: [...this.openGates],
      pz: this.puzzles.map((p) => (p.seq.solved ? p.seq.order.length : p.seq.step)),
    };
  }

  /** Guest: take on the host's state (opening gates as needed). */
  applySnapshot(s: FeatureState): void {
    this.capture.progress = s.cp;
    this.capture.state = CAPTURE_STATES[s.cs] ?? 'idle';
    for (const id of s.g) if (!this.openGates.has(id)) this.openGate(id);
    s.pz.forEach((step, i) => {
      const p = this.puzzles[i];
      if (!p) return;
      p.seq.step = Math.min(step, p.seq.order.length);
      p.seq.solved = step >= p.seq.order.length;
    });
  }

  /** For the minimap: shrine, portals and closed gates. */
  markers(): { x: number; z: number; color: string; size: number }[] {
    const out: { x: number; z: number; color: string; size: number }[] = [];
    const site = this.world.level.capture;
    if (site) out.push({ x: site.x, z: site.z, color: this.capture.state === 'captured' ? '#4ad8ff' : '#ffd23f', size: 0.9 });
    for (const { link, end } of this.portals) out.push({ x: link[end].x, z: link[end].z, color: link.kind === 'pocket' ? '#b060ff' : '#4ad8ff', size: 0.6 });
    for (const g of this.world.level.gates ?? [])
      if (!this.openGates.has(g.id) && g.kind !== 'secret') for (const t of g.tiles) out.push({ x: t.x + 0.5, z: t.z + 0.5, color: '#ff4a3a', size: 0.45 });
    return out;
  }

  /** A gate the hero should know about: closed boss gates. */
  gateOf(kind: Gate['kind']): Gate | undefined {
    return this.world.level.gates?.find((g) => g.kind === kind);
  }
}

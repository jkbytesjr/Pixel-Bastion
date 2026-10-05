import * as THREE from 'three';
import { voxelBox } from './voxelModel';
import { Tile, type TileGrid } from '../world/grid';
import type { CaptureState } from '../systems/objectives';
import type { Gate, PortalLink } from '../world/features';
import { groundAt } from '../world/terrain';

/** The three plate / gem colours of a plate puzzle. */
export const PLATE_COLORS = [0xff4a3a, 0x5aff6a, 0x4a9aff] as const;

const glow = (color: number, k = 1.8) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });

/**
 * A gate: an iron portcullis on the boss arena, a gem-set vault door, or a
 * cracked wall hiding a secret room. Opening animates it out of the way.
 */
export class GateView {
  readonly group = new THREE.Group();
  opened = false;
  private openT = 0;
  private cracks = 0;
  private readonly crackGlow: THREE.Mesh[] = [];
  private readonly gems: THREE.Mesh[] = [];

  constructor(
    readonly gate: Gate,
    grid: TileGrid,
    wall: { stone: number; cap: number },
  ) {
    for (const t of gate.tiles) {
      const cx = t.x + 0.5;
      const cz = t.z + 0.5;
      // The passage runs along x if there's floor to either side in x.
      const alongX = grid.get(t.x - 1, t.z) === Tile.Floor || grid.get(t.x + 1, t.z) === Tile.Floor;
      const piece = new THREE.Group();
      piece.position.set(cx, 0, cz);
      if (alongX) piece.rotation.y = Math.PI / 2;
      if (gate.kind === 'boss') {
        // Portcullis: iron bars and cross-bars, with a red rune at the top.
        for (const x of [-0.375, -0.125, 0.125, 0.375]) piece.add(voxelBox([0.07, 2.2, 0.07], 0x2a2a30, [x, 1.1, 0]));
        for (const y of [0.4, 1.1, 1.8]) piece.add(voxelBox([1, 0.07, 0.08], 0x34343c, [0, y, 0]));
        for (const x of [-0.375, -0.125, 0.125, 0.375]) piece.add(voxelBox([0.1, 0.12, 0.1], 0x4a4a54, [x, 0.04, 0]));
        const rune = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.1), glow(0xff3a24, 1.6));
        rune.position.set(0, 1.95, 0);
        piece.add(rune);
      } else if (gate.kind === 'vault') {
        // Heavy stone door with brass bands and three gem sockets.
        piece.add(voxelBox([1, 2, 0.4], 0x5a5660, [0, 1, 0]));
        piece.add(voxelBox([1.02, 0.1, 0.42], 0xc8a050, [0, 0.4, 0]), voxelBox([1.02, 0.1, 0.42], 0xc8a050, [0, 1.6, 0]));
        PLATE_COLORS.forEach((c, i) => {
          const gem = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.46), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.25) }));
          gem.position.set(-0.3 + i * 0.3, 1.05, 0);
          gem.userData.color = c;
          this.gems.push(gem);
          piece.add(gem);
        });
      } else {
        // A cracked wall: the same stone as the walls, with faint glowing fissures.
        piece.add(voxelBox([1, 2, 1], wall.stone, [0, 1, 0]));
        piece.add(voxelBox([1.04, 0.12, 1.04], wall.cap, [0, 2.06, 0]));
        for (const [x, y, h, r] of [
          [-0.15, 0.8, 0.7, 0.4],
          [0.2, 1.3, 0.5, -0.5],
          [0.05, 0.45, 0.4, -0.2],
        ]) {
          for (const side of [-1, 1]) {
            const crack = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.02), glow(0xffb04a, 0.8));
            crack.position.set(x, y, side * 0.51);
            crack.rotation.z = r;
            this.crackGlow.push(crack);
            piece.add(crack);
          }
        }
      }
      piece.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh));
      this.group.add(piece);
    }
  }

  /** Vault door: light the gems for the plates done so far. */
  setProgress(done: number): void {
    this.gems.forEach((g, i) => (g.material as THREE.MeshBasicMaterial).color.setHex(g.userData.color as number).multiplyScalar(i < done ? 1.8 : 0.25));
  }

  /** Cracked wall: each hit widens the fissures. */
  crack(): void {
    this.cracks++;
    for (const c of this.crackGlow) {
      (c.material as THREE.MeshBasicMaterial).color.setHex(0xffb04a).multiplyScalar(0.5 + this.cracks * 0.8);
      c.scale.x = 1 + this.cracks;
    }
  }

  open(): void {
    this.opened = true;
  }

  update(dt: number): void {
    if (!this.opened || !this.group.visible) return;
    this.openT += dt;
    const t = Math.min(1, this.openT / 1.2);
    if (this.gate.kind === 'boss') this.group.position.y = 2.3 * t * t;
    else if (this.gate.kind === 'vault') this.group.position.y = -2.1 * t;
    else {
      // Crumbles: shrinks and sinks away.
      this.group.scale.y = Math.max(0.01, 1 - t);
      this.group.position.y = -0.2 * t;
    }
    if (t >= 1) this.group.visible = false;
  }
}

const STATE_COLOR: Record<CaptureState, number> = { idle: 0xe8e2d0, capturing: 0xffd23f, contested: 0xff3a24, captured: 0x4ad8ff };

/** The capture shrine: a ring on the floor, a filling progress arc, a pedestal and a beam of light. */
export class ShrineView {
  readonly group = new THREE.Group();
  private readonly arc: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly crystal: THREE.Mesh;
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xe8e2d0, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly arcMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
  private shown = -1;
  private time = 0;

  constructor(
    x: number,
    z: number,
    private readonly radius: number,
  ) {
    const y = groundAt(x, z);
    this.group.position.set(x, y, z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.12, radius, 64), this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    this.arc = new THREE.Mesh(new THREE.RingGeometry(radius - 0.32, radius - 0.12, 64, 1, 0, 0.001), this.arcMat);
    this.arc.rotation.x = -Math.PI / 2;
    this.arc.position.y = 0.05;
    // Pedestal and floating crystal.
    const pedestal = new THREE.Group();
    pedestal.add(voxelBox([0.9, 0.25, 0.9], 0x6a6672, [0, 0.12, 0]), voxelBox([0.55, 0.7, 0.55], 0x8a8690, [0, 0.6, 0]), voxelBox([0.75, 0.12, 0.75], 0xc8a050, [0, 1.0, 0]));
    pedestal.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh));
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), glow(0xffffff, 1.6));
    this.crystal.position.y = 1.6;
    this.crystal.scale.y = 1.6;
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 8, 16, 1, true), this.beamMat);
    this.beam.position.y = 4;
    this.group.add(ring, this.arc, pedestal, this.crystal, this.beam);
  }

  update(dt: number, state: CaptureState, progress: number): void {
    this.time += dt;
    const color = STATE_COLOR[state];
    this.ringMat.color.setHex(color);
    this.arcMat.color.setHex(color);
    (this.crystal.material as THREE.MeshBasicMaterial).color.setHex(color).multiplyScalar(1.6);
    this.beamMat.color.setHex(color);
    const pulse = state === 'contested' ? 0.5 + 0.5 * Math.sin(this.time * 12) : 1;
    this.beamMat.opacity = (state === 'captured' ? 0.35 : state === 'idle' ? 0.1 : 0.22) * pulse;
    this.crystal.rotation.y += dt * (state === 'capturing' ? 4 : 1.2);
    this.crystal.position.y = 1.6 + Math.sin(this.time * 2) * 0.08;
    // Rebuild the arc only when the shown progress changes visibly.
    const shown = Math.round(progress * 100);
    if (shown !== this.shown) {
      this.shown = shown;
      this.arc.geometry.dispose();
      this.arc.geometry = new THREE.RingGeometry(this.radius - 0.32, this.radius - 0.12, 64, 1, Math.PI / 2, Math.max(0.001, progress * Math.PI * 2));
    }
  }
}

/** Pressure plates and the obelisk that blinks their order. */
export class PlatesView {
  readonly group = new THREE.Group();
  private readonly runes: THREE.MeshBasicMaterial[] = [];
  private readonly gems: THREE.MeshBasicMaterial[] = [];
  private time = 0;
  private flash = 0;

  constructor(
    plates: readonly { x: number; z: number }[],
    obelisk: { x: number; z: number },
    private readonly order: readonly number[],
  ) {
    plates.forEach((p, i) => {
      const g = new THREE.Group();
      g.position.set(p.x, groundAt(p.x, p.z), p.z);
      g.add(voxelBox([0.9, 0.06, 0.9], 0x5a5660, [0, 0.03, 0]));
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PLATE_COLORS[i]).multiplyScalar(0.35) });
      const rune = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.5), mat);
      rune.position.y = 0.07;
      rune.rotation.y = Math.PI / 4;
      this.runes.push(mat);
      g.add(rune);
      this.group.add(g);
    });
    // Obelisk beside the vault door: three gems blink the order.
    const ob = new THREE.Group();
    ob.position.set(obelisk.x, groundAt(obelisk.x, obelisk.z), obelisk.z);
    ob.add(voxelBox([0.5, 0.2, 0.5], 0x4a4652, [0, 0.1, 0]), voxelBox([0.36, 1.5, 0.36], 0x6a6672, [0, 0.95, 0]), voxelBox([0.18, 0.2, 0.18], 0x6a6672, [0, 1.8, 0]));
    ob.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh));
    PLATE_COLORS.forEach((c, i) => {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.25) });
      const gem = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.4), mat);
      gem.position.y = 1.45 - i * 0.35;
      gem.userData.color = c;
      this.gems.push(mat);
      ob.add(gem);
    });
    this.group.add(ob);
  }

  /** Something went wrong: flash everything red. */
  wrong(): void {
    this.flash = 0.5;
  }

  update(dt: number, step: number, solved: boolean): void {
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt);
    // Plates done so far glow; on a wrong step everything blinks red.
    this.runes.forEach((m, i) => {
      const done = solved || this.order.slice(0, step).includes(i);
      if (this.flash > 0) m.color.setHex(0xff2a14).multiplyScalar(Math.floor(this.flash * 10) % 2 ? 1.6 : 0.4);
      else m.color.setHex(PLATE_COLORS[i]).multiplyScalar(done ? 1.8 : 0.35);
    });
    // Obelisk: one gem at a time in the plate order, then a pause; all lit once solved.
    const slot = Math.floor(this.time / 0.7) % (this.order.length + 1);
    this.gems.forEach((m, row) => {
      // Row r shows the r-th plate's colour when it's that plate's turn.
      const plate = this.order[row];
      const lit = solved || slot === row;
      m.color.setHex(PLATE_COLORS[plate]).multiplyScalar(lit ? 1.8 : 0.2);
    });
  }
}

/** A mini-portal: an upright swirling ring (purple into a pocket dimension, cyan for shortcuts). */
export class MiniPortalView {
  readonly group = new THREE.Group();
  private readonly swirl: THREE.Mesh;
  private time = Math.random() * 10;

  constructor(
    x: number,
    z: number,
    readonly link: PortalLink,
  ) {
    const color = link.kind === 'pocket' ? 0xb060ff : 0x4ad8ff;
    this.group.position.set(x, groundAt(x, z), z);
    // Face the isometric camera.
    this.group.rotation.y = Math.PI / 4;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.08, 8, 32), glow(color, 1.7));
    ring.position.y = 0.95;
    ring.scale.y = 1.35;
    this.swirl = new THREE.Mesh(
      new THREE.CircleGeometry(0.58, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.9), transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    this.swirl.position.y = 0.95;
    this.swirl.scale.y = 1.35;
    const base = voxelBox([1.1, 0.1, 0.5], 0x4a4652, [0, 0.05, 0]);
    this.group.add(ring, this.swirl, base);
  }

  update(dt: number): void {
    this.time += dt;
    this.swirl.rotation.z = this.time * 2.5;
    this.swirl.scale.x = 1 + Math.sin(this.time * 3) * 0.06;
  }
}

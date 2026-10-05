import { groundAt } from '../world/terrain';
import * as THREE from 'three';
import { voxelBox } from './voxelModel';
import type { Drop, Rarity } from '../systems/loot';

const BEAM_COLOR: Record<Rarity, number> = { common: 0xdedede, rare: 0x4aa0ff, unique: 0xff9020, mythic: 0xff2d5a, admin: 0x29ffe0 };
const beamGeo = new THREE.BoxGeometry(0.14, 3, 0.14);
const beamMats = new Map<Rarity, THREE.MeshBasicMaterial>();

function beamMaterial(r: Rarity): THREE.MeshBasicMaterial {
  let m = beamMats.get(r);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: BEAM_COLOR[r],
      transparent: true,
      opacity: r === 'common' ? 0.18 : 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    beamMats.set(r, m);
  }
  return m;
}

/** Small voxel icon for a drop. */
function buildIcon(drop: Drop): THREE.Group {
  const g = new THREE.Group();
  if (drop.type === 'potion') {
    g.add(voxelBox([0.24, 0.26, 0.24], 0xd23a3a, [0, 0, 0]), voxelBox([0.1, 0.1, 0.1], 0x8a6a40, [0, 0.18, 0]));
    return g;
  }
  const item = drop.item;
  const accent = BEAM_COLOR[item.rarity];
  if (item.kind === 'armor') {
    g.add(voxelBox([0.42, 0.4, 0.16], 0x8b8f99, [0, 0, 0]), voxelBox([0.44, 0.08, 0.18], accent, [0, 0.12, 0]));
  } else if (item.weapon === 'sword') {
    g.add(voxelBox([0.07, 0.7, 0.07], 0xd7dde3, [0, 0.12, 0]), voxelBox([0.26, 0.07, 0.07], accent, [0, -0.2, 0]));
  } else if (item.weapon === 'spear') {
    g.add(voxelBox([0.06, 1.0, 0.06], 0x7a5530, [0, 0, 0]), voxelBox([0.12, 0.2, 0.12], accent, [0, 0.55, 0]));
  } else {
    g.add(
      voxelBox([0.06, 0.8, 0.06], 0x8a5a2b, [0, 0, 0]),
      voxelBox([0.12, 0.06, 0.06], 0x8a5a2b, [0.05, 0.4, 0]),
      voxelBox([0.12, 0.06, 0.06], 0x8a5a2b, [0.05, -0.4, 0]),
      voxelBox([0.02, 0.8, 0.02], accent, [0.12, 0, 0]),
    );
  }
  g.rotation.z = 0.5;
  return g;
}

/** A drop lying on the floor: bobbing icon plus a rarity-coloured light beam. */
export class Pickup {
  /** Co-op: the host's id for this drop. */
  netId = -1;
  readonly group = new THREE.Group();
  readonly pos: { x: number; z: number };
  /** Set after "bag full" is shown, until the player walks away. */
  warned = false;
  /** Seconds since spawned; loot can't be collected until it has landed. */
  age = 0;
  private readonly icon: THREE.Group;
  private time = Math.random() * 10;
  private readonly vel: { x: number; z: number };

  constructor(
    readonly drop: Drop,
    x: number,
    z: number,
    scatterAngle: number,
  ) {
    this.pos = { x, z };
    this.vel = { x: Math.sin(scatterAngle) * 3, z: Math.cos(scatterAngle) * 3 };
    this.icon = buildIcon(drop);
    this.group.add(this.icon);
    const rarity: Rarity = drop.type === 'potion' ? 'common' : drop.item.rarity;
    if (drop.type === 'item') {
      const beam = new THREE.Mesh(beamGeo, beamMaterial(rarity));
      beam.position.y = 1.5;
      this.group.add(beam);
    }
    this.group.position.set(x, 0, z);
  }

  get collectible(): boolean {
    return this.age > 0.45;
  }

  update(dt: number, canMove: (x: number, z: number) => boolean): void {
    this.time += dt;
    this.age += dt;
    // Brief scatter on spawn, stopped by walls.
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (canMove(nx, nz)) {
      this.pos.x = nx;
      this.pos.z = nz;
    }
    const decay = Math.exp(-6 * dt);
    this.vel.x *= decay;
    this.vel.z *= decay;
    this.group.position.set(this.pos.x, groundAt(this.pos.x, this.pos.z), this.pos.z);
    // Pop up out of the source, then settle into a gentle bob.
    const pop = Math.max(0, 1 - this.age / 0.45);
    this.icon.position.y = 0.55 + Math.sin(this.time * 3) * 0.1 + Math.sin(pop * Math.PI) * 0.8;
    this.icon.rotation.y = this.time * 1.8;
  }
}

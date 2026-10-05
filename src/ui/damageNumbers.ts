import { groundAt } from '../world/terrain';
import * as THREE from 'three';

const POOL = 48;
const LIFE = 0.9;

interface Num {
  el: HTMLSpanElement;
  x: number;
  y: number;
  z: number;
  /** Small sideways drift in screen pixels so stacked hits don't overlap. */
  drift: number;
  age: number;
  active: boolean;
}

/** Floating combat text, projected from world space onto a pooled set of DOM spans. */
export class DamageNumbers {
  private readonly layer: HTMLDivElement;
  private readonly nums: Num[] = [];
  private next = 0;
  private readonly v = new THREE.Vector3();

  constructor(root: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'dmg-layer';
    // First child, so it renders beneath every other HUD panel.
    root.prepend(this.layer);
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('span');
      el.className = 'dmg hidden';
      this.layer.appendChild(el);
      this.nums.push({ el, x: 0, y: 0, z: 0, drift: 0, age: 0, active: false });
    }
  }

  /** Damage as shown: exact up to 99,999, then compact (240K, 6.0M). */
  static format(amount: number): string {
    if (amount < 100_000) return String(amount);
    if (amount < 1_000_000) return `${Math.round(amount / 1000)}K`;
    if (amount < 1e9) return `${(amount / 1e6).toFixed(1)}M`;
    return `${(amount / 1e9).toFixed(1)}B`;
  }

  /** `kind` picks the style: enemy damage, crit, damage taken, or healing. */
  spawn(x: number, y: number, z: number, text: string, kind: 'hit' | 'crit' | 'hurt' | 'heal' | 'burn' | 'weak' | 'resist' | 'exposed' | 'note'): void {
    // Round-robin: when the pool is exhausted the oldest number is reused.
    const n = this.nums[this.next];
    this.next = (this.next + 1) % POOL;
    n.x = x;
    n.y = y + groundAt(x, z);
    n.z = z;
    n.drift = (Math.random() - 0.5) * 30;
    n.age = 0;
    n.active = true;
    n.el.textContent = text;
    n.el.className = `dmg ${kind}`;
  }

  get activeCount(): number {
    return this.nums.filter((n) => n.active).length;
  }

  clear(): void {
    for (const n of this.nums) {
      n.active = false;
      n.el.classList.add('hidden');
    }
  }

  update(dt: number, camera: THREE.Camera, width: number, height: number): void {
    for (const n of this.nums) {
      if (!n.active) continue;
      n.age += dt;
      if (n.age >= LIFE) {
        n.active = false;
        n.el.classList.add('hidden');
        continue;
      }
      const t = n.age / LIFE;
      this.v.set(n.x, n.y + t * 0.9, n.z).project(camera);
      if (this.v.z > 1) {
        n.el.style.opacity = '0';
        continue;
      }
      const sx = (this.v.x * 0.5 + 0.5) * width + n.drift * t;
      const sy = (-this.v.y * 0.5 + 0.5) * height;
      // Pop in, then fade over the second half.
      const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.6 : 1.2 - Math.min(0.2, (t - 0.12) * 0.8);
      n.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      n.el.style.opacity = String(t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5);
    }
  }
}

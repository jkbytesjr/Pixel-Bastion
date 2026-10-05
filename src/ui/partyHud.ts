import * as THREE from 'three';
import type { Player } from '../entities/player';
import type { RemotePlayer } from '../entities/remotePlayer';
import { groundAt } from '../world/terrain';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Co-op HUD: name tags over the other heroes and a party list with health bars. */
export class PartyHud {
  private readonly layer: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly tags = new Map<number, HTMLDivElement>();
  private readonly v = new THREE.Vector3();
  private lastList = '';

  constructor(root: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'name-tags';
    this.list = document.createElement('div');
    this.list.className = 'party-list hidden';
    root.append(this.layer, this.list);
  }

  /** Hide everything (left co-op). */
  clear(): void {
    for (const el of this.tags.values()) el.remove();
    this.tags.clear();
    this.list.classList.add('hidden');
    this.lastList = '';
  }

  update(me: { name: string; hero: Player }, others: RemotePlayer[], code: string, camera: THREE.Camera, width: number, height: number): void {
    // Name tags follow the other heroes on screen.
    const seen = new Set<number>();
    for (const r of others) {
      seen.add(r.netId);
      let el = this.tags.get(r.netId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'name-tag';
        this.layer.appendChild(el);
        this.tags.set(r.netId, el);
      }
      if (el.dataset.name !== r.name) {
        el.dataset.name = r.name;
        el.textContent = r.name;
      }
      this.v.set(r.pos.x, 2.15 + groundAt(r.pos.x, r.pos.z), r.pos.z).project(camera);
      const onScreen = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      el.style.display = onScreen ? '' : 'none';
      el.classList.toggle('down', !r.alive);
      if (onScreen) el.style.transform = `translate(${((this.v.x + 1) / 2) * width}px, ${((1 - this.v.y) / 2) * height}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of this.tags) {
      if (seen.has(id)) continue;
      el.remove();
      this.tags.delete(id);
    }
    // Party list, redrawn only when something changes.
    const rows = [
      { name: me.name, hp: me.hero.hp, max: me.hero.maxHp, alive: me.hero.alive, you: true },
      ...others.map((r) => ({ name: r.name, hp: r.hp, max: r.maxHp, alive: r.alive, you: false })),
    ];
    const key = code + rows.map((r) => `${r.name}:${Math.ceil((r.hp / Math.max(1, r.max)) * 50)}:${r.alive}`).join('|');
    if (key === this.lastList) return;
    this.lastList = key;
    this.list.classList.remove('hidden');
    this.list.innerHTML = `<div class="party-head">Co-op · Room <b>${esc(code)}</b></div>${rows
      .map(
        (r) => `<div class="party-row${r.alive ? '' : ' down'}">
          <span class="party-name">${esc(r.name)}${r.you ? ' (you)' : ''}</span>
          <span class="party-hp"><span style="width:${r.alive ? Math.max(0, Math.min(100, (r.hp / Math.max(1, r.max)) * 100)) : 0}%"></span></span>
        </div>`,
      )
      .join('')}`;
  }
}

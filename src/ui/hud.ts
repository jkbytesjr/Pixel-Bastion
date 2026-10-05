import type { Lesson } from '../world/tutorial';
import type { Player } from '../entities/player';
import type { Boss } from '../entities/boss';
import { xpToNext } from '../systems/progression';
import { RARITY_COLOR, describeModifier, type Item } from '../systems/loot';
import { iconFor } from './inventoryPanel';
import { DamageNumbers } from './damageNumbers';
import { describePower } from '../systems/powers';

const GLYPHS = {
  potion:
    '<svg viewBox="0 0 24 24"><path d="M9 2h6v3l3 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9l3-4z" fill="#c8323a"/><path d="M9 2h6v3H9z" fill="#8a6a40"/></svg>',
  slam: '<svg viewBox="0 0 24 24"><path d="M12 2v12M7 9l5 5 5-5" stroke="#f0d08a" stroke-width="2.4" fill="none"/><path d="M3 20h18M5 17l-2-2M19 17l2-2" stroke="#f0d08a" stroke-width="2"/></svg>',
  volley:
    '<svg viewBox="0 0 24 24"><path d="M4 20L18 6M4 20l5-14M4 20l14-5" stroke="#b08050" stroke-width="2"/><path d="M18 6l3-3-1 4zM9 6l1-4 1 4zM18 15l4-1-4-1z" fill="#e8eef4" stroke="#e8eef4" stroke-width="1.4"/></svg>',
  dodge: '<svg viewBox="0 0 24 24"><path d="M5 5l7 7-7 7M12 5l7 7-7 7" stroke="#e8e8e8" stroke-width="2.4" fill="none"/></svg>',
};

type AbilityName = keyof typeof GLYPHS;

export interface RunSummary {
  seed: number;
  /** Floor reached (1-based). */
  floor: number;
  time: number;
  kills: number;
  /** Deepest floor ever reached on this browser. */
  best: number;
  newBest: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

function ability(name: AbilityName, key: string, title: string): string {
  const count = name === 'potion' ? '<span class="potion-count"></span>' : '';
  return `<div class="ability" data-ability="${name}" title="${title}">
    <span class="ability-glyph">${GLYPHS[name]}</span>${count}
    <span class="ability-key">${key}</span>
    <div class="ability-shade"></div>
  </div>`;
}

/** DOM overlay: vitals, XP, ability cooldowns, boss bar, toasts, end screens. */
export class Hud {
  /** Called when the player picks "New run" on the death screen. */
  onNewRun: () => void = () => {};
  /** Called when the player picks "Main menu" on the death screen. */
  onMenu: () => void = () => {};
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  private readonly abilities = new Map<AbilityName, { el: HTMLElement; shade: HTMLElement; last: number }>();
  private readonly potionCount: HTMLSpanElement;
  private readonly xpFill: HTMLDivElement;
  private readonly levelBadge: HTMLSpanElement;
  private readonly deathScreen: HTMLDivElement;
  private readonly floorLabel: HTMLDivElement;
  private readonly bossBar: HTMLDivElement;
  private readonly bossName: HTMLDivElement;
  private readonly bossFill: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly runInfo: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly controls: HTMLDivElement;
  private readonly soundHint: HTMLSpanElement;
  private readonly gearWeapon: HTMLDivElement;
  private readonly gearArmor: HTMLDivElement;
  private shownWeapon: Item | null = null;
  private shownArmor: Item | null | undefined = undefined;
  private readonly tutorialBox: HTMLDivElement;
  private readonly levelReady: HTMLButtonElement;
  private lastTutorial = '';
  private lastLevelReady = '';
  /** Tutorial "Skip" clicked. */
  onSkipTutorial: () => void = () => {};
  /** "Attribute ready" badge clicked. */
  onLevelReady: () => void = () => {};
  private bannerTimer = 0;
  private lastHp = -1;
  private lastRunText = '';
  private lastBossHp = -1;

  constructor(
    private readonly root: HTMLElement,
    onRestart: () => void,
  ) {
    root.innerHTML = `
      <div class="vignette"></div>
      <div class="hurt-flash"></div>
      <div class="floor-label"></div>
      <div class="admin-badge hidden">ADMIN</div>
      <div class="run-info"></div>
      <div class="boss-bar hidden"><div class="boss-name"></div><div class="boss-track"><div class="boss-fill"></div></div></div>
      <div class="toasts"></div>
      <div class="tutorial-box hidden"></div>
      <button type="button" class="levelup-ready hidden" title="Choose your attribute now (L)"></button>
      <div class="boss-banner hidden" aria-live="polite">
        <div class="bb-rays"></div>
        <div class="bb-kicker">Boss defeated</div>
        <div class="bb-name"></div>
        <div class="bb-sub"></div>
      </div>
      <div class="hud-bottom">
        <div class="gear">
          <div class="gear-slot" data-gear="weapon"></div>
          <div class="gear-slot" data-gear="armor"></div>
        </div>
        ${ability('potion', '1', 'Health potion (1)')}
        <div class="vitals">
          <div class="hp-bar"><div class="hp-fill"></div><span class="hp-text"></span></div>
          <div class="xp-row"><span class="level-badge"></span><div class="xp-bar"><div class="xp-fill"></div></div></div>
        </div>
        ${ability('slam', 'Q', 'Ground slam (Q)')}
        ${ability('volley', 'E', 'Spear volley (E)')}
        ${ability('dodge', 'SPACE', 'Dodge roll (Space)')}
      </div>
      <div class="key-hint">Tab · Inventory &nbsp; H · Controls &nbsp; M · <span class="sound-hint">Sound on</span></div>
      <div class="controls-panel hidden">
        <h2>Controls</h2>
        <dl>
          <dt>W A S D</dt><dd>Move: W toward the mouse, S away, A/D circle (or screen-relative, set in the menu)</dd>
          <dt>Mouse</dt><dd>Aim</dd>
          <dt>Left click</dt><dd>Attack (hold to keep swinging)</dd>
          <dt>Space</dt><dd>Dodge roll (brief invulnerability)</dd>
          <dt>Q</dt><dd>Ground slam</dd>
          <dt>E</dt><dd>Spear volley</dd>
          <dt>1</dt><dd>Drink a health potion</dd>
          <dt>L</dt><dd>Choose a level-up attribute now (otherwise it waits until you're out of combat)</dd>
          <dt>Tab / I</dt><dd>Inventory (pauses)</dd>
          <dt>Esc</dt><dd>Pause, or save &amp; quit to the menu</dd>
          <dt>M</dt><dd>Mute / unmute</dd>
          <dt>F3</dt><dd>FPS meter</dd>
        </dl>
        <p class="hint">Find the boss on each floor, then step into the portal it leaves behind. Press H to close.</p>
      </div>
      <div class="screen death hidden">
        <h1>You have fallen</h1>
        <p class="summary"></p>
        <p class="best"></p>
        <div class="row">
          <button type="button" class="btn restart">Try again</button>
          <button type="button" class="btn secondary new-run">New run</button>
          <button type="button" class="btn secondary to-menu">Main menu</button>
        </div>
        <p class="hint">Try again replays this seed (or press R). New run rolls a new dungeon.</p>
      </div>`;
    this.hpFill = root.querySelector('.hp-fill')!;
    this.hpText = root.querySelector('.hp-text')!;
    root.querySelectorAll<HTMLElement>('[data-ability]').forEach((el) => {
      this.abilities.set(el.dataset.ability as AbilityName, { el, shade: el.querySelector('.ability-shade')!, last: -1 });
    });
    this.potionCount = root.querySelector('.potion-count')!;
    this.xpFill = root.querySelector('.xp-fill')!;
    this.levelBadge = root.querySelector('.level-badge')!;
    this.deathScreen = root.querySelector('.death')!;
    this.floorLabel = root.querySelector('.floor-label')!;
    this.bossBar = root.querySelector('.boss-bar')!;
    this.bossName = root.querySelector('.boss-name')!;
    this.bossFill = root.querySelector('.boss-fill')!;
    this.toasts = root.querySelector('.toasts')!;
    this.runInfo = root.querySelector('.run-info')!;
    this.gearWeapon = root.querySelector('[data-gear="weapon"]')!;
    this.gearArmor = root.querySelector('[data-gear="armor"]')!;
    this.vignette = root.querySelector('.vignette')!;
    this.flash = root.querySelector('.hurt-flash')!;
    this.controls = root.querySelector('.controls-panel')!;
    this.soundHint = root.querySelector('.sound-hint')!;
    this.tutorialBox = root.querySelector('.tutorial-box')!;
    this.levelReady = root.querySelector('.levelup-ready')!;
    this.levelReady.addEventListener('click', () => this.onLevelReady());
    root.querySelector('.restart')!.addEventListener('click', onRestart);
    root.querySelector('.new-run')!.addEventListener('click', () => this.onNewRun());
    root.querySelector('.to-menu')!.addEventListener('click', () => this.onMenu());
  }

  /** The tutorial checklist, or null to hide it. */
  setTutorial(lesson: Lesson | null): void {
    const key = lesson ? JSON.stringify(lesson) : '';
    if (key === this.lastTutorial) return;
    this.lastTutorial = key;
    this.tutorialBox.classList.toggle('hidden', !lesson);
    if (!lesson) return;
    const done = lesson.steps.every(([, d]) => d);
    this.tutorialBox.innerHTML = `
      <div class="tut-head"><span class="tut-kicker">Tutorial</span><b>${lesson.title}</b><button type="button" class="link tut-skip">Skip tutorial</button></div>
      <ul>${lesson.steps.map(([text, d]) => `<li class="${d ? 'done' : ''}">${text}</li>`).join('')}</ul>
      ${done && lesson.next ? `<p class="tut-next">${lesson.next}</p>` : ''}`;
    this.tutorialBox.querySelector('.tut-skip')!.addEventListener('click', () => this.onSkipTutorial());
  }

  /**
   * Badge for level-up picks waiting for a quiet moment.
   * @param picks Picks queued (0 hides it).
   * @param fighting Still in combat, so the choice is being held back.
   */
  setLevelReady(picks: number, fighting: boolean): void {
    const key = picks > 0 ? `${picks}:${fighting}` : '';
    if (key === this.lastLevelReady) return;
    this.lastLevelReady = key;
    this.levelReady.classList.toggle('hidden', picks <= 0);
    this.levelReady.classList.toggle('waiting', fighting);
    this.levelReady.innerHTML = `<b>▲ Level up${picks > 1 ? ` ×${picks}` : ''}</b><span>${fighting ? 'Choice waits until the fight is over · L to choose now' : 'Choosing…'}</span>`;
  }

  update(player: Player): void {
    if (player.hp !== this.lastHp) {
      this.lastHp = player.hp;
      this.hpFill.style.width = `${(player.hp / player.maxHp) * 100}%`;
      this.hpText.textContent = `${DamageNumbers.format(Math.ceil(player.hp))} / ${DamageNumbers.format(player.maxHp)}`;
      const low = player.alive && player.hp / player.maxHp < 0.3;
      this.vignette.classList.toggle('low', low);
    }
    this.setAbility('dodge', player.dodgeCooldown / player.dodgeCooldownMax);
    this.setAbility('slam', player.slamCooldown / player.slamCooldownMax);
    this.setAbility('volley', player.volleyCooldown / player.volleyCooldownMax);
    const potions = player.inventory.potions;
    this.setAbility('potion', potions > 0 ? player.potionCooldown : 1);
    this.potionCount.textContent = String(potions);
    const inv = player.inventory;
    if (inv.weapon !== this.shownWeapon) {
      this.shownWeapon = inv.weapon;
      this.renderGear(this.gearWeapon, inv.weapon, 'Weapon');
    }
    if (inv.armor !== this.shownArmor) {
      this.shownArmor = inv.armor;
      this.renderGear(this.gearArmor, inv.armor, 'Armor');
    }
    const { level, xp } = player.progress;
    this.levelBadge.textContent = `Lv ${level}`;
    this.xpFill.style.width = `${Math.min(100, (xp / xpToNext(level)) * 100)}%`;
  }

  /** Equipped-item slot: icon framed in its rarity colour, details on hover. */
  private renderGear(el: HTMLElement, item: Item | null, label: string): void {
    if (!item) {
      el.className = 'gear-slot empty';
      el.innerHTML = `<span>${label}</span>`;
      el.title = `No ${label.toLowerCase()} equipped`;
      el.style.removeProperty('--rarity');
      return;
    }
    el.className = 'gear-slot';
    el.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    el.innerHTML = iconFor(item);
    const base = item.kind === 'weapon' ? `${item.damage} damage` : `${item.armor} armor, +${item.maxHp} max HP`;
    const powers = item.kind === 'weapon' ? (item.powers ?? []).map(describePower) : [];
    el.title = [item.name, base, ...item.mods.map(describeModifier), ...powers].join('\n');
    el.classList.toggle('mythic', item.rarity === 'mythic');
    el.classList.toggle('admin', item.rarity === 'admin');
  }

  private setAbility(name: AbilityName, cooldownFraction: number): void {
    const a = this.abilities.get(name)!;
    // Quantize so the DOM is only touched when the shade visibly changes.
    const f = Math.round(Math.max(0, Math.min(1, cooldownFraction)) * 100) / 100;
    if (f === a.last) return;
    a.last = f;
    a.shade.style.height = `${f * 100}%`;
    a.el.classList.toggle('ready', f <= 0);
  }

  updateBoss(boss: Boss | null): void {
    const show = !!boss && boss.engaged && boss.alive;
    this.bossBar.classList.toggle('hidden', !show);
    if (!show || boss.hp === this.lastBossHp) return;
    this.lastBossHp = boss.hp;
    this.bossName.textContent = boss.name;
    this.bossFill.style.width = `${(boss.hp / boss.maxHp) * 100}%`;
  }

  /** Run timer and kill count under the floor label. */
  setRunInfo(seconds: number, kills: number): void {
    const text = `${formatTime(seconds)} · ${kills} kill${kills === 1 ? '' : 's'}`;
    if (text === this.lastRunText) return;
    this.lastRunText = text;
    this.runInfo.textContent = text;
  }

  /** Red edge flash when the player takes damage. */
  hurt(): void {
    this.flash.classList.remove('on');
    // Force a reflow so the animation restarts on rapid hits.
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  toggleControls(show = this.controls.classList.contains('hidden')): void {
    this.controls.classList.toggle('hidden', !show);
  }

  get deathShown(): boolean {
    return !this.deathScreen.classList.contains('hidden');
  }

  get controlsOpen(): boolean {
    return !this.controls.classList.contains('hidden');
  }

  setMuted(muted: boolean): void {
    this.soundHint.textContent = muted ? 'Sound off' : 'Sound on';
  }

  setFloor(floor: number, seed: number, tutorial = false): void {
    this.floorLabel.textContent = tutorial ? 'Tutorial' : `Floor ${floor} · Seed ${seed}`;
  }

  /** Short message in the upper middle of the screen. */
  toast(text: string, tone: 'info' | 'good' | 'danger' | 'loot' = 'info', color?: string): void {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    if (color) el.style.color = color;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 2600);
  }

  /** Big "boss defeated" title card; hides itself after a few seconds. */
  bossDefeated(name: string, floor: number): void {
    const el = this.root.querySelector<HTMLElement>('.boss-banner')!;
    el.querySelector('.bb-name')!.textContent = name;
    el.querySelector('.bb-sub')!.textContent = `Floor ${floor} cleared · the portal is open`;
    el.classList.remove('hidden', 'show');
    // Reflow so the entrance animation replays for back-to-back bosses.
    void el.offsetWidth;
    el.classList.add('show');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => el.classList.add('hidden'), 4200);
  }

  setAdmin(on: boolean): void {
    this.root.querySelector('.admin-badge')!.classList.toggle('hidden', !on);
  }

  /** Hide gameplay HUD (title screen) or show it. */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('hud-off', !visible);
  }

  /** Death screen with the run's summary; `null` hides it. */
  /**
   * Death screen wording and buttons: solo, co-op host (restarts for everyone)
   * or co-op guest (waits for the host).
   */
  setDeathMode(mode: 'solo' | 'host' | 'guest'): void {
    const s = this.deathScreen;
    s.querySelector('h1')!.textContent = mode === 'solo' ? 'You have fallen' : 'Your party has fallen';
    s.querySelector<HTMLElement>('.restart')!.style.display = mode === 'guest' ? 'none' : '';
    s.querySelector<HTMLElement>('.new-run')!.style.display = mode === 'guest' ? 'none' : '';
    s.querySelector('.to-menu')!.textContent = mode === 'solo' ? 'Main menu' : 'Leave co-op';
    s.querySelector('.hint')!.textContent =
      mode === 'solo'
        ? 'Try again replays this seed (or press R). New run rolls a new dungeon.'
        : mode === 'host'
          ? 'Try again replays this seed for the whole party. New run rolls a new dungeon for everyone.'
          : 'Waiting for the host to start again…';
  }

  showDeath(summary: RunSummary | null): void {
    this.deathScreen.classList.toggle('hidden', !summary);
    if (!summary) return;
    this.deathScreen.querySelector('.summary')!.textContent =
      `Reached floor ${summary.floor} in ${formatTime(summary.time)} with ${summary.kills} kills · Seed ${summary.seed}`;
    this.deathScreen.querySelector('.best')!.textContent = summary.newBest
      ? `New best: floor ${summary.best}!`
      : `Best: floor ${summary.best}`;
    this.deathScreen.querySelector('.best')!.classList.toggle('new', summary.newBest);
  }
}

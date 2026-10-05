import type { RunSave } from '../systems/save';

export type MoveMode = 'mouse' | 'screen';

export interface MenuInfo {
  save: RunSave | null;
  best: number;
  moveMode: MoveMode;
  muted: boolean;
  /** Mods switched on. */
  mods: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Title screen: continue a saved run, start a new one, or play a seed. */
export class MainMenu {
  onContinue: () => void = () => {};
  /** `seed` is null for a random dungeon. */
  onNewRun: (seed: number | null) => void = () => {};
  onMoveMode: (mode: MoveMode) => void = () => {};
  onToggleSound: () => void = () => {};
  onControls: () => void = () => {};
  onCoop: () => void = () => {};
  onCharacter: () => void = () => {};
  onMods: () => void = () => {};
  onTutorial: () => void = () => {};
  /** Hidden: clicking the title five times quickly. */
  onSecret: () => void = () => {};
  private readonly el: HTMLDivElement;
  private info: MenuInfo | null = null;
  private titleClicks: number[] = [];

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'main-menu hidden';
    root.appendChild(this.el);
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(info: MenuInfo): void {
    this.info = info;
    this.render();
    this.el.classList.remove('hidden');
    // Focus the main action so Enter starts playing.
    this.el.querySelector<HTMLButtonElement>('.menu-primary')?.focus();
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  private render(): void {
    const info = this.info!;
    const s = info.save;
    const cont = s
      ? `<button type="button" class="menu-btn menu-primary" data-act="continue">
          <span class="menu-btn-title">Continue</span>
          <span class="menu-btn-sub">Floor ${s.depth + 1} · Level ${s.progress.level} · ${formatTime(s.runTime)} · saved ${ago(s.savedAt)}</span>
        </button>`
      : '';
    this.el.innerHTML = `
      <div class="menu-panel">
        <h1 class="menu-title" aria-label="Pixel Bastion"><span>PIXEL</span><span>BASTION</span></h1>
        <p class="menu-tag">How deep can you go?</p>
        <div class="menu-actions">
          ${cont}
          <button type="button" class="menu-btn ${s ? '' : 'menu-primary'}" data-act="new">
            <span class="menu-btn-title">New run</span>
            <span class="menu-btn-sub">${s ? 'Replaces your saved run' : 'A fresh, random dungeon'}</span>
          </button>
          <button type="button" class="menu-btn" data-act="coop">
            <span class="menu-btn-title">Co-op</span>
            <span class="menu-btn-sub">Play online with up to 3 friends</span>
          </button>
          <div class="menu-row2">
            <button type="button" class="menu-btn small" data-act="character">Character</button>
            <button type="button" class="menu-btn small" data-act="mods">Mods${info.mods ? ` <b class="mod-count">${info.mods}</b>` : ''}</button>
          </div>
          <form class="menu-seed">
            <input name="seed" inputmode="numeric" autocomplete="off" placeholder="Seed, e.g. 12345" aria-label="Seed" />
            <button type="submit" class="menu-btn small">Play seed</button>
          </form>
        </div>
        <div class="menu-settings">
          <div class="menu-setting">
            <span>Movement</span>
            <div class="seg" role="group" aria-label="Movement">
              <button type="button" data-move="mouse" class="${info.moveMode === 'mouse' ? 'on' : ''}">Toward mouse</button>
              <button type="button" data-move="screen" class="${info.moveMode === 'screen' ? 'on' : ''}">Screen</button>
            </div>
          </div>
          <div class="menu-setting">
            <span>Sound</span>
            <div class="seg"><button type="button" data-act="sound" class="on">${info.muted ? 'Off' : 'On'}</button></div>
          </div>
        </div>
        <div class="menu-foot">
          <span>${info.best > 0 ? `Best: floor ${info.best}` : 'No runs yet'}</span>
          <span class="menu-links">
            <button type="button" class="link" data-act="tutorial">Tutorial</button>
            <button type="button" class="link" data-act="controls">Controls</button>
          </span>
        </div>
      </div>`;

    this.el.querySelector('.menu-title')!.addEventListener('click', () => {
      const now = performance.now();
      this.titleClicks = [...this.titleClicks.filter((t) => now - t < 2500), now];
      if (this.titleClicks.length >= 5) {
        this.titleClicks = [];
        this.onSecret();
      }
    });
    this.el.querySelector('[data-act="continue"]')?.addEventListener('click', () => this.onContinue());
    this.el.querySelector('[data-act="new"]')!.addEventListener('click', () => this.onNewRun(null));
    this.el.querySelector('[data-act="sound"]')!.addEventListener('click', () => this.onToggleSound());
    this.el.querySelector('[data-act="controls"]')!.addEventListener('click', () => this.onControls());
    this.el.querySelector('[data-act="character"]')!.addEventListener('click', () => this.onCharacter());
    this.el.querySelector('[data-act="coop"]')!.addEventListener('click', () => this.onCoop());
    this.el.querySelector('[data-act="mods"]')!.addEventListener('click', () => this.onMods());
    this.el.querySelector('[data-act="tutorial"]')!.addEventListener('click', () => this.onTutorial());
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.el.querySelector<HTMLInputElement>('input[name="seed"]')!;
      const seed = Number.parseInt(input.value.trim(), 10);
      if (!Number.isFinite(seed)) {
        input.classList.add('bad');
        input.focus();
        return;
      }
      this.onNewRun(seed >>> 0);
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
      b.addEventListener('click', () => {
        this.onMoveMode(b.dataset.move as MoveMode);
        this.info!.moveMode = b.dataset.move as MoveMode;
        this.render();
      }),
    );
  }

  /** Refresh the mod count after mods change. */
  setModCount(n: number): void {
    if (!this.info) return;
    this.info.mods = n;
    if (this.open) this.render();
  }

  /** Refresh the sound label after a toggle. */
  setMuted(muted: boolean): void {
    if (!this.info) return;
    this.info.muted = muted;
    if (this.open) this.render();
  }
}

/** Esc menu during a run. */
export class PauseMenu {
  onResume: () => void = () => {};
  onSaveQuit: () => void = () => {};
  onControls: () => void = () => {};
  private readonly el: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pause-menu hidden';
    this.el.innerHTML = `
      <div class="menu-panel small">
        <h2>Paused</h2>
        <button type="button" class="menu-btn menu-primary" data-act="resume"><span class="menu-btn-title">Resume</span></button>
        <button type="button" class="menu-btn" data-act="controls"><span class="menu-btn-title">Controls</span></button>
        <button type="button" class="menu-btn" data-act="save">
          <span class="menu-btn-title">Save &amp; quit to menu</span>
          <span class="menu-btn-sub">Continue later from the start of this floor, with your gear and level</span>
        </button>
        <p class="coop-note hidden">Co-op keeps running while this menu is open.</p>
      </div>`;
    root.appendChild(this.el);
    this.el.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.onResume());
    this.el.querySelector('[data-act="controls"]')!.addEventListener('click', () => this.onControls());
    this.el.querySelector('[data-act="save"]')!.addEventListener('click', () => this.onSaveQuit());
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /** In co-op the game doesn't pause, and leaving replaces save & quit. */
  setCoop(on: boolean): void {
    this.el.querySelector('h2')!.textContent = on ? 'Menu' : 'Paused';
    this.el.querySelector('[data-act="save"] .menu-btn-title')!.textContent = on ? 'Leave co-op' : 'Save & quit to menu';
    this.el.querySelector('[data-act="save"] .menu-btn-sub')!.textContent = on
      ? 'Co-op runs are not saved'
      : 'Continue later from the start of this floor, with your gear and level';
    this.el.querySelector('.coop-note')!.classList.toggle('hidden', !on);
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('hidden', !open);
    if (open) this.el.querySelector<HTMLButtonElement>('[data-act="resume"]')!.focus();
  }
}

const SKIP_PROMPT_KEY = 'voxel-dungeon:skip-tutorial-prompt';

/** Has the player asked not to be offered the tutorial again? */
export function tutorialPromptSuppressed(): boolean {
  try {
    return window.localStorage.getItem(SKIP_PROMPT_KEY) === '1';
  } catch {
    return false;
  }
}

/** "Play the tutorial first?" asked when starting a new run. */
export class TutorialPrompt {
  /** `tutorial` is true to play it first. */
  onAnswer: (tutorial: boolean) => void = () => {};
  private readonly el: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pause-menu tutorial-prompt hidden';
    this.el.innerHTML = `
      <div class="menu-panel small" role="dialog" aria-labelledby="tp-title">
        <h2 id="tp-title">Play the tutorial first?</h2>
        <p class="tp-text">A short walk through six rooms: moving, fighting, dodging, abilities, loot and a boss. About three minutes, then your run starts.</p>
        <button type="button" class="menu-btn menu-primary" data-act="yes">
          <span class="menu-btn-title">Yes, show me how to play</span>
        </button>
        <button type="button" class="menu-btn" data-act="no">
          <span class="menu-btn-title">No, start the run</span>
        </button>
        <label class="tp-check"><input type="checkbox" /> Don’t ask again (the tutorial stays on the title screen)</label>
      </div>`;
    root.appendChild(this.el);
    const answer = (yes: boolean) => {
      if (this.el.querySelector<HTMLInputElement>('.tp-check input')!.checked) {
        try {
          window.localStorage.setItem(SKIP_PROMPT_KEY, '1');
        } catch {
          // Will ask again next time.
        }
      }
      this.setOpen(false);
      this.onAnswer(yes);
    };
    this.el.querySelector('[data-act="yes"]')!.addEventListener('click', () => answer(true));
    this.el.querySelector('[data-act="no"]')!.addEventListener('click', () => answer(false));
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('hidden', !open);
    if (open) this.el.querySelector<HTMLButtonElement>('[data-act="yes"]')!.focus();
  }
}

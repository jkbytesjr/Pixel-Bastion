import type { LobbyPlayer } from '../net/coop';
import { MAX_PLAYERS } from '../net/protocol';

const NAME_KEY = 'voxel-dungeon:coop-name';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function savedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Co-op from the title screen: host a room or join one with a code, then wait in the lobby. */
export class CoopPanel {
  onHost: (name: string) => void = () => {};
  onJoin: (name: string, code: string) => void = () => {};
  onStart: () => void = () => {};
  onLeave: () => void = () => {};
  onBack: () => void = () => {};
  private readonly el: HTMLDivElement;
  private view: 'choose' | 'busy' | 'lobby' = 'choose';
  private error = '';
  private busyText = '';
  private lobby: { code: string; host: boolean; players: LobbyPlayer[]; you: number } | null = null;
  private code = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pause-menu coop-panel hidden';
    root.appendChild(this.el);
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /** Show the host / join choice (optionally with a code filled in from a link). */
  show(code = ''): void {
    this.view = 'choose';
    this.error = '';
    this.code = code;
    this.render();
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  busy(text: string): void {
    this.view = 'busy';
    this.busyText = text;
    this.render();
  }

  fail(message: string): void {
    this.view = 'choose';
    this.error = message;
    this.render();
  }

  showLobby(code: string, host: boolean, players: LobbyPlayer[], you: number): void {
    this.view = 'lobby';
    this.lobby = { code, host, players, you };
    this.render();
    this.el.classList.remove('hidden');
  }

  private name(): string {
    const input = this.el.querySelector<HTMLInputElement>('input[name="name"]');
    const name = (input?.value ?? '').trim() || 'Adventurer';
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch {
      // Not remembered; fine.
    }
    return name;
  }

  private render(): void {
    if (this.view === 'busy') {
      this.el.innerHTML = `<div class="menu-panel small coop-box"><h2>Co-op</h2><p class="coop-busy">${esc(this.busyText)}</p></div>`;
      return;
    }
    if (this.view === 'lobby' && this.lobby) {
      const { code, host, players, you } = this.lobby;
      const link = `${window.location.origin}${window.location.pathname}?join=${code}`;
      const slots = Array.from({ length: MAX_PLAYERS }, (_, i) => {
        const p = players[i];
        if (!p) return '<li class="coop-slot empty">Waiting for a player…</li>';
        const tags = [p.id === 0 ? 'host' : '', p.id === you ? 'you' : ''].filter(Boolean).join(', ');
        return `<li class="coop-slot"><b>${esc(p.name)}</b>${tags ? ` <span>(${tags})</span>` : ''}</li>`;
      }).join('');
      this.el.innerHTML = `
        <div class="menu-panel small coop-box">
          <h2>Co-op lobby</h2>
          <p class="coop-label">Room code</p>
          <div class="coop-code" data-act="copy-code" title="Click to copy">${code}</div>
          <button type="button" class="link coop-copy" data-act="copy-link">Copy invite link</button>
          <ul class="coop-players">${slots}</ul>
          ${
            host
              ? `<button type="button" class="menu-btn menu-primary" data-act="start"><span class="menu-btn-title">Start run</span><span class="menu-btn-sub">${players.length > 1 ? `${players.length} players` : 'Friends can still join after you start'}</span></button>`
              : '<p class="coop-wait">Waiting for the host to start…</p>'
          }
          <button type="button" class="menu-btn" data-act="leave"><span class="menu-btn-title">${host ? 'Close room' : 'Leave'}</span></button>
          <p class="coop-msg"></p>
        </div>`;
      const msg = this.el.querySelector<HTMLParagraphElement>('.coop-msg')!;
      const copy = (text: string, done: string) => {
        navigator.clipboard?.writeText(text).then(
          () => (msg.textContent = done),
          () => (msg.textContent = text),
        );
      };
      this.el.querySelector('[data-act="copy-code"]')!.addEventListener('click', () => copy(code, 'Code copied.'));
      this.el.querySelector('[data-act="copy-link"]')!.addEventListener('click', () => copy(link, 'Invite link copied: send it to your friends.'));
      this.el.querySelector('[data-act="start"]')?.addEventListener('click', () => this.onStart());
      this.el.querySelector('[data-act="leave"]')!.addEventListener('click', () => this.onLeave());
      return;
    }
    this.el.innerHTML = `
      <div class="menu-panel small coop-box">
        <h2>Co-op</h2>
        <p class="tp-text">Play with up to ${MAX_PLAYERS - 1} friends. One of you hosts and shares the room code; everyone else joins with it.</p>
        <label class="coop-field"><span>Your name</span><input name="name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Adventurer" value="${esc(savedName())}" /></label>
        <button type="button" class="menu-btn menu-primary" data-act="host"><span class="menu-btn-title">Host a game</span><span class="menu-btn-sub">Get a code to share</span></button>
        <form class="menu-seed coop-join">
          <input name="code" maxlength="6" autocomplete="off" spellcheck="false" placeholder="Room code" value="${esc(this.code)}" aria-label="Room code" />
          <button type="submit" class="menu-btn small">Join</button>
        </form>
        ${this.error ? `<p class="coop-error">${esc(this.error)}</p>` : ''}
        <button type="button" class="link" data-act="back">Back</button>
      </div>`;
    this.el.querySelector('[data-act="host"]')!.addEventListener('click', () => this.onHost(this.name()));
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.el.querySelector<HTMLInputElement>('input[name="code"]')!.value;
      this.onJoin(this.name(), code);
    });
    this.el.querySelector('[data-act="back"]')!.addEventListener('click', () => this.onBack());
    if (this.code) this.el.querySelector<HTMLInputElement>('input[name="name"]')!.focus();
  }
}

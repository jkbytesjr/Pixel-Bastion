import * as THREE from 'three';
import { CameraRig } from './cameraRig';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { atmosphereFor } from '../world/voxelBuilder';
import { groundAt } from '../world/terrain';
import { Input } from './input';
import { EventBus } from './events';
import { GameWorld } from './gameWorld';
import { generateDungeon, type EnemyKind } from '../world/dungeonGen';
import { cutoutUniforms } from '../world/wallCutout';
import { FpsMeter } from '../ui/fpsMeter';
import { Hud, type RunSummary } from '../ui/hud';
import { MainMenu, PauseMenu, TutorialPrompt, tutorialPromptSuppressed, type MoveMode } from '../ui/menus';
import { CharacterPanel } from '../ui/characterPanel';
import { buildRuneBurst } from '../entities/gearModel';
import { ModsPanel } from '../ui/modsPanel';
import { ModManager } from '../systems/modLoader';
import { ModRegistry, activeMods, setActiveMods } from '../systems/mods';
import { CoopSession, type CoopGame } from '../net/coop';
import { makeRoomCode, normalizeRoomCode } from '../net/protocol';
import { CoopPanel } from '../ui/coopPanel';
import { PartyHud } from '../ui/partyHud';
import { loadAppearance, storeAppearance } from '../systems/appearance';
import { TUTORIAL_BOSS_HP, buildTutorial, lessonFor, newTutorialProgress, roomAt, type TutorialProgress } from '../world/tutorial';
import type { Dungeon } from '../world/dungeonGen';
import { AdminConsole } from '../ui/adminConsole';
import { COMMANDS, intArg, parseCommand, type ParsedCommand } from '../systems/admin';
import { PERKS, PERK_IDS, applyPerk, type PerkId } from '../systems/perks';
import { ADMIN_MAX_LEVEL, MAX_LEVEL } from '../systems/progression';
import { BAG_SIZE, MAX_POTIONS } from '../systems/inventory';
import { RARITIES } from '../systems/loot';
import { SAVE_VERSION, clearSave, loadSave, writeSave, type RunSave } from '../systems/save';
import { InventoryPanel } from '../ui/inventoryPanel';
import { RARITY_COLOR, makeAdminItem, rollItem, type AdminGearKind, type Rarity } from '../systems/loot';
import { Rng } from './rng';
import { createEnemy } from '../entities/enemyFactory';
import type { Enemy } from '../entities/enemy';
import { FixedStep } from './fixedStep';
import { Particles } from '../systems/particles';
import { Sfx } from '../systems/audio';
import { DamageNumbers } from '../ui/damageNumbers';
import { Minimap } from '../ui/minimap';
import { LevelUpPanel } from '../ui/levelUpPanel';
import { rollPerkChoices } from '../systems/perks';
import { hashSeed } from './rng';

/** Longest real frame we account for; anything longer (tab switch, debugger) is dropped. */
const MAX_FRAME = 0.25;

/** Debris colors per enemy kind. */
const GIBS: Record<string, [number, number]> = {
  grunt: [0x6f8f52, 0x6b4a2e],
  archer: [0x4a3a66, 0xc9b9a6],
  exploder: [0xb4522c, 0xff8a3c],
  spider: [0x3a3044, 0x6a9a3a],
  shieldbearer: [0x8a909c, 0x6b4524],
  shaman: [0x6a7a5a, 0x6fe07a],
  wraith: [0x9fb4c8, 0x7ff0ff],
  boss: [0x2c2b33, 0xa070ff],
};

const BEST_KEY = 'voxel-dungeon:best-floor';

/** Deepest floor reached on this browser (0 if never played, or storage is blocked). */
function loadBestFloor(): number {
  try {
    return Number.parseInt(window.localStorage.getItem(BEST_KEY) ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveBestFloor(floor: number): void {
  try {
    window.localStorage.setItem(BEST_KEY, String(floor));
  } catch {
    // Storage unavailable; the record just won't persist.
  }
}

/** Seed from ?seed=123 in the URL, or null. A seed in the URL skips the title screen. */
function urlSeed(): number | null {
  const param = new URLSearchParams(window.location.search).get('seed');
  const parsed = param === null ? NaN : Number.parseInt(param, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

const randomSeed = () => Math.floor(Math.random() * 1e9);

const MOVE_KEY = 'voxel-dungeon:move-mode';

function loadMoveMode(): MoveMode {
  try {
    return window.localStorage.getItem(MOVE_KEY) === 'screen' ? 'screen' : 'mouse';
  } catch {
    return 'mouse';
  }
}

/** Slow motion after a boss kill: real seconds, and the simulation speed meanwhile. */
/** Seconds out of combat before a level-up choice pops up. */
const LEVELUP_CALM = 1.5;
const BOSS_SLOWMO = 1.4;
const SLOWMO_SCALE = 0.3;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  /** Render, then bloom (glowing crystals, runes, flames, magic), then output. */
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly hemi = new THREE.HemisphereLight(0x8a8fb8, 0x2a2018, 1.6);
  private readonly sun = new THREE.DirectionalLight(0x9aa6ff, 0.6);
  /** Sun height in radians for the current floor's mood (low sun, long shadows). */
  private sunElevation = 0.6;
  /** Seconds of very low frame rate at the lowest resolution: shadows are dropped after a while. */
  private lowFpsTime = 0;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly events = new EventBus();
  private readonly world: GameWorld;
  private readonly hud: Hud;
  private readonly inventory: InventoryPanel;
  private readonly minimap: Minimap;
  private readonly levelUp: LevelUpPanel;
  /** Smoke tests set this so level-ups don't stop the game waiting for a choice. */
  autoPerk = false;
  private readonly damageNumbers: DamageNumbers;
  readonly particles = new Particles();
  readonly sfx = new Sfx();
  private readonly fps = new FpsMeter();
  private readonly stepper = new FixedStep(1 / 60);
  private lastTime = -1;
  /** Seconds of sustained low frame rate, for adaptive resolution. */
  private slowTime = 0;
  private readonly aim = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  /** Edge-triggered actions pressed since the last simulation tick. */
  private readonly pending = { dodge: false, slam: false, volley: false, potion: false };
  seed = randomSeed();
  /** Title screen (attract view) or an active run. */
  mode: 'menu' | 'playing' = 'menu';
  private readonly menu: MainMenu;
  private readonly pause: PauseMenu;
  private readonly admin: AdminConsole;
  private readonly character: CharacterPanel;
  private readonly modsPanel: ModsPanel;
  private readonly tutorialPrompt: TutorialPrompt;
  private readonly coopPanel: CoopPanel;
  private readonly partyHud: PartyHud;
  /** The co-op session, while hosting or in someone else's game. */
  coop: CoopSession | null = null;
  /** Mods are switched off during co-op so every player's game matches; restored afterwards. */
  private soloMods = activeMods();
  /** The floor being loaded starts a new run (co-op: everyone starts over). */
  private freshRun = false;
  readonly mods = new ModManager();
  /** Playing the tutorial floor rather than a real run. */
  tutorial = false;
  private tutorialProgress: TutorialProgress = newTutorialProgress();
  /** Seed waiting on the tutorial prompt's answer. */
  private pendingSeed = 0;
  /** L pressed: show the level-up choice even mid-fight. */
  private forceLevelUp = false;
  /** Short-lived ground flashes (admin slam/volley): grow from `from` to `to` radius and fade over `life`. */
  private readonly decals: { mesh: THREE.Mesh; t: number; life: number; from: number; to: number; spin: number }[] = [];
  /** Seconds spent previewing the hero in the character creator. */
  private previewTime = 0;
  private moveMode: MoveMode = loadMoveMode();
  /** Real seconds of boss-kill slow motion left. */
  private slowMo = 0;
  /** Gold fountain at a defeated boss: position and real seconds left. */
  private celebrate = { x: 0, z: 0, t: 0, next: 0 };
  private menuOrbit = 0;
  depth = 0;
  /** Seconds since the run began (excludes time on end screens). */
  private runTime = 0;
  /** Total simulated seconds (used by automated tests to wait on game time). */
  simTime = 0;
  /** Rendered frames, paused or not (automated tests wait on it). */
  frameCount = 0;
  /** Player shots fired (smoke-test counter). */
  private shotsFired = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.input = new Input(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0d0b10);
    this.scene.fog = new THREE.Fog(0x0d0b10, 38, 66);
    // Sun / moon shadows over the area around the hero (the shadow camera follows the view).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -20;
    sc.right = sc.top = 20;
    sc.near = 1;
    sc.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.particles.mesh);

    // Bloom only picks up what's brighter than the threshold: emissive details, not lit walls.
    this.renderer.info.autoReset = false;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.6, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const hudRoot = document.getElementById('hud')!;
    this.world = new GameWorld(this.scene, this.events);
    this.hud = new Hud(hudRoot, () => this.restart());
    this.hud.onNewRun = () => {
      if (!this.coop || this.coop.isHost) this.startRun(randomSeed());
    };
    this.hud.onMenu = () => (this.coop ? this.leaveCoop() : this.showMenu());
    this.hud.setMuted(this.sfx.isMuted);
    this.damageNumbers = new DamageNumbers(hudRoot);
    this.minimap = new Minimap(hudRoot);
    this.inventory = new InventoryPanel(hudRoot, () => {});
    this.levelUp = new LevelUpPanel(hudRoot);
    this.levelUp.onPick = (id) => this.world.player.choosePerk(id);
    this.pause = new PauseMenu(hudRoot);
    this.pause.onResume = () => this.pause.setOpen(false);
    this.pause.onControls = () => this.hud.toggleControls(true);
    this.pause.onSaveQuit = () => {
      if (this.coop) {
        this.leaveCoop();
        return;
      }
      this.saveRun();
      this.showMenu();
    };
    this.menu = new MainMenu(hudRoot);
    this.menu.onContinue = () => this.continueRun();
    // A typed-in seed starts straight away; New run offers the tutorial first.
    this.menu.onNewRun = (seed) => (seed === null ? this.askTutorial(randomSeed()) : this.startRun(seed));
    this.menu.onControls = () => this.hud.toggleControls(true);
    this.menu.onToggleSound = () => {
      const muted = this.sfx.toggleMute();
      this.hud.setMuted(muted);
      this.menu.setMuted(muted);
    };
    this.menu.onMoveMode = (mode) => {
      this.moveMode = mode;
      try {
        window.localStorage.setItem(MOVE_KEY, mode);
      } catch {
        // Not persisted; the choice still applies this session.
      }
    };
    this.admin = new AdminConsole(hudRoot);
    this.admin.exec = (cmd) => this.adminCommand(cmd);
    this.admin.onLoginChange = (on) => this.setAdminMode(on);
    this.setAdminMode(this.admin.isLoggedIn);
    this.menu.onSecret = () => this.admin.requestAccess();
    this.menu.onCharacter = () => this.openCharacter();
    this.menu.onMods = () => {
      this.menu.hide();
      this.modsPanel.show();
    };
    this.menu.onTutorial = () => this.startTutorial();
    this.menu.onCoop = () => this.openCoop();
    this.coopPanel = new CoopPanel(hudRoot);
    this.coopPanel.onBack = () => {
      this.coopPanel.hide();
      this.menu.show({ save: loadSave(), best: loadBestFloor(), moveMode: this.moveMode, muted: this.sfx.isMuted, mods: this.mods.activeCount });
    };
    this.coopPanel.onHost = (name) => void this.hostCoop(name);
    this.coopPanel.onJoin = (name, code) => void this.joinCoop(name, code);
    this.coopPanel.onStart = () => {
      this.coopPanel.hide();
      this.startRun(randomSeed());
    };
    this.coopPanel.onLeave = () => this.leaveCoop();
    this.partyHud = new PartyHud(hudRoot);
    this.character = new CharacterPanel(hudRoot);
    this.character.onChange = (look) => {
      storeAppearance(look);
      this.world.player.setAppearance(look);
    };
    this.character.onClose = () => this.closeOverlays();
    this.modsPanel = new ModsPanel(hudRoot, this.mods);
    this.modsPanel.onClose = () => this.closeOverlays();
    this.tutorialPrompt = new TutorialPrompt(hudRoot);
    this.tutorialPrompt.onAnswer = (yes) => (yes ? this.startTutorial() : this.startRun(this.pendingSeed));
    this.hud.onSkipTutorial = () => this.finishTutorial(false);
    this.hud.onLevelReady = () => (this.forceLevelUp = true);
    this.world.player.setAppearance(loadAppearance());
    this.mods.onChange = () => {
      this.menu.setModCount(this.mods.activeCount);
      this.world.player.refreshEquipment();
    };
    void this.mods.load();
    this.wireEffects();

    const seed = urlSeed();
    if (seed !== null) this.startRun(seed);
    else this.showMenu();
    // Invite links (?join=CODE) open the co-op screen with the code filled in.
    const invite = new URLSearchParams(window.location.search).get('join');
    if (invite && seed === null) this.openCoop(normalizeRoomCode(invite) ?? '');
    window.addEventListener('resize', this.onResize);
    if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = this;
  }

  /** Toasts, particles, sounds, damage numbers and shake, all driven by game events. */
  private wireEffects(): void {
    const { events, hud, particles: fx, sfx, rig } = this;
    const nums = this.damageNumbers;
    events.on('itemPicked', ({ item }) => {
      hud.toast(`Picked up ${item.name}`, 'loot', RARITY_COLOR[item.rarity]);
      const p = this.world.player.pos;
      fx.burst(p.x, 0.8, p.z, { count: 14, color: Number.parseInt(RARITY_COLOR[item.rarity].slice(1), 16), up: [3, 6], speed: [0.5, 2] });
      sfx.pickup(item.rarity);
    });
    events.on('potionPicked', () => {
      hud.toast('+1 Health potion', 'good');
      sfx.pickup('potion');
    });
    events.on('bagFull', () => {
      hud.toast('Bag is full: salvage something (Tab)', 'danger');
      sfx.denied();
    });
    events.on('levelUp', ({ level }) => {
      hud.toast(`Level up! You are now level ${level}`, 'good');
      const p = this.world.player.pos;
      fx.burst(p.x, 0.2, p.z, { count: 40, color: 0xffd23f, color2: 0xfff2b0, speed: [0.5, 2.5], up: [2, 5], gravity: -0.15, life: [0.8, 1.3], spread: 0.6 });
      sfx.levelUp();
    });
    events.on('heal', (e) => {
      nums.spawn(e.x, 2, e.z, `+${e.amount}`, 'heal');
      fx.burst(e.x, 0.4, e.z, { count: 16, color: 0x6fe07a, color2: 0xc8ffd0, speed: [0.3, 1.2], up: [1, 2.5], gravity: -0.2, life: [0.6, 1] });
      sfx.drink();
    });
    events.on('hit', (e) => {
      if (e.target === 'player') {
        rig.shake(0.35);
        hud.hurt();
        nums.spawn(e.x, 2, e.z, String(e.amount), 'hurt');
        fx.burst(e.x, 1, e.z, { count: 8, color: 0xc0262b, speed: [1, 3] });
      } else {
        if (e.crit) rig.shake(0.15, 0.12);
        // Tactical hits get their own colour: exposed, weak to the element, resisted.
        const style = e.tag === 'exposed' || e.tag === 'weak' || e.tag === 'resist' ? e.tag : e.crit ? 'crit' : 'hit';
        nums.spawn(e.x, 1.9, e.z, `${DamageNumbers.format(e.amount)}${e.crit ? '!' : ''}${e.tag === 'high' ? ' ▲' : ''}`, style);
        fx.burst(e.x, 0.9, e.z, { count: e.crit ? 14 : 7, color: 0x9b1d1d, color2: e.crit ? 0xffd23f : 0xd8463c, speed: [1.5, 4] });
      }
      sfx.hit(e.target, e.crit);
    });
    events.on('swing', () => sfx.swing());
    events.on('shoot', (e) => {
      if (e.owner === 'player') this.shotsFired++;
      sfx.shoot(e.owner);
    });
    events.on('enemyDied', (e) => {
      const [a, b] = GIBS[e.kind] ?? [0x888888, 0x555555];
      const boss = e.kind === 'boss';
      fx.burst(e.x, 0.8, e.z, { count: boss ? 90 : 26, color: a, color2: b, speed: [1, boss ? 7 : 4.5], up: [2, 7], size: [0.1, boss ? 0.32 : 0.2], life: [0.7, 1.4], spread: boss ? 0.8 : 0.3 });
      sfx.enemyDied(boss);
    });
    events.on('slam', (e) => {
      if (e.admin) {
        // Admin slam: a rune circle blasts outward, a pillar of light and a gold-and-cyan storm.
        rig.shake(1.0, 0.55);
        this.addDecal(buildRuneBurst(0x29ffe0), e.x, e.z, 0.6, e.radius * 1.15, 0.9, 1.5);
        this.addDecal(buildRuneBurst(0xffd23f, true), e.x, e.z, 0.4, e.radius * 1.4, 0.6, 0);
        fx.ring(e.x, e.z, e.radius, 0x29ffe0, 56);
        fx.ring(e.x, e.z, e.radius * 0.6, 0xffd23f, 36);
        fx.burst(e.x, 0.2, e.z, { count: 70, color: 0x29ffe0, color2: 0xffffff, speed: [0.3, 1.5], up: [8, 14], gravity: 0.15, size: [0.06, 0.16], life: [0.6, 1.1], spread: 0.35 });
        fx.burst(e.x, 0.3, e.z, { count: 50, color: 0xffd23f, color2: 0xfff2b0, speed: [3, 9], up: [1, 4], size: [0.06, 0.14], life: [0.4, 0.8] });
        sfx.slam();
        sfx.explosion();
        return;
      }
      rig.shake(e.radius > 2 ? 0.6 : 0.35, 0.35);
      fx.ring(e.x, e.z, e.radius, 0x8a7f6a, 36);
      fx.burst(e.x, 0.1, e.z, { count: 16, color: 0xb8ad94, speed: [0.5, 2], up: [3, 6] });
      sfx.slam();
    });
    events.on('volley', (e) => {
      if (!e.admin) return;
      // Admin volley: a rune flares underfoot and light sprays out along the fan.
      this.addDecal(buildRuneBurst(0x29ffe0), e.x, e.z, 0.4, 1.3, 0.5, -2.5);
      for (let i = 0; i < 5; i++) {
        const a = e.facing + (i / 4 - 0.5) * 0.9;
        fx.burst(e.x + Math.sin(a) * 0.8, 0.9, e.z + Math.cos(a) * 0.8, {
          count: 8,
          color: i % 2 ? 0xffd23f : 0x29ffe0,
          color2: 0xffffff,
          speed: [1, 3],
          up: [0.5, 2],
          size: [0.05, 0.12],
          life: [0.25, 0.5],
        });
      }
      rig.shake(0.25, 0.15);
    });
    events.on('explosion', (e) => {
      rig.shake(0.7, 0.4);
      fx.burst(e.x, 0.6, e.z, { count: 60, color: 0xff8a3c, color2: 0xffd23f, speed: [2, e.radius * 3], up: [2, 8], life: [0.3, 0.7] });
      fx.burst(e.x, 0.6, e.z, { count: 24, color: 0x3a3438, color2: 0x5a5458, speed: [0.5, 2], up: [1, 3], gravity: -0.1, life: [0.8, 1.4], size: [0.2, 0.35] });
      fx.ring(e.x, e.z, e.radius, 0xff6a2c, 30);
      sfx.explosion();
    });
    events.on('power', (e) => {
      switch (e.id) {
        case 'chain': {
          // Sparks along each segment of the arc.
          const pts = e.points ?? [];
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            for (let k = 0; k <= 8; k++) {
              const t = k / 8;
              const jitter = (Math.random() - 0.5) * 0.35;
              fx.burst(a.x + (b.x - a.x) * t + jitter, 1 + Math.random() * 0.3, a.z + (b.z - a.z) * t + jitter, {
                count: 2,
                color: 0xc8e6ff,
                color2: 0xffffff,
                speed: [0.2, 0.8],
                up: [0, 0.6],
                gravity: 0,
                life: [0.15, 0.3],
                size: [0.06, 0.1],
                spread: 0.05,
              });
            }
          }
          sfx.zap();
          break;
        }
        case 'frost':
          fx.burst(e.x, 0.8, e.z, { count: 26, color: 0xbfe8ff, color2: 0x7fc4ff, speed: [1, 3], up: [1, 4], life: [0.5, 0.9] });
          sfx.freeze();
          break;
        case 'shockwave':
          fx.ring(e.x, e.z, e.radius ?? 2.5, 0xe8e2c8, 32);
          rig.shake(0.25, 0.2);
          sfx.shockwave();
          break;
        case 'detonate':
          fx.burst(e.x, 0.7, e.z, { count: 36, color: 0xff5a3c, color2: 0xffd23f, speed: [2, 5], up: [2, 6], life: [0.3, 0.6] });
          fx.ring(e.x, e.z, e.radius ?? 2, 0xff8a3c, 24);
          rig.shake(0.3, 0.2);
          sfx.detonate();
          break;
      }
    });
    events.on('burnTick', (e) => nums.spawn(e.x, 1.7, e.z, DamageNumbers.format(e.amount), 'burn'));
    events.on('status', (e) => {
      if (e.kind === 'burn')
        fx.burst(e.x, 0.6, e.z, { count: 2, color: 0xff8a3c, color2: 0xffd23f, speed: [0.1, 0.5], up: [1.5, 3], gravity: -0.2, life: [0.3, 0.6], spread: 0.35 });
      else
        fx.burst(e.x, e.kind === 'freeze' ? 0.9 : 0.4, e.z, {
          count: e.kind === 'freeze' ? 3 : 1,
          color: 0xbfe8ff,
          color2: 0xffffff,
          speed: [0.1, 0.4],
          up: [0.2, 1],
          gravity: 0.3,
          life: [0.4, 0.7],
          spread: 0.4,
        });
    });
    events.on('blocked', (e) => {
      fx.burst(e.x, 1, e.z, { count: 10, color: 0xfff2b0, color2: 0xffffff, speed: [2, 5], up: [1, 3], life: [0.15, 0.3], size: [0.04, 0.08] });
      nums.spawn(e.x, 2.1, e.z, 'BLOCK', 'hit');
      sfx.block();
    });
    events.on('enemyHeal', (e) => {
      fx.burst(e.x, 1.6, e.z, { count: 16, color: 0x6fe07a, color2: 0xc8ffd0, speed: [0.5, 2], up: [2, 4], gravity: -0.2, life: [0.5, 0.9] });
      for (const t of e.targets) {
        fx.burst(t.x, 0.5, t.z, { count: 12, color: 0x6fe07a, color2: 0xc8ffd0, speed: [0.2, 0.8], up: [1.5, 3], gravity: -0.3, life: [0.6, 1], spread: 0.35 });
        if (t.amount > 0) nums.spawn(t.x, 2, t.z, `+${t.amount}`, 'heal');
      }
      sfx.enemyHeal();
    });
    events.on('rise', (e) => {
      fx.burst(e.x, 0.1, e.z, { count: 22, color: 0x5a4a3a, color2: 0x3a3028, speed: [0.5, 2.2], up: [1.5, 4], life: [0.5, 0.9], size: [0.08, 0.16] });
      fx.ring(e.x, e.z, 1.2, 0x5a4a3a, 14);
      sfx.rise();
    });
    events.on('teleport', (e) => {
      fx.burst(e.x, 1, e.z, { count: 30, color: 0xb07cff, color2: 0x2a1f3a, speed: [0.5, 2.5], up: [1, 4], gravity: -0.2, life: [0.5, 0.9], spread: 0.5 });
      sfx.dodge();
    });
    events.on('dodge', (e) => {
      if (e.admin) {
        // Admin dash: a rune flares where you leave and light streams behind you.
        this.addDecal(buildRuneBurst(0x29ffe0), e.x, e.z, 0.5, 1.4, 0.45, 4);
        fx.burst(e.x, 0.6, e.z, { count: 24, color: 0x29ffe0, color2: 0xffd23f, speed: [1, 3.5], up: [0.5, 2.5], size: [0.05, 0.13], life: [0.3, 0.6], gravity: 0.2 });
        sfx.dodge();
        return;
      }
      fx.burst(e.x, 0.1, e.z, { count: 10, color: 0x8a7f6a, speed: [0.5, 1.5], up: [0.5, 1.5], life: [0.3, 0.5] });
      sfx.dodge();
    });
    events.on('chestOpened', (e) => {
      fx.burst(e.x, 0.7, e.z, { count: 30, color: 0xf2c14e, color2: 0xfff2b0, speed: [0.5, 2.5], up: [3, 7] });
      sfx.chest();
    });
    events.on('bossPhase', (e) => {
      hud.toast(e.phase === 3 ? `${e.name} is desperate!` : `${e.name} is enraged!`, 'danger');
      rig.shake(0.6, 0.5);
      sfx.bossEngaged();
    });
    events.on('bossStrike', (e) => {
      const [a, b] = ({ colossus: [0xb8ad94, 0xff8a2a], huntress: [0x7ad46a, 0xd8f0a0], pyromancer: [0xff6a1a, 0xffd23f], necromancer: [0xa070ff, 0x6a3aaa] } as Record<string, [number, number]>)[e.boss] ?? [0xff6a3a, 0xffd23f];
      fx.burst(e.x, 0.3, e.z, { count: Math.round(12 + e.radius * 8), color: a, color2: b, speed: [1, 2 + e.radius * 2], up: [2, 6], life: [0.4, 0.8] });
      fx.ring(e.x, e.z, e.radius, a, Math.round(12 + e.radius * 6));
      rig.shake(Math.min(0.7, 0.2 + e.radius * 0.12), 0.25);
      sfx.slam();
    });
    events.on('hazard', (e) => {
      // Co-op guests draw the host's hazards (the host's own were placed by the boss already).
      if (this.world.role === 'guest') this.world.boss?.hazards.add(e.spec);
    });
    events.on('affinity', (e) => {
      const name = { fire: 'fire', frost: 'frost', lightning: 'lightning', force: 'force' }[e.element] ?? e.element;
      nums.spawn(e.x, 2.6, e.z, e.label === 'weak' ? `Weak to ${name}!` : `Resists ${name}`, 'note');
    });
    events.on('playerDied', () => {
      if (this.coop) {
        // The run goes on while anyone is standing; down players come back on the next floor.
        hud.toast('You are down! You will be back on the next floor.', 'danger');
        sfx.playerDied();
        return;
      }
      // Death ends the run for good: the save goes with it (the tutorial never touches it).
      if (!this.tutorial) clearSave();
      hud.showDeath(this.runSummary());
      sfx.playerDied();
    });
    events.on('bossEngaged', (e) => {
      hud.toast(`${e.name} awakens!`, 'danger');
      sfx.bossEngaged();
    });
    events.on('bossDefeated', (e) => {
      // The big moment: slow motion, a zoom in, a gold blast and a title card.
      this.slowMo = BOSS_SLOWMO;
      rig.setZoom(0.72);
      rig.shake(1.1, 0.9);
      this.celebrate = { x: e.x, z: e.z, t: 2.2, next: 0 };
      fx.burst(e.x, 1.2, e.z, { count: 140, color: 0xffd23f, color2: 0xffffff, speed: [2, 9], up: [3, 11], size: [0.08, 0.26], life: [0.9, 1.8], spread: 0.6 });
      fx.burst(e.x, 1, e.z, { count: 60, color: 0xff8a3c, color2: 0xfff2b0, speed: [1, 4], up: [6, 14], gravity: 0.6, life: [1.2, 2], spread: 0.4 });
      fx.ring(e.x, e.z, 5, 0xffd23f, 48);
      fx.ring(e.x, e.z, 3, 0xffffff, 32);
      hud.bossDefeated(e.name, this.depth + 1);
      sfx.bossDefeated();
    });
  }

  start(): void {
    this.renderer.setAnimationLoop(this.frame);
  }

  /** New run from the menu: offer the tutorial first unless the player turned that off. */
  private askTutorial(seed: number): void {
    if (tutorialPromptSuppressed()) {
      this.startRun(seed);
      return;
    }
    this.pendingSeed = seed;
    this.tutorialPrompt.setOpen(true);
  }

  /** Play the tutorial floor with a fresh character. */
  startTutorial(): void {
    this.closeOverlays(false);
    this.enterPlay();
    this.tutorial = true;
    this.tutorialProgress = newTutorialProgress();
    this.pendingSeed ||= randomSeed();
    this.world.player.resetProgress();
    this.runTime = 0;
    this.world.kills = 0;
    this.loadFloor(0);
  }

  /** Leave the tutorial (finished or skipped) and start the real run. */
  finishTutorial(completed: boolean): void {
    if (!this.tutorial) return;
    this.hud.setTutorial(null);
    this.startRun(this.pendingSeed || randomSeed());
    this.hud.toast(completed ? 'Tutorial complete! Your run begins.' : 'Tutorial skipped. Your run begins.', 'good');
  }

  /** Begin a fresh run from floor 1. */
  startRun(seed: number): void {
    // In co-op only the host starts runs.
    if (this.coop && !this.coop.isHost) return;
    this.freshRun = true;
    this.coopPanel.hide();
    this.tutorial = false;
    this.pendingSeed = 0;
    this.hud.setTutorial(null);
    this.enterPlay();
    this.seed = seed;
    this.world.player.resetProgress();
    this.runTime = 0;
    this.world.kills = 0;
    this.loadFloor(0);
  }

  /** Resume the saved run at the start of its floor. */
  continueRun(): void {
    const save = loadSave();
    if (!save) {
      this.showMenu();
      return;
    }
    this.tutorial = false;
    this.hud.setTutorial(null);
    this.enterPlay();
    this.seed = save.seed;
    const p = this.world.player;
    p.resetProgress();
    const inv = p.inventory;
    inv.weapon = save.weapon;
    inv.armor = save.armor;
    inv.bag.length = 0;
    inv.bag.push(...save.bag);
    inv.potions = save.potions;
    p.progress = structuredClone(save.progress);
    p.refreshEquipment();
    this.runTime = save.runTime;
    this.world.kills = save.kills;
    this.loadFloor(save.depth);
    this.hud.toast('Run restored', 'good');
  }

  /** Title screen, over a slowly circling view of a random floor. */
  showMenu(): void {
    this.mode = 'menu';
    this.tutorial = false;
    this.hud.setTutorial(null);
    this.hud.setLevelReady(0, false);
    this.closeOverlays(false);
    this.pause.setOpen(false);
    this.inventory.setOpen(false, this.world.player);
    this.levelUp.hide();
    this.hud.toggleControls(false);
    this.hud.showDeath(null);
    this.hud.setVisible(false);
    this.slowMo = 0;
    this.seed = randomSeed();
    this.world.player.resetProgress();
    this.loadFloor(0);
    this.menu.show({ save: loadSave(), best: loadBestFloor(), moveMode: this.moveMode, muted: this.sfx.isMuted, mods: this.mods.activeCount });
  }

  /** Character creator: the camera moves in on the hero standing in the menu scene. */
  private openCharacter(): void {
    this.menu.hide();
    this.previewTime = 0;
    this.character.show(this.world.player.appearance);
  }

  /** Close the title-screen side panels (and return to the menu if `toMenu`). */
  private closeOverlays(toMenu = true): void {
    const wasOpen = this.character.open || this.modsPanel.open;
    this.character.hide();
    this.modsPanel.hide();
    this.tutorialPrompt.setOpen(false);
    this.rig.setZoom(1);
    if (toMenu && wasOpen && this.mode === 'menu')
      this.menu.show({ save: loadSave(), best: loadBestFloor(), moveMode: this.moveMode, muted: this.sfx.isMuted, mods: this.mods.activeCount });
  }

  private enterPlay(): void {
    this.mode = 'playing';
    this.menu.hide();
    this.pause.setOpen(false);
    this.hud.setVisible(true);
    this.rig.setOrbit(0);
    this.rig.setZoom(1);
    this.slowMo = 0;
    this.celebrate.t = 0;
  }

  private makeSave(): RunSave {
    const p = this.world.player;
    const inv = p.inventory;
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      depth: this.depth,
      runTime: this.runTime,
      kills: this.world.kills,
      progress: structuredClone(p.progress),
      weapon: inv.weapon,
      armor: inv.armor,
      bag: [...inv.bag],
      potions: inv.potions,
      savedAt: Date.now(),
    };
  }

  /** Save the run (only while playing and alive; a dead run has nothing to resume). */
  saveRun(): boolean {
    if (this.mode !== 'playing' || this.tutorial || this.coop || !this.world.player.alive) return false;
    return writeSave(this.makeSave());
  }

  /** Death restart: same seed, back to floor 1. */
  restart(): void {
    if (this.coop && !this.coop.isHost) return;
    if (this.tutorial) this.startTutorial();
    else this.startRun(this.seed);
  }

  loadFloor(depth: number): void {
    this.depth = depth;
    const level: Dungeon = this.tutorial ? buildTutorial() : generateDungeon(this.seed, depth);
    this.world.load(level);
    this.applyAtmosphere(level);
    if (this.coop?.isHost) this.coop.floorLoaded(this.freshRun);
    this.freshRun = false;
    for (const d of this.decals) this.scene.remove(d.mesh);
    this.decals.length = 0;
    if (this.tutorial && this.world.boss) {
      // A gentler guardian for practice.
      const b = this.world.boss;
      b.maxHp = b.hp = Math.round(b.maxHp * TUTORIAL_BOSS_HP);
    }
    this.minimap.load(this.world);
    this.particles.clear();
    this.damageNumbers.clear();
    this.stepper.reset();
    this.hud.showDeath(null);
    this.inventory.setOpen(false, this.world.player);
    this.levelUp.hide();
    this.hud.setFloor(depth + 1, this.seed, this.tutorial);
    this.rig.snapTo(this.focus.set(level.playerStart.x, 0, level.playerStart.z));
    if (this.mode === 'playing' && this.tutorial) this.hud.toast('Tutorial', 'info');
    else if (this.mode === 'playing') {
      this.hud.toast(`Floor ${depth + 1}`, 'info');
      // Autosave at the start of every floor.
      this.saveRun();
    }
  }

  private get paused(): boolean {
    // Co-op never pauses: the others are still playing.
    if (this.coop && this.mode === 'playing') return false;
    return (
      this.mode === 'menu' ||
      this.admin.open ||
      this.pause.open ||
      this.inventory.open ||
      this.hud.controlsOpen ||
      this.levelUp.open ||
      this.tutorialPrompt.open
    );
  }

  private frame = (time: number): void => {
    const dt = this.lastTime < 0 ? 0 : Math.min((time - this.lastTime) / 1000, MAX_FRAME);
    this.lastTime = time;
    this.frameCount++;
    this.handleUiKeys();

    if (this.mode === 'menu') {
      const p = this.world.player;
      if (this.character.open) {
        // Character creator: close-up of the hero, slowly turning, framed left of the panel.
        this.previewTime += dt;
        this.rig.setOrbit(0);
        this.rig.setZoom(0.32);
        p.facing = Math.PI / 4 + Math.sin(this.previewTime * 0.6) * 0.9;
        p.previewIdle(dt);
        const shift = Math.min(1, window.innerWidth / 1400);
        this.focus.set(p.pos.x + this.rig.right.x * 0.9 * shift, 0.85, p.pos.z + this.rig.right.z * 0.9 * shift);
        cutoutUniforms.uCutTarget.value.set(p.pos.x, 0.9, p.pos.z);
      } else {
        // Attract view: circle the start room with torches flickering.
        this.menuOrbit += dt * 0.07;
        this.rig.setOrbit(this.menuOrbit);
        this.focus.set(p.pos.x, 0, p.pos.z);
      }
      this.rig.update(this.focus, dt);
      this.world.updateScenery(dt, this.rig.camera);
      this.particles.update(dt);
    } else if (this.paused) {
      // Frozen: drop queued actions and don't bank time for a catch-up burst on resume.
      this.stepper.reset();
      this.pending.dodge = this.pending.slam = this.pending.volley = this.pending.potion = false;
    } else {
      this.latchActions();
      // Boss-kill slow motion scales simulated time, then eases back.
      const scale = this.slowMo > 0 ? SLOWMO_SCALE : 1;
      if (this.slowMo > 0) {
        this.slowMo -= dt;
        if (this.slowMo <= 0) this.rig.setZoom(1);
      }
      const sdt = dt * scale;
      const steps = this.stepper.advance(sdt);
      for (let i = 0; i < steps; i++) this.step(this.stepper.step);
      // Presentation runs at display rate.
      const { player } = this.world;
      this.focus.set(player.pos.x, 0, player.pos.z);
      this.rig.update(this.focus, dt);
      cutoutUniforms.uCutTarget.value.set(player.pos.x, 0.9, player.pos.z);
      this.updateCelebration(dt);
      this.updateDecals(sdt);
      this.updateTrails(sdt);
      this.particles.update(sdt);
      this.minimap.update(dt, this.world);
    }
    this.damageNumbers.update(this.paused ? 0 : dt, this.rig.camera, window.innerWidth, window.innerHeight);
    this.hud.update(this.world.player);
    this.hud.updateBoss(this.world.boss);
    this.hud.setRunInfo(this.runTime, this.world.kills);

    this.placeSun();
    this.renderer.info.reset();
    this.composer.render(dt);
    this.fps.tick(time, this.renderer.info.render.calls);
    this.adaptResolution(dt);
    if (this.coop) {
      this.coop.update(dt);
      if (this.mode === 'playing')
        this.partyHud.update({ name: this.coop.name, hero: this.world.player }, this.world.remotes, this.coop.code, this.rig.camera, window.innerWidth, window.innerHeight);
    }
    this.input.endFrame();
  };

  /** Admins get the badge, a level cap of ADMIN_MAX_LEVEL and the Ascendance attribute. */
  private setAdminMode(on: boolean): void {
    this.hud.setAdmin(on);
    this.world.player.levelCap = on ? ADMIN_MAX_LEVEL : MAX_LEVEL;
  }

  // ---- Co-op ----

  /** Title screen → co-op screen (optionally with an invite code filled in). */
  openCoop(code = ''): void {
    this.menu.hide();
    if (this.coop) this.refreshLobby(true);
    else this.coopPanel.show(code);
  }

  private coopGame(): CoopGame {
    return {
      world: this.world,
      events: this.events,
      look: () => this.world.player.appearance,
      seed: () => this.seed,
      depth: () => this.depth,
      playFloor: (seed, depth, fresh) => this.playCoopFloor(seed, depth, fresh),
      partyWiped: () => {
        this.hud.setDeathMode(this.coop?.isHost ? 'host' : 'guest');
        this.hud.showDeath(this.runSummary());
      },
      lobbyChanged: () => this.refreshLobby(),
      ended: (reason) => this.leaveCoop(reason),
      toast: (text, tone) => {
        if (this.mode === 'playing') this.hud.toast(text, tone);
      },
    };
  }

  private async hostCoop(name: string): Promise<void> {
    this.coopPanel.busy('Opening a room…');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.coop = await CoopSession.host(makeRoomCode(Math.random), name, this.coopGame());
        this.enterCoop('host');
        this.refreshLobby(true);
        return;
      } catch (err) {
        // A code clash just needs another code; anything else is reported.
        if (!(err as Error).message.includes('taken') || attempt === 2) {
          this.coopPanel.fail((err as Error).message);
          return;
        }
      }
    }
  }

  private async joinCoop(name: string, text: string): Promise<void> {
    const code = normalizeRoomCode(text);
    if (!code) {
      this.coopPanel.fail('Room codes are 5 letters and numbers, like K7Q2M.');
      return;
    }
    this.coopPanel.busy(`Joining ${code}…`);
    // Set up as a guest first: the host may send the floor right after letting us in.
    this.enterCoop('guest');
    try {
      this.coop = await CoopSession.join(code, name, this.coopGame());
      this.world.localId = this.coop.localId;
      this.refreshLobby(true);
    } catch (err) {
      this.exitCoopMode();
      this.coopPanel.fail((err as Error).message);
    }
  }

  /** Switch the world to co-op rules. */
  private enterCoop(role: 'host' | 'guest'): void {
    this.soloMods = activeMods();
    setActiveMods(new ModRegistry());
    this.world.role = role;
    this.world.localId = this.coop?.localId ?? 0;
    this.pause.setCoop(true);
  }

  private exitCoopMode(): void {
    this.world.role = 'solo';
    this.world.localId = 0;
    this.world.net = null;
    this.world.clearRemotes();
    setActiveMods(this.soloMods);
    this.pause.setCoop(false);
    this.partyHud.clear();
    this.hud.setDeathMode('solo');
  }

  /** Leave co-op (closing the room if hosting) and go back to the title screen. */
  leaveCoop(reason?: string): void {
    this.coop?.close();
    this.coop = null;
    this.exitCoopMode();
    this.coopPanel.hide();
    this.showMenu();
    if (reason) {
      this.menu.hide();
      this.coopPanel.show();
      this.coopPanel.fail(reason);
    }
  }

  /** Lobby screen, if it's showing (or `force` to show it). */
  private refreshLobby(force = false): void {
    if (!this.coop || (!force && !this.coopPanel.open)) return;
    const players = [...this.coop.players.values()].sort((a, b) => a.id - b.id);
    this.coopPanel.showLobby(this.coop.code, this.coop.isHost, players, this.coop.localId);
  }

  /** Guest: the host started a run or moved the party to a floor. */
  private playCoopFloor(seed: number, depth: number, fresh: boolean): void {
    this.coopPanel.hide();
    this.menu.hide();
    if (this.mode !== 'playing') this.enterPlay();
    this.tutorial = false;
    this.seed = seed;
    if (fresh) {
      this.world.player.resetProgress();
      this.runTime = 0;
      this.world.kills = 0;
    }
    this.loadFloor(depth);
  }

  /** Run an admin console command; returns the text to show. */
  private adminCommand({ name, args }: ParsedCommand): string {
    const p = this.world.player;
    const inv = p.inventory;
    if (name === 'help') return COMMANDS.map((c) => `${c.name}${c.args ? ' ' + c.args : ''}  —  ${c.help}`).join('\n');
    if (name === 'seed') {
      const n = intArg(args[0], 0, 2 ** 32 - 1);
      if (n === null) return 'Usage: seed <n>';
      this.startRun(n);
      return `New run on seed ${n}.`;
    }
    if (!COMMANDS.some((c) => c.name === name)) return `Unknown command "${name}". Type help.`;
    if (name === 'mods') {
      if (!this.mods.list.length) return 'No mods found (public/mods/index.json).';
      return this.mods.list
        .map((m) => `${m.enabled && m.mod ? '[on] ' : '[off]'} ${m.mod ? `${m.mod.name} (${m.mod.id})` : m.source}${m.errors.length ? ` — ${m.errors.length} error(s)` : ''}`)
        .join('\n');
    }
    if (this.mode !== 'playing') return 'Start a run first (this command works in-game).';
    if (this.coop && !this.coop.isHost && ['floor', 'boss', 'portal', 'killall', 'spawn'].includes(name))
      return 'Only the host can change the shared dungeon in co-op.';

    switch (name) {
      case 'god':
        p.godMode = args[0] === 'on' ? true : args[0] === 'off' ? false : !p.godMode;
        return `God mode ${p.godMode ? 'on' : 'off'}.`;
      case 'heal':
        p.hp = p.maxHp;
        return 'Healed to full.';
      case 'level': {
        const n = intArg(args[0], 1, p.levelCap);
        if (n === null) return `Usage: level <1-${p.levelCap}>`;
        if (n <= p.progress.level) return `Already level ${p.progress.level}; levels only go up.`;
        p.progress.pendingPicks += n - p.progress.level;
        p.progress.level = n;
        p.progress.xp = 0;
        return `Level ${n}. ${p.progress.pendingPicks} attribute pick(s) queued.`;
      }
      case 'xp': {
        const n = intArg(args[0], 1, 10_000_000);
        if (n === null) return 'Usage: xp <amount>';
        const gained = p.gainXp(n);
        if (gained > 0) this.events.emit('levelUp', { level: p.progress.level });
        return `+${n} XP${gained ? `, ${gained} level(s) gained` : ''}.`;
      }
      case 'give': {
        const kind = args[0];
        if (kind !== 'weapon' && kind !== 'armor') return 'Usage: give <weapon|armor> [rarity] [count]';
        const rarity = (args[1] ?? 'unique') as Rarity;
        if (!RARITIES.includes(rarity)) return `Rarity must be one of: ${RARITIES.join(', ')}`;
        const count = args[2] === undefined ? 1 : intArg(args[2], 1, BAG_SIZE);
        if (count === null) return `Count must be 1-${BAG_SIZE}.`;
        let added = 0;
        for (let i = 0; i < count && !inv.full; i++, added++) this.debugGive(kind, rarity);
        return added ? `Added ${added} ${rarity} ${kind}${added > 1 ? 's' : ''} to your bag.` : 'Bag is full.';
      }
      case 'admingear': {
        const which = args[0] ?? 'all';
        const kinds: AdminGearKind[] =
          which === 'all' ? [inv.weapon.weapon, 'armor'] : (['sword', 'spear', 'bow', 'armor'] as const).filter((k) => k === which);
        if (!kinds.length) return 'Usage: admingear [sword|spear|bow|armor|all]';
        const made = kinds.map((k) => {
          const item = makeAdminItem(k, Math.floor(Math.random() * 2 ** 31));
          // Equip it, moving whatever was worn into the bag (dropped if the bag is full).
          if (item.kind === 'weapon') {
            if (inv.weapon.id !== 0) inv.add(inv.weapon);
            inv.weapon = item;
          } else {
            if (inv.armor) inv.add(inv.armor);
            inv.armor = item;
          }
          return item.name;
        });
        p.refreshEquipment();
        p.hp = p.maxHp;
        return `Equipped ${made.join(' and ')}.`;
      }
      case 'spawn': {
        const what = args[0];
        const count = args[1] === undefined ? 1 : intArg(args[1], 1, 20);
        if (!what || count === null) return 'Usage: spawn <enemy|mod-variant-id> [1-20]';
        const regular: EnemyKind[] = ['grunt', 'archer', 'exploder', 'spider', 'shieldbearer', 'shaman', 'wraith'];
        const variant = activeMods().enemyById(what);
        const kind = variant ? (variant.base as EnemyKind) : (what as EnemyKind);
        if (!regular.includes(kind)) {
          const ids = activeMods().enemies.map((v) => v.id);
          return `Enemies: ${regular.join(', ')}${ids.length ? `; mod variants: ${ids.join(', ')}` : ''}`;
        }
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          const e = this.debugPlace(kind, Math.sin(a) * 4, Math.cos(a) * 4);
          if (variant) this.world.applyVariant(e, variant);
        }
        return `Spawned ${count} ${variant ? variant.name : kind}${count > 1 ? 's' : ''}.`;
      }
      case 'potions': {
        const n = intArg(args[0], 0, MAX_POTIONS);
        if (n === null) return `Usage: potions <0-${MAX_POTIONS}>`;
        inv.potions = n;
        return `Potions: ${n}.`;
      }
      case 'perk': {
        const id = args[0] as PerkId;
        if (id === 'ascendance') {
          applyPerk(p.progress.perks, 'ascendance');
          p.refreshEquipment();
          p.hp = p.maxHp;
          return `Ascended: every attribute is rank ${p.progress.perks.might}.`;
        }
        if (!PERK_IDS.includes(id)) return `Attributes: ${PERK_IDS.join(', ')}, ascendance`;
        const ranks = args[1] === undefined ? 1 : intArg(args[1], 1, 20);
        if (ranks === null) return 'Usage: perk <name> [ranks]';
        p.progress.perks[id] = Math.min(PERKS[id].max, (p.progress.perks[id] ?? 0) + ranks);
        p.refreshEquipment();
        return `${PERKS[id].name} is now rank ${p.progress.perks[id]}.`;
      }
      case 'floor': {
        const n = intArg(args[0], 1, 999);
        if (n === null) return 'Usage: floor <n>';
        this.loadFloor(n - 1);
        return `Jumped to floor ${n}.`;
      }
      case 'boss': {
        const b = this.world.boss;
        if (!b?.alive) return 'This floor’s boss is already dead.';
        this.debugTeleport(b.pos.x, b.pos.z + 4);
        return `Teleported to ${b.name}.`;
      }
      case 'portal':
        this.world.portal.activate();
        this.debugTeleport(this.world.level.exit.x, this.world.level.exit.z);
        return 'Through the portal…';
      case 'killall': {
        let n = 0;
        for (const e of this.world.enemies) {
          if (e.isBoss || !e.alive) continue;
          e.applyDamage(1e9, 0, 0);
          n++;
        }
        return `Killed ${n} enemies.`;
      }
      case 'speed': {
        const v = Number.parseFloat(args[0] ?? '');
        if (!(v >= 0.25 && v <= 5)) return 'Usage: speed <0.25-5>';
        p.speedMult = v;
        return `Move speed ×${v}.`;
      }
      case 'reveal':
        this.minimap.revealAll();
        return 'Map revealed.';
      case 'save':
        return this.saveRun() ? 'Run saved.' : 'Could not save (storage blocked?).';
    }
    return `Unknown command "${name}".`;
  }

  /** Sparks behind admin light-spears, and the streak behind an admin dash. */
  private trailClock = 0;
  private updateTrails(dt: number): void {
    this.trailClock += dt;
    if (this.trailClock < 1 / 45) return;
    this.trailClock = 0;
    for (const t of this.world.projectiles.trailPoints())
      this.particles.burst(t.x, 1, t.z, { count: 1, color: t.color, color2: 0xffffff, speed: [0, 0.4], up: [0, 0.6], size: [0.05, 0.1], life: [0.2, 0.35], gravity: 0 });
    const p = this.world.player;
    if (p.dodging && p.ascendedArmor)
      this.particles.burst(p.pos.x, 0.9, p.pos.z, { count: 4, color: 0x29ffe0, color2: 0xffd23f, speed: [0, 0.6], up: [0, 1], size: [0.06, 0.14], life: [0.25, 0.5], gravity: 0, spread: 0.35 });
  }

  private addDecal(mesh: THREE.Mesh, x: number, z: number, from: number, to: number, life: number, spin: number): void {
    mesh.position.set(x, 0.05 + groundAt(x, z), z);
    mesh.scale.setScalar(from);
    this.scene.add(mesh);
    this.decals.push({ mesh, t: 0, life, from, to, spin });
  }

  /** Grow, spin and fade the ground flashes, removing them when done. */
  private updateDecals(dt: number): void {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.t += dt;
      const k = Math.min(1, d.t / d.life);
      d.mesh.scale.setScalar(d.from + (d.to - d.from) * (1 - (1 - k) ** 3));
      d.mesh.rotation.z += d.spin * dt;
      const mat = d.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - k) ** 1.5;
      if (k >= 1) {
        this.scene.remove(d.mesh);
        mat.dispose();
        this.decals.splice(i, 1);
      }
    }
  }

  /** Keep a gold fountain going where the boss fell. */
  private updateCelebration(dt: number): void {
    const c = this.celebrate;
    if (c.t <= 0) return;
    c.t -= dt;
    c.next -= dt;
    if (c.next > 0) return;
    c.next = 0.09;
    this.particles.burst(c.x, 0.3, c.z, { count: 10, color: 0xffd23f, color2: 0xfff2b0, speed: [0.5, 2.5], up: [6, 10], size: [0.06, 0.14], life: [0.8, 1.3], spread: 0.5 });
  }

  /**
   * On high-DPI screens fill rate dominates. If the frame rate stays low for a
   * few seconds, render at a lower pixel ratio (never below 1).
   */
  private adaptResolution(dt: number): void {
    const ratio = this.renderer.getPixelRatio();
    if (this.fps.fps === 0) return;
    if (ratio <= 1) {
      // Already at the lowest resolution: if it's still very slow, drop the shadows.
      this.lowFpsTime = this.fps.fps < 25 && this.renderer.shadowMap.enabled ? this.lowFpsTime + dt : 0;
      if (this.lowFpsTime > 6) {
        this.renderer.shadowMap.enabled = false;
        this.sun.castShadow = false;
      }
      return;
    }
    this.slowTime = this.fps.fps < 45 ? this.slowTime + dt : 0;
    if (this.slowTime < 3) return;
    this.slowTime = 0;
    this.renderer.setPixelRatio(Math.max(1, ratio - 0.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }


  /** Menu and toggle keys: handled once per rendered frame, paused or not. */
  private handleUiKeys(): void {
    const { input, world } = this;
    // Typing in a text field (the seed box) must not trigger game keys.
    if (document.activeElement instanceof HTMLInputElement) return;
    if (this.mode === 'menu') {
      if (input.wasPressed('Escape') && (this.character.open || this.modsPanel.open || this.tutorialPrompt.open)) {
        this.closeOverlays();
        if (!this.menu.open) this.showMenu();
        return;
      }
      if (input.wasPressed('Escape') || input.wasPressed('KeyH')) this.hud.toggleControls(input.wasPressed('KeyH') ? undefined : false);
      if (input.wasPressed('KeyM')) this.menu.onToggleSound();
      return;
    }
    if (input.wasPressed('KeyL')) this.forceLevelUp = true;
    this.updateLevelUp();
    if (this.levelUp.open) {
      for (const [i, code] of ['Digit1', 'Digit2', 'Digit3'].entries()) {
        if (input.wasPressed(code) && this.levelUp.pick(i)) {
          input.consume(code);
          break;
        }
      }
    }
    if (input.wasPressed('F3')) this.fps.toggle();
    if (input.wasPressed('KeyM')) this.hud.setMuted(this.sfx.toggleMute());
    if (input.wasPressed('KeyR') && !world.player.alive && (!this.coop || this.coop.isHost) && this.hud.deathShown) this.restart();
    if (input.wasPressed('KeyH') && !this.inventory.open && !this.levelUp.open) this.hud.toggleControls();
    if (this.pause.open) return;
    if (
      (input.wasPressed('Tab') || input.wasPressed('KeyI')) &&
      world.player.alive &&
      !this.hud.controlsOpen &&
      !this.levelUp.open
    )
    {
      this.inventory.toggle(world.player);
      if (this.tutorial) this.tutorialProgress.inventoryOpened = true;
    }
    if (input.wasPressed('Escape')) {
      if (this.inventory.open) this.inventory.setOpen(false, world.player);
      else if (this.hud.controlsOpen) this.hud.toggleControls(false);
      else if (this.pause.open) this.pause.setOpen(false);
      else if (world.player.alive && !this.levelUp.open) this.pause.setOpen(true);
    }
    if (import.meta.env.DEV && input.wasPressed('BracketRight') && !this.paused) this.loadFloor(this.depth + 1);
  }

  /** Offer the next queued attribute pick once nothing else is on screen. */
  private updateLevelUp(): void {
    const p = this.world.player;
    const prog = p.progress;
    const fighting = this.world.calmTime < LEVELUP_CALM;
    this.hud.setLevelReady(this.levelUp.open || !p.alive ? 0 : prog.pendingPicks, fighting && !this.forceLevelUp);
    if (prog.pendingPicks <= 0) this.forceLevelUp = false;
    if (this.levelUp.open || prog.pendingPicks <= 0 || !p.alive || this.inventory.open || this.pause.open || this.admin.open) return;
    // Wait for a lull in the fighting (or L), so a pick never interrupts a fight.
    // Once choosing, queued picks follow one after another (forceLevelUp clears when none are left).
    if (fighting && !this.forceLevelUp && !this.autoPerk) return;
    this.forceLevelUp = true;
    const taken = Object.values(prog.perks).reduce((a, b) => a + (b ?? 0), 0);
    // Seeded by run and pick number, so a seed replays the same offers.
    const choices = rollPerkChoices(new Rng(hashSeed(`${this.seed}:perk:${taken}`)), prog.perks, 3, this.admin.isLoggedIn);
    if (choices.length === 0) {
      prog.pendingPicks = 0;
      return;
    }
    if (this.autoPerk) {
      p.choosePerk(choices[0]);
      return;
    }
    this.hud.toggleControls(false);
    this.levelUp.show(prog.level - prog.pendingPicks + 1, prog.pendingPicks - 1, choices, prog.perks);
  }

  /**
   * Remember edge-triggered presses until a simulation tick consumes them. On
   * high-refresh displays some frames run no tick, and a press must not be lost.
   */
  private latchActions(): void {
    const { input, pending } = this;
    pending.dodge ||= input.wasPressed('Space');
    pending.slam ||= input.wasPressed('KeyQ');
    pending.volley ||= input.wasPressed('KeyE');
    pending.potion ||= input.wasPressed('Digit1');
  }

  /** One fixed simulation tick. */
  private step(dt: number): void {
    const { input, rig, world, pending } = this;
    this.simTime += dt;
    let fwd = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const side = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    rig.mouseToGround(input.mouseNdc.x, input.mouseNdc.y, 0.8, this.aim);
    let f: { x: number; z: number } = rig.forward;
    let r: { x: number; z: number } = rig.right;
    if (this.moveMode === 'mouse') {
      // W walks toward the cursor, S backs away, A/D circle around it.
      const p = world.player.pos;
      const dx = this.aim.x - p.x;
      const dz = this.aim.z - p.z;
      const len = Math.hypot(dx, dz);
      const fx = len > 0.01 ? dx / len : Math.sin(world.player.facing);
      const fz = len > 0.01 ? dz / len : Math.cos(world.player.facing);
      f = { x: fx, z: fz };
      r = { x: -fz, z: fx };
      // Ease in to a stop near the cursor instead of overshooting and jittering
      // across it; the braking distance grows with move speed.
      if (fwd > 0) {
        const speed = world.player.stats.moveSpeed * world.player.speedMult;
        fwd *= Math.min(1, Math.max(0, (len - 0.45) / Math.max(0.4, speed * 0.1)));
      }
    }

    world.update(
      dt,
      {
        moveX: f.x * fwd + r.x * side,
        moveZ: f.z * fwd + r.z * side,
        aimX: this.aim.x,
        aimZ: this.aim.z,
        attack: input.mouseDown,
        dodge: pending.dodge,
        slam: pending.slam,
        volley: pending.volley,
        potion: pending.potion,
      },
      rig.camera,
    );
    // Each press is used by exactly one tick.
    pending.dodge = pending.slam = pending.volley = pending.potion = false;

    if (world.player.alive) this.runTime += dt;
    if (this.tutorial) {
      this.updateTutorial(dt);
      if (world.portalReached) {
        this.sfx.portal();
        this.finishTutorial(true);
      }
      return;
    }
    if (world.portalReached) {
      // Floors go on forever: every portal leads one floor deeper.
      this.sfx.portal();
      this.loadFloor(this.depth + 1);
    }
  }

  /** Tick the tutorial checklist from what the player is doing. */
  private updateTutorial(dt: number): void {
    const { world, tutorialProgress: tp } = this;
    const p = world.player;
    const level = world.level;
    if (p.alive && (this.input.isDown('KeyW') || this.input.isDown('KeyA') || this.input.isDown('KeyS') || this.input.isDown('KeyD')))
      tp.moved += dt * p.stats.moveSpeed;
    if (p.attackCooldown > 0) tp.attacked = true;
    if (p.dodging) tp.dodged = true;
    if (p.slamCooldown > 0) tp.slammed = true;
    if (p.volleyCooldown > 0) tp.volleyed = true;
    if (p.potionHealed > 0 || p.inventory.potions === 0) tp.drank = true;
    if (world.chests.some((c) => c.opened)) tp.chestOpened = true;
    if (p.inventory.armor || p.inventory.weapon.id !== 0) tp.equipped = true;
    if (world.boss && !world.boss.alive) tp.bossDead = true;
    const room = roomAt(level, p.pos.x, p.pos.z);
    const r = level.rooms[room];
    const cleared = !world.enemies.some((e) => e.alive && e.pos.x >= r.x && e.pos.x < r.x + r.w && e.pos.z >= r.z && e.pos.z < r.z + r.h);
    this.hud.setTutorial(lessonFor(room, tp, cleared));
  }

  /** Summary for the death screen; also records the deepest floor reached (never from the tutorial). */
  private runSummary(): RunSummary {
    const floor = this.depth + 1;
    const prev = loadBestFloor();
    const newBest = !this.tutorial && floor > prev;
    if (newBest) saveBestFloor(floor);
    return { seed: this.seed, floor, time: this.runTime, kills: this.world.kills, best: Math.max(prev, floor), newBest };
  }

  /** Keep the sun's shadow camera over the part of the world in view; light comes from the north-west. */
  private placeSun(): void {
    const e = this.sunElevation;
    const f = this.focus;
    const d = 45;
    this.sun.position.set(f.x - Math.cos(e) * d * 0.8, Math.sin(e) * d, f.z - Math.cos(e) * d * 0.6);
    this.sun.target.position.set(f.x, 0, f.z);
  }

  /** Sky colour, fog, light colours and bloom for the floor's zone. */
  private applyAtmosphere(level: { seed: number; theme: number }): void {
    const a = atmosphereFor(level);
    this.sunElevation = a.sunElevation;
    (this.scene.background as THREE.Color).setHex(a.background);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(a.fog);
    fog.near = a.fogNear;
    fog.far = a.fogFar;
    this.hemi.color.setHex(a.hemiSky);
    this.hemi.groundColor.setHex(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    this.sun.color.setHex(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    this.bloom.strength = a.bloomStrength;
  }

  private onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.rig.setAspect(window.innerWidth / window.innerHeight);
  };

  // ---- Dev-only hooks for the automated smoke test ----

  debugState(): {
    player: {
      x: number;
      z: number;
      facing: number;
      hp: number;
      maxHp: number;
      alive: boolean;
      dodging: boolean;
      level: number;
      xp: number;
      potions: number;
      bag: number;
      weapon: string;
    };
    enemies: { kind: string; x: number; z: number; hp: number; alive: boolean }[];
  } {
    const p = this.world.player;
    return {
      player: {
        ...p.pos,
        facing: p.facing,
        hp: p.hp,
        maxHp: p.maxHp,
        alive: p.alive,
        dodging: p.dodging,
        level: p.progress.level,
        xp: p.progress.xp,
        potions: p.inventory.potions,
        bag: p.inventory.bag.length,
        weapon: p.inventory.weapon.weapon,
      },
      enemies: this.world.enemies.map((e) => ({ kind: e.kind, ...e.pos, hp: e.hp, alive: e.alive })),
    };
  }

  get level(): GameWorld['level'] {
    return this.world.level;
  }

  /** Teleport the player next to the boss / portal (smoke-test helper). */
  debugTeleport(x: number, z: number): void {
    this.world.player.setPosition(x, z);
  }

  /** Remove non-boss enemies and spawn one enemy at an offset from the player. */
  debugSpawn(kind: EnemyKind, dx: number, dz: number): void {
    for (const e of this.world.enemies) {
      if (e.isBoss || !e.alive) continue;
      e.rewardsOnDeath = false;
      e.applyDamage(99999, 0, 0);
    }
    this.debugPlace(kind, dx, dz);
  }

  /**
   * Spawn an enemy roughly (dx, dz) from the player without clearing others,
   * rotating the offset until the spot is open floor in sight of the player.
   */
  debugPlace(kind: EnemyKind, dx: number, dz: number): Enemy {
    const p = this.world.player.pos;
    const grid = this.world.level.grid;
    const dist = Math.hypot(dx, dz);
    const base = Math.atan2(dx, dz);
    const e = createEnemy(kind, this.depth);
    for (let i = 0; i < 32; i++) {
      const a = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 16);
      const x = p.x + Math.sin(a) * dist;
      const z = p.z + Math.cos(a) * dist;
      const open = grid.isWalkableAt(x, z) && grid.isWalkableAt(x + 0.4, z) && grid.isWalkableAt(x - 0.4, z);
      if (open && grid.lineOfSight(p.x, p.z, x, z)) return this.world.spawn(e, x, z);
    }
    return this.world.spawn(e, p.x + dx, p.z + dz);
  }


  /** Give the player an item (smoke-test helper). */
  debugGive(kind: 'weapon' | 'armor', rarity: Rarity): void {
    const rng = new Rng(Math.floor(Math.random() * 1e9));
    let item = rollItem(rng, this.depth, { kind, minRarity: rarity, uniqueBoost: 50 });
    // Reroll until the rarity is exact (minRarity only sets a floor).
    for (let i = 0; i < 500 && item.rarity !== rarity; i++) item = rollItem(rng, this.depth, { kind, minRarity: rarity, uniqueBoost: 50 });
    this.world.player.inventory.add(item);
  }

  get worldState(): GameWorld {
    return this.world;
  }

  debugFx(): { particles: number; damageNumbers: number; explored: number; audio: string; muted: boolean } {
    return {
      particles: this.particles.count,
      damageNumbers: this.damageNumbers.activeCount,
      explored: this.minimap.seenCount,
      audio: this.sfx.state,
      muted: this.sfx.isMuted,
    };
  }

  debugKillBoss(): void {
    this.world.boss?.applyDamage(999999, 0, 0);
  }

  debugExtra(): {
    projectiles: number;
    shots: number;
    portalActive: boolean;
    bossEngaged: boolean;
    bossKind: string | null;
    depth: number;
    bestFloor: number;
    levelUpOpen: boolean;
  } {
    return {
      projectiles: this.world.projectiles.mesh.count,
      shots: this.shotsFired,
      portalActive: this.world.portal.active,
      bossEngaged: !!this.world.boss?.engaged,
      bossKind: this.world.boss?.bossKind ?? null,
      depth: this.depth,
      bestFloor: loadBestFloor(),
      levelUpOpen: this.levelUp.open,
    };
  }

  /** Parse an admin command line (smoke-test helper). */
  debugParse(line: string): ParsedCommand {
    return parseCommand(line) ?? { name: '', args: [] };
  }

  /** A fresh enemy for the current floor (smoke-test helper; add it with worldState.spawn). */
  debugCreateEnemy(kind: EnemyKind): Enemy {
    return createEnemy(kind, this.depth);
  }

  /** Screen-space pixel position of a world point (for aiming the mouse in tests). */
  debugWorldToScreen(x: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, 0.8, z).project(this.rig.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
}

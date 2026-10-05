/**
 * The tutorial: a fixed row of six rooms, each teaching one thing, ending in
 * a weakened boss and the portal into a real run. Layout and lesson tracking
 * are pure; the game feeds in what the player did.
 */
import { Tile, TileGrid } from './grid';
import { placeTorches } from './level';
import { roomCenter, type Dungeon, type EnemySpawn, type Room } from './dungeonGen';

/** Rooms left to right: [x, z, w, h, kind]. */
const ROOMS: [number, number, number, number, Room['kind']][] = [
  [3, 8, 9, 8, 'start'],
  [16, 7, 10, 10, 'normal'],
  [30, 6, 11, 12, 'normal'],
  [45, 6, 11, 12, 'normal'],
  [60, 8, 8, 8, 'treasure'],
  [72, 4, 14, 15, 'boss'],
];

/** The hand-built tutorial floor. */
export function buildTutorial(): Dungeon {
  const grid = new TileGrid(90, 24);
  const rooms: Room[] = ROOMS.map(([x, z, w, h, kind], id) => ({ id, x, z, w, h, kind }));
  for (const r of rooms) grid.fillRect(r.x, r.z, r.w, r.h, Tile.Floor);
  // Five-wide corridors joining each room to the next.
  for (let i = 0; i + 1 < rooms.length; i++) {
    const a = rooms[i];
    const b = rooms[i + 1];
    grid.fillRect(a.x + a.w, 10, b.x - (a.x + a.w), 5, Tile.Floor);
  }
  grid.buildWalls();

  const c = rooms.map(roomCenter);
  const spawns: EnemySpawn[] = [
    { kind: 'grunt', x: c[1].x + 2.5, z: c[1].z + 0.5, roomId: 1 },
    { kind: 'archer', x: c[2].x + 3.5, z: c[2].z - 2.5, roomId: 2 },
    { kind: 'spider', x: c[3].x + 2.5, z: c[3].z - 2.5, roomId: 3 },
    { kind: 'spider', x: c[3].x + 3.5, z: c[3].z + 0.5, roomId: 3 },
    { kind: 'spider', x: c[3].x + 2.5, z: c[3].z + 3.5, roomId: 3 },
    { kind: 'boss', x: c[5].x + 0.5, z: c[5].z + 0.5, roomId: 5 },
  ];
  const boss = rooms[5];
  return {
    seed: 0,
    depth: 0,
    grid,
    rooms,
    connections: rooms.slice(1).map((r) => [r.id - 1, r.id] as [number, number]),
    spawns,
    chests: [{ x: c[4].x + 0.5, z: c[4].z + 0.5 }],
    exit: { x: boss.x + boss.w / 2, z: boss.z + 2.5 },
    boss: 'colossus',
    theme: 0,
    torches: placeTorches(grid, 5),
    playerStart: { x: c[0].x - 1.5, z: c[0].z + 0.5 },
    tutorial: true,
    heights: new Float32Array(grid.width * grid.height),
    gates: [],
    capture: null,
    portals: [],
    puzzles: [],
    rift: null,
  };
}

/** Boss health in the tutorial, as a fraction of a floor-1 boss. */
export const TUTORIAL_BOSS_HP = 0.4;

/** What the player has done so far (the game updates it). */
export interface TutorialProgress {
  moved: number;
  attacked: boolean;
  dodged: boolean;
  slammed: boolean;
  volleyed: boolean;
  chestOpened: boolean;
  inventoryOpened: boolean;
  equipped: boolean;
  drank: boolean;
  bossDead: boolean;
}

export function newTutorialProgress(): TutorialProgress {
  return {
    moved: 0,
    attacked: false,
    dodged: false,
    slammed: false,
    volleyed: false,
    chestOpened: false,
    inventoryOpened: false,
    equipped: false,
    drank: false,
    bossDead: false,
  };
}

export interface Lesson {
  title: string;
  /** Checklist: [text, done]. */
  steps: [string, boolean][];
  /** Shown once every step is done. */
  next: string;
}

/**
 * The lesson for the room the player is in. `cleared` says whether that
 * room's monsters are all dead.
 */
export function lessonFor(room: number, p: TutorialProgress, cleared: boolean): Lesson {
  switch (room) {
    case 0:
      return {
        title: 'Moving',
        steps: [
          ['Hold W to walk toward the mouse cursor', p.moved > 3],
          ['A / D circle around it, S backs away', p.moved > 6],
        ],
        next: 'Follow the corridor east →',
      };
    case 1:
      return {
        title: 'Fighting',
        steps: [
          ['Aim with the mouse and left-click to swing', p.attacked],
          ['Defeat the grunt', cleared],
        ],
        next: 'Nice. On to the next room →',
      };
    case 2:
      return {
        title: 'Dodging',
        steps: [
          ['Press Space to roll: you can’t be hit mid-roll', p.dodged],
          ['Roll through the arrows and defeat the archer', cleared],
        ],
        next: 'Keep going →',
      };
    case 3:
      return {
        title: 'Abilities',
        steps: [
          ['Q: ground slam hits everything around you', p.slammed],
          ['E: spear volley throws a fan of spears at the mouse', p.volleyed],
          ['Clear the spider pack', cleared],
        ],
        next: 'Abilities recharge: watch the icons at the bottom →',
      };
    case 4:
      return {
        title: 'Loot',
        steps: [
          ['Walk into the chest to open it, then pick up what falls out', p.chestOpened],
          ['Tab opens your inventory: click an item to equip it', p.equipped || p.inventoryOpened],
          ['Press 1 to drink a health potion when hurt', p.drank],
        ],
        next: 'Gear shows on your character. Now face the guardian →',
      };
    default:
      return {
        title: 'The boss',
        steps: [
          ['Every floor ends with a boss: watch the red warnings on the ground and roll away', p.bossDead],
          ['Step into the portal it leaves behind', false],
        ],
        next: '',
      };
  }
}

/** Index of the room containing (x, z), or the nearest room to the left of it in a corridor. */
export function roomAt(level: Dungeon, x: number, z: number): number {
  let best = 0;
  for (const r of level.rooms) {
    if (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.h) return r.id;
    if (x >= r.x + r.w) best = Math.max(best, r.id);
  }
  return best;
}

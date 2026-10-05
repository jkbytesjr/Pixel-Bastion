# Pixel Bastion

A dungeon crawler that runs in the browser, built entirely from coloured cubes. Descend through endless procedurally generated floors, collect loot with special powers, choose how your character grows, and see how deep you can get.

Nothing is pre-made: dungeon layouts, character models, loot and sound effects are all generated in code. The repo contains no image or audio assets.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-000000?logo=threedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)

**[▶ Play in your browser](https://jkbytesjr.github.io/Pixel-Bastion/)** · [Latest release: V1.5](https://github.com/jkbytesjr/Pixel-Bastion/releases/tag/v1.5) · [What's new](docs/releases/v1.5.0.md)

![Fighting a pack of monsters on a raised altar in the Overgrown Ruins](docs/screenshots/combat.png)

## Features

- **Endless procedurally generated floors**: arena rooms and wide corridors that get harder as you go. A seed always rebuilds the same dungeon, and the game remembers your deepest floor.
- **Four bosses** with telegraphed attacks that get faster in an enraged phase below half health and a desperate phase below a quarter. Each also has two special powers: warned impact zones, shockwaves to roll through, and eruption lanes. They return with grander titles every four floors.
- **Real-time combat**: mouse-aimed melee and bow attacks, a dodge roll with brief invulnerability, a ground slam, a spear volley and health potions.
- **Loot** in four rarities (common, rare, unique, mythic) with random stat modifiers. Unique and mythic weapons carry special powers like Chain Lightning and Ignite. Your equipped armor and weapon show on your character.
- **Level-up choices**: each level offers three random attributes to pick from. The choice waits until you're out of combat (or press L), so it never interrupts a fight. Levels come faster the deeper you go.
- **Shrines, gates and secrets**: capture each floor's shrine (stand in its circle while monsters try to contest it) to open the gates to the boss. Every floor hides one rift into another dimension, sealed until you solve two puzzles. Pressure-plate puzzles open vaults, and cracked walls hide secret rooms full of loot.
- **Tactical combat**: dodge rolls use stamina, monsters are exposed for extra damage right after they attack, high ground adds 20% damage, and every monster and boss has elemental weaknesses and resistances to exploit with weapon powers. Monsters flank, take turns, sidestep your shots and pounce on openings.
- **Online co-op**: play with up to 3 friends. One player hosts and shares a room code or invite link, and everyone fights through the same dungeon together. No server or sign-up needed.
- **Tutorial**: a short six-room walkthrough of moving, fighting, dodging, abilities, loot and a boss. New runs offer it first.
- **Character creator**: pick skin, hair style and colour, beard, eyes, tunic, scarf, trousers and boots, with a live preview.
- **Mods**: JSON files that tweak the rules, add items to the loot tables and add new enemy variants. Switch them on and off from the title screen.
- **Title screen and saves**: continue a saved run, start a new one or play a specific seed. The game autosaves at every floor, and Esc lets you save and quit.
- **Isometric voxel world**: a fixed 45° isometric camera over open arena rooms joined by wide corridors (5 to 7 tiles). Rooms have raised altars, stepped ledges and sunken pits with block staircases. Floors blend cobblestone, cracked tiles, slate, sandstone and terracotta, with inlaid mosaics and worn edges. Walls are block masonry with cornices, battlements, chiselled pillars, alcoves with iron gates, and arches over doorways. Rooms sit on layered cliffs or floating islands above deep chasms.
- **Six biomes in changing moods**: Ancient Temple, Overgrown Ruins, Dark Keep, Sky Bastion, Crystal Catacombs and Garden Courtyard, each lit by day, dusk, mist, torchlight, arcane or ember moods, so no two floors of a run look the same. Crates, barrels, urns and planters fill room corners. Mana crystals, magic circles and water channels glow and cast coloured light, sconces flicker, the sun casts long shadows, and bloom and haze add atmosphere.
- **Detailed characters**: faces, outfits and visible gear, and distinct enemy and boss designs.
- **Animation**: breathing, leaning into runs, wind-ups and follow-through on every attack, hit flinches, squash and stretch, a sword combo, and bodies that topple and bounce when they die.
- **Game feel**: particles, floating damage numbers, screen shake, a slow-motion "boss defeated" finale, a fog-of-war minimap, and sound effects synthesised in the browser.

## Screenshots

| | |
| --- | --- |
| ![The Cinder King in a Sky Bastion arena](docs/screenshots/boss-cinder-king.png) | ![Vesh the Thornhuntress in a Garden Courtyard arena](docs/screenshots/boss-huntress.png) |
| *The Cinder King, on a mosaic floor in the Sky Bastion.* | *Vesh the Thornhuntress, in the Garden Courtyard.* |
| ![Ancient Temple in daylight](docs/screenshots/world-temple.png) | ![Dark Keep by torchlight](docs/screenshots/world-keep.png) |
| *Ancient Temple: sandstone, terracotta and long daylight shadows.* | *Dark Keep: basalt, violet shadow and a glowing magic circle.* |
| ![Overgrown Ruins](docs/screenshots/world-ruins.png) | ![Sky Bastion](docs/screenshots/world-sky.png) |
| *Overgrown Ruins: mossy masonry, ivy and wooden railings.* | *Sky Bastion: white stone and terracotta on floating islands.* |
| ![Inventory with an item comparison tooltip](docs/screenshots/inventory.png) | ![Level-up screen offering three attributes](docs/screenshots/level-up.png) |
| *Hover an item to compare it with your gear.* | *Pick one of three attributes on each level-up.* |

## Getting started

You need [Node.js](https://nodejs.org/) 22.12 or newer.

```sh
npm install
npm run dev
```

Then open http://localhost:5173. The title screen lets you start a new run, continue a saved one, type in a seed, customise your character or manage mods. A new run asks whether you want the tutorial first. You can turn that question off, and the tutorial stays available from the title screen. Sound starts after your first click or key press.

The same seed always produces the same floors, bosses and level-up offers. You can also skip the title screen and jump straight into a seed with a URL like `http://localhost:5173/?seed=12345`.

**Co-op.** Choose *Co-op* on the title screen, enter a name and pick *Host a game*. Share the 5-letter room code or the invite link, and friends join with *Co-op → Join* (or by opening the link). The host starts the run, and friends can also join after it has started. Everyone keeps their own character, gear, level and attributes:

- Every kill gives XP to the whole party.
- Loot goes to whoever walks over it.
- Monsters get 60% more health for each extra player.
- Stepping into the portal takes the whole party down a floor.
- A player who falls comes back on the next floor. The run ends only when everyone is down, and then the host can restart it for all.

Co-op doesn't pause, isn't saved, and runs with mods off so every player's game matches. Players connect directly to each other over WebRTC, using the free public PeerJS service only to find each other. A very strict school or work network can block that connection.

**Mods.** Mods are JSON files in `public/mods/`, listed in `public/mods/index.json`. You can also import one from *Mods* on the title screen. A mod can change rules such as XP, drop rates, enemy health and your damage. It can also add weapons and armor to the loot tables, and add recoloured, resized or tougher variants of existing enemies. Mods are plain data and never run code. `public/mods/example-mod.json` shows every option and ships switched off. The full format is in [`public/mods/README.md`](public/mods/README.md).

**Saving.** The game autosaves at the start of every floor. Press Esc and choose *Save & quit to menu* to stop playing, then pick *Continue* on the title screen. You resume at the start of the saved floor with your level, attributes and gear. Saves live in your browser, and dying deletes the save.

To make a production build:

```sh
npm run build      # type-check and build to dist/
npm run preview    # serve the build locally
```

`dist/` is a static site, so you can host it anywhere that serves static files.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move. By default W walks toward the mouse, S backs away and A/D circle around it. Switch to screen-relative movement on the title screen. |
| Mouse | Aim |
| Left click | Attack (hold to keep attacking) |
| Space | Dodge roll, with brief invulnerability. Uses stamina (the green bar): about three rolls from full |
| Q | Ground slam (area damage) |
| E | Spear volley (7 spears in a spread) |
| 1 | Drink a health potion |
| 1 / 2 / 3 | Pick an attribute on the level-up screen |
| L | Choose a level-up attribute now, without waiting for the fight to end |
| Tab / I | Inventory (pauses the game) |
| H | Controls overlay (pauses the game) |
| Esc | Pause menu (resume, controls, save & quit) |
| M | Mute / unmute |
| F3 | FPS and draw-call meter |
| R | Restart after death |

## How a run works

Each floor is a set of rooms joined by corridors, ending in a boss arena. Killing the boss triggers a slow-motion finale and opens a portal to the next floor. The floors never end: enemies keep getting tougher, and the run is over when you die. The death screen shows how deep you got and your best floor so far.

**Each floor.** Find the shrine and capture it to open the gates sealing the boss arena. Stand inside its circle until the meter fills; any monster in the circle contests it, and more climb out of the floor while you capture. Along the way:

- **The hidden rift.** Every floor hides one rift into another dimension, behind a cracked wall. It stays dormant until you break its two seals:
  - **Rift plates:** step on three plates in the order shown by an obelisk crowned with a violet crystal.
  - **Brazier trial:** touch the four violet braziers in one room to light them. The first one starts a clock, and if it runs out they all go dark.

  When both seals break, the rift's wall glows violet and the rift shows up on the minimap. It leads to a pocket dimension with an elite pack and two rich chests, and the way back puts you exactly where you stepped in.
- Three coloured pressure plates open a vault. The obelisk beside the vault door blinks their order, and a wrong plate resets them.
- A faintly glowing crack marks a hidden wall. Strike it twice to break through to a secret room.
- A cyan portal pair, on some floors, is a shortcut between distant rooms.

**Tactics.**

- **Exposed:** monsters are off balance for a moment after attacking (a yellow marker above them) and take 50% more damage.
- **High ground:** fighting from a raised ledge or altar gives +20% damage, and fighting up from below gives -15%. The same goes for monsters hitting you.
- **Elements:** weapon powers deal elements: Ignite and Detonate are fire, Frost is frost, Chain Lightning is lightning, and Shockwave is force. Spiders burn, wraiths fear lightning, exploders and the Cinder King shrug off fire, and the game tells you the first time you find a weakness or resistance.

**Enemies.** New kinds appear as you go deeper, and any of them can spawn as a gold-ringed **elite** with much more health, harder hits and a guaranteed good drop. Elites get more common the deeper you go.

| Enemy | From floor | How it fights |
| --- | --- | --- |
| Grunt (orc) | 1 | Charges in and slams with a club. |
| Archer | 1 | Keeps its distance, strafes and shoots. |
| Exploder (goblin) | 1 | Sprints at you and detonates its powder keg. |
| Spider | 1 | Hunts in packs of three, crouches and lunges. |
| Shieldbearer | 2 | Blocks most damage from the front and turns slowly, so flank it. Open while recovering from a shield bash. |
| Shaman | 3 | Hangs back, heals nearby monsters and lobs poison bolts. Kill it first. |
| Wraith | 4 | Floating ghost that blinks in behind you and slashes. |

**Bosses.** Every big attack is marked on the ground in red before it lands.

| Boss | Fighting style |
| --- | --- |
| The Ashen Colossus | Ground slams, charges, and summons helpers when hurt. |
| Vesh the Thornhuntress | Stays at range, fires arrow fans and rapid shots, and dashes away if you close in. |
| The Cinder King | Drops bombs on marked spots around you and blasts a fire nova if you get close. |
| The Hollow Lich | Raises minions, fires bolt fans and rings, and teleports away when cornered. |

Floor 1 is always the Colossus, and floors 2–4 bring the other three in an order set by the seed. After that each floor gets a seeded boss, never the same one twice in a row. Returning bosses earn a title every four floors: *Reborn* from floor 5, *Ascendant* from floor 9 and *Eternal* from floor 13.

**Loot.** Enemies and chests drop swords, spears, bows, armor and potions in four rarities: common, rare, unique and mythic. Rarer items have bigger stats and more modifiers. Mythic items are very rare on the first floors and turn up more often deeper down and from bosses. Your equipped gear appears on your character (leather, chain or plate, with rarity-coloured trim) and in the HUD.

**Weapon powers.** Every unique weapon has one special power, and every mythic weapon has two stronger ones. Powers trigger on weapon hits:

| Power | Effect |
| --- | --- |
| Ignite | Sets enemies on fire, dealing damage over time. |
| Frost | Slows enemies, with a chance to freeze them solid. Bosses are only slowed. |
| Chain Lightning | Chance to arc to several nearby enemies. |
| Shockwave | Every few hits releases a blast around the target. |
| Detonate | Critical hits explode, damaging enemies around the target. |

**Leveling.** Kills give XP, and deeper floors give much more, so each level takes fewer kills the further you get. Each level-up fully heals you and lets you choose one of three random attributes, such as max HP, damage, crit chance, attack speed or faster cooldowns. Each attribute has a maximum rank.

## Development

```sh
npm run lint && npm run typecheck && npm test   # run before every commit
npm run smoke                                    # headless browser test
npm run smoke:coop                               # two-player co-op test
```

- **Unit tests** (`npm test`, Vitest) cover the pure game logic: dungeon generation and boss order, the collision grid, damage formulas, loot rolls and weapon powers, inventory, leveling pace and attribute picks, save validation, co-op messages, stamina and tactics, boss hazards, shrine capture and plate puzzles, floor features (gates, portals, secrets) and their reachability, mod validation and merging, character looks, the tutorial layout, pathfinding, the fixed-step clock and minimap exploration.
- **Smoke test** (`npm run smoke`) starts the dev server and plays the game in headless Chromium with Playwright. It checks movement (including walking toward the mouse), combat, every enemy type (including spider lunges, shield blocking, shaman healing and wraith blinks), elites and summons, ten floors and their bosses, the boss-defeated banner, the death summary, loot, every weapon power, inventory, abilities, level-ups, the pause menu, saving and continuing, the title screen, the character creator, the mods screen, the tutorial, effects and the HUD. It fails on any console error or warning, and saves screenshots to `smoke-out/`. Install the browser once with `npx playwright install chromium`.

### Project layout

```
src/
  core/      Game loop, fixed-step clock, input, seeded RNG, event bus, camera rig
  world/     Dungeon generator, tutorial floor, tile grid and collision, voxel level builder, torches, fog of war
  entities/  Player and gear models, enemies, bosses (bosses/), chests, pickups, portal
  systems/   Damage, loot, weapon powers, inventory, leveling, attributes, saves, mods, character looks, projectiles, pathfinding, particles, audio
  net/       Co-op: room codes, the message protocol, connections (PeerJS / WebRTC) and keeping players in sync
  ui/        Title and pause menus, co-op lobby and party HUD, character creator, mods screen, HUD, minimap, inventory, level-up screen, damage numbers, FPS meter
public/mods/ Mod files, the example mod and the mod format guide
tests/       Vitest unit tests
scripts/     Playwright smoke test
docs/        README screenshots
```

### How it's built

- **Game logic is separate from rendering.** Generation, loot, damage and progression don't import three.js, so they're tested without a browser.
- **Seeded randomness.** A mulberry32 RNG derives every floor, its boss and the level-up offers from the run seed.
- **Grid collision.** Characters are circles that slide along wall tiles; there's no physics engine.
- **Fixed timestep.** The simulation runs at 60 Hz regardless of screen refresh rate. The camera, particles, damage numbers and minimap update every rendered frame.
- **Event-driven effects.** The simulation emits events (`hit`, `enemyDied`, `explosion`, ...). Sound, particles, damage numbers, screen shake and messages listen for them and never change game state.
- **Cheap rendering.** Level geometry is built from instanced boxes, split into 16×16-tile chunks so anything off screen is skipped. Character models merge their boxes into one mesh per body part, and all particles share a single pooled instanced mesh. Small pools of point lights follow the torches and glowing spots nearest the player. If the frame rate stays low, the renderer lowers its resolution and then turns off shadows.
- **Synthesised audio.** Sound effects are built from Web Audio oscillators and filtered noise. Audio starts on the first key press or click, as browsers require.

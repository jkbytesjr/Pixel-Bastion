// Headless browser smoke test: boots the dev server, loads the game, drives
// input, fails on any console error/warning, and saves screenshots.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const outDir = process.env.SMOKE_OUT ?? 'smoke-out';
mkdirSync(outDir, { recursive: true });

const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
// Chromium's software GL reports a stall when Playwright reads pixels for a
// screenshot. That is the harness, not the game, so it is ignored.
const harnessNoise = /GL Driver Message .*GPU stall due to ReadPixels/;
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !harnessNoise.test(m.text()))
    problems.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
};
const state = () => page.evaluate(() => window.__game.debugState());
/**
 * Wait `ms` of real time and at least three rendered frames. Headless software
 * rendering can drop to ~8 fps, so a fixed short wait can end before the game
 * has even seen a key press.
 */
const settle = async (ms) => {
  const f0 = await page.evaluate(() => window.__game?.frameCount ?? 0);
  await page.waitForTimeout(ms);
  await page.waitForFunction((f) => (window.__game?.frameCount ?? 0) >= f + 3, f0, { timeout: 20000 });
};
/** Wait for `seconds` of simulated game time (headless rendering runs slower than real time). */
const waitSim = async (seconds) => {
  const start = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((t) => window.__game.simTime >= t, start + seconds, { timeout: 60000 });
};

try {
  await page.goto('http://localhost:5199/?seed=777');
  await page.waitForFunction(() => window.__game && window.__stats, null, { timeout: 20000 });
  // Level-up choices would pause the game mid-test; auto-pick except where tested.
  await page.evaluate(() => (window.__game.autoPerk = true));
  await page.mouse.move(900, 300);
  await page.screenshot({ path: `${outDir}/01-start.png` });

  const boot = await state();
  check(boot.enemies.length > 8, `dungeon spawns enemies (${boot.enemies.length})`);
  const kinds = new Set(boot.enemies.map((e) => e.kind));
  check(['grunt', 'archer', 'exploder', 'boss'].every((k) => kinds.has(k)), `all enemy kinds present (${[...kinds]})`);
  const s0 = await state();
  await page.keyboard.down('KeyW');
  await settle(800);
  await page.keyboard.up('KeyW');
  const s1 = await state();
  check(Math.hypot(s1.player.x - s0.player.x, s1.player.z - s0.player.z) > 1, 'W moves the player');

  // Walk into a wall for a long time; the player must stay on walkable ground.
  await page.keyboard.down('KeyA');
  await settle(3000);
  await page.keyboard.up('KeyA');
  const s2 = await state();
  const inside = await page.evaluate(({ x, z }) => window.__game.level.grid.isWalkableAt(x, z), s2.player);
  check(inside, `player stays inside walls (at ${s2.player.x.toFixed(2)}, ${s2.player.z.toFixed(2)})`);
  await page.screenshot({ path: `${outDir}/02-after-move.png` });

  await page.screenshot({ path: `${outDir}/02b-wall.png` });

  // --- M2: combat ---
  await page.evaluate(() => window.__game.restart());
  await settle(200);
  // Grunt 1.2 tiles away; aim at it and attack until it dies.
  await page.evaluate(() => window.__game.debugSpawn('grunt', 1.2, 0));
  await settle(100);
  const target = async () => (await state()).enemies.find((e) => e.alive && e.kind === 'grunt');
  const aimAtGrunt = async () => {
    const g = await target();
    if (!g) return false;
    const sp = await page.evaluate(({ x, z }) => window.__game.debugWorldToScreen(x, z), g);
    await page.mouse.move(sp.x, sp.y);
    return true;
  };
  await aimAtGrunt();
  const hp0 = (await target()).hp;
  await page.mouse.down();
  await settle(250);
  await page.screenshot({ path: `${outDir}/03-combat.png` });
  for (let i = 0; i < 60 && (await aimAtGrunt()); i++) await waitSim(0.15);
  await page.mouse.up();
  const g3 = await target();
  check(!g3 || g3.hp < hp0, 'attacks damage the grunt');
  check(!g3, 'grunt can be killed');
  check((await state()).player.xp > 0, 'kills grant XP');

  // Dodge: player moves quickly and is flagged as dodging (i-frames).
  const d0 = await state();
  await page.keyboard.press('Space');
  // Wait for the next simulation tick to pick up the press (headless frames are slow).
  const dodged = await page
    .waitForFunction(() => window.__game.debugState().player.dodging, null, { polling: 'raf', timeout: 2000 })
    .then(() => true, () => false);
  check(dodged, 'space starts a dodge roll');
  await settle(400);
  const d2 = await state();
  check(Math.hypot(d2.player.x - d0.player.x, d2.player.z - d0.player.z) > 1.5, 'dodge roll covers distance');

  // Grunt attacks: stand still next to one and check HP drops.
  await page.evaluate(() => window.__game.debugSpawn('grunt', 1.0, 0));
  await waitSim(2.5);
  const h = await state();
  check(h.player.hp < h.player.maxHp, `grunt damages the player (hp ${h.player.hp}/${h.player.maxHp})`);
  await page.screenshot({ path: `${outDir}/04-hurt.png` });

  // Death screen + restart.
  await page.evaluate(() => window.__game.world.player.applyDamage(9999, 0, 0));
  await settle(600);
  check(await page.isVisible('.screen.death'), 'death screen shows at 0 HP');
  check((await page.textContent('.screen.death .summary')).includes('Reached floor 1'), 'death screen shows the floor reached');
  await page.screenshot({ path: `${outDir}/05-death.png` });
  await page.click('.restart');
  await settle(200);
  const r = await state();
  check(r.player.alive && r.player.hp === 100 && !(await page.isVisible('.screen.death')), 'restart restores the player');

  // --- M4: archer, exploder, boss, portal, victory ---
  const extra = () => page.evaluate(() => window.__game.debugExtra());
  await page.evaluate(() => window.__game.restart());
  await settle(200);
  await page.evaluate(() => window.__game.debugSpawn('archer', 0, 5.5));
  let sawArrow = false;
  for (let i = 0; i < 40 && !sawArrow; i++) {
    await waitSim(0.1);
    sawArrow = (await extra()).projectiles > 0;
  }
  check(sawArrow, 'archer fires arrows');
  await page.screenshot({ path: `${outDir}/07-archer.png` });

  await page.evaluate(() => window.__game.restart());
  await settle(200);
  await page.evaluate(() => window.__game.debugSpawn('exploder', 3, 0));
  await waitSim(0.6);
  await page.screenshot({ path: `${outDir}/08-exploder-fuse.png` });
  await waitSim(2);
  const ex = await state();
  check(ex.player.hp < ex.player.maxHp && !ex.enemies.some((e) => e.kind === 'exploder' && e.alive), `exploder detonates (hp ${ex.player.hp})`);

  // Bosses: walk into each arena, let the boss fight a while, then kill it and use the portal.
  // Floors are endless; walk through enough to see two boss title upgrades.
  const floors = 9;
  const bossKinds = [];
  for (let depth = 0; depth < floors; depth++) {
    const boss = (await state()).enemies.find((e) => e.kind === 'boss');
    // Unkillable for this loop, so late bosses can't end the run early.
    await page.evaluate(() => {
      const p = window.__game.worldState.player;
      p.maxHp = p.hp = 100000;
    });
    await page.evaluate(({ x, z }) => window.__game.debugTeleport(x, z + 5), boss);
    await waitSim(2.5);
    const info = await extra();
    bossKinds.push(info.bossKind);
    check(info.bossEngaged, `floor ${depth + 1}: ${info.bossKind} engages`);
    if (depth === 0) check(await page.isVisible('.boss-bar'), 'boss health bar shows');
    const bossName = await page.textContent('.boss-name');
    if (depth === 4) check(bossName.endsWith('Reborn'), `floor 5 boss is Reborn (${bossName})`);
    if (depth === 8) check(bossName.endsWith('Ascendant'), `floor 9 boss is Ascendant (${bossName})`);
    if (depth < 4) await page.screenshot({ path: `${outDir}/09-boss-${depth + 1}-${info.bossKind}.png` });
    await page.evaluate(() => window.__game.debugKillBoss());
    await settle(300);
    if (depth === 0) {
      const banner = await page.isVisible('.boss-banner.show');
      const bname = await page.textContent('.bb-name');
      check(banner && bname.includes('Colossus'), `boss defeated banner shows (${bname})`);
      await settle(400);
      await page.screenshot({ path: `${outDir}/09b-boss-defeated.png` });
    }
    if (depth === 0) check((await extra()).portalActive, 'portal opens after the boss dies');
    const exit = await page.evaluate(() => window.__game.level.exit);
    await page.evaluate(({ x, z }) => window.__game.debugTeleport(x, z), exit);
    await settle(300);
    check((await extra()).depth === depth + 1, `portal leads to floor ${depth + 2}`);
  }
  check(bossKinds[0] === 'colossus' && new Set(bossKinds.slice(0, 4)).size === 4, `floors 1-4 have four different bosses (${bossKinds.join(', ')})`);
  check(bossKinds.every((b, i) => i === 0 || b !== bossKinds[i - 1]), 'no boss repeats on back-to-back floors');
  check(await page.textContent('.floor-label').then((t) => t.startsWith('Floor 10 ·')), 'floors keep going past the old 6-floor limit');
  await page.screenshot({ path: `${outDir}/10-floor10.png` });

  // Death ends the run: summary, best floor, and New run rolls a new seed.
  const seedBefore = await page.evaluate(() => window.__game.seed);
  await page.evaluate(() => window.__game.worldState.player.applyDamage(1e9, 0, 0));
  await settle(400);
  check((await page.textContent('.screen.death .summary')).includes('Reached floor 10'), 'death summary shows floor 10');
  check((await extra()).bestFloor >= 10, `best floor is recorded (${(await extra()).bestFloor})`);
  await page.click('.new-run');
  await settle(200);
  check(
    (await extra()).depth === 0 && (await page.evaluate(() => window.__game.seed)) !== seedBefore && !(await page.isVisible('.screen.death')),
    'New run starts a fresh dungeon at floor 1',
  );

  // --- M5: loot, chests, inventory, weapons, abilities, potions ---
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.2);
  const chests = await page.evaluate(() => window.__game.worldState.chests.map((c) => ({ x: c.x, z: c.z })));
  check(chests.length > 0, `level has chests (${chests.length})`);
  const chestStart = await state();
  const bag0 = chestStart.player.bag;
  await page.evaluate(({ x, z }) => window.__game.debugTeleport(x, z), chests[0]);
  // Loot becomes collectible after a short delay; grab the drop positions and
  // step back before the player (standing on the chest) auto-collects them.
  await page.waitForFunction(() => window.__game.worldState.pickups.length > 0, null, { polling: 'raf', timeout: 10000 }).catch(() => {});
  const drops = await page.evaluate(({ x, z }) => {
    const g = window.__game;
    const d = g.worldState.pickups.map((p) => ({ ...p.pos }));
    g.debugTeleport(x, z);
    return d;
  }, chestStart.player);
  check(await page.evaluate(() => window.__game.worldState.chests[0].opened), 'walking up to a chest opens it');
  await page.screenshot({ path: `${outDir}/11-chest.png` });
  await waitSim(0.5);
  check(drops.length > 0, `chest spills loot (${drops.length})`);
  for (const d of drops) {
    await page.evaluate(({ x, z }) => window.__game.debugTeleport(x, z), d);
    await waitSim(0.15);
  }
  const afterLoot = await state();
  check(afterLoot.player.bag > bag0 || afterLoot.player.potions > 1, 'walking over loot picks it up');

  // Inventory: equip a spear from the bag via the UI.
  await page.evaluate(() => {
    const inv = window.__game.worldState.player.inventory;
    inv.bag.length = 0;
  });
  await page.evaluate(() => window.__game.debugGive('weapon', 'unique'));
  await page.evaluate(() => window.__game.debugGive('armor', 'rare'));
  await page.keyboard.press('Tab');
  await settle(150);
  check(await page.isVisible('.inventory'), 'Tab opens the inventory');
  const simBefore = await page.evaluate(() => window.__game.simTime);
  await settle(300);
  check((await page.evaluate(() => window.__game.simTime)) === simBefore, 'game is paused while inventory is open');
  await page.hover('[data-bag="0"]');
  await settle(100);
  await page.screenshot({ path: `${outDir}/12-inventory.png` });
  const weaponBefore = (await state()).player.weapon;
  const newKind = await page.evaluate(() => window.__game.worldState.player.inventory.bag[0].weapon);
  await page.click('[data-bag="0"]');
  check((await state()).player.weapon === newKind && newKind !== undefined, `clicking a bag weapon equips it (${weaponBefore} -> ${newKind})`);
  const armorIdx = await page.evaluate(() => window.__game.worldState.player.inventory.bag.findIndex((i) => i.kind === 'armor'));
  const hpMaxBefore = (await state()).player.maxHp;
  await page.click(`[data-bag="${armorIdx}"]`);
  check((await state()).player.maxHp > hpMaxBefore, 'equipping armor raises max HP');
  await page.keyboard.press('Tab');
  await settle(100);
  check(!(await page.isVisible('.inventory')), 'Tab closes the inventory');
  check(await page.evaluate(() => (window.__game.worldState.player.worn?.parts.length ?? 0) > 0), 'equipped armor is shown on the character');
  check(
    await page.evaluate(() => {
      const m = window.__game.worldState.player.model;
      return !m.hair || m.hair.visible === false;
    }),
    'headgear hides the hair instead of clipping through it',
  );
  check(
    (await page.locator('[data-gear="weapon"] svg').count()) === 1 && (await page.locator('[data-gear="armor"].empty').count()) === 0,
    'HUD shows equipped weapon and armor',
  );
  await page.screenshot({ path: `${outDir}/12b-armor.png` });

  // Bow fires arrows; Q slam and E volley.
  await page.evaluate(() => {
    const p = window.__game.worldState.player;
    p.inventory.weapon = { ...p.inventory.weapon, kind: 'weapon', weapon: 'bow', damage: 9, mods: [] };
    p.refreshEquipment();
  });
  await page.mouse.move(900, 300);
  const shots0 = (await extra()).shots;
  await page.mouse.down();
  await waitSim(0.6);
  await page.mouse.up();
  check((await extra()).shots > shots0, 'bow attack fires an arrow');
  // Let any bow draw already in progress release before counting the volley.
  await waitSim(0.8);
  const shots1 = (await extra()).shots;
  await page.keyboard.press('KeyE');
  await waitSim(0.05);
  check((await extra()).shots - shots1 === 7, 'E throws a 7-spear volley');
  await page.screenshot({ path: `${outDir}/13-volley.png` });
  await page.evaluate(() => window.__game.debugSpawn('grunt', 1.5, 0));
  await waitSim(0.1);
  const slamHp = (await target()).hp;
  await page.keyboard.press('KeyQ');
  await waitSim(0.7);
  const afterSlam = await target();
  check(!afterSlam || afterSlam.hp < slamHp, 'Q ground slam damages nearby enemies');

  // Potion heals.
  await page.evaluate(() => window.__game.debugSpawn('archer', 30, 30));
  await page.evaluate(() => {
    const p = window.__game.worldState.player;
    p.hp = 20;
    p.inventory.potions = 2;
  });
  await page.keyboard.press('Digit1');
  await waitSim(0.1);
  const healed = await state();
  check(healed.player.hp > 20 && healed.player.potions === 1, `1 drinks a potion (hp ${healed.player.hp})`);

  // --- Weapon powers ---
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.2);
  await page.evaluate(() => {
    const g = window.__game;
    window.__fx = { power: {}, burn: 0, status: {} };
    g.events.on('power', (e) => (window.__fx.power[e.id] = (window.__fx.power[e.id] ?? 0) + 1));
    g.events.on('burnTick', () => window.__fx.burn++);
    g.events.on('status', (e) => (window.__fx.status[e.kind] = (window.__fx.status[e.kind] ?? 0) + 1));
  });
  /** Equip a sword with the given powers, surround the player with grunts, and swing for a while. */
  const testPowers = async (powers, crit) => {
    await page.evaluate(
      ({ powers, crit }) => {
        const g = window.__game;
        const p = g.worldState.player;
        p.inventory.weapon = { ...p.inventory.weapon, id: Math.random(), rarity: 'mythic', weapon: 'sword', damage: 6, powers };
        p.refreshEquipment();
        p.maxHp = p.hp = 100000;
        if (crit) p.stats.critChance = 1;
        g.debugSpawn('grunt', 1.3, 0);
        for (const [dx, dz] of [[1.5, 0.8], [1.5, -0.8], [2.2, 0]]) g.worldState.spawn(g.debugCreateEnemy('grunt'), p.pos.x + dx, p.pos.z + dz);
      },
      { powers, crit },
    );
    await page.mouse.move(...Object.values(await page.evaluate(() => {
      const p = window.__game.worldState.player.pos;
      return window.__game.debugWorldToScreen(p.x + 1.5, p.z);
    })));
    await page.mouse.down();
    await waitSim(2.5);
    await page.mouse.up();
    return page.evaluate(() => window.__fx);
  };
  let fxc = await testPowers([{ id: 'ignite', tier: 2 }, { id: 'chain', tier: 2 }], false);
  check(fxc.burn > 0 && fxc.status.burn > 0, `Ignite burns enemies (${fxc.burn} burn ticks)`);
  check((fxc.power.chain ?? 0) > 0, `Chain Lightning arcs between enemies (${fxc.power.chain ?? 0})`);
  await page.screenshot({ path: `${outDir}/17-powers.png` });
  fxc = await testPowers([{ id: 'shockwave', tier: 2 }, { id: 'detonate', tier: 2 }], true);
  check((fxc.power.shockwave ?? 0) > 0, `Shockwave triggers (${fxc.power.shockwave ?? 0})`);
  check((fxc.power.detonate ?? 0) > 0, `Detonate triggers on crits (${fxc.power.detonate ?? 0})`);
  fxc = await testPowers([{ id: 'frost', tier: 2 }], false);
  check((fxc.status.chill ?? 0) + (fxc.status.freeze ?? 0) > 0, 'Frost chills enemies');
  await page.evaluate(() => {
    window.__game.debugGive('weapon', 'mythic');
    const inv = window.__game.worldState.player.inventory;
    const it = inv.bag[inv.bag.length - 1];
    window.__mythic = { rarity: it.rarity, powers: it.powers?.length ?? 0 };
  });
  const myth = await page.evaluate(() => window.__mythic);
  check(myth.rarity === 'mythic' && myth.powers === 2, 'mythic weapons roll with two powers');
  await page.keyboard.press('Tab');
  await settle(150);
  await page.hover(`[data-bag="${(await state()).player.bag - 1}"]`);
  await settle(120);
  check((await page.locator('.tooltip .tt-power').count()) === 2, 'tooltip lists the weapon powers');
  await page.screenshot({ path: `${outDir}/18-mythic-tooltip.png` });
  await page.keyboard.press('Tab');
  await settle(100);

  // --- Level-up attribute choice ---
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.2);
  await page.evaluate(() => {
    const g = window.__game;
    g.autoPerk = false;
    const p = g.worldState.player;
    p.hp = 30;
    p.gainXp(1000);
    // Pretend a fight is going on: the choice must wait.
    g.worldState.calmTime = 0;
  });
  await settle(120);
  check(
    !(await extra()).levelUpOpen && (await page.isVisible('.levelup-ready')),
    'level-up waits during a fight, with an "attribute ready" badge',
  );
  await page.keyboard.press('KeyL');
  await settle(200);
  const lv = await state();
  check((await extra()).levelUpOpen && (await page.locator('.levelup .perk').count()) === 3, `level-up offers 3 attributes (level ${lv.player.level})`);
  const simL = await page.evaluate(() => window.__game.simTime);
  await settle(300);
  check((await page.evaluate(() => window.__game.simTime)) === simL, 'game is paused while choosing');
  await page.screenshot({ path: `${outDir}/16-levelup.png` });
  const before = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    return { picks: p.progress.pendingPicks, potions: p.inventory.potions };
  });
  await page.keyboard.press('Digit1');
  await settle(150);
  const after = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    return { picks: p.progress.pendingPicks, potions: p.inventory.potions, perks: Object.values(p.progress.perks).reduce((a, b) => a + b, 0) };
  });
  check(after.perks === 1 && after.picks === before.picks - 1, `pressing 1 picks an attribute (${after.picks} picks left)`);
  check(after.potions >= before.potions, 'picking with 1 does not also drink a potion');
  // Click through any remaining picks.
  for (let i = 0; i < 20 && (await extra()).levelUpOpen; i++) {
    await page.click('.levelup .perk >> nth=1');
    await settle(80);
  }
  const lvDone = { open: (await extra()).levelUpOpen, alive: (await state()).player.alive, pending: await page.evaluate(() => window.__game.worldState.player.progress.pendingPicks) };
  check(!lvDone.open && lvDone.alive, `clicking a card picks it and resumes (${JSON.stringify(lvDone)})`);
  await page.evaluate(() => (window.__game.autoPerk = true));

  // --- M6: particles, damage numbers, minimap, audio, HUD ---
  const fx = () => page.evaluate(() => window.__game.debugFx());
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.3);
  check((await fx()).explored > 20, `minimap reveals the start room (${(await fx()).explored} tiles)`);
  check(await page.evaluate(() => {
    const c = document.querySelector('.minimap canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }), 'minimap canvas has drawn pixels');
  check((await fx()).audio === 'running', `audio unlocks after input (${(await fx()).audio})`);
  await page.evaluate(() => window.__game.debugSpawn('grunt', 1.4, 0));
  await waitSim(0.1);
  await page.mouse.move(900, 300);
  await page.mouse.down();
  await waitSim(0.5);
  const fxHit = await fx();
  await page.mouse.up();
  check(fxHit.particles > 0, `hits spawn particles (${fxHit.particles})`);
  check(fxHit.damageNumbers > 0 && (await page.locator('.dmg:not(.hidden)').count()) > 0, `hits show damage numbers (${fxHit.damageNumbers})`);
  await page.screenshot({ path: `${outDir}/14-effects.png` });
  await page.evaluate(() => (window.__game.worldState.player.hp = 10));
  await page.evaluate(() => window.__game.worldState.player.applyDamage(1, 0, 0));
  await settle(150);
  check(await page.locator('.vignette.low').count() === 1, 'low HP shows the warning vignette');
  const muted0 = (await fx()).muted;
  await page.keyboard.press('KeyM');
  await settle(100);
  check((await fx()).muted !== muted0 && (await page.textContent('.sound-hint')).includes(muted0 ? 'on' : 'off'), 'M toggles sound');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('KeyH');
  await settle(100);
  const simH = await page.evaluate(() => window.__game.simTime);
  await settle(300);
  check(await page.isVisible('.controls-panel') && (await page.evaluate(() => window.__game.simTime)) === simH, 'H shows controls and pauses');
  await page.screenshot({ path: `${outDir}/15-controls.png` });
  await page.keyboard.press('KeyH');
  await settle(100);
  check(!(await page.isVisible('.controls-panel')), 'H hides controls');
  const t0 = await page.evaluate(() => window.__game.simTime);
  await settle(1000);
  const simRate = (await page.evaluate(() => window.__game.simTime)) - t0;
  check(simRate > 0.2, `fixed-step simulation keeps running (${simRate.toFixed(2)} sim s per real s)`);

  // --- Movement follows the mouse ---
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.3);
  {
    const p0 = (await state()).player;
    // Aim at a point up-left of the player on screen, then hold W.
    const target = await page.evaluate(({ x, z }) => window.__game.debugWorldToScreen(x - 2.2, z + 1.2), p0);
    await page.mouse.move(target.x, target.y);
    await waitSim(0.1);
    await page.keyboard.down('KeyW');
    await waitSim(0.3);
    await page.keyboard.up('KeyW');
    const p1 = (await state()).player;
    const mx = p1.x - p0.x;
    const mz = p1.z - p0.z;
    const dot = (mx * -2.2 + mz * 1.2) / (Math.hypot(mx, mz) * Math.hypot(-2.2, 1.2) || 1);
    check(Math.hypot(mx, mz) > 0.5 && dot > 0.8, `W walks toward the mouse (alignment ${dot.toFixed(2)})`);
  }

  // --- Pause menu, saving, title screen, continue ---
  await page.evaluate(() => {
    const g = window.__game;
    const p = g.worldState.player;
    p.gainXp(400);
    g.debugGive('weapon', 'mythic');
    g.loadFloor(2);
  });
  await waitSim(0.2);
  // Let auto-pick spend any queued attribute picks first.
  await page.waitForFunction(() => window.__game.worldState.player.progress.pendingPicks === 0, null, { timeout: 10000 });
  const beforeSave = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    return { level: p.progress.level, bag: p.inventory.bag.length, perks: JSON.stringify(p.progress.perks) };
  });
  await page.keyboard.press('Escape');
  await settle(150);
  const simP = await page.evaluate(() => window.__game.simTime);
  await settle(250);
  check((await page.isVisible('.pause-menu')) && (await page.evaluate(() => window.__game.simTime)) === simP, 'Escape pauses the game');
  await page.screenshot({ path: `${outDir}/19-pause.png` });
  await page.click('.pause-menu [data-act="save"]');
  await settle(400);
  check(
    (await page.isVisible('.main-menu')) && (await page.evaluate(() => window.__game.mode)) === 'menu' && !(await page.isVisible('.hp-bar')),
    'Save & quit shows the title screen without the HUD',
  );
  const contText = await page.textContent('.main-menu [data-act="continue"]').catch(() => '');
  check(contText.includes('Floor 3') && contText.includes(`Level ${beforeSave.level}`), `title screen offers Continue (${contText.replace(/\s+/g, ' ').trim()})`);
  await settle(800);
  await page.screenshot({ path: `${outDir}/20-title.png` });
  await page.click('.main-menu [data-act="continue"]');
  await settle(300);
  const afterLoad = await page.evaluate(() => {
    const g = window.__game;
    const p = g.worldState.player;
    return { mode: g.mode, depth: g.depth, level: p.progress.level, bag: p.inventory.bag.length, perks: JSON.stringify(p.progress.perks) };
  });
  check(
    afterLoad.mode === 'playing' && afterLoad.depth === 2 && afterLoad.level === beforeSave.level && afterLoad.bag === beforeSave.bag && afterLoad.perks === beforeSave.perks,
    `Continue restores floor, level, attributes and bag (before ${JSON.stringify(beforeSave)} after ${JSON.stringify(afterLoad)})`,
  );
  await page.evaluate(() => window.__game.worldState.player.applyDamage(1e9, 0, 0));
  await settle(300);
  check((await page.evaluate(() => window.localStorage.getItem('voxel-dungeon:save'))) === null, 'dying deletes the save');
  await page.click('.screen.death .to-menu');
  await settle(300);
  check((await page.isVisible('.main-menu')) && (await page.locator('.main-menu [data-act="continue"]').count()) === 0, 'death screen leads to the menu, with no Continue');
  await page.fill('.menu-seed input', '4242');
  await page.click('.menu-seed button');
  await settle(300);
  check((await page.evaluate(() => [window.__game.mode, window.__game.seed, window.__game.depth].join())) === 'playing,4242,0', 'Play seed starts that dungeon');
  await page.evaluate(() => window.__game.showMenu());
  await settle(150);
  await page.click('.main-menu [data-move="screen"]');
  check((await page.evaluate(() => window.localStorage.getItem('voxel-dungeon:move-mode'))) === 'screen', 'movement setting is saved');
  await page.click('.main-menu [data-move="mouse"]');

  // --- Character creator ---
  await page.click('.main-menu [data-act="character"]');
  await settle(200);
  check((await page.isVisible('.char-panel')) && !(await page.isVisible('.main-menu')), 'Character opens the creator');
  await page.click('.char-panel [data-style="mohawk"]');
  await page.click('.char-panel .swatch[data-key="shirt"] >> nth=1');
  await page.click('.char-panel [data-beard="on"]');
  await settle(600);
  const look = await page.evaluate(() => JSON.parse(window.localStorage.getItem('voxel-dungeon:appearance') ?? 'null'));
  const heroLook = await page.evaluate(() => window.__game.worldState.player.appearance);
  check(look?.hairStyle === 'mohawk' && look.beard !== null && heroLook.hairStyle === 'mohawk', 'look changes apply live and are saved');
  await page.screenshot({ path: `${outDir}/24-character.png` });
  await page.click('.char-panel [data-act="done"]');
  await settle(150);
  check(await page.isVisible('.main-menu'), 'Done returns to the menu');

  // --- Mods screen ---
  await page.click('.main-menu [data-act="mods"]');
  await settle(200);
  const modNames = await page.locator('.mods-panel .mod-name').allTextContents();
  check(modNames.some((n) => n.includes('Example Mod')), `mods folder is listed (${modNames.join(', ')})`);
  check((await page.locator('.mods-panel .mod-row.on').count()) === 0, 'the example mod ships switched off');
  await page.click('.mods-panel [data-toggle="0"]');
  await settle(100);
  check(
    (await page.locator('.mods-panel .mod-row.on').count()) === 1 &&
      (await page.evaluate(() => window.__game.mods.activeCount)) === 1,
    'a mod can be switched on',
  );
  await page.screenshot({ path: `${outDir}/25-mods.png` });
  await page.click('.mods-panel [data-act="done"]');
  await settle(150);
  check((await page.textContent('.main-menu [data-act="mods"]')).includes('1'), 'menu shows the active mod count');

  // --- Tutorial prompt and tutorial ---
  await page.click('.main-menu [data-act="new"]');
  await settle(200);
  check((await page.isVisible('.tutorial-prompt')) && (await page.evaluate(() => window.__game.mode)) === 'menu', 'New run asks about the tutorial first');
  await page.click('.tutorial-prompt [data-act="yes"]');
  await settle(300);
  check(
    (await page.evaluate(() => [window.__game.mode, window.__game.tutorial].join())) === 'playing,true' && (await page.isVisible('.tutorial-box')),
    'Yes starts the tutorial with its checklist',
  );
  check((await page.textContent('.floor-label')) === 'Tutorial', 'HUD labels the tutorial floor');
  await page.keyboard.down('KeyW');
  await waitSim(1.2);
  await page.keyboard.up('KeyW');
  await settle(100);
  check((await page.locator('.tutorial-box li.done').count()) >= 1, 'moving ticks off the first tutorial step');
  await page.screenshot({ path: `${outDir}/26-tutorial.png` });
  // Beat the guardian and take the portal: the real run starts.
  await page.evaluate(() => {
    const g = window.__game;
    g.debugKillBoss();
  });
  await waitSim(0.6);
  await page.evaluate(() => {
    const g = window.__game;
    g.debugTeleport(g.level.exit.x, g.level.exit.z);
  });
  await waitSim(0.5);
  check(
    (await page.evaluate(() => [window.__game.tutorial, window.__game.depth, window.__game.mode].join())) === 'false,0,playing' &&
      !(await page.isVisible('.tutorial-box')),
    'the tutorial portal starts the real run on floor 1',
  );
  await page.evaluate(() => window.__game.showMenu());
  await settle(150);
  await page.click('.main-menu [data-act="new"]');
  await settle(150);
  await page.click('.tutorial-prompt [data-act="no"]');
  await settle(300);
  check((await page.evaluate(() => [window.__game.mode, window.__game.tutorial].join())) === 'playing,false', 'No starts the run directly');

  // --- New mobs, elites, summons, animations ---
  await page.evaluate(() => window.__game.restart());
  await waitSim(0.3);
  await page.evaluate(() => {
    const g = window.__game;
    window.__ev = { blocked: 0, enemyHeal: 0, teleport: 0, rise: 0 };
    for (const k of Object.keys(window.__ev)) g.events.on(k, () => window.__ev[k]++);
  });
  const ev = () => page.evaluate(() => window.__ev);
  /** Place a mob near the player; it's kept as window.__mobs[tag] so later checks find the same one. */
  const placeMob = (tag, kind, dx, dz, setup) =>
    page.evaluate(
      ({ tag, kind, dx, dz, setup }) => {
        const g = window.__game;
        const p = g.worldState.player;
        const e = g.debugPlace(kind, dx, dz);
        e.facing = Math.atan2(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
        if (setup) new Function('e', 'g', setup)(e, g);
        (window.__mobs ??= {})[tag] = e;
      },
      { tag, kind, dx, dz, setup },
    );
  const mob = (tag, expr) => page.evaluate(({ tag, expr }) => new Function('e', `return ${expr}`)(window.__mobs[tag]), { tag, expr });
  const clearMobs = () =>
    page.evaluate(() => {
      for (const e of window.__game.worldState.enemies) if (!e.isBoss && e.alive) {
        e.rewardsOnDeath = false;
        e.applyDamage(1e9, 0, 0);
      }
    });
  const healMe = () => page.evaluate(() => { const p = window.__game.worldState.player; p.godMode = false; p.hp = p.maxHp; });

  // Spider: a pack member lunges and bites.
  await clearMobs();
  await healMe();
  await placeMob('spider', 'spider', 2.2, 0.4);
  await waitSim(2.5);
  const sp = await state();
  check(sp.player.hp < sp.player.maxHp, `spider lunges and bites (hp ${sp.player.hp}/${sp.player.maxHp})`);
  await page.screenshot({ path: `${outDir}/22-spider.png` });

  // Shieldbearer: blocks from the front, not from behind.
  await clearMobs();
  await placeMob('sb', 'shieldbearer', 1.8, 0, "e.state = 'advance';");
  const guard = await mob(
    'sb',
    '({ front: e.incomingMult(e.pos.x + Math.sin(e.facing) * 2, e.pos.z + Math.cos(e.facing) * 2), back: e.incomingMult(e.pos.x - Math.sin(e.facing) * 2, e.pos.z - Math.cos(e.facing) * 2) })',
  );
  check(guard.front < 0.5 && guard.back === 1, `shieldbearer blocks from the front only (front ×${guard.front}, back ×${guard.back})`);
  await page.evaluate(() => (window.__game.worldState.player.godMode = true));
  await page.mouse.move(...Object.values(await mob('sb', 'window.__game.debugWorldToScreen(e.pos.x, e.pos.z)')));
  await page.mouse.down();
  await waitSim(0.8);
  await page.mouse.up();
  check((await ev()).blocked > 0, `hitting the shield shows a block (${(await ev()).blocked})`);
  await page.screenshot({ path: `${outDir}/23-shieldbearer.png` });

  // Shaman: heals a wounded ally.
  await clearMobs();
  await page.evaluate(() => (window.__game.worldState.player.godMode = true));
  await placeMob('hurt', 'grunt', -2.2, 1.5, 'e.hp = Math.round(e.maxHp * 0.3);');
  await placeMob('shaman', 'shaman', -2.2, -1.2);
  const healHp0 = await mob('hurt', 'e.hp');
  await waitSim(4.5);
  const healHp1 = await mob('hurt', 'e.hp');
  check((await ev()).enemyHeal > 0 && healHp1 > healHp0, `shaman heals a wounded grunt (${healHp0} -> ${healHp1})`);
  await page.screenshot({ path: `${outDir}/24-shaman.png` });

  // Wraith: blinks behind the player.
  await clearMobs();
  const tp0 = (await ev()).teleport;
  await placeMob('wraith', 'wraith', 4, 1);
  await waitSim(3);
  check((await ev()).teleport > tp0, 'wraith blinks to the player');
  await page.screenshot({ path: `${outDir}/25-wraith.png` });

  // Elites and summons.
  await clearMobs();
  const elite = await page.evaluate(() => {
    const g = window.__game;
    const e = g.debugCreateEnemy('grunt');
    const base = e.maxHp;
    e.makeElite();
    return { ratio: e.maxHp / base, elite: e.elite };
  });
  check(elite.elite && elite.ratio > 2, `elites are much tougher (×${elite.ratio.toFixed(1)} HP)`);
  const rose = await page.evaluate(() => {
    const w = window.__game.worldState;
    const p = w.player.pos;
    w.ctx.spawnEnemy('grunt', p.x + 2, p.z);
    return w.enemies[w.enemies.length - 1].rising;
  });
  check(rose && (await ev()).rise > 0, 'summoned monsters rise out of the floor');

  // Sword alternates slash and chop.
  await clearMobs();
  const swings = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    p.inventory.weapon = { ...p.inventory.weapon, weapon: 'sword', id: Math.random() };
    p.refreshEquipment();
    return p.swingIndex;
  });
  await page.mouse.down();
  await waitSim(0.5);
  await page.mouse.up();
  await waitSim(0.5);
  const swings2 = await page.evaluate(() => window.__game.worldState.player.swingIndex);
  check(typeof swings === 'number' && typeof swings2 === 'number', 'sword combo state tracks swings');
  await page.evaluate(() => (window.__game.worldState.player.godMode = false));

  // --- Floor features: shrine & gates, plates, secrets, portals ---
  await page.evaluate(() => window.__game.startRun(4242));
  await waitSim(0.3);
  await page.evaluate(() => {
    const g = window.__game;
    g.worldState.player.godMode = true;
    for (const e of g.worldState.enemies) if (!e.isBoss) { e.rewardsOnDeath = false; e.applyDamage(1e9, 0, 0); }
  });
  await waitSim(0.3);
  const feat = await page.evaluate(() => {
    const lvl = window.__game.level;
    const boss = lvl.gates.find((x) => x.kind === 'boss');
    return { capture: lvl.capture, bossGate: boss ? boss.tiles[0] : null, gates: lvl.gates.length, puzzles: lvl.puzzles.length, portals: lvl.portals.map((p) => p.kind) };
  });
  check(!!feat.capture && !!feat.bossGate, `the floor has a capture shrine and a sealed boss gate (${feat.gates} gates, portals: ${feat.portals.join(', ')})`);
  check(
    await page.evaluate((t) => !window.__game.level.grid.isWalkable(t.x, t.z), feat.bossGate),
    'the boss gate blocks the way while closed',
  );
  check(await page.isVisible('.objective'), 'the objective tracker shows the shrine goal');

  // Capture: stand in the circle; a monster inside contests it.
  await page.evaluate((c) => window.__game.debugTeleport(c.x, c.z), feat.capture);
  await page.waitForFunction(() => window.__game.worldState.features.capture.state === 'capturing', null, { timeout: 30000 });
  check(true, 'standing in the shrine circle starts capturing it');
  await page.waitForSelector('.obj-meter:not(.hidden)', { timeout: 10000 });
  check(true, 'the capture meter appears near the shrine');
  await page.evaluate((c) => {
    const w = window.__game.worldState;
    const e = window.__game.debugCreateEnemy('grunt');
    w.spawn(e, c.x + 1, c.z);
    e.maxHp = e.hp = 99999;
  }, feat.capture);
  await page.waitForFunction(() => window.__game.worldState.features.capture.state === 'contested', null, { timeout: 30000 });
  check(true, 'a monster in the circle contests the capture');
  await page.evaluate(() => {
    const w = window.__game.worldState;
    for (const e of w.enemies) if (!e.isBoss) { e.rewardsOnDeath = false; e.applyDamage(1e9, 0, 0); }
    w.features.capture.progress = 0.9;
  });
  await page.waitForFunction(() => window.__game.worldState.features.capture.state === 'captured', null, { timeout: 60000 });
  check(await page.evaluate((t) => window.__game.level.grid.isWalkable(t.x, t.z), feat.bossGate), 'capturing the shrine opens the boss gate');

  // Plate puzzle: wrong order resets, right order opens the vault.
  const puzzleFloor = await page.evaluate(() => {
    for (let d = 0; d < 8; d++) {
      window.__game.loadFloor(d);
      if (window.__game.level.puzzles.length) return d;
    }
    return -1;
  });
  if (puzzleFloor >= 0) {
    const pz = await page.evaluate(() => {
      const p = window.__game.level.puzzles[0];
      const gate = window.__game.level.gates.find((g) => g.id === p.gateId).tiles[0];
      return { plates: p.plates, order: p.order, gate };
    });
    await page.evaluate(() => {
      const w = window.__game.worldState;
      w.player.godMode = true;
      for (const e of w.enemies) if (!e.isBoss) { e.rewardsOnDeath = false; e.applyDamage(1e9, 0, 0); }
    });
    const step = async (i) => {
      await page.evaluate((p) => window.__game.debugTeleport(p.x, p.z), pz.plates[i]);
      await waitSim(0.25);
      await page.evaluate((p) => window.__game.debugTeleport(p.x + 2.2, p.z + 2.2), pz.plates[i]);
      await waitSim(0.15);
    };
    await step(pz.order[1]);
    check((await page.evaluate(() => window.__game.worldState.features.snapshot().pz[0])) === 0, 'a plate out of order resets the puzzle');
    for (const i of pz.order) await step(i);
    check(await page.evaluate((t) => window.__game.level.grid.isWalkable(t.x, t.z), pz.gate), 'the plates in the right order open the vault');
  } else check(false, 'found a floor with a plate puzzle');

  // Secret wall: strike it and it gives way.
  const secret = await page.evaluate(() => {
    const lvl = window.__game.level;
    const g = lvl.gates.find((x) => x.kind === 'secret');
    if (!g) return null;
    const t = g.tiles[0];
    // The room side: the floor tile next to it.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (lvl.grid.isWalkable(t.x + dx, t.z + dz)) return { t, x: t.x + dx + 0.5, z: t.z + dz + 0.5 };
    return null;
  });
  if (secret) {
    await page.evaluate((s) => window.__game.debugTeleport(s.x, s.z), secret);
    await waitSim(0.2);
    const aimAt = await page.evaluate((t) => window.__game.debugWorldToScreen(t.x + 0.5, t.z + 0.5), secret.t);
    await page.mouse.move(aimAt.x, aimAt.y);
    await page.mouse.down();
    await page.waitForFunction((t) => window.__game.level.grid.isWalkable(t.x, t.z), secret.t, { timeout: 60000 }).catch(() => {});
    await page.mouse.up();
    check(await page.evaluate((t) => window.__game.level.grid.isWalkable(t.x, t.z), secret.t), 'striking a cracked wall reveals a secret passage');
  } else check(false, 'found a secret wall on the floor');

  // Mini-portal: into the pocket dimension, and back out to exactly where we stepped in.
  const link = await page.evaluate(() => window.__game.level.portals.find((p) => p.kind === 'pocket'));
  if (link) {
    await page.evaluate((l) => window.__game.debugTeleport(l.a.x, l.a.z), link);
    await waitSim(0.3);
    const inPocket = await page.evaluate((l) => Math.hypot(window.__game.worldState.player.pos.x - l.b.x, window.__game.worldState.player.pos.z - l.b.z) < 0.5, link);
    check(inPocket, 'a mini-portal carries the hero into its pocket dimension');
    await waitSim(1);
    check(
      await page.evaluate((l) => Math.hypot(window.__game.worldState.player.pos.x - l.b.x, window.__game.worldState.player.pos.z - l.b.z) < 0.5, link),
      'arriving on a portal does not bounce the hero straight back',
    );
    await page.evaluate((l) => window.__game.debugTeleport(l.b.x + 2, l.b.z - 2), link);
    await waitSim(0.3);
    await page.evaluate((l) => window.__game.debugTeleport(l.b.x, l.b.z), link);
    await waitSim(0.3);
    const back = await page.evaluate(() => ({ ...window.__game.worldState.player.pos }));
    check(Math.hypot(back.x - link.a.x, back.z - link.a.z) < 0.05, 'the return portal puts the hero back exactly where they entered');
  } else check(false, 'found a pocket-dimension portal');

  // --- Tactics ---
  await page.evaluate(() => window.__game.loadFloor(0));
  await waitSim(0.3);
  const rolls = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    p.stamina.value = 20;
    return p.actions[1];
  });
  await page.keyboard.press('Space');
  await waitSim(0.3);
  check((await page.evaluate(() => window.__game.worldState.player.actions[1])) === rolls, 'no dodge roll without enough stamina');
  await page.evaluate(() => (window.__game.worldState.player.stamina.value = 100));
  await page.keyboard.press('Space');
  await waitSim(0.3);
  check((await page.evaluate(() => window.__game.worldState.player.actions[1])) === rolls + 1, 'with stamina the roll goes off and costs stamina');
  const tactics = await page.evaluate(() => {
    const g = window.__game;
    const w = g.worldState;
    const seen = [];
    const off = w.events.on.bind(w.events);
    off('hit', (e) => e.tag && seen.push(e.tag));
    off('affinity', (e) => seen.push(`aff:${e.label}`));
    const p = w.player.pos;
    const spider = g.debugCreateEnemy('spider');
    w.spawn(spider, p.x + 1.5, p.z);
    spider.maxHp = spider.hp = 99999;
    w.damageEnemy(spider, { base: 10, power: 1, critChance: 0, critMultiplier: 1 }, p.x, p.z, 0, false, w.player, 'fire');
    const grunt = g.debugCreateEnemy('grunt');
    w.spawn(grunt, p.x - 1.5, p.z);
    grunt.maxHp = grunt.hp = 99999;
    grunt.expose(1);
    const before = grunt.hp;
    w.damageEnemy(grunt, { base: 10, power: 1, critChance: 0, critMultiplier: 1 }, p.x, p.z, 0);
    return { seen, exposedHit: before - grunt.hp };
  });
  check(tactics.seen.includes('weak') && tactics.seen.includes('aff:weak'), `fire finds the spider's weakness (${tactics.seen.join(', ')})`);
  check(tactics.seen.includes('exposed') && tactics.exposedHit >= 13, `exposed monsters take extra damage (${tactics.exposedHit})`);

  // --- Bosses: phases and telegraphed powers ---
  await page.evaluate(() => {
    const g = window.__game;
    const b = g.worldState.boss;
    g.debugTeleport(b.pos.x, b.pos.z + 5);
    b.hp = b.maxHp * 0.45;
  });
  await page.waitForFunction(() => window.__game.worldState.boss.engaged, null, { timeout: 60000 });
  await page.waitForSelector('.boss-bar.phase2', { timeout: 30000 });
  check(true, 'a hurt boss enrages (phase 2 on the boss bar)');
  await page.waitForFunction(() => window.__game.worldState.boss.hazards.count > 0, null, { timeout: 90000 }).catch(() => {});
  check(await page.evaluate(() => window.__game.worldState.boss.hazards.count > 0), 'the boss uses telegraphed hazard powers');
  await page.screenshot({ path: `${outDir}/28-boss-hazards.png` });
  await page.evaluate(() => (window.__game.worldState.player.godMode = false));

  // --- Hidden admin access and commands ---
  await page.evaluate(() => window.__game.showMenu());
  await settle(200);
  check(!(await page.isVisible('.admin-login')), 'admin login is hidden by default');
  // Fire the clicks straight at the element: headless software rendering is too slow for
  // five real clicks (each waits on frames) to land inside the 2.5 s window.
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) document.querySelector('.menu-title').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle(150);
  check(await page.isVisible('.admin-login'), 'clicking the title 5 times opens the hidden login');
  await page.fill('.admin-login input[name="user"]', 'jkbytes');
  await page.fill('.admin-login input[name="pass"]', 'not-the-password');
  await page.click('.admin-login button[type="submit"]');
  await settle(100);
  check((await page.textContent('.admin-error')).includes('Wrong'), 'wrong credentials are rejected');
  if (process.env.ADMIN_PW) {
    // The real password is never stored in the repo; pass it in to test a real login.
    await page.fill('.admin-login input[name="user"]', 'jkbytes');
    await page.fill('.admin-login input[name="pass"]', process.env.ADMIN_PW);
    await page.click('.admin-login button[type="submit"]');
    await settle(150);
    check(await page.isVisible('.admin-console'), 'correct login opens the admin console');
    await page.keyboard.press('Escape');
  } else {
    await page.click('.admin-login [data-act="cancel"]');
  }
  await page.click('.main-menu [data-act="new"]');
  await settle(150);
  await page.check('.tutorial-prompt .tp-check input');
  await page.click('.tutorial-prompt [data-act="no"]');
  await settle(200);
  const adm = (line) => page.evaluate((l) => window.__game.adminCommand(window.__game.debugParse(l)), line);
  check((await adm('help')).includes('give'), 'admin help lists commands');
  await adm('god on');
  await page.evaluate(() => window.__game.worldState.player.applyDamage(500, 0, 0));
  check((await state()).player.alive && (await state()).player.hp === (await state()).player.maxHp, 'god mode blocks damage');
  await adm('god off');
  check((await adm('give weapon mythic 3')).startsWith('Added 3 mythic'), 'give adds mythic weapons');
  check((await adm('floor 7')).includes('7') && (await extra()).depth === 6, 'floor jumps to floor 7');
  const killed = await adm('killall');
  await waitSim(0.3);
  check(killed.startsWith('Killed') && (await state()).enemies.filter((e) => e.alive && e.kind !== 'boss').length === 0, `killall clears the floor (${killed})`);
  // Auto-picked level-ups may already have ranked Might up, so check the change.
  const mightBefore = await page.evaluate(() => window.__game.worldState.player.progress.perks.might ?? 0);
  const perkOut = await adm('perk might 2');
  check(perkOut.includes(`rank ${Math.min(10, mightBefore + 2)}`), `perk adds attribute ranks (${perkOut})`);
  check((await adm('perk ascendance')).includes('rank 100'), 'perk ascendance sets every attribute to rank 100');
  // Ascended attack speed must still land hits: swings shorten to fit.
  await page.evaluate(() => window.__game.debugSpawn('grunt', 0, 1.4));
  await page.mouse.move(...Object.values(await page.evaluate(() => {
    const g = window.__game;
    const e = g.debugState().enemies.find((x) => x.alive && x.kind === 'grunt');
    return g.debugWorldToScreen(e.x, e.z);
  })));
  await page.mouse.down();
  await waitSim(0.5);
  await page.mouse.up();
  check(
    (await state()).enemies.filter((e) => e.kind === 'grunt' && e.alive).length === 0,
    'ascended rapid attacks still hit',
  );
  check((await adm('level 60')).startsWith('Level 60'), 'level raises character level');
  check((await adm('level 500')).startsWith('Usage: level <1-100>'), 'without an admin login the level cap is 100');
  await page.evaluate(() => (window.__game.worldState.player.levelCap = 1000));
  check((await adm('level 500')).startsWith('Level 500'), 'the admin level cap is 1000');
  await page.evaluate(() => (window.__game.autoPerk = true));
  await waitSim(0.1);
  check((await adm('frobnicate')).startsWith('Unknown'), 'unknown commands are reported');
  const gear = await adm('admingear all');
  const worn = await page.evaluate(() => {
    const p = window.__game.worldState.player;
    return { w: p.inventory.weapon.rarity, a: p.inventory.armor?.rarity, powers: p.inventory.weapon.powers?.length, hp: p.maxHp, dmg: p.inventory.weapon.damage };
  });
  check(gear.startsWith('Equipped') && worn.w === 'admin' && worn.a === 'admin' && worn.powers === 5 && worn.hp >= 999999 && worn.dmg === 999999, `admingear equips maxed gear (${JSON.stringify(worn)})`);
  await settle(200);
  await page.screenshot({ path: `${outDir}/27-admin-gear.png` });
  check((await adm('spawn frost-grunt 2')).startsWith('Spawned 2 Frost Grunt'), 'spawn makes mod variants');
  check((await adm('spawn dragon')).startsWith('Enemies:'), 'spawn lists valid enemies');
  const modList = await adm('mods');
  check(modList.includes('[on]') && modList.includes('Example Mod'), 'mods lists loaded mods');
  await page.screenshot({ path: `${outDir}/21-floor7.png` });

  // --- M3: floors render with their own theme ---
  for (const depth of [1, 2]) {
    await page.evaluate((d) => window.__game.loadFloor(d), depth);
    await settle(300);
    await page.screenshot({ path: `${outDir}/06-floor${depth + 1}.png` });
  }
  await page.evaluate(() => window.__game.loadFloor(0));

  const stats = await page.evaluate(() => window.__stats);
  console.log(`stats (headless software GL, not representative): ${JSON.stringify(stats)}`);
} catch (e) {
  check(false, String(e));
}
check(problems.length === 0, `no console errors/warnings${problems.length ? ':\n  ' + problems.join('\n  ') : ''}`);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);

// Co-op smoke test: a host and a guest in two tabs of one headless browser,
// connected over a BroadcastChannel (?net=local) instead of the internet.
// Checks the lobby, starting a run, seeing each other, combat on both sides,
// shared XP, loot, floor changes, a party wipe and leaving.
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ logLevel: 'error', server: { port: 5196, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
const problems = [];
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
};

async function open(name) {
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('GPU stall')) problems.push(`${name}: ${m.text()}`);
  });
  return page;
}
const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });
const g = (page, fn, arg) => page.evaluate(fn, arg);

try {
  const host = await open('host');
  await host.goto('http://localhost:5196/?net=local');
  await waitFor(host, () => window.__game?.frameCount > 2);

  // --- Lobby ---
  await host.click('.main-menu [data-act="coop"]');
  await host.fill('.coop-panel input[name="name"]', 'Hosty');
  await host.click('.coop-panel [data-act="host"]');
  await waitFor(host, () => !!document.querySelector('.coop-code'));
  const code = (await host.textContent('.coop-code')).trim();
  check(/^[A-Z2-9]{5}$/.test(code), `hosting shows a room code (${code})`);

  const guest = await open('guest');
  await guest.goto(`http://localhost:5196/?net=local&join=${code}`);
  await waitFor(guest, () => !!document.querySelector('.coop-panel:not(.hidden) input[name="code"]'));
  check((await guest.inputValue('.coop-panel input[name="code"]')) === code, 'an invite link fills in the code');
  await guest.fill('.coop-panel input[name="name"]', 'Guesty');
  await guest.click('.coop-panel .coop-join button');
  await waitFor(guest, () => document.querySelectorAll('.coop-slot:not(.empty)').length === 2);
  await waitFor(host, () => document.querySelectorAll('.coop-slot:not(.empty)').length === 2);
  check(true, 'both lobbies list two players');
  check((await guest.textContent('.coop-players')).includes('Hosty'), 'the guest sees the host by name');

  // --- Start ---
  await host.click('.coop-panel [data-act="start"]');
  await waitFor(guest, () => window.__game.mode === 'playing' && window.__game.coop?.started);
  const seeds = [await g(host, () => window.__game.seed), await g(guest, () => window.__game.seed)];
  check(seeds[0] === seeds[1], `the guest plays the host's dungeon (seed ${seeds[0]})`);
  await waitFor(host, () => window.__game.worldState.remotes.length === 1);
  await waitFor(guest, () => window.__game.worldState.remotes.length === 1);
  check(true, 'each side sees the other hero');
  check(
    (await g(host, () => window.__game.worldState.enemies.length)) === (await g(guest, () => window.__game.worldState.enemies.length)),
    'both copies of the floor have the same monsters',
  );
  await waitFor(host, () => window.__game.worldState.remotes[0].name === 'Guesty');
  // --- Floor features stay in sync: the host captures the shrine, the guest's gate opens ---
  const gateTile = await g(host, () => window.__game.level.gates.find((x) => x.kind === 'boss')?.tiles[0] ?? null);
  if (gateTile) {
    check(await g(guest, (t) => !window.__game.level.grid.isWalkable(t.x, t.z), gateTile), "the guest's boss gate starts closed");
    await g(host, () => {
      const f = window.__game.worldState.features;
      f.capture.progress = 1;
      f.capture.state = 'captured';
      f.openGate(window.__game.level.gates.find((x) => x.kind === 'boss').id);
    });
    await waitFor(guest, (t) => window.__game.level.grid.isWalkable(t.x, t.z), gateTile);
    check((await g(guest, () => window.__game.worldState.features.capture.state)) === 'captured', "the host's capture opens the gate for the guest too");
  } else check(false, 'the co-op floor has a boss gate');

  check(true, "the host knows the guest's name");
  await waitFor(guest, () => !!document.querySelector('.party-list:not(.hidden)'));
  check((await guest.textContent('.party-list')).includes('Hosty'), 'the party list shows everyone');
  for (const p of [host, guest]) await g(p, () => (window.__game.worldState.player.godMode = true));

  // --- Movement is shared ---
  const spot = await g(host, () => {
    const lvl = window.__game.level;
    const r = lvl.rooms.find((x) => x.kind === 'normal');
    return { x: r.x + r.w / 2 + 0.5, z: r.z + r.h / 2 + 0.5 };
  });
  await g(guest, (s) => window.__game.debugTeleport(s.x, s.z), spot);
  await waitFor(host, (s) => Math.hypot(window.__game.worldState.remotes[0].pos.x - s.x, window.__game.worldState.remotes[0].pos.z - s.z) < 1, spot);
  check(true, "the host sees the guest move");

  // --- The guest fights: hits are resolved by the host ---
  const enemyId = await g(host, (s) => {
    const w = window.__game.worldState;
    for (const e of w.enemies) if (!e.isBoss) { e.rewardsOnDeath = false; e.applyDamage(1e9, 0, 0); }
    const e = window.__game.debugCreateEnemy('grunt');
    w.spawn(e, s.x + 1.2, s.z);
    e.maxHp = e.hp = 5000;
    return e.netId;
  }, spot);
  await waitFor(guest, (id) => window.__game.worldState.enemies.some((e) => e.netId === id && e.alive), enemyId);
  const aim = await g(guest, (id) => {
    const e = window.__game.worldState.enemies.find((x) => x.netId === id);
    return window.__game.debugWorldToScreen(e.pos.x, e.pos.z);
  }, enemyId);
  await guest.mouse.move(aim.x, aim.y);
  await guest.mouse.down();
  await waitFor(host, (id) => {
    const e = window.__game.worldState.enemies.find((x) => x.netId === id);
    return e && e.hp < e.maxHp;
  }, enemyId);
  await guest.mouse.up();
  check(true, "the guest's sword hurts the host's monster");
  await waitFor(guest, (id) => {
    const e = window.__game.worldState.enemies.find((x) => x.netId === id);
    return e && e.hp < e.maxHp;
  }, enemyId);
  check(true, "the guest sees the monster's health drop");

  // --- Monsters hurt the guest (damage is sent to its owner) ---
  await g(guest, () => (window.__game.worldState.player.godMode = false));
  const hp0 = await g(guest, () => window.__game.worldState.player.hp);
  await waitFor(guest, (h) => window.__game.worldState.player.hp < h, hp0, 90000);
  check(true, 'monsters on the host hurt the guest');
  await g(guest, () => {
    const p = window.__game.worldState.player;
    p.godMode = true;
    p.hp = p.maxHp;
  });

  // --- Shared XP and loot ---
  const xp0 = await g(guest, () => window.__game.worldState.player.progress.xp + window.__game.worldState.player.progress.level * 1e6);
  await g(host, (id) => {
    const e = window.__game.worldState.enemies.find((x) => x.netId === id);
    e.rewardsOnDeath = true;
    e.applyDamage(1e9, 0, 0);
  }, enemyId);
  await waitFor(guest, (x) => window.__game.worldState.player.progress.xp + window.__game.worldState.player.progress.level * 1e6 > x, xp0);
  check(true, 'kills give XP to the whole party');
  await waitFor(guest, (id) => !window.__game.worldState.enemies.some((e) => e.netId === id && e.alive), enemyId);
  check(true, 'the dead monster dies on the guest too');

  const bag0 = await g(guest, () => window.__game.worldState.player.inventory.bag.length);
  await g(host, () => {
    const w = window.__game.worldState;
    const r = w.remotes[0];
    w.dropLoot([{ type: 'item', item: { kind: 'armor', id: 99, name: 'Test Vest', armor: 5, maxHp: 5, rarity: 'rare', itemLevel: 0, mods: [] } }], r.pos.x, r.pos.z);
  });
  await waitFor(guest, (b) => window.__game.worldState.player.inventory.bag.length > b, bag0);
  check(true, 'loot the guest walks over goes into their bag');

  // --- Floor change takes everyone ---
  await g(host, () => window.__game.loadFloor(1));
  await waitFor(guest, () => window.__game.depth === 1);
  check(true, 'when the host changes floor, the guest follows');

  // --- Party wipe ---
  for (const p of [host, guest]) await g(p, () => {
    const pl = window.__game.worldState.player;
    pl.godMode = false;
    pl.applyDamage(1e9, 0, 0);
  });
  await waitFor(host, () => !document.querySelector('.screen.death').classList.contains('hidden'));
  await waitFor(guest, () => !document.querySelector('.screen.death').classList.contains('hidden'));
  check(true, 'when everyone is down, both see the party death screen');
  check(!(await guest.isVisible('.screen.death .restart')), 'only the host can restart');
  await host.click('.screen.death .restart');
  await waitFor(guest, () => window.__game.worldState.player.alive && window.__game.depth === 0);
  check(true, "the host's Try again restarts the run for everyone");

  // --- Leaving ---
  await guest.click('.hud-bottom', { position: { x: 1, y: 1 } }).catch(() => {});
  await g(guest, () => window.__game.leaveCoop());
  await waitFor(host, () => window.__game.worldState.remotes.length === 0);
  check(true, 'a guest leaving disappears from the host');
  await g(host, () => window.__game.leaveCoop());
  check((await g(host, () => window.__game.worldState.role)) === 'solo', 'closing the room returns to solo play');
} catch (e) {
  check(false, String(e));
}
check(problems.length === 0, `no console errors or warnings${problems.length ? ':\n  ' + problems.join('\n  ') : ''}`);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);

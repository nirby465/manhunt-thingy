'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/game.js');
const engine = require('../lib/engine');
const Geo = require('../public/geo.js');

const MIN = 60000;
const home = { lat: 40.0, lng: -75.0 };

// --- tiny harness around the serverless handler (memory store)
async function call(body) {
  let status = 200, payload;
  const res = {
    setHeader() {},
    status(s) { status = s; return this; },
    json(p) { payload = p; return this; },
  };
  await handler({ method: 'POST', body }, res);
  return { status, ...payload };
}
const pos = (p, dn = 0, de = 0) => ({ ...Geo.offset(p, dn, de), acc: 5 });

async function newGame(names, settings) {
  const host = await call({ action: 'create', name: names[0] });
  const players = [{ name: names[0], pid: host.pid, token: host.token }];
  for (const n of names.slice(1)) {
    const j = await call({ action: 'join', code: host.code, name: n });
    assert.ok(j.pid, JSON.stringify(j));
    players.push({ name: n, pid: j.pid, token: j.token });
  }
  const s = {
    zones: { enabled: true, shape: { shape: 'circle', center: home, radius: 500 }, oobGraceSec: 60 },
    ...settings,
  };
  const r = await call({ action: 'settings', code: host.code, pid: host.pid, token: host.token, settings: s });
  assert.ok(!r.error, r.error);
  return { code: host.code, players, host: players[0] };
}
const act = (g, p, action, extra = {}) => call({ action, code: g.code, pid: p.pid, token: p.token, ...extra });
const sync = (g, p, loc) => act(g, p, 'sync', { loc });

// Put everyone at a location and make sure the server has it.
async function place(g, map) {
  for (const [p, loc] of map) await sync(g, p, loc);
}

async function started(names, settings) {
  const g = await newGame(names, settings);
  const r = await act(g, g.host, 'start');
  assert.ok(!r.error, r.error);
  const views = {};
  for (const p of g.players) views[p.name] = (await sync(g, p, pos(home))).view;
  const seekers = g.players.filter((p) => views[p.name].me.role === 'seeker');
  const hiders = g.players.filter((p) => views[p.name].me.role === 'hider');
  return { g, seekers, hiders, views };
}

test('create, join, defaults match the ruleset', async () => {
  const g = await newGame(['Host', 'Ann']);
  const v = (await sync(g, g.host, pos(home))).view;
  assert.equal(v.players.length, 2);
  const s = engine.defaultSettings();
  assert.equal(s.headStartMin, 5);
  assert.equal(s.pingIntervalMin, 5);
  assert.equal(s.seekerCount, 1);
  assert.equal(s.whenCaught, 'out');
  assert.equal(s.reveal.threshold, 2);
  assert.equal(s.reveal.durationMin, 15);
  assert.equal(s.bounty.durationMin, 15);
  assert.equal(s.bounty.reward, 1);
  assert.equal(s.abilities.revive.cost, 3);
  assert.equal(s.abilities.reboot.cost, 3);
  assert.equal(s.abilities.vanish.durationMin, 10);
  assert.equal(s.abilities.steal.cost, 1);
});

test('join validation: bad code, started game, only host can change rules', async () => {
  const bad = await call({ action: 'join', code: 'ZZZZZ', name: 'X' });
  assert.equal(bad.status, 404);
  const g = await newGame(['Host', 'Ann']);
  const r = await act(g, g.players[1], 'settings', { settings: { headStartMin: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.error, /host/i);
  await act(g, g.host, 'start');
  const late = await call({ action: 'join', code: g.code, name: 'Late' });
  assert.equal(late.status, 409);
});

test('start needs a zone when zones are on', async () => {
  const host = await call({ action: 'create', name: 'H' });
  await call({ action: 'join', code: host.code, name: 'A' });
  const r = await call({ action: 'start', code: host.code, pid: host.pid, token: host.token });
  assert.match(r.error, /play area/i);
});

test('pings: seekers see nothing during head start, then a snapshot only', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B'], { seekerCount: 1, pingIntervalMin: 5, headStartMin: 5 });
  const hider = hiders[0], seeker = seekers[0];
  await sync(g, hider, pos(home, 50, 0));
  let v = (await sync(g, seeker, pos(home))).view;
  assert.equal(v.markers.filter((m) => m.role === 'hider').length, 0, 'no hiders during head start');
  // fast-forward by rewriting timestamps through the engine
  const { store } = require('../lib/store');
  const { game, locs } = await store.read(g.code);
  game.hsEnd = Date.now() - 10;
  game.endsAt = game.hsEnd + 60 * MIN;
  await store.write(g.code, game);
  v = (await sync(g, seeker, pos(home))).view;
  const m = v.markers.find((x) => x.id === hider.pid);
  assert.ok(m, 'first ping at end of head start');
  assert.equal(m.kind, 'ping');
  const first = { lat: m.lat, lng: m.lng };
  await sync(g, hider, pos(home, 300, 0)); // hider moves; seeker must still see the old ping
  v = (await sync(g, seeker, pos(home))).view;
  const m2 = v.markers.find((x) => x.id === hider.pid);
  assert.ok(Geo.distance(first, m2) < 1, 'ping location stays frozen between pings');
});

test('live pings (0) show real-time positions', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B'], { pingIntervalMin: 0, headStartMin: 0 });
  await sync(g, hiders[0], pos(home, 120, 0));
  const v = (await sync(g, seekers[0], pos(home))).view;
  const m = v.markers.find((x) => x.id === hiders[0].pid);
  assert.equal(m.kind, 'live');
  await sync(g, hiders[0], pos(home, 200, 0));
  const v2 = (await sync(g, seekers[0], pos(home))).view;
  assert.ok(Geo.distance(v2.markers.find((x) => x.id === hiders[0].pid), pos(home, 200, 0)) < 1);
});

test('tag: out mode removes hider; range, safe zone and shield are respected', async () => {
  const { g, seekers, hiders } = await started(['H', 'A'], { headStartMin: 0, pingIntervalMin: 0 });
  const [s] = seekers; const [h] = hiders;
  await place(g, [[s, pos(home)], [h, pos(home, 200, 0)]]);
  let r = await act(g, s, 'tag', { loc: pos(home) });
  assert.match(r.error, /No hider within/);
  // personal safe zone blocks the tag
  await sync(g, h, pos(home, 5, 0));
  r = await act(g, h, 'safe', { loc: pos(home, 5, 0) });
  assert.ok(!r.error, r.error);
  r = await act(g, s, 'tag', { loc: pos(home) });
  assert.match(r.error, /safe zone/);
  // second placement is refused (stock 1)
  r = await act(g, h, 'safe', { loc: pos(home, 5, 0) });
  assert.match(r.error, /no safe zones/i);
  // step out of the safe zone and get tagged
  await sync(g, h, pos(home, 40, 0));
  await sync(g, s, pos(home, 30, 0));
  r = await act(g, s, 'tag', { loc: pos(home, 30, 0) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.players.find((p) => p.id === h.pid).role, 'out');
});

test('zombie rule: tagged hider turns into a seeker and the game ends when none remain', async () => {
  const { g, seekers, hiders } = await started(['H', 'A'], { mode: 'zombie', whenCaught: 'seeker', headStartMin: 0, pingIntervalMin: 0 });
  const [s] = seekers; const [h] = hiders;
  await place(g, [[s, pos(home)], [h, pos(home, 5, 0)]]);
  const r = await act(g, s, 'tag', { loc: pos(home) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.phase, 'ended');
  assert.equal(r.view.winner, 'seekers');
  assert.equal(r.view.players.find((p) => p.id === h.pid).role, 'seeker');
});

test('boundary: seeker out of bounds is eliminated; hider outcome follows the mode', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B', 'C'], { headStartMin: 0, pingIntervalMin: 0 });
  const far = pos(home, 2000, 0);
  await sync(g, seekers[0], far);
  await sync(g, hiders[0], far);
  const { store } = require('../lib/store');
  const { game } = await store.read(g.code);
  for (const p of Object.values(game.players)) if (p.oobSince) p.oobSince -= 120000; // grace period passed
  await store.write(g.code, game);
  const watcher = g.players.find((p) => p.pid !== seekers[0].pid && p.pid !== hiders[0].pid);
  const v = (await sync(g, watcher, pos(home))).view;
  const by = (id) => v.players.find((p) => p.id === id);
  assert.equal(by(seekers[0].pid).role, 'out');
  assert.equal(by(seekers[0].pid).elim, 'oob');
  assert.equal(by(hiders[0].pid).role, 'out'); // out mode
});

test('boundary in zombie mode turns an out-of-bounds hider into a seeker', async () => {
  const { g, hiders } = await started(['H', 'A', 'B', 'C'], { mode: 'zombie', whenCaught: 'seeker', headStartMin: 0, pingIntervalMin: 0 });
  await sync(g, hiders[0], pos(home, 2000, 0));
  const { store } = require('../lib/store');
  const { game } = await store.read(g.code);
  for (const p of Object.values(game.players)) if (p.oobSince) p.oobSince -= 120000;
  await store.write(g.code, game);
  const watcher = g.players.find((p) => p.pid !== hiders[0].pid);
  const v = (await sync(g, watcher, pos(home))).view;
  assert.equal(v.players.find((p) => p.id === hiders[0].pid).role, 'seeker');
});

test('drops give points; abilities cost points and last for their duration', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B'], { headStartMin: 0, pingIntervalMin: 0, drops: { enabled: true, points: 3, pickupRadiusM: 20, intervalMin: 5, maxActive: 3, lifetimeMin: 15 } });
  const h = hiders[0];
  let v = (await sync(g, h, pos(home))).view;
  assert.ok(v.drops.length >= 1, 'a drop spawned');
  const d = v.drops[0];
  assert.equal(v.me.points, 0);
  v = (await sync(g, h, { lat: d.lat, lng: d.lng, acc: 5 })).view;
  assert.equal(v.me.points, 3);

  let r = await act(g, h, 'ability', { name: 'vanish', loc: { lat: d.lat, lng: d.lng, acc: 5 } });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.me.points, 2);
  assert.ok(r.view.me.fx.vanishUntil > Date.now() + 9 * MIN);
  // vanished hider invisible to seeker; Trace reveals them
  await sync(g, seekers[0], pos(home));
  v = (await sync(g, seekers[0], pos(home))).view;
  assert.ok(!v.markers.find((m) => m.id === h.pid), 'vanished');
  r = await act(g, seekers[0], 'ability', { name: 'trace' });
  assert.match(r.error, /need/i); // seeker has no points yet
});

test('trace, fake location, reveal and bounty interact correctly', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B'], { headStartMin: 0, pingIntervalMin: 5, startPoints: 5, drops: { enabled: false } });
  const s = seekers[0], h = hiders[0];
  await place(g, [[s, pos(home)], [h, pos(home, 100, 0)]]);
  const { store } = require('../lib/store');
  let st = await store.read(g.code); st.game.lastPingIdx = -1; await store.write(g.code, st.game);

  // hider fakes location; seeker sees the decoy in the ping view
  let r = await act(g, h, 'ability', { name: 'fake', loc: pos(home, 100, 0) });
  assert.ok(!r.error, r.error);
  st = await store.read(g.code); st.game.lastPingIdx = -1; st.game.hsEnd = Date.now() - 5 * MIN - 1000; st.game.endsAt = st.game.hsEnd + 60 * MIN; await store.write(g.code, st.game);
  let v = (await sync(g, s, pos(home))).view;
  const decoy = v.markers.find((m) => m.id === h.pid);
  assert.ok(decoy && Geo.distance(decoy, pos(home, 100, 0)) > 100, 'seeker sees a decoy, not the real spot');

  // Reveal exposes the real live position and overrides the fake
  r = await act(g, s, 'reveal');
  assert.ok(!r.error, r.error);
  v = r.view;
  const real = v.markers.find((m) => m.id === h.pid);
  assert.equal(real.kind, 'reveal');
  assert.ok(Geo.distance(real, pos(home, 100, 0)) < 1);
  // abilities are blocked while Reveal runs
  r = await act(g, h, 'ability', { name: 'shield' });
  assert.match(r.error, /Reveal/);
  r = await act(g, s, 'reveal');
  assert.match(r.error, /already/i);

  // end reveal, then bounty
  st = await store.read(g.code); st.game.reveal.until = Date.now() - 1; await store.write(g.code, st.game);
  r = await act(g, s, 'bounty', { target: h.pid });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.bounty.target, h.name);
  const hv = (await sync(g, h, pos(home, 100, 0))).view;
  // Clear bounty ability on the target
  r = await act(g, h, 'ability', { name: 'clearBounty', loc: pos(home, 100, 0) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.bounty, null);
});

test('bounty reward and steal / disable-safe / revive / reboot', async () => {
  const { g, seekers, hiders } = await started(['H', 'A', 'B', 'C'], { seekerCount: 1, headStartMin: 0, pingIntervalMin: 0, startPoints: 6, drops: { enabled: false }, bounty: { enabled: true, threshold: 2, durationMin: 15, reward: 1, usesPerPlayer: 1 } });
  const s = seekers[0]; const [h1, h2, h3] = hiders;
  await place(g, [[s, pos(home)], [h1, pos(home, 5, 0)], [h2, pos(home, 300, 0)], [h3, pos(home, 0, 300)]]);

  // steal
  let r = await act(g, h2, 'ability', { name: 'steal', target: h3.pid, loc: pos(home, 300, 0) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.me.points, 6); // -1 cost, +1 stolen

  // bounty then catch for the reward
  r = await act(g, s, 'bounty', { target: h1.pid });
  assert.ok(!r.error, r.error);
  r = await act(g, s, 'tag', { loc: pos(home) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.me.points, 7);
  assert.equal(r.view.bounty, null);

  // revive costs 3 and puts the tagged player back as a hider
  r = await act(g, h1, 'ability', { name: 'revive' });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.me.role, 'hider');
  assert.equal(r.view.me.points, 3);
  // revived player is briefly immune
  r = await act(g, s, 'tag', { loc: pos(home) });
  assert.match(r.error, /protected/);

  // a second catch then a reboot by another hider
  const st = await require('../lib/store').store.read(g.code);
  st.game.players[h1.pid].fx = {}; await require('../lib/store').store.write(g.code, st.game);
  r = await act(g, s, 'tag', { loc: pos(home) });
  assert.ok(!r.error, r.error);
  r = await act(g, h2, 'ability', { name: 'reboot', target: h1.pid, loc: pos(home, 300, 0) });
  assert.ok(!r.error, r.error);
  assert.equal(r.view.players.find((p) => p.id === h1.pid).role, 'hider');
});

test('shrinking and moving zones are computed from progress', () => {
  const z = { shape: 'circle', center: home, radius: 1000 };
  const half = Geo.zoneAt(z, { progress: 0.5, shrinkEnd: 0.5, moveM: 400, bearing: 0 });
  assert.ok(Math.abs(half.radius - 750) < 1e-6);
  assert.ok(Math.abs(Geo.distance(half.center, home) - 200) < 1);
  const poly = { shape: 'polygon', points: [Geo.offset(home, 100, 0), Geo.offset(home, -100, 100), Geo.offset(home, -100, -100)] };
  const shrunk = Geo.zoneAt(poly, { progress: 1, shrinkEnd: 0.5, moveM: 0, bearing: 0 });
  assert.ok(Geo.inZone(home, shrunk));
  assert.ok(!Geo.inZone(Geo.offset(home, 90, 0), shrunk));
});

test('settings are clamped and can be toggled off', () => {
  const s = engine.sanitizeSettings({ headStartMin: 9999, pingIntervalMin: -3, abilities: { vanish: { enabled: false, cost: 99, durationMin: 0 } }, zones: { enabled: false } });
  assert.equal(s.headStartMin, 60);
  assert.equal(s.pingIntervalMin, 0);
  assert.equal(s.abilities.vanish.enabled, false);
  assert.equal(s.abilities.vanish.cost, 20);
  assert.equal(s.abilities.vanish.durationMin, 1);
  assert.equal(s.zones.enabled, false);
});

test('end of time: hiders win; host can rematch', async () => {
  const { g } = await started(['H', 'A'], { headStartMin: 0, pingIntervalMin: 0 });
  const { store } = require('../lib/store');
  const st = await store.read(g.code); st.game.endsAt = Date.now() - 1; await store.write(g.code, st.game);
  let v = (await sync(g, g.host, pos(home))).view;
  assert.equal(v.phase, 'ended');
  assert.equal(v.winner, 'hiders');
  const r = await act(g, g.host, 'rematch');
  assert.equal(r.view.phase, 'lobby');
});

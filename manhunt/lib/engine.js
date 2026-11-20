'use strict';
/*
 * Manhunt game engine. Pure functions over a JSON game object, so it can run on
 * any serverless host. All rules live here; the browser only renders `view()`.
 */
const crypto = require('crypto');
const Geo = require('../public/geo.js');

const MIN = 60 * 1000;
const FRESH_MS = 90 * 1000; // a location older than this is "stale"

const rid = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (error) => ({ error });
const ok = (msg) => ({ ok: true, msg });

// ---------------------------------------------------------------- settings

const ABILITY_DEFAULTS = {
  revive: { enabled: true, cost: 3 },
  reboot: { enabled: true, cost: 3 },
  vanish: { enabled: true, cost: 1, durationMin: 10 },
  fake: { enabled: true, cost: 1, durationMin: 10 },
  trace: { enabled: true, cost: 1, durationMin: 10 },
  shield: { enabled: true, cost: 1, durationMin: 10 },
  clearBounty: { enabled: true, cost: 1 },
  extraSafe: { enabled: true, cost: 1 },
  disableSafe: { enabled: true, cost: 1, durationMin: 10 },
  steal: { enabled: true, cost: 1, amount: 1 },
};

function defaultSettings() {
  return {
    mode: 'tag', // 'tag' = out when tagged, 'zombie'
    durationMin: 60, // length of the hunt after the head start
    headStartMin: 5,
    pingIntervalMin: 5, // 0 = live location
    pingWarnSec: 15,
    seekerCount: 1,
    seekerVisibility: 'ping', // how hiders see seekers: live | ping | hidden
    whenCaught: 'out', // out | seeker
    tagRadiusM: 25,
    reviveImmunitySec: 30,
    startPoints: 0,
    zones: { enabled: true, oobGraceSec: 60, shape: null },
    shrinking: { enabled: false, endPercent: 50 },
    moving: { enabled: false, distanceM: 300 },
    safeZones: { enabled: false, list: [] },
    personalSafe: { enabled: true, radiusM: 15, durationMin: 5, stock: 1 },
    drops: { enabled: true, intervalMin: 5, maxActive: 3, points: 1, pickupRadiusM: 20, lifetimeMin: 15 },
    reveal: { enabled: true, threshold: 2, durationMin: 15, usesPerPlayer: 1 },
    bounty: {
      enabled: true, threshold: 2, durationMin: 15, reward: 1, usesPerPlayer: 1,
      disableSafeZones: false, disableAbilities: false,
    },
    abilities: clone(ABILITY_DEFAULTS),
  };
}

const num = (v, min, max, d) => {
  v = Number(v);
  if (!Number.isFinite(v)) return d;
  return Math.min(max, Math.max(min, v));
};
const int = (v, min, max, d) => Math.round(num(v, min, max, d));
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function cleanShape(sh) {
  if (!sh || typeof sh !== 'object') return null;
  if (sh.shape === 'circle' && Geo.validPoint(sh.center)) {
    return {
      shape: 'circle',
      center: { lat: sh.center.lat, lng: sh.center.lng },
      radius: num(sh.radius, 30, 30000, 300),
    };
  }
  if (sh.shape === 'polygon' && Array.isArray(sh.points)) {
    const pts = sh.points.filter(Geo.validPoint).slice(0, 80).map((p) => ({ lat: p.lat, lng: p.lng }));
    if (pts.length >= 3) return { shape: 'polygon', points: pts };
  }
  return null;
}

function sanitizeSettings(input, base) {
  const inp = obj(input);
  const d = base || defaultSettings();
  const s = {};
  s.mode = pick(inp.mode, ['tag', 'zombie'], d.mode);
  s.durationMin = int(inp.durationMin, 5, 360, d.durationMin);
  s.headStartMin = int(inp.headStartMin, 0, 60, d.headStartMin);
  s.pingIntervalMin = int(inp.pingIntervalMin, 0, 15, d.pingIntervalMin);
  s.pingWarnSec = int(inp.pingWarnSec, 0, 60, d.pingWarnSec);
  s.seekerCount = int(inp.seekerCount, 1, 20, d.seekerCount);
  s.seekerVisibility = pick(inp.seekerVisibility, ['live', 'ping', 'hidden'], d.seekerVisibility);
  s.whenCaught = pick(inp.whenCaught, ['out', 'seeker'], d.whenCaught);
  s.tagRadiusM = int(inp.tagRadiusM, 5, 200, d.tagRadiusM);
  s.reviveImmunitySec = int(inp.reviveImmunitySec, 0, 300, d.reviveImmunitySec);
  s.startPoints = int(inp.startPoints, 0, 20, d.startPoints);

  const z = obj(inp.zones);
  s.zones = {
    enabled: bool(z.enabled, d.zones.enabled),
    oobGraceSec: int(z.oobGraceSec, 5, 600, d.zones.oobGraceSec),
    shape: 'shape' in z ? cleanShape(z.shape) : d.zones.shape,
  };
  const sh = obj(inp.shrinking);
  s.shrinking = {
    enabled: bool(sh.enabled, d.shrinking.enabled),
    endPercent: int(sh.endPercent, 10, 95, d.shrinking.endPercent),
  };
  const mv = obj(inp.moving);
  s.moving = {
    enabled: bool(mv.enabled, d.moving.enabled),
    distanceM: int(mv.distanceM, 20, 5000, d.moving.distanceM),
  };
  const sz = obj(inp.safeZones);
  let list = d.safeZones.list;
  if (Array.isArray(sz.list)) {
    list = sz.list
      .filter(Geo.validPoint)
      .slice(0, 25)
      .map((p) => ({ lat: p.lat, lng: p.lng, r: int(p.r, 5, 1000, 30) }));
  }
  s.safeZones = { enabled: bool(sz.enabled, d.safeZones.enabled), list };
  const ps = obj(inp.personalSafe);
  s.personalSafe = {
    enabled: bool(ps.enabled, d.personalSafe.enabled),
    radiusM: int(ps.radiusM, 5, 150, d.personalSafe.radiusM),
    durationMin: int(ps.durationMin, 1, 120, d.personalSafe.durationMin),
    stock: int(ps.stock, 0, 10, d.personalSafe.stock),
  };
  const dr = obj(inp.drops);
  s.drops = {
    enabled: bool(dr.enabled, d.drops.enabled),
    intervalMin: int(dr.intervalMin, 1, 60, d.drops.intervalMin),
    maxActive: int(dr.maxActive, 1, 20, d.drops.maxActive),
    points: int(dr.points, 1, 10, d.drops.points),
    pickupRadiusM: int(dr.pickupRadiusM, 5, 100, d.drops.pickupRadiusM),
    lifetimeMin: int(dr.lifetimeMin, 1, 120, d.drops.lifetimeMin),
  };
  const rv = obj(inp.reveal);
  s.reveal = {
    enabled: bool(rv.enabled, d.reveal.enabled),
    threshold: int(rv.threshold, 0, 20, d.reveal.threshold),
    durationMin: int(rv.durationMin, 1, 120, d.reveal.durationMin),
    usesPerPlayer: int(rv.usesPerPlayer, 1, 10, d.reveal.usesPerPlayer),
  };
  const bo = obj(inp.bounty);
  s.bounty = {
    enabled: bool(bo.enabled, d.bounty.enabled),
    threshold: int(bo.threshold, 0, 20, d.bounty.threshold),
    durationMin: int(bo.durationMin, 1, 120, d.bounty.durationMin),
    reward: int(bo.reward, 0, 10, d.bounty.reward),
    usesPerPlayer: int(bo.usesPerPlayer, 1, 10, d.bounty.usesPerPlayer),
    disableSafeZones: bool(bo.disableSafeZones, d.bounty.disableSafeZones),
    disableAbilities: bool(bo.disableAbilities, d.bounty.disableAbilities),
  };
  const ab = obj(inp.abilities);
  s.abilities = {};
  for (const key of Object.keys(ABILITY_DEFAULTS)) {
    const dv = d.abilities[key] || ABILITY_DEFAULTS[key];
    const iv = obj(ab[key]);
    const out = { enabled: bool(iv.enabled, dv.enabled), cost: int(iv.cost, 0, 20, dv.cost) };
    if ('durationMin' in ABILITY_DEFAULTS[key]) out.durationMin = int(iv.durationMin, 1, 120, dv.durationMin);
    if ('amount' in ABILITY_DEFAULTS[key]) out.amount = int(iv.amount, 1, 10, dv.amount);
    s.abilities[key] = out;
  }
  return s;
}

// ---------------------------------------------------------------- game setup

function newPlayer(g, name, now) {
  let base = String(name || 'Player').replace(/[<>]/g, '').trim().slice(0, 20) || 'Player';
  let final = base;
  let n = 2;
  const taken = () => Object.values(g.players).some((p) => p.name.toLowerCase() === final.toLowerCase());
  while (taken()) final = `${base} ${n++}`;
  const p = {
    id: rid(10), token: rid(24), name: final, joinedAt: now,
    role: null, caught: false, revivable: false, elim: null,
    points: 0, safeStock: 0, zones: [], fx: {}, revealUses: 0, bountyUses: 0, oobSince: null,
  };
  g.players[p.id] = p;
  return p;
}

function createGame(code, hostName, now) {
  const g = {
    v: 1, code, createdAt: now, hostId: null, phase: 'lobby',
    settings: defaultSettings(), players: {}, events: [],
    drops: [], snaps: {}, reveal: null, bounty: null, lastPingIdx: -1, winner: null,
  };
  const host = newPlayer(g, hostName, now);
  g.hostId = host.id;
  return { game: g, host };
}

function resetToLobby(g) {
  g.phase = 'lobby';
  g.winner = null; g.endReason = null;
  g.startedAt = g.hsEnd = g.endsAt = null;
  g.drops = []; g.snaps = {}; g.reveal = null; g.bounty = null; g.lastPingIdx = -1; g.events = [];
  Object.values(g.players).forEach((p) => {
    Object.assign(p, {
      role: null, caught: false, revivable: false, elim: null, points: 0, safeStock: 0,
      zones: [], fx: {}, revealUses: 0, bountyUses: 0, oobSince: null,
    });
  });
}

function ev(g, msg, kind, now) {
  g.events.push({ t: now, msg, kind: kind || 'info' });
  if (g.events.length > 60) g.events.splice(0, g.events.length - 60);
}

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

function startGame(g, now) {
  if (g.phase !== 'lobby') return fail('The game already started');
  const ids = Object.keys(g.players);
  if (ids.length < 2) return fail('You need at least 2 players');
  const s = g.settings;
  if (s.zones.enabled && !s.zones.shape) return fail('Draw the play area first (or turn zones off)');
  const nSeek = Math.min(s.seekerCount, ids.length - 1);
  shuffle(ids);
  ids.forEach((id, i) => {
    const p = g.players[id];
    p.role = i < nSeek ? 'seeker' : 'hider';
    p.points = s.startPoints;
    p.safeStock = s.personalSafe.enabled ? s.personalSafe.stock : 0;
  });
  g.phase = 'running';
  g.startedAt = now;
  g.hsEnd = now + s.headStartMin * MIN;
  g.endsAt = g.hsEnd + s.durationMin * MIN;
  g.moveBearing = Math.random() * 2 * Math.PI;
  g.lastPingIdx = -1;
  g.snaps = {};
  g.drops = [];
  g.nextDropAt = now;
  g.events = [];
  const names = ids.filter((id) => g.players[id].role === 'seeker').map((id) => g.players[id].name);
  ev(g, `The hunt is on! Seekers: ${names.join(', ')}`, 'start', now);
  return ok('started');
}

function endGame(g, winner, reason, now) {
  g.phase = 'ended';
  g.winner = winner;
  g.endReason = reason;
  g.reveal = null;
  ev(g, reason, 'end', now);
}

// ---------------------------------------------------------------- helpers

const isActive = (p) => p.role === 'hider' || p.role === 'seeker';
const fxOn = (p, key, now) => (p.fx[key + 'Until'] || 0) > now;
const fresh = (loc, now) => loc && now - loc.t <= FRESH_MS;
const revealOn = (g, now) => !!(g.reveal && now < g.reveal.until);
const bountyOn = (g, now) => !!(g.bounty && now < g.bounty.until);

function progress(g, now) {
  if (!g.hsEnd || now <= g.hsEnd) return 0;
  return Math.min(1, (now - g.hsEnd) / Math.max(1, g.endsAt - g.hsEnd));
}

function currentZone(g, now) {
  const s = g.settings;
  if (!s.zones.enabled || !s.zones.shape) return null;
  if (g.phase !== 'running' && g.phase !== 'ended') return s.zones.shape;
  return Geo.zoneAt(s.zones.shape, {
    progress: progress(g, now),
    shrinkEnd: s.shrinking.enabled ? s.shrinking.endPercent / 100 : null,
    moveM: s.moving.enabled ? s.moving.distanceM : 0,
    bearing: g.moveBearing || 0,
  });
}

function abilitiesBlocked(g, p, now) {
  if (revealOn(g, now)) return 'Abilities are disabled while Reveal is active';
  if (bountyOn(g, now) && g.bounty.disableAbilities && g.bounty.targetId === p.id) {
    return 'Abilities are disabled while you carry a bounty';
  }
  return null;
}

function safeBlocked(g, p, now) {
  if (revealOn(g, now)) return true;
  return bountyOn(g, now) && g.bounty.disableSafeZones && g.bounty.targetId === p.id;
}

function inSafeZone(g, p, loc, now) {
  const s = g.settings;
  if (safeBlocked(g, p, now)) return false;
  if (s.safeZones.enabled && s.safeZones.list.some((z) => Geo.distance(loc, z) <= z.r)) return true;
  if (s.personalSafe.enabled && !fxOn(p, 'disableSafe', now)) {
    if (p.zones.some((z) => z.expiresAt > now && Geo.distance(loc, z) <= z.r)) return true;
  }
  return false;
}

// What a player shows to others: null (hidden), a decoy, or the real spot.
function shownLoc(p, loc, now) {
  if (fxOn(p, 'vanish', now)) return null;
  if (fxOn(p, 'fake', now) && p.fx.fakeLoc) return p.fx.fakeLoc;
  return { lat: loc.lat, lng: loc.lng };
}

function takeSnaps(g, locs, now) {
  g.snaps = {};
  for (const p of Object.values(g.players)) {
    const loc = locs[p.id];
    if (!isActive(p) || !loc) continue;
    const shown = shownLoc(p, loc, now);
    g.snaps[p.id] = {
      at: now, lat: loc.lat, lng: loc.lng,
      shown, vanished: fxOn(p, 'vanish', now),
    };
  }
}

// ---------------------------------------------------------------- elimination

function applyCaught(g, p, reason, now) {
  const s = g.settings;
  p.caught = true;
  p.revivable = reason === 'caught';
  p.fx = {};
  p.oobSince = null;
  if (s.whenCaught === 'seeker') {
    p.role = 'seeker';
    p.elim = null;
    ev(g, `${p.name} turned into a seeker!`, 'turn', now);
  } else {
    p.role = 'out';
    p.elim = reason;
  }
}

function outOfBounds(g, p, now) {
  if (p.role === 'hider') {
    ev(g, `${p.name} left the play area`, 'oob', now);
    if (g.bounty && g.bounty.targetId === p.id) g.bounty = null;
    applyCaught(g, p, 'oob', now);
  } else if (p.role === 'seeker') {
    p.role = 'out';
    p.elim = 'oob';
    p.oobSince = null;
    ev(g, `Seeker ${p.name} left the play area and is eliminated`, 'oob', now);
  }
}

// ---------------------------------------------------------------- tick

function spawnPoint(g, locs, now) {
  const z = currentZone(g, now);
  if (z) return Geo.randomIn(z);
  const act = Object.values(g.players).filter((p) => isActive(p) && locs[p.id]);
  if (!act.length) return null;
  const base = locs[act[Math.floor(Math.random() * act.length)].id];
  const r = 250 * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  return Geo.offset(base, r * Math.cos(a), r * Math.sin(a));
}

/** Advance time-based rules. Returns true if the game object changed. */
function tick(g, locs, now) {
  if (g.phase !== 'running') return false;
  const s = g.settings;
  let ch = false;

  if (now >= g.endsAt) {
    endGame(g, 'hiders', 'Time is up. The hiders survived!', now);
    return true;
  }

  // Ping snapshots
  const iv = s.pingIntervalMin * MIN;
  if (iv > 0 && now >= g.hsEnd) {
    const idx = Math.floor((now - g.hsEnd) / iv);
    if (idx > g.lastPingIdx) {
      takeSnaps(g, locs, now);
      g.lastPingIdx = idx;
      ch = true;
    }
  }

  if (g.bounty && now >= g.bounty.until) {
    ev(g, 'The bounty expired', 'bounty', now);
    g.bounty = null;
    ch = true;
  }
  if (g.reveal && now >= g.reveal.until) {
    ev(g, 'Reveal ended. Hiders are hidden again', 'reveal', now);
    g.reveal = null;
    ch = true;
  }

  // Boundary
  if (s.zones.enabled && s.zones.shape) {
    const z = currentZone(g, now);
    for (const p of Object.values(g.players)) {
      if (!isActive(p)) continue;
      const loc = locs[p.id];
      if (!loc || now - loc.t > 3 * MIN) continue;
      if (!Geo.inZone(loc, z)) {
        if (!p.oobSince) { p.oobSince = now; ch = true; }
        else if (now - p.oobSince >= s.zones.oobGraceSec * 1000) { outOfBounds(g, p, now); ch = true; }
      } else if (p.oobSince) {
        p.oobSince = null;
        ch = true;
      }
    }
  }

  // Ability drops
  if (s.drops.enabled) {
    const before = g.drops.length;
    g.drops = g.drops.filter((d) => d.expiresAt > now);
    if (g.drops.length !== before) ch = true;

    for (const p of Object.values(g.players)) {
      if (!isActive(p)) continue;
      const loc = locs[p.id];
      if (!fresh(loc, now)) continue;
      const hit = g.drops.find((d) => Geo.distance(loc, d) <= s.drops.pickupRadiusM);
      if (hit) {
        g.drops = g.drops.filter((d) => d.id !== hit.id);
        p.points += hit.points;
        ev(g, `${p.name} grabbed an ability drop`, 'drop', now);
        ch = true;
      }
    }

    if (now >= (g.nextDropAt || 0)) {
      if (g.drops.length < s.drops.maxActive) {
        const pt = spawnPoint(g, locs, now);
        if (pt) {
          g.drops.push({
            id: rid(6), lat: pt.lat, lng: pt.lng,
            points: s.drops.points, expiresAt: now + s.drops.lifetimeMin * MIN,
          });
          ev(g, 'An ability drop appeared on the map', 'drop', now);
        }
      }
      g.nextDropAt = now + s.drops.intervalMin * MIN;
      ch = true;
    }
  }

  // Win conditions
  const players = Object.values(g.players);
  if (!players.some((p) => p.role === 'hider')) {
    endGame(g, 'seekers', 'Every hider was caught. Seekers win!', now);
    ch = true;
  } else if (!players.some((p) => p.role === 'seeker')) {
    endGame(g, 'hiders', 'No seekers left. Hiders win!', now);
    ch = true;
  }
  return ch;
}

// ---------------------------------------------------------------- actions

function protectionReason(g, h, loc, now) {
  if (fxOn(h, 'immune', now)) return `${h.name} just came back and is protected for a moment`;
  if (!abilitiesBlocked(g, h, now) && fxOn(h, 'shield', now)) return `${h.name} blocked the tag with an Immunity Shield`;
  if (inSafeZone(g, h, loc, now)) return `${h.name} is standing in a safe zone`;
  return null;
}

function claimBounty(g, h, seeker, now) {
  if (bountyOn(g, now) && g.bounty.targetId === h.id) {
    const reward = g.settings.bounty.reward;
    if (seeker && reward > 0) {
      seeker.points += reward;
      ev(g, `${seeker.name} collected the bounty on ${h.name} (+${reward} pt)`, 'bounty', now);
    } else {
      ev(g, `The bounty on ${h.name} was claimed`, 'bounty', now);
    }
    g.bounty = null;
  }
}

function actTag(g, locs, p, now) {
  const s = g.settings;
  if (g.phase !== 'running') return fail('The game is not running');
  if (p.role !== 'seeker') return fail('Only seekers can tag');
  if (now < g.hsEnd) return fail('The head start is still running');
  const me = locs[p.id];
  if (!fresh(me, now)) return fail('Your GPS location is out of date. Wait for a fix and try again.');
  const reach = s.tagRadiusM + 8; // small slack for GPS drift
  const near = [];
  for (const h of Object.values(g.players)) {
    if (h.role !== 'hider') continue;
    const loc = locs[h.id];
    if (!fresh(loc, now)) continue;
    const d = Geo.distance(me, loc);
    if (d <= reach) near.push({ h, loc, d });
  }
  if (!near.length) return fail(`No hider within ${s.tagRadiusM} m of you`);
  near.sort((a, b) => a.d - b.d);
  let firstReason = null;
  for (const c of near) {
    const why = protectionReason(g, c.h, c.loc, now);
    if (why) { firstReason = firstReason || why; continue; }
    applyCaught(g, c.h, 'caught', now);
    ev(g, `${p.name} tagged ${c.h.name}`, 'tag', now);
    claimBounty(g, c.h, p, now);
    return ok(`You tagged ${c.h.name}!`);
  }
  return fail(firstReason);
}

function actSelfCaught(g, locs, p, now) {
  if (g.phase !== 'running') return fail('The game is not running');
  if (p.role !== 'hider') return fail('Only hiders can report being tagged');
  const mine = locs[p.id];
  let nearest = null;
  if (fresh(mine, now)) {
    for (const sk of Object.values(g.players)) {
      if (sk.role !== 'seeker' || !fresh(locs[sk.id], now)) continue;
      const d = Geo.distance(mine, locs[sk.id]);
      if (d <= g.settings.tagRadiusM * 3 && (!nearest || d < nearest.d)) nearest = { sk, d };
    }
  }
  applyCaught(g, p, 'caught', now);
  ev(g, `${p.name} was caught`, 'tag', now);
  claimBounty(g, p, nearest && nearest.sk, now);
  return ok('You were caught');
}

function actPlaceSafe(g, locs, p, now) {
  const s = g.settings;
  if (g.phase !== 'running') return fail('The game is not running');
  if (!s.personalSafe.enabled) return fail('Personal safe zones are turned off');
  if (!isActive(p)) return fail('You are out of the game');
  if (p.safeStock <= 0) return fail('You have no safe zones left to place');
  const loc = locs[p.id];
  if (!fresh(loc, now)) return fail('Waiting for a GPS fix');
  p.zones = p.zones.filter((z) => z.expiresAt > now);
  p.zones.push({ id: rid(6), lat: loc.lat, lng: loc.lng, r: s.personalSafe.radiusM, expiresAt: now + s.personalSafe.durationMin * MIN });
  p.safeStock -= 1;
  return ok(`Safe zone placed for ${s.personalSafe.durationMin} min`);
}

function targetPlayer(g, id) {
  return id && g.players[id] ? g.players[id] : null;
}

function actAbility(g, locs, p, name, params, now) {
  const s = g.settings;
  if (g.phase !== 'running') return fail('The game is not running');
  const a = s.abilities[name];
  if (!a || !a.enabled) return fail('That ability is turned off');
  if (name !== 'revive' && !isActive(p)) return fail('You are out of the game');
  const blocked = abilitiesBlocked(g, p, now);
  if (blocked) return fail(blocked);
  if (p.points < a.cost) return fail(`You need ${a.cost} ability point${a.cost === 1 ? '' : 's'}`);
  const dur = (a.durationMin || 0) * MIN;
  const target = targetPlayer(g, params && params.target);
  let msg;

  switch (name) {
    case 'vanish':
    case 'trace':
    case 'shield': {
      if (fxOn(p, name, now)) return fail('That is already active');
      p.fx[name + 'Until'] = now + dur;
      msg = `${name === 'vanish' ? 'Vanish' : name === 'trace' ? 'Trace' : 'Immunity Shield'} active for ${a.durationMin} min`;
      break;
    }
    case 'fake': {
      const me = locs[p.id];
      if (!fresh(me, now)) return fail('Waiting for a GPS fix');
      if (fxOn(p, 'fake', now)) return fail('A decoy is already active');
      const zone = currentZone(g, now);
      let pt = null;
      for (let i = 0; i < 40 && !pt; i++) {
        const dist = 150 + Math.random() * 250;
        const ang = Math.random() * 2 * Math.PI;
        const cand = Geo.offset(me, dist * Math.cos(ang), dist * Math.sin(ang));
        if (!zone || Geo.inZone(cand, zone)) pt = cand;
      }
      if (!pt) pt = Geo.offset(me, 200, 0);
      p.fx.fakeLoc = pt;
      p.fx.fakeUntil = now + dur;
      msg = `Decoy pin placed for ${a.durationMin} min`;
      break;
    }
    case 'clearBounty': {
      if (!bountyOn(g, now) || g.bounty.targetId !== p.id) return fail('There is no bounty on you');
      g.bounty = null;
      ev(g, `${p.name} cleared the bounty on themselves`, 'bounty', now);
      msg = 'Bounty cleared';
      break;
    }
    case 'extraSafe': {
      if (!s.personalSafe.enabled) return fail('Personal safe zones are turned off');
      const loc = locs[p.id];
      if (!fresh(loc, now)) return fail('Waiting for a GPS fix');
      p.zones = p.zones.filter((z) => z.expiresAt > now);
      p.zones.push({ id: rid(6), lat: loc.lat, lng: loc.lng, r: s.personalSafe.radiusM, expiresAt: now + s.personalSafe.durationMin * MIN });
      msg = `Extra safe zone placed for ${s.personalSafe.durationMin} min`;
      break;
    }
    case 'disableSafe': {
      if (!target || target.id === p.id || !isActive(target)) return fail('Pick another active player');
      target.fx.disableSafeUntil = now + dur;
      msg = `${target.name}'s personal safe zones are disabled for ${a.durationMin} min`;
      break;
    }
    case 'steal': {
      if (!target || target.id === p.id || !isActive(target)) return fail('Pick another active player');
      const take = Math.min(a.amount, target.points);
      if (take <= 0) return fail(`${target.name} has no ability points to steal`);
      target.points -= take;
      p.points += take;
      msg = `Stole ${take} point${take === 1 ? '' : 's'} from ${target.name}`;
      break;
    }
    case 'revive': {
      if (!p.caught || !p.revivable || p.role === 'hider') return fail('Only players who were tagged can revive');
      p.role = 'hider';
      p.elim = null;
      p.caught = false;
      p.revivable = false;
      p.fx = { immuneUntil: now + s.reviveImmunitySec * 1000 };
      ev(g, `${p.name} revived and is back in the game!`, 'revive', now);
      msg = 'You are back in the game';
      break;
    }
    case 'reboot': {
      if (p.role !== 'hider') return fail('Only active hiders can use a Reboot Card');
      if (!target || !target.caught || !target.revivable || target.role === 'hider') return fail('Pick a tagged player to bring back');
      target.role = 'hider';
      target.elim = null;
      target.caught = false;
      target.revivable = false;
      target.fx = { immuneUntil: now + s.reviveImmunitySec * 1000 };
      ev(g, `${p.name} rebooted ${target.name} back into the game!`, 'revive', now);
      msg = `${target.name} is back in the game`;
      break;
    }
    default:
      return fail('Unknown ability');
  }
  p.points -= a.cost;
  return ok(msg);
}

function actReveal(g, p, now) {
  const r = g.settings.reveal;
  if (g.phase !== 'running') return fail('The game is not running');
  if (!r.enabled) return fail('Reveal is turned off');
  if (p.role !== 'seeker') return fail('Only seekers can start a Reveal');
  if (now < g.hsEnd) return fail('Wait until the head start is over');
  if (p.points < r.threshold) return fail(`Reveal unlocks at ${r.threshold} ability points`);
  if (p.revealUses >= r.usesPerPlayer) return fail('You already used your Reveal');
  if (revealOn(g, now)) return fail('A Reveal is already running');
  p.revealUses += 1;
  g.reveal = { until: now + r.durationMin * MIN, by: p.id };
  ev(g, `REVEAL! ${p.name} exposed every hider for ${r.durationMin} min`, 'reveal', now);
  return ok('Reveal started');
}

function actBounty(g, p, params, now) {
  const b = g.settings.bounty;
  if (g.phase !== 'running') return fail('The game is not running');
  if (!b.enabled) return fail('Bounty is turned off');
  if (p.role !== 'seeker') return fail('Only seekers can post a bounty');
  if (now < g.hsEnd) return fail('Wait until the head start is over');
  if (p.points < b.threshold) return fail(`Bounty unlocks at ${b.threshold} ability points`);
  if (p.bountyUses >= b.usesPerPlayer) return fail('You already posted your bounty');
  if (bountyOn(g, now)) return fail('A bounty is already active');
  const t = targetPlayer(g, params && params.target);
  if (!t || t.role !== 'hider') return fail('Pick an active hider');
  p.bountyUses += 1;
  g.bounty = {
    targetId: t.id, by: p.id, until: now + b.durationMin * MIN,
    disableSafeZones: b.disableSafeZones, disableAbilities: b.disableAbilities,
  };
  ev(g, `BOUNTY on ${t.name}! Seekers can see them for ${b.durationMin} min`, 'bounty', now);
  return ok(`Bounty posted on ${t.name}`);
}

// ---------------------------------------------------------------- views

function nextPingAt(g, now) {
  const iv = g.settings.pingIntervalMin * MIN;
  if (g.phase !== 'running' || iv <= 0) return null;
  const t = now < g.hsEnd ? g.hsEnd : g.hsEnd + (Math.floor((now - g.hsEnd) / iv) + 1) * iv;
  return t < g.endsAt ? t : null;
}

function markerFor(g, locs, v, t, now) {
  const s = g.settings;
  const loc = locs[t.id];
  const viewerHider = v.role === 'hider';
  const trace = fxOn(v, 'trace', now) && !abilitiesBlocked(g, v, now);
  let mode;

  if (t.role === 'hider') {
    if (viewerHider) mode = 'live';
    else if (revealOn(g, now)) mode = 'reveal';
    else if (bountyOn(g, now) && g.bounty.targetId === t.id) mode = 'bounty';
    else if (now < g.hsEnd) return null;
    else mode = s.pingIntervalMin === 0 ? 'live' : 'ping';
  } else {
    if (!viewerHider) mode = 'live';
    else if (s.seekerVisibility === 'hidden') return null;
    else if (now < g.hsEnd || s.seekerVisibility === 'live' || s.pingIntervalMin === 0) mode = 'live';
    else mode = 'ping';
  }

  if (mode === 'reveal' || mode === 'bounty') {
    if (!loc) return null;
    return { id: t.id, name: t.name, role: t.role, lat: loc.lat, lng: loc.lng, t: loc.t, kind: mode };
  }
  if (mode === 'live') {
    if (!loc) return null;
    if (fxOn(t, 'vanish', now)) {
      if (!trace) return null;
      return { id: t.id, name: t.name, role: t.role, lat: loc.lat, lng: loc.lng, t: loc.t, kind: 'trace' };
    }
    const sh = shownLoc(t, loc, now);
    return { id: t.id, name: t.name, role: t.role, lat: sh.lat, lng: sh.lng, t: loc.t, kind: 'live' };
  }
  const snap = g.snaps[t.id];
  if (!snap) return null;
  if (snap.vanished) {
    if (!trace) return null;
    return { id: t.id, name: t.name, role: t.role, lat: snap.lat, lng: snap.lng, t: snap.at, kind: 'trace' };
  }
  const sh = snap.shown;
  if (!sh) return null;
  return { id: t.id, name: t.name, role: t.role, lat: sh.lat, lng: sh.lng, t: snap.at, kind: 'ping' };
}

function view(g, locs, pid, now) {
  const s = g.settings;
  const me = g.players[pid];
  const running = g.phase === 'running';
  const out = {
    now, code: g.code, phase: g.phase, hostId: g.hostId, settings: s,
    winner: g.winner || null, endReason: g.endReason || null,
    timers: {
      startedAt: g.startedAt || null, hsEnd: g.hsEnd || null, endsAt: g.endsAt || null,
      nextPingAt: nextPingAt(g, now), pingIdx: g.lastPingIdx,
    },
    me: {
      id: me.id, name: me.name, role: me.role, caught: me.caught, revivable: me.revivable, elim: me.elim,
      points: me.points, safeStock: me.safeStock, oobSince: me.oobSince,
      revealUses: me.revealUses, bountyUses: me.bountyUses,
      fx: {
        vanishUntil: me.fx.vanishUntil || 0, fakeUntil: me.fx.fakeUntil || 0,
        traceUntil: me.fx.traceUntil || 0, shieldUntil: me.fx.shieldUntil || 0,
        immuneUntil: me.fx.immuneUntil || 0, disableSafeUntil: me.fx.disableSafeUntil || 0,
        fakeLoc: me.fx.fakeUntil > now ? me.fx.fakeLoc : null,
      },
      zones: me.zones.filter((z) => z.expiresAt > now),
      isHost: me.id === g.hostId,
    },
    players: Object.values(g.players).map((p) => ({
      id: p.id, name: p.name, role: p.role, caught: p.caught, elim: p.elim, isHost: p.id === g.hostId,
      online: !!(locs[p.id] && now - locs[p.id].t < 2 * MIN),
    })),
    events: g.events.slice(-40),
    zone: currentZone(g, now),
    safeZones: s.safeZones.enabled ? s.safeZones.list : [],
    safeOff: revealOn(g, now),
    drops: g.drops || [],
    reveal: revealOn(g, now) ? { until: g.reveal.until, by: (g.players[g.reveal.by] || {}).name } : null,
    bounty: bountyOn(g, now)
      ? {
          targetId: g.bounty.targetId, target: (g.players[g.bounty.targetId] || {}).name,
          by: (g.players[g.bounty.by] || {}).name, until: g.bounty.until,
          disableSafeZones: g.bounty.disableSafeZones, disableAbilities: g.bounty.disableAbilities,
        }
      : null,
    markers: [],
  };
  if (running || g.phase === 'ended') {
    for (const t of Object.values(g.players)) {
      if (t.id === pid || !isActive(t)) continue;
      const m = markerFor(g, locs, me, t, now);
      if (m) out.markers.push(m);
    }
  }
  return out;
}

module.exports = {
  MIN, FRESH_MS, rid, clone, defaultSettings, sanitizeSettings, createGame, newPlayer, resetToLobby,
  startGame, endGame, tick, view, currentZone,
  actTag, actSelfCaught, actPlaceSafe, actAbility, actReveal, actBounty, ev,
};

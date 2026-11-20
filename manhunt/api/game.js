'use strict';
const engine = require('../lib/engine');
const { store, mutate } = require('../lib/store');
const Geo = require('../public/geo.js');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => {
  let c = '';
  for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
};

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function cleanLoc(loc, now) {
  if (!loc || !Geo.validPoint(loc)) return null;
  return { lat: loc.lat, lng: loc.lng, acc: Math.min(Math.max(Number(loc.acc) || 0, 0), 9999), t: now };
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function auth(game, pid, token) {
  const p = game && game.players[pid];
  if (!p || p.token !== token) throw new HttpError(401, 'You are not part of this game');
  return p;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, body) => res.status(status).json(body);

  try {
    if (req.method === 'GET') {
      return send(200, { ok: true, storage: store.kind, note: store.kind === 'memory' ? 'No database connected: games will not survive between requests on Vercel. Add Upstash Redis.' : undefined });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');

    const b = parseBody(req);
    const now = Date.now();
    const action = String(b.action || '');
    const code = cleanCode(b.code);
    const loc = cleanLoc(b.loc, now);

    // ---------- create / join
    if (action === 'create') {
      for (let i = 0; i < 12; i++) {
        const c = newCode();
        const { game, host } = engine.createGame(c, b.name, now);
        if (await store.create(c, game)) {
          return send(200, { code: c, pid: host.id, token: host.token, view: engine.view(game, {}, host.id, now) });
        }
      }
      throw new HttpError(503, 'Could not create a game, try again');
    }

    if (action === 'join') {
      if (!code) throw new HttpError(400, 'Enter a game code');
      let joined;
      const r = await mutate(code, (g) => {
        if (g.phase !== 'lobby') return { error: 'That game already started' };
        if (Object.keys(g.players).length >= 30) return { error: 'That game is full' };
        joined = engine.newPlayer(g, b.name, now);
        return { ok: true };
      }).catch((e) => {
        if (e.message === 'Game not found') throw new HttpError(404, 'No game with that code');
        throw e;
      });
      if (r.result.error) throw new HttpError(409, r.result.error);
      return send(200, { code, pid: joined.id, token: joined.token, view: engine.view(r.game, r.locs, joined.id, now) });
    }

    // ---------- everything else needs a session
    const pid = String(b.pid || '');
    const token = String(b.token || '');
    if (!code || !pid) throw new HttpError(400, 'Missing game or player');

    if (action === 'sync') {
      let { game, locs } = await store.read(code, pid, loc);
      if (!game) throw new HttpError(404, 'This game no longer exists');
      auth(game, pid, token);
      if (engine.tick(engine.clone(game), locs, now)) {
        const r = await mutate(code, (g, l) => {
          if (loc) l[pid] = loc;
          engine.tick(g, l, now);
          return { ok: true };
        });
        game = r.game;
        locs = r.locs;
      }
      return send(200, { view: engine.view(game, locs, pid, now) });
    }

    const run = async (fn) => {
      let message;
      const r = await mutate(code, (g, l) => {
        const p = auth(g, pid, token);
        if (loc) l[pid] = loc; // use the freshest position for distance checks
        const out = fn(g, l, p);
        if (out && out.error) return out;
        message = out && out.msg;
        engine.tick(g, l, now); // settle wins/ends caused by this action
        return out || { ok: true };
      }).catch((e) => {
        if (e.message === 'Game not found') throw new HttpError(404, 'This game no longer exists');
        throw e;
      });
      if (r.result && r.result.error) throw new HttpError(400, r.result.error);
      const view = r.game.players[pid] ? engine.view(r.game, r.locs, pid, now) : null;
      return send(200, { ok: true, msg: message, view });
    };

    const hostOnly = (g, p) => (p.id !== g.hostId ? { error: 'Only the host can do that' } : null);

    switch (action) {
      case 'settings':
        return await run((g, l, p) => {
          const e = hostOnly(g, p);
          if (e) return e;
          if (g.phase !== 'lobby') return { error: 'Rules are locked once the game starts' };
          g.settings = engine.sanitizeSettings(b.settings, g.settings);
          return { ok: true };
        });
      case 'start':
        return await run((g, l, p) => hostOnly(g, p) || engine.startGame(g, now));
      case 'end':
        return await run((g, l, p) => {
          const e = hostOnly(g, p);
          if (e) return e;
          if (g.phase !== 'running') return { error: 'The game is not running' };
          engine.endGame(g, null, 'The host ended the game', now);
          return { ok: true };
        });
      case 'rematch':
        return await run((g, l, p) => {
          const e = hostOnly(g, p);
          if (e) return e;
          engine.resetToLobby(g);
          return { ok: true };
        });
      case 'leave':
        return await run((g, l, p) => {
          if (g.phase !== 'lobby') return { error: 'You can only leave from the lobby' };
          delete g.players[p.id];
          const rest = Object.keys(g.players);
          if (g.hostId === p.id && rest.length) g.hostId = rest[0];
          return { ok: true };
        });
      case 'tag':
        return await run((g, l, p) => engine.actTag(g, l, p, now));
      case 'caught':
        return await run((g, l, p) => engine.actSelfCaught(g, l, p, now));
      case 'safe':
        return await run((g, l, p) => engine.actPlaceSafe(g, l, p, now));
      case 'ability':
        return await run((g, l, p) => engine.actAbility(g, l, p, String(b.name || ''), { target: b.target }, now));
      case 'reveal':
        return await run((g, l, p) => engine.actReveal(g, p, now));
      case 'bounty':
        return await run((g, l, p) => engine.actBounty(g, p, { target: b.target }, now));
      default:
        throw new HttpError(400, 'Unknown action');
    }
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return res.status(status).json({ error: status === 500 ? e.message || 'Server error' : e.message });
  }
};

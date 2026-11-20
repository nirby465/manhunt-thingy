'use strict';
/*
 * Storage for game state.
 *  - Production: Upstash Redis over its REST API (no npm packages needed).
 *    Add the "Upstash Redis" integration to your Vercel project and the env vars appear automatically.
 *  - Fallback: in-memory (fine for `vercel dev` / a single warm instance, NOT reliable on serverless).
 */
const crypto = require('crypto');

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const TTL = 60 * 60 * 24 * 2; // games disappear 2 days after the last write

const gKey = (c) => `mh:g:${c}`;
const lKey = (c) => `mh:l:${c}`;
const kKey = (c) => `mh:k:${c}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Upstash REST
async function pipeline(cmds) {
  const r = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Storage error ${r.status}`);
  const arr = await r.json();
  return arr.map((x) => {
    if (x && x.error) throw new Error(`Storage: ${x.error}`);
    return x.result;
  });
}

function parseHash(flat) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* skip bad row */ }
  }
  return out;
}

const redis = {
  kind: 'upstash',
  async create(code, game) {
    const [res] = await pipeline([['SET', gKey(code), JSON.stringify(game), 'NX', 'EX', TTL]]);
    return res === 'OK';
  },
  // Optionally store a location, then read the game and every location in one round trip.
  async read(code, pid, loc) {
    const cmds = [];
    if (loc) {
      cmds.push(['HSET', lKey(code), pid, JSON.stringify(loc)]);
      cmds.push(['EXPIRE', lKey(code), TTL]);
    }
    cmds.push(['GET', gKey(code)]);
    cmds.push(['HGETALL', lKey(code)]);
    const res = await pipeline(cmds);
    const raw = res[res.length - 2];
    return { game: raw ? JSON.parse(raw) : null, locs: parseHash(res[res.length - 1]) };
  },
  async write(code, game) {
    await pipeline([['SET', gKey(code), JSON.stringify(game), 'EX', TTL]]);
  },
  async clearLocs(code) {
    await pipeline([['DEL', lKey(code)]]);
  },
  async lock(code) {
    const token = crypto.randomBytes(8).toString('hex');
    for (let i = 0; i < 25; i++) {
      const [res] = await pipeline([['SET', kKey(code), token, 'NX', 'PX', 4000]]);
      if (res === 'OK') return token;
      await sleep(80 + Math.random() * 80);
    }
    return null;
  },
  async unlock(code) {
    await pipeline([['DEL', kKey(code)]]);
  },
};

// ---- Memory fallback
const mem = { games: new Map(), locs: new Map(), locks: new Set() };
const memory = {
  kind: 'memory',
  async create(code, game) {
    if (mem.games.has(code)) return false;
    mem.games.set(code, JSON.stringify(game));
    mem.locs.set(code, {});
    return true;
  },
  async read(code, pid, loc) {
    if (loc) {
      const l = mem.locs.get(code) || {};
      l[pid] = loc;
      mem.locs.set(code, l);
    }
    const raw = mem.games.get(code);
    return { game: raw ? JSON.parse(raw) : null, locs: JSON.parse(JSON.stringify(mem.locs.get(code) || {})) };
  },
  async write(code, game) { mem.games.set(code, JSON.stringify(game)); },
  async clearLocs(code) { mem.locs.set(code, {}); },
  async lock(code) {
    for (let i = 0; i < 25; i++) {
      if (!mem.locks.has(code)) { mem.locks.add(code); return 'mem'; }
      await sleep(20);
    }
    return null;
  },
  async unlock(code) { mem.locks.delete(code); },
};

const store = URL_ && TOKEN ? redis : memory;

/** Run fn(game, locs) while holding the game lock. fn returns an error object to abort, or anything else to save. */
async function mutate(code, fn) {
  const token = await store.lock(code);
  if (!token) throw new Error('Game is busy, try again');
  try {
    const { game, locs } = await store.read(code);
    if (!game) throw new Error('Game not found');
    const result = await fn(game, locs);
    if (!(result && result.error)) await store.write(code, game);
    return { game, locs, result };
  } finally {
    await store.unlock(code);
  }
}

module.exports = { store, mutate };

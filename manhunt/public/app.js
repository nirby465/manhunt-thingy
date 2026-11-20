(() => {
'use strict';
const Geo = window.Geo;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const MIN = 60000;

const S = {
  name: '', code: null, pid: null, token: null, view: null, skew: 0, screen: 'home',
  settings: null, lobbyAsHost: null, tab: 'status', snap: 'half', follow: true,
  lastEventT: null, lastPingIdx: null, warnedFor: 0, saveTimer: null, saving: null,
  map: null, layers: null, fitted: false, tabHtml: {}, syncing: false, syncTimer: null,
};
const GPS = { pos: null, watch: null, perm: 'unknown', err: null };
window.__mh = { S, GPS };

// ------------------------------------------------------------------ utils
const now = () => Date.now() + S.skew;
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const fMin = (n) => (n >= 60 ? (n % 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n / 60} h`) : `${n} min`);
const fSec = (n) => (n >= 60 ? `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ''}` : `${n} s`);
const fM = (n) => `${n} m`;
const fN = (n) => String(n);
const fPing = (n) => (n === 0 ? 'Live' : `${n} min`);
const fPct = (n) => `${n}%`;
const fPts = (n) => `${n} pt${n === 1 ? '' : 's'}`;
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function toast(msg, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
let audio;
function beep(freq = 880, dur = 0.16) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.07;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch (e) { /* audio is optional */ }
}
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* optional */ } };

async function api(action, body = {}) {
  let r, j;
  try {
    r = await fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
    j = await r.json();
  } catch (e) {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  if (!r.ok || j.error) { const err = new Error(j.error || 'Request failed'); err.status = r.status; throw err; }
  return j;
}
const authBody = () => ({ code: S.code, pid: S.pid, token: S.token });

function show(id) {
  S.screen = id;
  ['home', 'lobby', 'game', 'end'].forEach((s) => { $('#' + s).hidden = s !== id; });
}

function saveSession() { localStorage.setItem('manhunt.session', JSON.stringify({ code: S.code, pid: S.pid, token: S.token })); }
function clearSession() {
  localStorage.removeItem('manhunt.session');
  stopSync();
  Object.assign(S, { code: null, pid: null, token: null, view: null, settings: null, lobbyAsHost: null, lastEventT: null, lastPingIdx: null, fitted: false, tabHtml: {}, snap: 'half', tab: 'status' });
  if (S.map) { S.map.remove(); S.map = null; }
  const body = $('#lobbyBody'); if (body) body.innerHTML = '';
}

// ------------------------------------------------------------------ GPS / permission
function updatePerm() {
  const dot = $('#permDot'), title = $('#permTitle'), text = $('#permText'), btn = $('#permBtn');
  const set = (cls, t, msg, b) => { dot.className = 'dot ' + cls; title.textContent = t; text.innerHTML = msg; btn.hidden = !b; btn.textContent = b || ''; };
  if (GPS.perm === 'unsupported') return set('bad', 'No GPS on this device', 'This browser cannot read your location. Try Chrome or Safari on your phone.', '');
  if (GPS.perm === 'denied') return set('bad', 'Location is blocked', 'Open your browser&rsquo;s site settings for this page, set Location to <b>Allow</b>, then reload.', 'Try again');
  if (GPS.perm === 'granted') {
    const acc = GPS.pos ? ` (accuracy &plusmn;${Math.round(GPS.pos.acc)} m)` : '';
    return set('ok', 'Location is on' , `Keep Manhunt open with the screen on while you play${acc}. Browsers pause GPS when a page is in the background, so install the app and avoid locking your phone.`, '');
  }
  set('warn', 'Location access', 'Manhunt needs your GPS. When asked, choose <b>Allow</b> (or &ldquo;Allow all the time&rdquo; if your phone offers it).', 'Turn on location');
}
function startGPS() {
  if (!('geolocation' in navigator)) { GPS.perm = 'unsupported'; updatePerm(); return; }
  if (GPS.watch != null) return;
  GPS.watch = navigator.geolocation.watchPosition(
    (p) => {
      GPS.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      GPS.perm = 'granted'; GPS.err = null;
      onGps();
    },
    (e) => {
      GPS.err = e;
      if (e.code === 1) { GPS.perm = 'denied'; navigator.geolocation.clearWatch(GPS.watch); GPS.watch = null; }
      updatePerm(); renderHud();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
  );
}
async function checkPerm() {
  try {
    if (navigator.permissions) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      GPS.perm = st.state;
      st.onchange = () => { GPS.perm = st.state; updatePerm(); if (st.state === 'granted') startGPS(); };
    }
  } catch (e) { /* not supported */ }
  updatePerm();
  if (GPS.perm === 'granted') startGPS();
}
let wake = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch (e) { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.code) { keepAwake(); syncOnce(); }
});

// ------------------------------------------------------------------ sync loop
function startSync() { stopSync(); syncOnce(); S.syncTimer = setInterval(syncOnce, 3500); }
function stopSync() { if (S.syncTimer) clearInterval(S.syncTimer); S.syncTimer = null; }
async function syncOnce() {
  if (S.syncing || !S.code) return;
  S.syncing = true;
  try {
    const j = await api('sync', { ...authBody(), loc: GPS.pos });
    applyView(j.view);
  } catch (e) {
    if (e.status === 404 || e.status === 401) {
      toast(e.message, 'bad');
      clearSession(); show('home');
    }
  } finally { S.syncing = false; }
}
function onGps() {
  updatePerm();
  if (S.screen === 'game' && S.map) { drawMe(); if (S.follow && GPS.pos && !S.fitted) { S.map.setView([GPS.pos.lat, GPS.pos.lng], 17); S.fitted = true; } else if (S.follow && GPS.pos) S.map.panTo([GPS.pos.lat, GPS.pos.lng], { animate: true, duration: 0.5 }); }
  renderHud();
}

function applyView(v) {
  const prev = S.view;
  S.view = v;
  S.skew = v.now - Date.now();
  handleEvents(prev, v);
  if (v.phase === 'lobby') { if (S.screen !== 'lobby') enterLobby(); renderLobby(); }
  else if (v.phase === 'running') { if (S.screen !== 'game') enterGame(); renderGame(); }
  else if (v.phase === 'ended') { if (S.screen !== 'end') enterEnd(); renderEnd(); }
}

function handleEvents(prev, v) {
  const evs = v.events || [];
  const latest = evs.length ? evs[evs.length - 1].t : 0;
  if (S.lastEventT == null) { S.lastEventT = latest; return; }
  const fresh = evs.filter((e) => e.t > S.lastEventT).slice(-3);
  S.lastEventT = Math.max(S.lastEventT, latest);
  fresh.forEach((e) => {
    const kind = e.kind === 'tag' || e.kind === 'oob' ? 'bad' : e.kind === 'revive' || e.kind === 'drop' ? 'good' : 'warn';
    if (e.kind === 'drop' && /appeared/.test(e.msg)) { toast(e.msg, 'good'); return; }
    toast(e.msg, kind, 5000);
    if (['reveal', 'bounty', 'tag', 'turn'].includes(e.kind)) { buzz([150, 80, 150]); beep(e.kind === 'reveal' ? 520 : 760); }
  });
}

// ------------------------------------------------------------------ home
function initHome() {
  S.name = localStorage.getItem('manhunt.name') || '';
  $('#nameInput').value = S.name;
  const params = new URLSearchParams(location.search);
  if (params.get('code')) { $('#joinRow').hidden = false; $('#codeInput').value = params.get('code').toUpperCase().slice(0, 8); }
  $('#joinToggle').onclick = () => { $('#joinRow').hidden = !$('#joinRow').hidden; if (!$('#joinRow').hidden) $('#codeInput').focus(); };
  $('#hostBtn').onclick = () => enter('create');
  $('#joinBtn').onclick = () => enter('join');
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter('join'); });
  $('#permBtn').onclick = () => { GPS.perm = 'prompt'; startGPS(); };
  $('#installBtn').onclick = async () => {
    if (!S.installEv) return;
    S.installEv.prompt();
    await S.installEv.userChoice.catch(() => {});
    S.installEv = null; $('#installCard').hidden = true;
  };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEv = e; $('#installCard').hidden = false; });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#iosHint').hidden = !(ios && !standalone);
  checkPerm();
}

async function enter(kind) {
  const name = $('#nameInput').value.trim();
  const err = $('#homeError');
  err.textContent = '';
  if (!name) { err.textContent = 'Enter your name first.'; $('#nameInput').focus(); return; }
  localStorage.setItem('manhunt.name', name);
  S.name = name;
  startGPS(); // triggers the permission prompt on the tap that started the game
  try {
    let j;
    if (kind === 'create') j = await api('create', { name });
    else {
      const code = $('#codeInput').value.trim().toUpperCase();
      if (!code) { err.textContent = 'Enter the game code.'; $('#codeInput').focus(); return; }
      j = await api('join', { code, name });
    }
    Object.assign(S, { code: j.code || j.view.code, pid: j.pid, token: j.token, lastEventT: null });
    saveSession();
    history.replaceState(null, '', location.pathname);
    applyView(j.view);
    startSync();
    keepAwake();
  } catch (e) { err.textContent = e.message; }
}

async function tryResume() {
  let ses; try { ses = JSON.parse(localStorage.getItem('manhunt.session') || 'null'); } catch (e) { ses = null; }
  if (!ses || !ses.code) return;
  Object.assign(S, ses);
  try {
    const j = await api('sync', { ...authBody(), loc: GPS.pos });
    applyView(j.view); startSync(); keepAwake();
  } catch (e) {
    if (e.status === 404 || e.status === 401) clearSession();
    else { $('#resumeBtn').hidden = false; $('#resumeBtn').onclick = tryResume; }
  }
}

// ------------------------------------------------------------------ share
async function shareCode() {
  const url = `${location.origin}/?code=${S.code}`;
  const text = `Join my Manhunt game! Code: ${S.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Manhunt', text, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied', 'good'); }
  catch (e) { toast(`Code: ${S.code}`); }
}

// ------------------------------------------------------------------ lobby: host settings UI
const ABILITY_ORDER = ['revive', 'reboot', 'vanish', 'fake', 'trace', 'shield', 'clearBounty', 'extraSafe', 'disableSafe', 'steal'];
const AB = {
  revive: { name: 'Revive', ic: '❤️', desc: () => 'After being tagged, spend points to rejoin the game as an active hider.' },
  reboot: { name: 'Reboot Card', ic: '🔄', target: 'caught', desc: () => 'Bring another tagged hider back into the game.' },
  vanish: { name: 'Vanish', ic: '👻', desc: (a) => `Hide your location from the group for ${a.durationMin} min.` },
  fake: { name: 'Fake Location', ic: '🎭', desc: (a) => `Show a decoy pin instead of your real location for ${a.durationMin} min.` },
  trace: { name: 'Trace', ic: '🔎', desc: (a) => `See players who are using Vanish for ${a.durationMin} min.` },
  shield: { name: 'Immunity Shield', ic: '🛡️', desc: (a) => `Block incoming tags for ${a.durationMin} min.` },
  clearBounty: { name: 'Clear Bounty', ic: '🧹', desc: () => 'Instantly remove an active bounty on yourself.' },
  extraSafe: { name: 'Extra Safe Zone', ic: '⛺', desc: () => 'Place an additional personal safe zone where you are standing.' },
  disableSafe: { name: 'Disable Safe Zone', ic: '🚫', target: 'active', desc: (a) => `Turn off another player's personal safe zones for ${a.durationMin} min.` },
  steal: { name: 'Steal Credits', ic: '💰', target: 'active', desc: (a) => `Take ${a.amount} ability point${a.amount === 1 ? '' : 's'} from another active player.` },
};

const T = (p, label, desc, extra) => ({ t: 'toggle', p, label, desc, ...extra });
const Rg = (p, label, min, max, step, fmt, extra) => ({ t: 'range', p, label, min, max, step, fmt, ...extra });
const SCHEMA = [
  { id: 'game', title: 'Game', open: true, fields: [
    { t: 'seg', p: 'mode', label: 'Mode', opts: [['tag', 'Out when tagged'], ['zombie', 'Zombie']], desc: 'Out when tagged: caught hiders are eliminated. Zombie: caught hiders turn into seekers.' },
    Rg('durationMin', 'Hunt length (after head start)', 10, 240, 5, fMin),
    Rg('headStartMin', 'Head start', 0, 30, 1, fMin, { desc: 'Seekers wait before they can hunt. Hiders get the map to themselves.' }),
    Rg('seekerCount', 'Seekers', 1, 8, 1, fN, { desc: 'Chosen at random when you start.' }),
    { t: 'select', p: 'whenCaught', label: 'When a hider is caught', opts: [['out', 'Out of the game'], ['seeker', 'Becomes a seeker']] },
    Rg('tagRadiusM', 'Tag distance', 10, 100, 5, fM, { desc: 'How close a seeker must be to tag.' }),
  ] },
  { id: 'pings', title: 'Pings', fields: [
    Rg('pingIntervalMin', 'Time between pings', 0, 15, 1, fPing, { desc: 'Live shows hiders in real time. Otherwise seekers only see a snapshot every few minutes.' }),
    Rg('pingWarnSec', 'Warning before a ping', 0, 60, 5, fSec),
    { t: 'select', p: 'seekerVisibility', label: 'Hiders can see seekers', opts: [['ping', 'On each ping'], ['live', 'Live'], ['hidden', 'Never']] },
  ] },
  { id: 'zones', title: 'Play area', fields: [
    T('zones.enabled', 'Enable zones', 'Players must stay inside the boundary you draw.'),
    { t: 'zone', dep: 'zones.enabled' },
    Rg('zones.oobGraceSec', 'Time allowed outside the line', 10, 300, 5, fSec, { dep: 'zones.enabled', desc: 'Seekers are eliminated when it runs out. Hiders are caught or turned, depending on the rule above.' }),
    T('shrinking.enabled', 'Shrinking zone', 'The boundary closes in over the hunt.', { dep: 'zones.enabled' }),
    Rg('shrinking.endPercent', 'Final size', 20, 90, 5, fPct, { dep: 'shrinking.enabled', sub: true }),
    T('moving.enabled', 'Moving zone', 'The boundary drifts in a random direction over the hunt.', { dep: 'zones.enabled' }),
    Rg('moving.distanceM', 'Travel distance', 50, 2000, 50, fM, { dep: 'moving.enabled', sub: true }),
  ] },
  { id: 'safe', title: 'Safe zones', fields: [
    T('safeZones.enabled', 'Allow safe zones', 'No-tag areas you place on the map.'),
    { t: 'safebtn', dep: 'safeZones.enabled' },
    T('personalSafe.enabled', 'Personal safe zones', 'Each player can drop their own no-tag circle where they stand.'),
    Rg('personalSafe.radiusM', 'Size', 5, 60, 5, fM, { dep: 'personalSafe.enabled', sub: true }),
    Rg('personalSafe.durationMin', 'Lasts', 1, 30, 1, fMin, { dep: 'personalSafe.enabled', sub: true }),
    Rg('personalSafe.stock', 'Per player', 0, 5, 1, fN, { dep: 'personalSafe.enabled', sub: true }),
  ] },
  { id: 'drops', title: 'Ability drops & points', fields: [
    T('drops.enabled', 'Ability drops', 'Pickups appear on the map. Walk onto one to earn ability points.'),
    Rg('drops.intervalMin', 'New drop every', 1, 30, 1, fMin, { dep: 'drops.enabled', sub: true }),
    Rg('drops.maxActive', 'Max on the map', 1, 10, 1, fN, { dep: 'drops.enabled', sub: true }),
    Rg('drops.points', 'Points per drop', 1, 5, 1, fPts, { dep: 'drops.enabled', sub: true }),
    Rg('drops.pickupRadiusM', 'Pickup distance', 10, 50, 5, fM, { dep: 'drops.enabled', sub: true }),
    Rg('drops.lifetimeMin', 'Drop disappears after', 3, 60, 1, fMin, { dep: 'drops.enabled', sub: true }),
    Rg('startPoints', 'Starting points', 0, 10, 1, fPts),
  ] },
  { id: 'reveal', title: 'Reveal mode', fields: [
    T('reveal.enabled', 'Enable Reveal', 'A seeker ability. Shows every hider’s exact live location to everyone and switches off safe zones and abilities.'),
    Rg('reveal.threshold', 'Unlocks at', 0, 10, 1, fPts, { dep: 'reveal.enabled', sub: true, desc: 'Points are not spent. This is just the qualification.' }),
    Rg('reveal.durationMin', 'Lasts', 1, 60, 1, fMin, { dep: 'reveal.enabled', sub: true }),
    Rg('reveal.usesPerPlayer', 'Uses per seeker', 1, 5, 1, fN, { dep: 'reveal.enabled', sub: true }),
  ] },
  { id: 'bounty', title: 'Bounty mode', fields: [
    T('bounty.enabled', 'Enable Bounty', 'A qualified seeker posts one public hider target for all seekers to chase.'),
    Rg('bounty.threshold', 'Unlocks at', 0, 10, 1, fPts, { dep: 'bounty.enabled', sub: true }),
    Rg('bounty.durationMin', 'Lasts', 1, 60, 1, fMin, { dep: 'bounty.enabled', sub: true }),
    Rg('bounty.reward', 'Catch reward', 0, 5, 1, fPts, { dep: 'bounty.enabled', sub: true }),
    Rg('bounty.usesPerPlayer', 'Uses per seeker', 1, 5, 1, fN, { dep: 'bounty.enabled', sub: true }),
    T('bounty.disableSafeZones', 'Disable safe zones during bounty', 'The target cannot use safe zones.', { dep: 'bounty.enabled', sub: true }),
    T('bounty.disableAbilities', 'Disable abilities during bounty', 'The target cannot use abilities.', { dep: 'bounty.enabled', sub: true }),
  ] },
  { id: 'abilities', title: 'Player abilities', custom: 'abilities' },
];

function fieldHtml(f, s) {
  const dep = f.dep ? ` data-dep="${f.dep}"` : '';
  const cls = 'field' + (f.sub ? ' sub2' : '');
  const desc = f.desc ? `<p class="desc">${esc(f.desc)}</p>` : '';
  const val = f.p ? getP(s, f.p) : null;
  switch (f.t) {
    case 'toggle':
      return `<div class="${cls}"${dep}><div class="row"><span class="lab">${esc(f.label)}</span><label class="toggle"><input type="checkbox" data-p="${f.p}" data-t="bool" ${val ? 'checked' : ''}><i></i></label></div>${desc}</div>`;
    case 'range':
      return `<div class="${cls}"${dep}><div class="row"><span class="lab">${esc(f.label)}</span><span class="val" data-val="${f.p}">${esc(f.fmt(val))}</span></div><input type="range" data-p="${f.p}" data-t="num" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">${desc}</div>`;
    case 'seg':
      return `<div class="${cls}"${dep}><div class="row"><span class="lab">${esc(f.label)}</span></div><div class="seg" data-seg="${f.p}">${f.opts.map(([k, l]) => `<button type="button" data-v="${k}" class="${val === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>${desc}</div>`;
    case 'select':
      return `<div class="${cls}"${dep}><div class="row"><span class="lab">${esc(f.label)}</span></div><select data-p="${f.p}" data-t="str">${f.opts.map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${desc}</div>`;
    case 'zone':
      return `<div class="${cls}"${dep}><button type="button" class="btn zonebtn" data-open="zone"><span>Draw the play area</span><span class="st" data-zonestatus></span></button></div>`;
    case 'safebtn':
      return `<div class="${cls}"${dep}><button type="button" class="btn zonebtn" data-open="safe"><span>Place safe zones</span><span class="st" data-safestatus></span></button></div>`;
    default: return '';
  }
}

function abilitiesSectionHtml(s) {
  return ABILITY_ORDER.map((k) => {
    const a = s.abilities[k], meta = AB[k];
    let mini = `<div><span class="lab">Cost</span><span class="val" data-val="abilities.${k}.cost">${fPts(a.cost)}</span><input type="range" data-p="abilities.${k}.cost" data-t="num" min="0" max="10" step="1" value="${a.cost}"></div>`;
    if ('durationMin' in a) mini += `<div><span class="lab">Lasts</span><span class="val" data-val="abilities.${k}.durationMin">${fMin(a.durationMin)}</span><input type="range" data-p="abilities.${k}.durationMin" data-t="num" min="1" max="60" step="1" value="${a.durationMin}"></div>`;
    if ('amount' in a) mini += `<div><span class="lab">Points taken</span><span class="val" data-val="abilities.${k}.amount">${a.amount}</span><input type="range" data-p="abilities.${k}.amount" data-t="num" min="1" max="5" step="1" value="${a.amount}"></div>`;
    return `<div class="abil"><div class="head"><span class="nm">${meta.ic} ${meta.name}</span><label class="toggle"><input type="checkbox" data-p="abilities.${k}.enabled" data-t="bool" ${a.enabled ? 'checked' : ''}><i></i></label></div><p class="desc muted small-t" style="margin:0">${esc(meta.desc(a))}</p><div class="mini" data-dep="abilities.${k}.enabled">${mini}</div></div>`;
  }).join('');
}

function settingsHtml(s) {
  return SCHEMA.map((sec) => {
    const body = sec.custom === 'abilities' ? abilitiesSectionHtml(s) : sec.fields.map((f) => fieldHtml(f, s)).join('');
    return `<details class="set" ${sec.open ? 'open' : ''}><summary>${esc(sec.title)}</summary><div class="body">${body}</div></details>`;
  }).join('');
}

function setFill(el) {
  const min = +el.min, max = +el.max;
  el.style.setProperty('--fill', `${((+el.value - min) / (max - min)) * 100}%`);
}
function applyDeps() {
  $$('#lobbyBody [data-dep]').forEach((el) => { el.hidden = !getP(S.settings, el.dataset.dep); });
}
function refreshZoneStatus() {
  const z = S.settings && S.settings.zones.shape;
  const txt = !z ? 'Not set' : z.shape === 'circle' ? `Circle, ${Math.round(z.radius)} m` : `Traced, ${z.points.length} points`;
  $$('[data-zonestatus]').forEach((e) => { e.textContent = txt; });
  const n = S.settings ? S.settings.safeZones.list.length : 0;
  $$('[data-safestatus]').forEach((e) => { e.textContent = n ? `${n} placed` : 'None yet'; });
}

function onSetting(p, val) {
  setP(S.settings, p, val);
  if (p === 'mode') {
    S.settings.whenCaught = val === 'zombie' ? 'seeker' : 'out';
    const sel = $('#lobbyBody select[data-p="whenCaught"]'); if (sel) sel.value = S.settings.whenCaught;
  }
  applyDeps();
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushSave, 450);
  updateStart();
}
async function flushSave() {
  clearTimeout(S.saveTimer); S.saveTimer = null;
  if (!S.settings) return;
  try { await api('settings', { ...authBody(), settings: S.settings }); }
  catch (e) { toast(e.message, 'bad'); }
}

function buildHostUI(v) {
  S.settings = clone(v.settings);
  const box = $('#lobbyBody');
  box.innerHTML = settingsHtml(S.settings);
  $$('input[type=range]', box).forEach(setFill);
  applyDeps(); refreshZoneStatus();
  box.oninput = (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.p || el.type !== 'range') return;
    const val = +el.value; setFill(el);
    const lab = $(`[data-val="${el.dataset.p}"]`, box);
    if (lab) {
      const f = findField(el.dataset.p);
      lab.textContent = f ? f.fmt(val) : el.dataset.p.endsWith('.cost') ? fPts(val) : el.dataset.p.endsWith('durationMin') ? fMin(val) : String(val);
    }
    onSetting(el.dataset.p, val);
  };
  box.onchange = (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.p || el.type === 'range') return;
    onSetting(el.dataset.p, el.type === 'checkbox' ? el.checked : el.value);
  };
  box.onclick = (e) => {
    const seg = e.target.closest('[data-seg] button');
    if (seg) {
      $$('button', seg.parentElement).forEach((b) => b.classList.toggle('on', b === seg));
      onSetting(seg.parentElement.dataset.seg, seg.dataset.v);
      return;
    }
    const op = e.target.closest('[data-open]');
    if (op) openEditor(op.dataset.open);
  };
}
function findField(path) {
  for (const sec of SCHEMA) for (const f of sec.fields || []) if (f.p === path) return f;
  return null;
}

function describeRulesHtml(s) { return rulesHtml(s); }

function enterLobby() {
  show('lobby');
  S.lobbyAsHost = null;
  $('#lobbyBack').onclick = async () => {
    if (!confirm('Leave this game?')) return;
    try { await api('leave', authBody()); } catch (e) { /* ignore */ }
    clearSession(); show('home');
  };
  $('#codeChip').onclick = shareCode;
  $('#startBtn').onclick = async () => {
    const btn = $('#startBtn'); btn.disabled = true;
    try { await flushSave(); const j = await api('start', authBody()); applyView(j.view); }
    catch (e) { toast(e.message, 'bad'); }
    btn.disabled = false;
  };
}

function renderLobby() {
  const v = S.view, host = v.me.isHost;
  $('#lobbyCode').textContent = v.code;
  $('#playerCount').textContent = `(${v.players.length})`;
  $('#lobbyPlayers').innerHTML = v.players.map((p) => `<li><span class="dot ${p.online ? 'ok' : ''}"></span><span class="nm">${esc(p.name)}${p.id === v.me.id ? ' (you)' : ''}</span>${p.isHost ? '<span class="badge">Host</span>' : ''}</li>`).join('');
  if (S.lobbyAsHost !== host) {
    S.lobbyAsHost = host;
    if (host) buildHostUI(v); else { S.settings = null; $('#lobbyBody').onclick = $('#lobbyBody').oninput = $('#lobbyBody').onchange = null; }
  }
  if (!host) $('#lobbyBody').innerHTML = `<div class="card rules">${rulesHtml(v.settings)}</div>`;
  $('#lobbySub').textContent = host ? 'You are the host. Set the rules, draw the area, then start when everyone has joined.' : 'Waiting for the host to start. These are the rules for this game.';
  updateStart();
}
function updateStart() {
  const v = S.view; if (!v) return;
  const btn = $('#startBtn'), note = $('#startNote');
  if (!v.me.isHost) { btn.hidden = true; note.textContent = 'The host starts the game.'; return; }
  btn.hidden = false;
  const s = S.settings || v.settings;
  let why = '';
  if (v.players.length < 2) why = 'Waiting for at least one more player.';
  else if (s.zones.enabled && !s.zones.shape) why = 'Draw the play area first (or turn zones off).';
  btn.disabled = !!why;
  note.textContent = why || `${v.players.length} players ready. ${Math.min(s.seekerCount, v.players.length - 1)} seeker(s) will be picked at random.`;
}

// ------------------------------------------------------------------ rules text (also shown live in-game)
function rulesHtml(s, withHow) {
  const R = (ic, html) => `<div class="rule"><span class="ic">${ic}</span><div>${html}</div></div>`;
  const H = (t) => `<h4>${esc(t)}</h4>`;
  const caught = s.whenCaught === 'seeker' ? 'turns into a <b>seeker</b>' : 'is <b>out</b>';
  let h = '';
  h += H('The goal');
  h += R('🎯', s.mode === 'zombie'
    ? `<b>Zombie mode.</b> Seekers tag hiders and a tagged hider ${caught}. Seekers win when no hiders are left. Hiders win if the clock runs out.`
    : `<b>Out when tagged.</b> A tagged hider ${caught}. Seekers win when no hiders are left. Hiders win if the clock runs out.`);
  h += H('Format');
  h += R('⏱️', s.headStartMin ? `Head start: seekers must wait <b>${fMin(s.headStartMin)}</b>. They cannot tag and see no hiders until it ends.` : 'No head start: the hunt begins immediately.');
  h += R('👁️', `<b>${s.seekerCount}</b> seeker${s.seekerCount === 1 ? '' : 's'}, picked at random. The hunt lasts <b>${fMin(s.durationMin)}</b> after the head start.`);
  h += R('📡', s.pingIntervalMin === 0
    ? 'Pings are <b>live</b>: seekers see hiders in real time.'
    : `Every <b>${fMin(s.pingIntervalMin)}</b> a ping shows seekers where each hider was at that moment. In between, hiders are invisible.${s.pingWarnSec ? ` You get a warning <b>${s.pingWarnSec} s</b> before each ping.` : ''}`);
  h += R('👀', s.seekerVisibility === 'hidden' ? 'Hiders never see seekers on the map.' : s.seekerVisibility === 'live' || s.pingIntervalMin === 0 ? 'Hiders see seekers live.' : 'Hiders see seekers on each ping.');
  h += R('✋', `Seekers tap <b>TAG</b> when within <b>${fM(s.tagRadiusM)}</b> of a hider. Hiders can also report <b>I was tagged</b>.`);
  if (s.zones.enabled) {
    h += H('Play area');
    h += R('🗺️', `Stay inside the orange line. Be outside for <b>${fSec(s.zones.oobGraceSec)}</b> and you are eliminated: a seeker is out of the hunt, a hider ${caught}.`);
    if (s.shrinking.enabled) h += R('⭕', `The zone <b>shrinks</b> to ${s.shrinking.endPercent}% of its size by the end.`);
    if (s.moving.enabled) h += R('🧭', `The zone <b>drifts</b> about ${fM(s.moving.distanceM)} during the hunt.`);
  }
  if (s.safeZones.enabled || s.personalSafe.enabled) {
    h += H('Safe zones');
    if (s.safeZones.enabled) h += R('🏠', `<b>${s.safeZones.list.length}</b> host-placed safe zone${s.safeZones.list.length === 1 ? '' : 's'} (green). Nobody can be tagged inside one.`);
    if (s.personalSafe.enabled) h += R('⛺', `Each player can drop <b>${s.personalSafe.stock}</b> personal safe zone${s.personalSafe.stock === 1 ? '' : 's'} (${fM(s.personalSafe.radiusM)} wide, lasts ${fMin(s.personalSafe.durationMin)}). Only you can see yours.`);
  }
  h += H('Ability points');
  if (s.drops.enabled) h += R('⚡', `Ability drops appear every <b>${fMin(s.drops.intervalMin)}</b> (up to ${s.drops.maxActive} at once). Walk within ${fM(s.drops.pickupRadiusM)} to earn <b>${fPts(s.drops.points)}</b>. Drops vanish after ${fMin(s.drops.lifetimeMin)}.`);
  else h += R('⚡', 'Ability drops are turned off.');
  if (s.startPoints) h += R('🎁', `Everyone starts with <b>${fPts(s.startPoints)}</b>.`);
  if (s.reveal.enabled) h += R('📢', `<b>Reveal</b> (seekers): at <b>${fPts(s.reveal.threshold)}</b> a seeker can expose every hider’s exact live location to everyone for <b>${fMin(s.reveal.durationMin)}</b>. It costs nothing, ${s.reveal.usesPerPlayer}× per seeker. It overrides Vanish, fake locations and approximate areas, and switches off safe zones and all other abilities while active.`);
  if (s.bounty.enabled) h += R('💰', `<b>Bounty</b> (seekers): at <b>${fPts(s.bounty.threshold)}</b> a seeker posts one hider as a public target for <b>${fMin(s.bounty.durationMin)}</b>. Seekers can see the target live. Catching them pays <b>${fPts(s.bounty.reward)}</b>.${s.bounty.disableSafeZones ? ' The target’s safe zones are disabled.' : ''}${s.bounty.disableAbilities ? ' The target’s abilities are disabled.' : ''}`);
  const on = ABILITY_ORDER.filter((k) => s.abilities[k].enabled);
  if (on.length) {
    h += H('Abilities you can buy');
    on.forEach((k) => { const a = s.abilities[k]; h += R(AB[k].ic, `<b>${AB[k].name}</b> – ${fPts(a.cost)}. ${esc(AB[k].desc(a))}`); });
  }
  return `<div class="rules">${h}</div>`;
}

// ------------------------------------------------------------------ map editor (host)
const ED = { map: null, tab: 'zone', shape: 'circle', circle: null, poly: [], safe: [], layer: null, safeR: 30 };
function openEditor(tab) {
  $('#editor').hidden = false;
  const z = S.settings.zones.shape;
  ED.tab = tab;
  ED.shape = z ? z.shape : 'circle';
  ED.circle = z && z.shape === 'circle' ? clone(z) : null;
  ED.poly = z && z.shape === 'polygon' ? clone(z.points) : [];
  ED.safe = clone(S.settings.safeZones.list);
  if (!ED.map) {
    ED.map = L.map('edmap', { zoomControl: false }).setView([39.5, -98.35], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(ED.map);
    ED.layer = L.layerGroup().addTo(ED.map);
    ED.map.on('click', (e) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (ED.tab === 'zone') {
        if (ED.shape === 'circle') ED.circle = { shape: 'circle', center: p, radius: +$('#edRadius').value };
        else ED.poly.push(p);
      } else ED.safe.push({ lat: p.lat, lng: p.lng, r: ED.safeR });
      drawEd(); edUi();
    });
  }
  setTimeout(() => {
    ED.map.invalidateSize();
    const b = L.latLngBounds([]);
    drawEd();
    if (ED.circle) b.extend(L.circle([ED.circle.center.lat, ED.circle.center.lng], { radius: ED.circle.radius }).getBounds());
    ED.poly.forEach((p) => b.extend([p.lat, p.lng]));
    ED.safe.forEach((p) => b.extend([p.lat, p.lng]));
    if (b.isValid()) ED.map.fitBounds(b.pad(0.3));
    else if (GPS.pos) ED.map.setView([GPS.pos.lat, GPS.pos.lng], 16);
  }, 80);
  edUi();
}
function edUi() {
  $$('#edTabs button').forEach((b) => b.classList.toggle('on', b.dataset.ed === ED.tab));
  $$('#edShapeRow button').forEach((b) => b.classList.toggle('on', b.dataset.shape === ED.shape));
  const zone = ED.tab === 'zone';
  $('#edShapeRow').hidden = !zone;
  const rad = $('#edRadius');
  const showRad = !zone || ED.shape === 'circle';
  rad.hidden = !showRad; $('#edRadLabel').parentElement.hidden = !showRad;
  if (zone) {
    rad.min = 100; rad.max = 5000; rad.step = 50;
    rad.value = ED.circle ? ED.circle.radius : 400;
    $('#edRadLabel').textContent = 'Radius';
    $('#edHelp').textContent = ED.shape === 'circle' ? 'Search a place or tap the map to drop the center, then slide the radius.' : `Tap the map to add corner points along the streets (${ED.poly.length} so far, need 3+).`;
  } else {
    rad.min = 10; rad.max = 300; rad.step = 5;
    const last = ED.safe[ED.safe.length - 1];
    rad.value = last ? last.r : ED.safeR;
    $('#edRadLabel').textContent = 'Size of the last safe zone';
    $('#edHelp').textContent = `Tap to drop a no-tag circle, then slide to size it. ${ED.safe.length} placed.`;
  }
  $('#edRadVal').textContent = `${Math.round(rad.value)} m`;
  setFill(rad);
}
function drawEd() {
  ED.layer.clearLayers();
  const orange = { color: '#ff6a1f', weight: 3, fillColor: '#ff6a1f', fillOpacity: 0.08 };
  if (ED.shape === 'circle' && ED.circle) L.circle([ED.circle.center.lat, ED.circle.center.lng], { ...orange, radius: ED.circle.radius }).addTo(ED.layer);
  if (ED.shape === 'polygon' && ED.poly.length) {
    const pts = ED.poly.map((p) => [p.lat, p.lng]);
    (pts.length >= 3 ? L.polygon(pts, orange) : L.polyline(pts, orange)).addTo(ED.layer);
    pts.forEach((p) => L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: '#ff6a1f', fillOpacity: 1 }).addTo(ED.layer));
  }
  ED.safe.forEach((z) => L.circle([z.lat, z.lng], { color: '#3ddc84', weight: 2, fillColor: '#3ddc84', fillOpacity: 0.25, radius: z.r }).addTo(ED.layer));
}
function initEditor() {
  $('#edClose').onclick = () => { $('#editor').hidden = true; };
  $('#edTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; ED.tab = b.dataset.ed; edUi(); };
  $('#edShapeRow').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; ED.shape = b.dataset.shape; drawEd(); edUi(); };
  $('#edRadius').oninput = (e) => {
    const val = +e.target.value;
    if (ED.tab === 'zone') { if (ED.circle) ED.circle.radius = val; }
    else { ED.safeR = val; const last = ED.safe[ED.safe.length - 1]; if (last) last.r = val; }
    $('#edRadVal').textContent = `${val} m`; setFill(e.target); drawEd();
  };
  $('#edUndo').onclick = () => {
    if (ED.tab === 'safe') ED.safe.pop();
    else if (ED.shape === 'polygon') ED.poly.pop(); else ED.circle = null;
    drawEd(); edUi();
  };
  $('#edClear').onclick = () => { if (ED.tab === 'safe') ED.safe = []; else { ED.circle = null; ED.poly = []; } drawEd(); edUi(); };
  $('#edMe').onclick = () => { if (GPS.pos) ED.map.setView([GPS.pos.lat, GPS.pos.lng], 17); else { startGPS(); toast('Waiting for your location...'); } };
  $('#edSearch').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#edQuery').value.trim(); if (!q) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!j.length) { toast('Place not found'); return; }
      ED.map.setView([+j[0].lat, +j[0].lon], 16);
    } catch (err) { toast('Search failed', 'bad'); }
  };
  $('#edDone').onclick = () => {
    const zs = S.settings.zones;
    if (ED.shape === 'circle' && ED.circle) zs.shape = { shape: 'circle', center: ED.circle.center, radius: Math.round(ED.circle.radius) };
    else if (ED.shape === 'polygon' && ED.poly.length >= 3) zs.shape = { shape: 'polygon', points: ED.poly };
    else if (ED.circle === null && ED.poly.length === 0) zs.shape = null;
    else { toast('Add at least 3 points, or choose a circle.', 'warn'); return; }
    if (zs.shape) zs.enabled = true;
    S.settings.safeZones.list = ED.safe;
    if (ED.safe.length) S.settings.safeZones.enabled = true;
    $$('#lobbyBody input[type=checkbox]').forEach((c) => { if (c.dataset.p) c.checked = !!getP(S.settings, c.dataset.p); });
    applyDeps(); refreshZoneStatus(); scheduleSave();
    $('#editor').hidden = true;
  };
}

// ------------------------------------------------------------------ game screen
const SNAPS = ['peek', 'half', 'full'];
function setSnap(s) { S.snap = s; $('#sheet').className = 'snap-' + s; measurePeek(); setTimeout(() => S.map && S.map.invalidateSize(), 250); }
function measurePeek() {
  const h = $('#sheetHandle').offsetHeight + $('#peek').offsetHeight + 4;
  $('#game').style.setProperty('--peek-h', h + 'px');
}

function enterGame() {
  show('game');
  keepAwake(); startGPS();
  S.tabHtml = {};
  initMap();
  setSnap(S.snap);
  const handle = $('#sheetHandle'); let drag = null;
  handle.onpointerdown = (e) => { drag = { y: e.clientY }; try { handle.setPointerCapture(e.pointerId); } catch (x) { /* ok */ } };
  handle.onpointerup = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y; drag = null;
    const i = SNAPS.indexOf(S.snap);
    if (dy < -30) setSnap(SNAPS[Math.min(2, i + 1)]);
    else if (dy > 30) setSnap(SNAPS[Math.max(0, i - 1)]);
    else setSnap(SNAPS[(i + 1) % 3]);
  };
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab;
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    if (S.snap === 'peek') setSnap('half');
    renderTab(true);
  };
  $('#tabBody').onclick = onTabClick;
  $('#actionRow').onclick = onActionClick;
  $('#recenter').onclick = () => {
    S.follow = true; $('#recenter').classList.add('on');
    if (GPS.pos) S.map.setView([GPS.pos.lat, GPS.pos.lng], Math.max(S.map.getZoom(), 17));
  };
  $('#recenter').classList.add('on');
}

function initMap() {
  if (S.map) { S.map.invalidateSize(); return; }
  S.map = L.map('map', { zoomControl: false }).setView([39.5, -98.35], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
  S.layers = { zone: L.layerGroup().addTo(S.map), safe: L.layerGroup().addTo(S.map), drops: L.layerGroup().addTo(S.map), others: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
  S.map.on('dragstart', () => { S.follow = false; $('#recenter').classList.remove('on'); });
  S.fitted = false;
}

const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><i></i></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
function ringLL(zone) { return Geo.ring(zone).map((p) => [p.lat, p.lng]); }

function drawMe() {
  S.layers.me.clearLayers();
  if (!GPS.pos) return;
  const ll = [GPS.pos.lat, GPS.pos.lng];
  L.circle(ll, { radius: Math.max(GPS.pos.acc, 3), color: '#5cc8ff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(S.layers.me);
  L.marker(ll, { icon: pinIcon('me'), interactive: false, zIndexOffset: 1000 }).addTo(S.layers.me);
  const v = S.view;
  if (v && v.me.fx.fakeLoc && v.me.fx.fakeUntil > now()) L.marker([v.me.fx.fakeLoc.lat, v.me.fx.fakeLoc.lng], { icon: pinIcon('ping seeker'), interactive: false }).bindTooltip('Your decoy', { permanent: true, direction: 'top', offset: [0, -12], className: 'pin-label' }).addTo(S.layers.me);
}

function drawWorld() {
  const v = S.view, L_ = S.layers;
  L_.zone.clearLayers(); L_.safe.clearLayers(); L_.drops.clearLayers(); L_.others.clearLayers();
  if (v.zone) {
    const ring = ringLL(v.zone);
    const world = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
    L.polygon([world, ring], { stroke: false, fillColor: '#000', fillOpacity: 0.5, interactive: false }).addTo(L_.zone);
    const outline = L.polygon(ring, { color: '#ff6a1f', weight: 3, fill: false, dashArray: '9 7', interactive: false }).addTo(L_.zone);
    if (!S.fitted && !GPS.pos) { S.map.fitBounds(outline.getBounds().pad(0.15)); S.fitted = true; }
  }
  const safeCol = v.safeOff ? '#7a847d' : '#3ddc84';
  v.safeZones.forEach((z) => L.circle([z.lat, z.lng], { radius: z.r, color: safeCol, weight: 2, fillColor: safeCol, fillOpacity: 0.2, interactive: false }).addTo(L_.safe));
  v.me.zones.forEach((z) => L.circle([z.lat, z.lng], { radius: z.r, color: safeCol, weight: 2, dashArray: '4 4', fillColor: safeCol, fillOpacity: 0.18, interactive: false }).addTo(L_.safe));
  v.drops.forEach((d) => L.marker([d.lat, d.lng], { icon: pinIcon('drop'), interactive: false }).bindTooltip(`+${d.points}`, { permanent: true, direction: 'top', offset: [0, -14], className: 'pin-label' }).addTo(L_.drops));
  v.markers.forEach((m) => {
    const cls = `${m.role} ${m.kind === 'ping' ? 'ping' : m.kind === 'trace' ? 'trace' : m.kind === 'reveal' || m.kind === 'bounty' ? 'reveal' : ''}`;
    let label = esc(m.name);
    if (m.kind === 'ping') label += ` · ${Math.max(0, Math.round((now() - m.t) / 60000))}m ago`;
    if (m.kind === 'trace') label += ' · vanished';
    if (m.kind === 'bounty') label += ' · BOUNTY';
    L.marker([m.lat, m.lng], { icon: pinIcon(cls), interactive: false }).bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -12], className: 'pin-label' }).addTo(L_.others);
  });
}

function roleLabel(v) {
  const r = v.me.role;
  if (r === 'hider') return 'HIDER';
  if (r === 'seeker') return v.me.caught ? 'ZOMBIE' : 'SEEKER';
  return 'OUT';
}
function renderHud() {
  const v = S.view; if (!v || S.screen !== 'game') return;
  const n = now();
  $('#hudRole').className = 'chip ' + v.me.role; $('#hudRole').textContent = roleLabel(v);
  const t = v.timers;
  $('#hudClock').innerHTML = n < t.hsEnd ? `HEAD START <span data-until="${t.hsEnd}"></span>` : `TIME LEFT <span data-until="${t.endsAt}"></span>`;
  $('#hudPing').innerHTML = v.settings.pingIntervalMin === 0 ? 'LIVE LOCATIONS' : t.nextPingAt ? `PING <span data-until="${t.nextPingAt}"></span>` : 'LAST PING DONE';
  const g = $('#hudGps');
  if (!GPS.pos) { g.className = 'chip bad'; g.textContent = GPS.perm === 'denied' ? 'GPS BLOCKED' : 'GPS...'; }
  else { const acc = Math.round(GPS.pos.acc); g.className = 'chip ' + (acc > 50 ? 'warn' : ''); g.textContent = `GPS ±${acc} m`; }
  tickClocks();
}

function renderBanner() {
  const v = S.view, n = now(), b = $('#banner');
  const lines = []; let cls = '';
  const me = v.me, s = v.settings;
  if (v.reveal) { lines.push(`REVEAL: every hider is exposed for <span data-until="${v.reveal.until}"></span>`); cls = 'red'; }
  if (v.bounty) {
    if (v.bounty.targetId === me.id) { lines.push(`You have a BOUNTY. Seekers can see you for <span data-until="${v.bounty.until}"></span>`); cls = 'red'; }
    else lines.push(`BOUNTY on ${esc(v.bounty.target)} for <span data-until="${v.bounty.until}"></span>`);
  }
  if (v.zone && GPS.pos && me.role !== 'out' && !Geo.inZone(GPS.pos, v.zone)) {
    const left = me.oobSince ? me.oobSince + s.zones.oobGraceSec * 1000 : n + s.zones.oobGraceSec * 1000;
    lines.push(`You are OUTSIDE the play area. Get back in <span data-until="${left}"></span> or you are eliminated.`); cls = 'red';
  }
  if (!lines.length && me.role === 'seeker' && n < v.timers.hsEnd) { lines.push(`Stay put. The hunt starts in <span data-until="${v.timers.hsEnd}"></span>`); }
  if (!lines.length && me.role === 'hider' && n < v.timers.hsEnd) { lines.push(`Head start! Move and hide. Seekers are held back for <span data-until="${v.timers.hsEnd}"></span>`); cls = 'good'; }
  const html = lines.join('<br>');
  if (S.bannerHtml !== html || b.className !== cls) { S.bannerHtml = html; b.className = cls; b.innerHTML = html; }
  b.hidden = !html;
}

function renderPeek() {
  const v = S.view, me = v.me, s = v.settings, n = now();
  const bits = [`<b>${fPts(me.points)}</b>`];
  bits.push(s.pingIntervalMin === 0 ? 'Live locations' : `Ping every <b>${s.pingIntervalMin} min</b>`);
  bits.push(`Tag within <b>${s.tagRadiusM} m</b>`);
  if (v.zone) bits.push(GPS.pos && !Geo.inZone(GPS.pos, v.zone) ? '<b style="color:var(--bad)">Outside zone</b>' : 'Inside zone');
  $('#strip').innerHTML = bits.join(' · ');
  let btns = '';
  if (me.role === 'seeker') btns += `<button class="btn primary" data-act="tag" ${n < v.timers.hsEnd ? 'disabled' : ''}>TAG</button>`;
  if (me.role === 'hider') {
    btns += `<button class="btn danger" data-act="caught">I was tagged</button>`;
    if (s.personalSafe.enabled && me.safeStock > 0) btns += `<button class="btn" data-act="safe">Safe zone (${me.safeStock})</button>`;
  }
  if (me.role !== 'hider' && me.caught && me.revivable && s.abilities.revive.enabled) {
    btns += `<button class="btn primary" data-act="ability:revive" ${me.points < s.abilities.revive.cost ? 'disabled' : ''}>Revive (${s.abilities.revive.cost})</button>`;
  }
  if (!btns) btns = `<span class="muted small-t">${me.role === 'out' ? 'You are out. Spectating.' : ''}</span>`;
  const row = $('#actionRow');
  if (row.dataset.html !== btns) { row.dataset.html = btns; row.innerHTML = btns; }
}

async function onActionClick(e) {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'tag') return doAction('tag', {}, b);
  if (act === 'safe') return doAction('safe', {}, b);
  if (act === 'caught') {
    return confirmModal('Report that you were tagged?', 'You will be removed from the hiders.', 'Yes, I was tagged', () => doAction('caught', {}));
  }
  if (act.startsWith('ability:')) return useAbility(act.split(':')[1]);
}
async function doAction(action, extra, btn) {
  if (btn) btn.disabled = true;
  try {
    const j = await api(action, { ...authBody(), loc: GPS.pos, ...extra });
    if (j.msg) toast(j.msg, 'good');
    applyView(j.view);
  } catch (e) { toast(e.message, 'bad', 4500); buzz(80); }
  if (btn) btn.disabled = false;
}

function openModal(html) {
  const m = $('#modal'); $('#modalCard').innerHTML = html; m.hidden = false;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }
function confirmModal(title, text, yes, cb) {
  openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><button class="btn danger" id="mYes">${esc(yes)}</button><button class="btn" id="mNo">Cancel</button>`);
  $('#mYes').onclick = () => { closeModal(); cb(); };
  $('#mNo').onclick = closeModal;
}
function pickModal(title, text, players, cb) {
  if (!players.length) { toast('Nobody to pick right now'); return; }
  openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>${players.map((p) => `<button class="pick" data-id="${p.id}"><span>${esc(p.name)}</span><span class="badge gray">${esc(p.role === 'seeker' ? 'seeker' : p.role === 'hider' ? 'hider' : 'out')}</span></button>`).join('')}<button class="btn" id="mNo">Cancel</button>`);
  $('#modalCard').onclick = (e) => { const b = e.target.closest('.pick'); if (b) { closeModal(); cb(b.dataset.id); } };
  $('#mNo').onclick = closeModal;
}

function useAbility(key) {
  const v = S.view, meta = AB[key];
  const others = v.players.filter((p) => p.id !== v.me.id && (p.role === 'hider' || p.role === 'seeker'));
  if (meta.target === 'active') return pickModal(meta.name, 'Pick a player.', others, (id) => doAction('ability', { name: key, target: id }));
  if (meta.target === 'caught') return pickModal(meta.name, 'Pick a tagged player to bring back.', v.players.filter((p) => p.caught && p.role !== 'hider' && p.elim !== 'oob'), (id) => doAction('ability', { name: key, target: id }));
  doAction('ability', { name: key });
}

// ---- tabs
function abilityWhy(v, key) {
  const a = v.settings.abilities[key], me = v.me, n = now();
  if (v.reveal) return 'Disabled during Reveal';
  if (key === 'revive') { if (!me.caught || me.role === 'hider' || !me.revivable) return 'Only for tagged players'; }
  else if (me.role === 'out') return 'You are out';
  if (me.points < a.cost) return `Needs ${a.cost} pt${a.cost === 1 ? '' : 's'}`;
  if (key === 'reboot' && me.role !== 'hider') return 'Active hiders only';
  if (key === 'clearBounty' && !(v.bounty && v.bounty.targetId === me.id)) return 'No bounty on you';
  if (['vanish', 'trace', 'shield', 'fake'].includes(key) && me.fx[key + 'Until'] > n) return 'Already active';
  if (key === 'extraSafe' && !v.settings.personalSafe.enabled) return 'Safe zones are off';
  return '';
}

function statusHtml(v) {
  const me = v.me, s = v.settings, t = v.timers, n = now();
  let h = '';
  const role = me.role;
  let title = role === 'hider' ? 'You are a HIDER' : role === 'seeker' ? (me.caught ? 'You are a ZOMBIE' : 'You are a SEEKER') : 'You are OUT';
  let text;
  if (role === 'hider') text = n < t.hsEnd ? `Head start is on. Get away and find a spot. Seekers are held back for <span data-until="${t.hsEnd}"></span>.` : `Stay hidden and stay inside the play area. ${s.pingIntervalMin === 0 ? 'Seekers can see you live.' : `Seekers get a snapshot of your position every ${s.pingIntervalMin} min.`}`;
  else if (role === 'seeker') text = n < t.hsEnd ? `Stay put until the head start ends in <span data-until="${t.hsEnd}"></span>.` : `Find hiders and tap TAG when you are within ${s.tagRadiusM} m.`;
  else text = me.elim === 'oob' ? 'You left the play area. You can still watch the game.' : 'You were tagged. You can watch the game' + (s.abilities.revive.enabled ? ' or spend points to Revive.' : '.');
  h += `<div class="role-card ${role}"><h3>${title}</h3><p>${text}</p></div>`;
  if (v.zone && GPS.pos && role !== 'out' && !Geo.inZone(GPS.pos, v.zone)) h += `<div class="alert red">You are outside the play area. Head back inside now.</div>`;
  h += `<div class="kv"><span>Ability points</span><span class="pts">${me.points}</span><span>Time left</span><span><span data-until="${t.endsAt}"></span></span>`;
  if (t.nextPingAt) h += `<span>Next ping</span><span><span data-until="${t.nextPingAt}"></span></span>`;
  if (s.personalSafe.enabled && role !== 'out') h += `<span>Safe zones to place</span><span>${me.safeStock}</span>`;
  h += `</div>`;
  const fx = [];
  const add = (label, until) => { if (until > n) fx.push(`<span class="badge">${label} <span data-until="${until}"></span></span>`); };
  add('Vanish', me.fx.vanishUntil); add('Decoy', me.fx.fakeUntil); add('Trace', me.fx.traceUntil); add('Shield', me.fx.shieldUntil);
  add('Protected', me.fx.immuneUntil); add('Safe zones off', me.fx.disableSafeUntil);
  me.zones.forEach((z) => fx.push(`<span class="badge green">Your safe zone <span data-until="${z.expiresAt}"></span></span>`));
  if (fx.length) h += `<div class="fxrow">${fx.join('')}</div>`;
  if (v.reveal) h += `<div class="alert red">REVEAL is active for <span data-until="${v.reveal.until}"></span>. Safe zones and abilities are off.</div>`;
  if (v.bounty) h += `<div class="alert">${v.bounty.targetId === me.id ? 'There is a BOUNTY on you.' : `Bounty on <b>${esc(v.bounty.target)}</b>.`} <span data-until="${v.bounty.until}"></span> left.</div>`;
  return h;
}

function abilitiesHtml(v) {
  const s = v.settings, me = v.me;
  let h = `<div class="kv"><span>Your ability points</span><span class="pts">${me.points}</span></div>`;
  if (s.drops.enabled) h += `<p class="muted small-t">Walk onto yellow diamonds on the map to earn points. ${v.drops.length} on the map right now.</p>`;
  if (me.role === 'seeker') {
    if (s.reveal.enabled) {
      const ok = me.points >= s.reveal.threshold && me.revealUses < s.reveal.usesPerPlayer && !v.reveal && now() >= v.timers.hsEnd;
      const why = me.revealUses >= s.reveal.usesPerPlayer ? 'Already used' : me.points < s.reveal.threshold ? `Unlocks at ${s.reveal.threshold} pts (you have ${me.points})` : v.reveal ? 'Running now' : now() < v.timers.hsEnd ? 'After the head start' : '';
      h += `<div class="abtn"><span class="nm">📢 Reveal</span><span class="ds">Expose every hider’s live location to everyone for ${s.reveal.durationMin} min. Costs nothing.</span><button class="btn primary" data-ab="reveal" ${ok ? '' : 'disabled'}>Start</button>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
    }
    if (s.bounty.enabled) {
      const ok = me.points >= s.bounty.threshold && me.bountyUses < s.bounty.usesPerPlayer && !v.bounty && now() >= v.timers.hsEnd;
      const why = me.bountyUses >= s.bounty.usesPerPlayer ? 'Already used' : me.points < s.bounty.threshold ? `Unlocks at ${s.bounty.threshold} pts (you have ${me.points})` : v.bounty ? 'A bounty is already running' : now() < v.timers.hsEnd ? 'After the head start' : '';
      h += `<div class="abtn"><span class="nm">💰 Bounty</span><span class="ds">Post a hider as a public target for ${s.bounty.durationMin} min. Catch reward ${fPts(s.bounty.reward)}.</span><button class="btn primary" data-ab="bounty" ${ok ? '' : 'disabled'}>Post</button>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
    }
  }
  ABILITY_ORDER.forEach((k) => {
    const a = s.abilities[k]; if (!a.enabled) return;
    const why = abilityWhy(v, k);
    h += `<div class="abtn"><span class="nm">${AB[k].ic} ${AB[k].name} <span class="muted" style="font-size:16px">· ${fPts(a.cost)}</span></span><span class="ds">${esc(AB[k].desc(a))}</span><button class="btn" data-ab="${k}" ${why ? 'disabled' : ''}>Use</button>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
  });
  return h;
}

function playersHtml(v) {
  const badge = (p) => p.role === 'hider' ? '<span class="badge green">Hider</span>' : p.role === 'seeker' ? `<span class="badge red">${p.caught ? 'Zombie' : 'Seeker'}</span>` : '<span class="badge gray">Out</span>';
  let h = `<ul class="plist">${v.players.map((p) => `<li><span class="dot ${p.online ? 'ok' : ''}"></span><span class="nm">${esc(p.name)}${p.id === v.me.id ? ' (you)' : ''}</span>${p.isHost ? '<span class="badge">Host</span>' : ''}${badge(p)}</li>`).join('')}</ul>`;
  const t0 = v.timers.startedAt || 0;
  h += `<h3 style="margin:18px 0 6px;font-size:22px">Event log</h3><ul class="log">${v.events.slice().reverse().map((e) => `<li><time>${fmtClock(e.t - t0)}</time>${esc(e.msg)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
  h += `<div style="display:grid;gap:8px;margin-top:16px">`;
  if (v.me.isHost) h += `<button class="btn danger" data-act2="end">End game for everyone</button>`;
  h += `<button class="btn" data-act2="leave">Leave this game</button></div>`;
  return h;
}

function renderTab(force) {
  const v = S.view; if (!v || S.screen !== 'game') return;
  const body = $('#tabBody');
  const html = S.tab === 'status' ? statusHtml(v) : S.tab === 'abilities' ? abilitiesHtml(v) : S.tab === 'rules' ? rulesHtml(v.settings) : playersHtml(v);
  if (!force && S.tabHtml[S.tab] === html) return;
  S.tabHtml[S.tab] = html;
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
  tickClocks();
}

async function onTabClick(e) {
  const ab = e.target.closest('[data-ab]');
  if (ab && !ab.disabled) {
    const k = ab.dataset.ab;
    if (k === 'reveal') return doAction('reveal', {}, ab);
    if (k === 'bounty') return pickModal('Post a bounty', 'Pick the hider seekers will chase.', S.view.players.filter((p) => p.role === 'hider'), (id) => doAction('bounty', { target: id }));
    return useAbility(k);
  }
  const a2 = e.target.closest('[data-act2]');
  if (!a2) return;
  if (a2.dataset.act2 === 'end') confirmModal('End the game?', 'Everyone will see the final screen.', 'End game', () => doAction('end', {}));
  if (a2.dataset.act2 === 'leave') confirmModal('Leave this game?', 'You can rejoin only if the host is still running it and you have the same device.', 'Leave', () => { clearSession(); show('home'); });
}

function renderGame() {
  const v = S.view;
  drawWorld(); drawMe();
  renderHud(); renderBanner(); renderPeek(); renderTab();
  measurePeek();
}

// ------------------------------------------------------------------ end
function enterEnd() {
  show('end');
  $('#endLeave').onclick = () => { clearSession(); show('home'); };
  $('#rematchBtn').onclick = async () => {
    try { const j = await api('rematch', authBody()); S.lastEventT = null; applyView(j.view); } catch (e) { toast(e.message, 'bad'); }
  };
}
function renderEnd() {
  const v = S.view;
  const me = v.me;
  let title = 'The hunt is over';
  if (v.winner === 'seekers') title = me.role === 'seeker' ? 'Seekers win!' : 'Seekers win';
  else if (v.winner === 'hiders') title = me.role === 'hider' ? 'Hiders win!' : 'Hiders win';
  $('#endTitle').textContent = title;
  $('#endReason').textContent = v.endReason || '';
  $('#endPlayers').innerHTML = v.players.map((p) => `<li><span class="nm">${esc(p.name)}${p.id === me.id ? ' (you)' : ''}</span>${p.role === 'hider' ? '<span class="badge green">Survived</span>' : p.role === 'seeker' ? `<span class="badge red">${p.caught ? 'Zombie' : 'Seeker'}</span>` : '<span class="badge gray">Out</span>'}</li>`).join('');
  const t0 = v.timers.startedAt || 0;
  $('#endLog').innerHTML = v.events.map((e) => `<li><time>${fmtClock(e.t - t0)}</time>${esc(e.msg)}</li>`).join('');
  $('#rematchBtn').hidden = !me.isHost;
}

// ------------------------------------------------------------------ 1s clock
function tickClocks() {
  const n = now();
  $$('[data-until]').forEach((el) => { el.textContent = fmtClock(+el.dataset.until - n); });
}
setInterval(() => {
  tickClocks();
  const v = S.view;
  if (!v || v.phase !== 'running') return;
  const n = now(), np = v.timers.nextPingAt, warn = v.settings.pingWarnSec * 1000;
  if (np && warn > 0 && np - n <= warn && np - n > 0 && S.warnedFor !== np) {
    S.warnedFor = np;
    toast(`Ping in ${Math.round((np - n) / 1000)} s. Everyone's location updates.`, 'warn', 6000);
    buzz([200, 100, 200]); beep(660);
  }
  if (S.lastPingIdx == null) S.lastPingIdx = v.timers.pingIdx;
  else if (v.timers.pingIdx > S.lastPingIdx) { S.lastPingIdx = v.timers.pingIdx; toast('PING! Locations updated', 'warn'); buzz(300); beep(990); }
  if (S.screen === 'game') renderBanner();
}, 1000);

// ------------------------------------------------------------------ boot
function boot() {
  initHome();
  initEditor();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  tryResume();
}
boot();
})();

/* Service worker: caches the app shell so it installs and opens fast. Game data is never cached. */
const CACHE = 'manhunt-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/geo.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return; // always live
  const sameOrigin = url.origin === self.location.origin;
  const cdn = /(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|basemaps\.cartocdn\.com)$/.test(url.hostname);
  if (!sameOrigin && !cdn) return;
  // Network first so updates show up, cache as the offline fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque') && !/basemaps\.cartocdn\.com/.test(url.hostname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});

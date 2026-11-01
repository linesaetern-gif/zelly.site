/* Zelly service worker: makes the app installable and shows a friendly page when offline.
   It never caches pages or API calls, so shop data and prices are always live. */
const V = 'zelly-shell-v1', SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).catch(() => caches.match('/offline.html'))); return; }
  if (u.pathname.startsWith('/icons/') || u.pathname === '/favicon.svg') e.respondWith(caches.match(r).then(m => m || fetch(r)));
});

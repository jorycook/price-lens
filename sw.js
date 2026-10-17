/* Price Lens offline copy. The page's own files are stored when this installs; the text reader
 * (fetched from a CDN the first time it is used) is stored as it arrives, and the page also sends
 * the list of the reader's files once it has started, since on the very first visit the page
 * (and its reader's worker) start before this worker controls them. Exchange rates are not
 * handled here: the page keeps the last ones itself and says how old they are.
 * Change VERSION whenever a file of the page changes, so phones pick up the new copy. */
const VERSION = 'price-lens-4';
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './src/app.js', './src/prices.js', './src/rates.js', './src/location.js', './src/camera.js', './src/zones.js', './src/styles.css',
  './src/reader.js', './src/ocr.js', './src/ocr-paddle.js', './src/paddle-worker.js', './src/paddle-boxes.js',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net/';
const CDN_CACHE = 'price-lens-cdn';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('price-lens-') && k !== VERSION && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* The page, once its reader has started: { type: 'keep', urls }. Each CDN file not stored yet is
   fetched (usually straight from the browser's own cache) and stored. */
self.addEventListener('message', (event) => {
  const urls = event.data?.type === 'keep' && Array.isArray(event.data.urls) ? event.data.urls : [];
  const wanted = urls.filter((u) => typeof u === 'string' && u.startsWith(CDN));
  if (!wanted.length) return;
  event.waitUntil(caches.open(CDN_CACHE).then((c) => Promise.all(wanted.map(async (url) => {
    if (await c.match(url, { ignoreVary: true })) return;
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) await c.put(url, res);
  }))).catch((err) => console.warn('offline copy of the reader:', err)));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (url.startsWith(CDN)) {
    /* the reader's files never change at a pinned version: stored copy first */
    event.respondWith(caches.open(CDN_CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  } else if (new URL(url).origin === self.location.origin) {
    /* the page: network first so a new version shows up, the stored copy when offline */
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
  }
});

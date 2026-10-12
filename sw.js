/* Price Lens offline copy. The page's own files are stored when this installs; the text reader
 * (fetched from a CDN the first time it is used) is stored as it arrives. Exchange rates are not
 * handled here: the page keeps the last ones itself and says how old they are.
 * Change VERSION whenever a file of the page changes, so phones pick up the new copy. */
const VERSION = 'price-lens-1';
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './src/app.js', './src/prices.js', './src/rates.js', './src/ocr.js', './src/styles.css',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('price-lens-') && k !== VERSION && k !== 'price-lens-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (url.startsWith(CDN)) {
    /* the reader's files never change at a pinned version: stored copy first */
    event.respondWith(caches.open('price-lens-cdn').then(async (c) => {
      const hit = await c.match(req);
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

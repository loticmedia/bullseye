/* Offline cache: serve from cache for speed (OpenCV.js is 10 MB), refresh it in the
 * background so a new version shows up on the next visit. */
const CACHE = 'bullseye-v8';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'game.js', 'frame-worker.js', 'measure-worker.js', 'scorer.js',
  'ball_lut.bin', 'vendor/opencv.js', 'vendor/mp4box.all.min.js', 'vendor/bungee-latin.woff2', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    if (hit) { e.waitUntil(fresh); return hit; }
    return fresh;
  }));
});

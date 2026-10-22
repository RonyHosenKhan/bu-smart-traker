// Service Worker for BU Smart Bus Tracker PWA
const CACHE_NAME = 'bu-smart-bus-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './data.js',
  './eta.js',
  './driver.js',
  './student.js',
  './admin.js',
  './app.js',
  './manifest.json',
  './icons/bus-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Always fetch live GPS API requests from network, never cache them
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network first for HTML, Cache first for static assets with network fallback
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

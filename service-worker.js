/* Date Night Decider service worker v3.4.3-hotfix1 */
'use strict';
const CACHE_NAME = 'date-night-decider-v3.4.3-hotfix1';
const LEGACY_CACHE_PREFIX = 'date-night-decider-';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=3.4.3-hotfix1',
  './manifest.json',
  './vendor/dexie.min.js',
  './vendor/peerjs.min.js',
  './src/adapters/device-adapter.js?v=3.4.3-hotfix1',
  './src/adapters/billing-adapter.js?v=3.4.3-hotfix1',
  './boot.js?v=3.4.3-hotfix1',
  './db.js?v=3.4.3-hotfix1',
  './store.js?v=3.4.3-hotfix1',
  './p2p.js?v=3.4.3-hotfix1',
  './ui.js?v=3.4.3-hotfix1',
  './app.js?v=3.4.3-hotfix1',
  './privacy.html',
  './support.html'
];
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png'];

async function cacheSafely(cache, request, response) {
  try { await cache.put(request, response.clone()); }
  catch (error) { console.warn('Cache update failed:', request.url, error); }
}

async function findCachedResponse(cache, request, cacheKey) {
  return await cache.match(request, { ignoreSearch: true }) || await cache.match(cacheKey, { ignoreSearch: true }) || null;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (error) {
      console.error('Service worker precache failed:', error);
      await caches.delete(CACHE_NAME);
      throw error;
    }
    await Promise.all(OPTIONAL_ASSETS.map(asset => cache.add(asset).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => key.startsWith(LEGACY_CACHE_PREFIX) && key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  const scopeUrl = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = request.mode === 'navigate' ? new URL('./index.html', scopeUrl).href : request;
    try {
      const response = await fetch(request);
      if (response.ok) { await cacheSafely(cache, cacheKey, response); return response; }
      return await findCachedResponse(cache, request, cacheKey) || response;
    } catch (error) {
      const fallback = await findCachedResponse(cache, request, cacheKey);
      if (fallback) return fallback;
      if (request.mode === 'navigate') {
        const indexFallback = await cache.match(new URL('./index.html', scopeUrl).href);
        if (indexFallback) return indexFallback;
      }
      throw error;
    }
  })());
});

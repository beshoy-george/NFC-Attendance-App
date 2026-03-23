// NFC Attendance Manager - Service Worker (Offline-First PWA)
const CACHE_VERSION = 'v4';
const STATIC_CACHE = 'nfc-static-' + CACHE_VERSION;
const API_CACHE    = 'nfc-api-' + CACHE_VERSION;

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

// API GET endpoints that should be cached for offline viewing
const CACHEABLE_API_PREFIXES = [
  '/api/dashboard', '/api/employees', '/api/attendance/',
  '/api/analytics', '/api/auth/me', '/api/supervisors',
  '/api/birthdays', '/api/visits', '/api/services', '/api/stages'
];

// ---- INSTALL ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ---- ACTIVATE ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- FETCH ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // === API requests ===
  if (url.pathname.startsWith('/api/')) {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;

    const isCacheable = CACHEABLE_API_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (!isCacheable) return;

    // Network-first: try network, cache the response, fall back to cache
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // === Static assets & navigation ===
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cache but also update it in background (stale-while-revalidate)
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok) {
            caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, response));
          }
          return response.clone();
        }).catch(() => {});
        return cached;
      }
      // Not in cache — fetch from network
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

// ---- BACKGROUND SYNC (if supported) ----
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-writes') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SYNC_NOW' }));
      })
    );
  }
});

// ---- PUSH NOTIFICATION (placeholder for future) ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

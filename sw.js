// NFC Attendance Manager - Service Worker for PWA (offline-capable)
const CACHE_NAME = 'nfc-attendance-v2';
const API_CACHE = 'nfc-api-cache-v1';
const OFFLINE_URLS = [
  '/', '/css/styles.css', '/js/app.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

// Cacheable GET API endpoints (for offline viewing on phone)
const CACHEABLE_API = [
  '/api/dashboard', '/api/employees', '/api/attendance/date',
  '/api/attendance/today', '/api/analytics', '/api/auth/me', '/api/supervisors'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== API_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For API GET requests: network-first, fallback to cache (offline mode)
  if (url.pathname.startsWith('/api/') && event.request.method === 'GET') {
    const isCacheable = CACHEABLE_API.some(p => url.pathname.startsWith(p));
    if (isCacheable) {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
            return response;
          })
          .catch(() => caches.match(event.request))
      );
      return;
    }
    // Non-cacheable API calls (POST etc) - just pass through
    return;
  }

  // For static assets: cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

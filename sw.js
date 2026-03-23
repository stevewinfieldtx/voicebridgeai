/* =========================================
   TalkBridge — Service Worker v3
   Caches the app shell so it loads instantly
   and works offline (speech/translation still
   need network, but the UI is always ready).
   ========================================= */

const CACHE_NAME = 'talkbridge-v4';
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './favicon.svg',
    './icon-512.png',
    './manifest.json',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME)
                    .map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch: stale-while-revalidate for app shell, network-first for API
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Don't cache cross-origin API calls (translation, fonts, etc.)
    if (url.origin !== location.origin) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            // Return cached version, but also update cache in background
            const fetchPromise = fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                })
                .catch(() => cached); // If offline, fall back to cache

            return cached || fetchPromise;
        })
    );
});

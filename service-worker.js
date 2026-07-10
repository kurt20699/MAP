const CACHE_NAME = 'prmsu-navigator-v4';
const TILE_CACHE_NAME = 'prmsu-map-tiles-v3';

// App shell files to cache immediately
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './script.js',
];

// Install - cache app shell
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Caching app shell...');
            return cache.addAll(APP_SHELL);
        })
    );
    self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME && key !== TILE_CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch - serve from cache or network
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Handle map tile requests (OpenStreetMap)
    if (url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(cache => {
                return cache.match(event.request).then(cached => {
                    if (cached) {
                        return cached; // Serve from cache
                    }
                    // Fetch and cache the tile
                    return fetch(event.request).then(response => {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    }).catch(() => {
                        // Return a blank tile if offline and not cached
                        return new Response('', { status: 200 });
                    });
                });
            })
        );
        return;
    }

    // Always prefer network for index to avoid stale login/app shell state
    if (url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/Software_Engineering_II/')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put('./index.html', responseClone));
                }
                return response;
            }).catch(() => caches.match('./index.html'))
        );
        return;
    }

    // JS/CSS must always be checked against the network first, same as
    // index.html — otherwise edits to these files get silently ignored
    // by returning users until the cache is manually busted (e.g. hard
    // refresh), which is confusing during active development.
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Handle remaining app shell requests (images, icons, fonts, etc.)
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                return cached; // Serve from cache
            }
            return fetch(event.request).then(response => {
                // Cache successful responses
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            }).catch(() => {
                // If offline and not cached, return index.html
                return caches.match('./index.html');
            });
        })
    );
});
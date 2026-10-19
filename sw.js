/**
 * SismoData Panamá — Service Worker (PWA)
 * Gestión de caché de recursos estáticos y bypass total para consultas de sismicidad dinámica.
 */

const CACHE_NAME = 'sismodata-static-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

// Instalación: pre-cachear el caparazón estático
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activación: depurar cachés antiguas y tomar control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Interceptación de solicitudes de red
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo interceptar peticiones GET
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // REGLA CRÍTICA DE INTEGRIDAD SÍSMICA:
  // NUNCA cachear llamadas a endpoints de datos dinámicos (Netlify Functions, APIs sísmicas, Supabase).
  // La información sísmica debe llegar SIEMPRE en vivo desde la red.
  if (
    url.pathname.includes('/.netlify/functions/') ||
    url.pathname.includes('/functions/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('sismosgeociencias.up.ac.pa')
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Estrategia stale-while-revalidate / cache-first con actualización en segundo plano para estáticos
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (networkResponse.type === 'basic' || networkResponse.type === 'cors')
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback a caché si la red falla
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});

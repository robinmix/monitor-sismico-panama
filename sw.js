/**
 * sismoPA — Service Worker (PWA)
 *
 * Políticas de caché y actualización seguras:
 * 1. Bypass total (Network-Only) para APIs de sismicidad dinámica, Supabase e IGC-UP.
 * 2. Navegación y HTML (Network-First con timeout corto y fallback offline).
 * 3. JavaScript y CSS propios (Network-First con fallback a caché para coherencia de versiones).
 * 4. Recursos estáticos locales e iconos (Stale-While-Revalidate).
 * 5. Librerías CDN de terceros fijas como MapLibre/Leaflet (Stale-While-Revalidate en caché vendor).
 * 6. Limpieza segura y acotada de cachés obsoletas con prefijo 'sismodata-'.
 * 7. Cero persistencia de geolocalización o datos personales.
 */

const CACHE_PREFIX = 'sismodata-';
const CURRENT_CACHES = {
  core: `${CACHE_PREFIX}core-v20261024amoled3`,
  static: `${CACHE_PREFIX}static-v20261024amoled3`,
  vendor: `${CACHE_PREFIX}vendor-v1`
};

// Archivos esenciales del App Shell
const CORE_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js'
];

// Activos estáticos locales
const STATIC_ASSETS = [
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-16.png',
  './assets/icons/icon-maskable-512.png',
  './favicon.ico'
];

// Instalación: precachear el caparazón estático básico
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CURRENT_CACHES.core).then((cache) => cache.addAll(CORE_ASSETS)),
      caches.open(CURRENT_CACHES.static).then((cache) => cache.addAll(STATIC_ASSETS))
    ]).then(() => self.skipWaiting())
  );
});

// Activación: eliminar de forma segura SOLO cachés obsoletas de la aplicación
self.addEventListener('activate', (event) => {
  const expectedCaches = new Set(Object.values(CURRENT_CACHES));

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && !expectedCaches.has(name))
          .map((name) => {
            console.log('[SW] Eliminando caché obsoleta:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Helpers de estrategia de caché
async function networkFirstWithTimeout(request, cacheName, timeoutMs = 2500, fallbackUrl = null) {
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(async () => {
      // Priorizar coincidencia exacta de versión; solo usar ignoreSearch como fallback
      const cached = (await caches.match(request)) || (await caches.match(request, { ignoreSearch: true }));
      if (cached) {
        resolve(cached);
      } else if (fallbackUrl) {
        const fallback = (await caches.match(fallbackUrl)) || (await caches.match(fallbackUrl, { ignoreSearch: true }));
        if (fallback) resolve(fallback);
      }
    }, timeoutMs);
  });

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      clearTimeout(timeoutId);
      if (
        networkResponse &&
        networkResponse.status === 200 &&
        (networkResponse.type === 'basic' || networkResponse.type === 'cors')
      ) {
        const cache = await caches.open(cacheName);
        cache.put(request, networkResponse.clone());

        // Guardar también la clave limpia para compatibilidad offline
        try {
          const urlObj = new URL(request.url);
          if (urlObj.search) {
            urlObj.search = '';
            cache.put(urlObj.toString(), networkResponse.clone());
          }
        } catch (_) {}
      }
      return networkResponse;
    })
    .catch(async (err) => {
      clearTimeout(timeoutId);
      // En desconexión o fallo, buscar coincidencia exacta y solo recurrir a ignoreSearch si no existe
      const cached = (await caches.match(request)) || (await caches.match(request, { ignoreSearch: true }));
      if (cached) return cached;
      if (fallbackUrl) {
        const fallback = (await caches.match(fallbackUrl)) || (await caches.match(fallbackUrl, { ignoreSearch: true }));
        if (fallback) return fallback;
      }
      throw err;
    });

  return Promise.race([networkPromise, timeoutPromise]);
}

async function staleWhileRevalidate(request, cacheName) {
  const cachedResponse = await caches.match(request, { ignoreSearch: true });

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      if (
        networkResponse &&
        networkResponse.status === 200 &&
        (networkResponse.type === 'basic' || networkResponse.type === 'cors')
      ) {
        const cache = await caches.open(cacheName);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  // Si existe en caché, devolver de inmediato; la red actualizará la caché en segundo plano.
  // Si no existe en caché, esperar la respuesta de la red.
  return cachedResponse || (await networkPromise);
}

// Interceptación de solicitudes de red
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo interceptar peticiones GET
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // REGLA CRÍTICA 1: INTEGRIDAD SÍSMICA Y ASSET LINKS (Network-Only)
  // NUNCA cachear llamadas a endpoints de datos dinámicos, APIs externas de sismos ni Digital Asset Links.
  if (
    url.pathname.includes('/.well-known/') ||
    url.pathname.includes('/api/') ||
    url.pathname.includes('/.netlify/functions/') ||
    url.pathname.includes('/functions/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('sismosgeociencias.up.ac.pa')
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // REGLA CRÍTICA 2: Teselas de mapa (Network directo, evitar saturar Cache Storage)
  if (
    url.hostname.includes('tiles.openfreemap.org') ||
    url.hostname.includes('tile.openstreetmap.org')
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // ESTRATEGIA A: Navegación y documentos HTML (Network-First con fallback a index.html)
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      networkFirstWithTimeout(req, CURRENT_CACHES.core, 2500, './index.html')
    );
    return;
  }

  // ESTRATEGIA B: Scripts y estilos propios del App Shell (Network-First para sincronía total)
  if (
    url.origin === self.location.origin &&
    (url.pathname.endsWith('/app.js') || url.pathname.endsWith('/style.css'))
  ) {
    event.respondWith(
      networkFirstWithTimeout(req, CURRENT_CACHES.core, 3000)
    );
    return;
  }

  // ESTRATEGIA C: Librerías fijas CDN de terceros (Google Fonts, unpkg Leaflet/MapLibre)
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com')
  ) {
    event.respondWith(
      staleWhileRevalidate(req, CURRENT_CACHES.vendor)
    );
    return;
  }

  // ESTRATEGIA D: Recursos estáticos locales (iconos, manifest)
  if (
    url.origin === self.location.origin &&
    (url.pathname.includes('/assets/icons/') || url.pathname.endsWith('manifest.webmanifest'))
  ) {
    event.respondWith(
      staleWhileRevalidate(req, CURRENT_CACHES.static)
    );
    return;
  }

  // ESTRATEGIA GENERAL: Para cualquier otro recurso del mismo origen
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        return cached || fetch(req);
      })
    );
    return;
  }
});

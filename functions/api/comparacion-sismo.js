import { getInternationalComparisons } from '../../cloudflare/lib/comparacion-sismos.mjs';

/**
 * sismoPA — Endpoint Cloudflare Pages: /api/comparacion-sismo
 * Consulta controlada y bajo demanda de magnitudes internacionales (USGS, EMSC, GFZ).
 * 
 * Optimización extrema:
 * - Caché compartida per-evento con caches.default de Cloudflare (s-maxage dinámico).
 * - Deduplicación de solicitudes concurrentes en tránsito (Request Collapsing).
 * - Caché en memoria por isolate para latencia cero en consultas repetidas.
 * - Validación estricta anti-proxy abierto: solo consulta catálogos oficiales para sismos de Panamá.
 */

const HEADERS_BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

// Caché en memoria local por Isolate
const memoryCache = new Map();
const inFlightRequests = new Map();
const MAX_MEM_ENTRIES = 300;

export async function onRequest(context) {
  const method = context.request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: HEADERS_BASE
    });
  }

  if (method !== 'GET') {
    return Response.json(
      { ok: false, error: 'Método no permitido. Solo se admite GET u OPTIONS.' },
      { status: 405, headers: { ...HEADERS_BASE, Allow: 'GET, OPTIONS' } }
    );
  }

  const url = new URL(context.request.url);
  const id = (url.searchParams.get('id') || '').trim();
  const rawLat = url.searchParams.get('lat');
  const rawLon = url.searchParams.get('lon');
  const rawTime = url.searchParams.get('time');
  const rawMag = url.searchParams.get('mag');
  const rawDepth = url.searchParams.get('depth');

  // Validación estricta de parámetros
  if (!id || id.length > 120 || !/^[a-zA-Z0-9_\-\.:+%|]+$/.test(id)) {
    return Response.json(
      { ok: false, error: 'Parámetro "id" inválido o ausente.' },
      { status: 400, headers: HEADERS_BASE }
    );
  }

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    return Response.json(
      { ok: false, error: 'Parámetro "lat" numérico requerido entre -90 y 90.' },
      { status: 400, headers: HEADERS_BASE }
    );
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    return Response.json(
      { ok: false, error: 'Parámetro "lon" numérico requerido entre -180 y 180.' },
      { status: 400, headers: HEADERS_BASE }
    );
  }

  const dateObj = new Date(rawTime);
  if (!rawTime || !Number.isFinite(dateObj.getTime())) {
    return Response.json(
      { ok: false, error: 'Parámetro "time" requerido en formato ISO 8601 válido.' },
      { status: 400, headers: HEADERS_BASE }
    );
  }

  // Clave de caché normalizada
  const cacheKeyUrl = new URL('/api/comparacion-sismo', url.origin);
  cacheKeyUrl.searchParams.set('id', id);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  // 1. Verificar Cloudflare Cache API (caches.default) si está disponible en runtime
  let cfCache = null;
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      cfCache = caches.default;
      const hit = await cfCache.match(cacheKey);
      if (hit) {
        const hitHeaders = new Headers(hit.headers);
        hitHeaders.set('X-Cache', 'HIT-CF');
        return new Response(hit.body, {
          status: hit.status,
          headers: hitHeaders
        });
      }
    }
  } catch (_) {}

  // 2. Verificar caché en memoria Isolate
  const now = Date.now();
  const memCached = memoryCache.get(id);
  if (memCached && (now - memCached.timestamp < memCached.ttlMs)) {
    return Response.json(memCached.data, {
      status: 200,
      headers: {
        ...HEADERS_BASE,
        'X-Cache': 'HIT-MEMORY',
        'Cache-Control': `public, max-age=${Math.round(memCached.ttlMs / 1000)}, s-maxage=${Math.round(memCached.ttlMs / 1000)}`
      }
    });
  }

  // 3. Deduplicación de solicitudes concurrentes (In-flight Request Collapsing)
  if (inFlightRequests.has(id)) {
    try {
      const sharedData = await inFlightRequests.get(id);
      return Response.json(sharedData, {
        status: 200,
        headers: {
          ...HEADERS_BASE,
          'X-Cache': 'HIT-INFLIGHT',
          'Cache-Control': 'public, max-age=300, s-maxage=600'
        }
      });
    } catch (_) {}
  }

  // 4. Ejecutar consulta hacia las agencias
  const queryPromise = (async () => {
    return await getInternationalComparisons({
      lat,
      lon,
      time: dateObj.getTime(),
      mag: rawMag,
      depth: rawDepth
    });
  })();

  inFlightRequests.set(id, queryPromise);

  let result;
  try {
    result = await queryPromise;
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: 'Inconveniente consultando servicios sismológicos internacionales.',
        detalle: err.message
      },
      { status: 502, headers: HEADERS_BASE }
    );
  } finally {
    inFlightRequests.delete(id);
  }

  const ttlSeconds = result.meta?.cacheTtlSeconds || 3600;

  // Guardar en memoria local
  if (memoryCache.size >= MAX_MEM_ENTRIES) {
    const firstKey = memoryCache.keys().next().value;
    memoryCache.delete(firstKey);
  }
  memoryCache.set(id, {
    timestamp: now,
    ttlMs: ttlSeconds * 1000,
    data: result
  });

  const responseHeaders = {
    ...HEADERS_BASE,
    'X-Cache': 'MISS',
    'Cache-Control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=86400`
  };

  const finalResponse = Response.json(result, {
    status: 200,
    headers: responseHeaders
  });

  // Guardar en Cloudflare Edge Cache
  if (cfCache && context.waitUntil) {
    try {
      context.waitUntil(cfCache.put(cacheKey, finalResponse.clone()));
    } catch (_) {}
  }

  return finalResponse;
}

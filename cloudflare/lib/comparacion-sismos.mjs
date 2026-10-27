'use strict';

/**
 * sismoPA — Comparación Internacional de Magnitudes en Fichas Sísmicas
 * Módulo científico y motor de correspondencia conservadora entre eventos sísmicos.
 * Consulta catálogos oficiales: USGS, EMSC-CSEM y GFZ/GEOFON.
 * 
 * Principios:
 * 1. IGC-UP es la fuente soberana y primaria de sismoPA.
 * 2. Criterio de coincidencia conservador: hora UTC, latitud, longitud, profundidad y distancia geodésica.
 * 3. En caso de ambigüedad (sismos simultáneos o muy cercanos en Panamá), descartar conservadoramente
 *    y devolver «Sin coincidencia» en lugar de atribuir una magnitud potencialmente errónea.
 * 4. Tolerancia a fallos: timeouts estrictos y control de errores para no degradar la experiencia de usuario.
 */

const MAX_TIME_DIFF_SEC = 90; // Tolerancia temporal máxima estricta (segundos)
const MAX_DISTANCE_KM = 120;  // Tolerancia espacial máxima estricta (km)
const MAX_DEPTH_DIFF_KM = 60; // Tolerancia de profundidad si ambas > 45km
const FETCH_TIMEOUT_MS = 3800; // Timeout rápido para evitar bloquear la ficha

/**
 * Distancia geodésica mediante fórmula de Haversine (en kilómetros).
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rLat1) * Math.cos(rLat2) * (Math.sin(dLon / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

/**
 * Valida y normaliza los parámetros de entrada del evento base (IGC-UP).
 */
export function validateTargetEvent(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('Parámetros de evento inválidos.');
  }

  const lat = Number(target.lat);
  const lon = Number(target.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new Error('Latitud fuera de rango o inválida.');
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new Error('Longitud fuera de rango o inválida.');
  }

  const dateObj = new Date(target.time);
  const timestamp = dateObj.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('Marca temporal UTC inválida.');
  }

  const mag = target.mag !== undefined && target.mag !== null && target.mag !== '' ? Number(target.mag) : null;
  const depth = target.depth !== undefined && target.depth !== null && target.depth !== '' ? Number(target.depth) : null;

  return {
    time: timestamp,
    isoTime: dateObj.toISOString(),
    lat,
    lon,
    mag: Number.isFinite(mag) ? mag : null,
    depth: Number.isFinite(depth) ? depth : null
  };
}

/**
 * Algoritmo conservador de correspondencia entre el evento objetivo (IGC-UP)
 * y una lista de candidatos reportados por una agencia internacional.
 * 
 * Retorna:
 * - { matched: true, magnitude, magText, magType, agency, catalogId, distKm, timeDiffSec }
 * - { matched: false, status: 'sin_coincidencia', ambiguous?: boolean }
 */
export function matchEarthquakeCandidate(target, candidates, agencyName = 'AGENCIA') {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      matched: false,
      status: 'sin_coincidencia',
      agency: agencyName
    };
  }

  const eligible = [];

  for (const cand of candidates) {
    if (!cand || !Number.isFinite(cand.lat) || !Number.isFinite(cand.lon) || !Number.isFinite(cand.time)) {
      continue;
    }

    const timeDiffSec = Math.abs(target.time - cand.time) / 1000;
    if (timeDiffSec > MAX_TIME_DIFF_SEC) continue;

    const distKm = haversineKm(target.lat, target.lon, cand.lat, cand.lon);
    if (distKm > MAX_DISTANCE_KM) continue;

    // Validación de profundidad si ambas están reportadas y son significativas (> 45km)
    if (Number.isFinite(target.depth) && Number.isFinite(cand.depth)) {
      if (target.depth > 45 && cand.depth > 45) {
        if (Math.abs(target.depth - cand.depth) > MAX_DEPTH_DIFF_KM) continue;
      }
    }

    // Puntuación combinada de discrepancia (menor es mejor)
    // Peso: 60% tiempo, 40% espacio
    const score = (timeDiffSec / MAX_TIME_DIFF_SEC) * 0.6 + (distKm / MAX_DISTANCE_KM) * 0.4;

    eligible.push({
      ...cand,
      distKm: Math.round(distKm * 10) / 10,
      timeDiffSec: Math.round(timeDiffSec * 10) / 10,
      score
    });
  }

  if (eligible.length === 0) {
    return {
      matched: false,
      status: 'sin_coincidencia',
      agency: agencyName
    };
  }

  // Ordenar candidatos por menor discrepancia espaciotemporal
  eligible.sort((a, b) => a.score - b.score);

  // Si hay exactamente 1 candidato elegible
  if (eligible.length === 1) {
    const winner = eligible[0];
    const magVal = Number(winner.mag);
    return {
      matched: true,
      status: 'reportada',
      agency: agencyName,
      magnitude: Number.isFinite(magVal) ? magVal : null,
      magText: Number.isFinite(magVal) ? `M${magVal.toFixed(1)}` : '—',
      magType: winner.magType || '',
      catalogId: winner.id || '',
      distKm: winner.distKm,
      timeDiffSec: winner.timeDiffSec,
      depthKm: winner.depth
    };
  }

  // Si hay 2 o más candidatos en la misma ventana (posible duplicidad/enjambre/réplica en Panamá)
  const best = eligible[0];
  const second = eligible[1];

  // Criterio de desambiguación conservador:
  // Solo se acepta si el mejor es claramente cercano y el segundo es sustancialmente distante
  if (best.score <= 0.28 && (second.score - best.score) >= 0.35) {
    const magVal = Number(best.mag);
    return {
      matched: true,
      status: 'reportada',
      agency: agencyName,
      magnitude: Number.isFinite(magVal) ? magVal : null,
      magText: Number.isFinite(magVal) ? `M${magVal.toFixed(1)}` : '—',
      magType: best.magType || '',
      catalogId: best.id || '',
      distKm: best.distKm,
      timeDiffSec: best.timeDiffSec,
      depthKm: best.depth
    };
  }

  // Si ambos candidatos tienen puntuaciones cercanas o el mejor no es indiscutible:
  // DESCARTAR CONSERVADORAMENTE para evitar asignar una magnitud incorrecta al usuario
  return {
    matched: false,
    status: 'sin_coincidencia',
    ambiguous: true,
    agency: agencyName,
    candidateCount: eligible.length
  };
}

/**
 * Consulta y empareja datos de USGS (United States Geological Survey).
 */
export async function fetchAndMatchUsgs(target, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startIso = new Date(target.time - 120000).toISOString();
    const endIso = new Date(target.time + 120000).toISOString();

    const minLat = (target.lat - 1.25).toFixed(4);
    const maxLat = (target.lat + 1.25).toFixed(4);
    const minLon = (target.lon - 1.25).toFixed(4);
    const maxLon = (target.lon + 1.25).toFixed(4);

    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startIso}&endtime=${endIso}&minlatitude=${minLat}&maxlatitude=${maxLat}&minlongitude=${minLon}&maxlongitude=${maxLon}&limit=10&eventtype=earthquake`;

    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'sismoPA-Scientific-Comparison/1.0 (+https://sismopa.pages.dev)'
      }
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        matched: false,
        status: 'no_disponible',
        agency: 'USGS',
        httpStatus: res.status
      };
    }

    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];

    const candidates = features.map(f => {
      const coords = f.geometry?.coordinates || [];
      const props = f.properties || {};
      return {
        id: f.id || props.code,
        time: Number(props.time),
        lat: Number(coords[1]),
        lon: Number(coords[0]),
        depth: Number.isFinite(Number(coords[2])) ? Number(coords[2]) : null,
        mag: Number.isFinite(Number(props.mag)) ? Number(props.mag) : null,
        magType: props.magType || ''
      };
    });

    return matchEarthquakeCandidate(target, candidates, 'USGS');
  } catch (err) {
    clearTimeout(timer);
    return {
      matched: false,
      status: 'no_disponible',
      agency: 'USGS',
      error: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    };
  }
}

/**
 * Consulta y empareja datos de EMSC (Euro-Mediterranean Seismological Centre).
 */
export async function fetchAndMatchEmsc(target, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startIso = new Date(target.time - 120000).toISOString();
    const endIso = new Date(target.time + 120000).toISOString();

    const minLat = (target.lat - 1.25).toFixed(4);
    const maxLat = (target.lat + 1.25).toFixed(4);
    const minLon = (target.lon - 1.25).toFixed(4);
    const maxLon = (target.lon + 1.25).toFixed(4);

    const url = `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&starttime=${startIso}&endtime=${endIso}&minlat=${minLat}&maxlat=${maxLat}&minlon=${minLon}&maxlon=${maxLon}&limit=10`;

    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'sismoPA-Scientific-Comparison/1.0 (+https://sismopa.pages.dev)'
      }
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        matched: false,
        status: 'no_disponible',
        agency: 'EMSC',
        httpStatus: res.status
      };
    }

    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];

    const candidates = features.map(f => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      const timeMs = props.time ? new Date(props.time).getTime() : NaN;
      return {
        id: f.id || props.unid || props.source_id,
        time: timeMs,
        lat: Number.isFinite(Number(props.lat)) ? Number(props.lat) : Number(coords[1]),
        lon: Number.isFinite(Number(props.lon)) ? Number(props.lon) : Number(coords[0]),
        depth: Number.isFinite(Number(props.depth)) ? Number(props.depth) : null,
        mag: Number.isFinite(Number(props.mag)) ? Number(props.mag) : null,
        magType: props.magtype || props.magType || ''
      };
    });

    return matchEarthquakeCandidate(target, candidates, 'EMSC');
  } catch (err) {
    clearTimeout(timer);
    return {
      matched: false,
      status: 'no_disponible',
      agency: 'EMSC',
      error: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    };
  }
}

/**
 * Consulta y empareja datos de GFZ (GEOFON - German Research Centre for Geosciences).
 */
export async function fetchAndMatchGfz(target, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startIso = new Date(target.time - 120000).toISOString();
    const endIso = new Date(target.time + 120000).toISOString();

    const minLat = (target.lat - 1.25).toFixed(4);
    const maxLat = (target.lat + 1.25).toFixed(4);
    const minLon = (target.lon - 1.25).toFixed(4);
    const maxLon = (target.lon + 1.25).toFixed(4);

    const url = `https://geofon.gfz.de/fdsnws/event/1/query?format=text&starttime=${startIso}&endtime=${endIso}&minlat=${minLat}&maxlat=${maxLat}&minlon=${minLon}&maxlon=${maxLon}&limit=10`;

    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'sismoPA-Scientific-Comparison/1.0 (+https://sismopa.pages.dev)'
      }
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        matched: false,
        status: 'no_disponible',
        agency: 'GFZ',
        httpStatus: res.status
      };
    }

    const text = await res.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));

    const candidates = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 11) continue;

      const eventId = parts[0]?.trim();
      const timeStr = parts[1]?.trim();
      const latVal = Number(parts[2]?.trim());
      const lonVal = Number(parts[3]?.trim());
      const depthVal = Number(parts[4]?.trim());
      const magType = parts[9]?.trim();
      const magVal = Number(parts[10]?.trim());

      const timeMs = timeStr ? new Date(timeStr.endsWith('Z') ? timeStr : timeStr + 'Z').getTime() : NaN;
      if (!Number.isFinite(timeMs)) continue;

      candidates.push({
        id: eventId,
        time: timeMs,
        lat: latVal,
        lon: lonVal,
        depth: Number.isFinite(depthVal) ? depthVal : null,
        mag: Number.isFinite(magVal) ? magVal : null,
        magType: magType || ''
      });
    }

    return matchEarthquakeCandidate(target, candidates, 'GFZ');
  } catch (err) {
    clearTimeout(timer);
    return {
      matched: false,
      status: 'no_disponible',
      agency: 'GFZ',
      error: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    };
  }
}

/**
 * Consulta coordinada en paralelo hacia las 3 agencias internacionales.
 */
export async function getInternationalComparisons(rawTarget, options = {}) {
  const target = validateTargetEvent(rawTarget);

  const [usgsRes, emscRes, gfzRes] = await Promise.allSettled([
    fetchAndMatchUsgs(target, options),
    fetchAndMatchEmsc(target, options),
    fetchAndMatchGfz(target, options)
  ]);

  const fallback = agency => ({
    matched: false,
    status: 'no_disponible',
    agency
  });

  const usgs = usgsRes.status === 'fulfilled' ? usgsRes.value : fallback('USGS');
  const emsc = emscRes.status === 'fulfilled' ? emscRes.value : fallback('EMSC');
  const gfz = gfzRes.status === 'fulfilled' ? gfzRes.value : fallback('GFZ');

  // Calcular vigencia óptima de caché
  const now = Date.now();
  const eventAgeMs = now - target.time;
  const isRecent = eventAgeMs < 24 * 3600 * 1000;
  const isVeryRecent = eventAgeMs < 2 * 3600 * 1000;

  const anyAvailable = [usgs, emsc, gfz].some(a => a.status !== 'no_disponible');
  const anyMatched = [usgs, emsc, gfz].some(a => a.matched);

  let cacheTtlSeconds = 86400; // 24h por defecto para históricos

  if (!anyAvailable) {
    cacheTtlSeconds = 60; // 1 minuto si todas las agencias fallaron por red
  } else if (isVeryRecent) {
    cacheTtlSeconds = anyMatched ? 1800 : 900; // 30 min si hay match, 15 min si negativa reciente
  } else if (isRecent) {
    cacheTtlSeconds = 3600; // 1 hora para eventos de las últimas 24 horas
  }

  return {
    ok: true,
    agencias: {
      usgs,
      emsc,
      gfz
    },
    meta: {
      cacheTtlSeconds,
      timestamp: new Date().toISOString()
    }
  };
}

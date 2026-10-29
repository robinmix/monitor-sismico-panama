/**
 * sismoPA — Utilidad de Distancia Geodésica y Formato de Notificaciones Sísmicas
 *
 * Implementa cálculo Haversine de alta precisión, truncamiento por privacidad
 * (máx 3 decimales ~110m), resolución de frescura (≤48h 'de ti', >48h/'ZONA' 'de tu zona')
 * y generación estricta de títulos y cuerpos de notificación.
 *
 * Orden estricto de información:
 * 1. Magnitud (ej. M3.5)
 * 2. Distancia personal (ej. 42 km de ti / 42 km de tu zona)
 * 3. Referencia geográfica precisa del GeographicResolver (ej. 60 km al sureste de Soná)
 * 4. Metadatos secundarios (profundidad, hora) si el espacio lo permite.
 */

const EARTH_RADIUS_KM = 6371.0088; // Radio medio de la Tierra WGS84
const FRESH_GPS_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 horas
const MAX_LOCATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

/**
 * Distancia ortodrómica entre dos pares de coordenadas (Haversine).
 * Retorna la distancia en kilómetros (número flotante) o null si las coordenadas son inválidas.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lat1 === undefined ||
      lon1 === null || lon1 === undefined ||
      lat2 === null || lat2 === undefined ||
      lon2 === null || lon2 === undefined) {
    return null;
  }

  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (!Number.isFinite(nLat1) || !Number.isFinite(nLon1) ||
      !Number.isFinite(nLat2) || !Number.isFinite(nLon2)) {
    return null;
  }

  if (Math.abs(nLat1) > 90 || Math.abs(nLat2) > 90 ||
      Math.abs(nLon1) > 180 || Math.abs(nLon2) > 180) {
    return null;
  }

  const dLat = (nLat2 - nLat1) * Math.PI / 180;
  const dLon = (nLon2 - nLon1) * Math.PI / 180;
  const radLat1 = nLat1 * Math.PI / 180;
  const radLat2 = nLat2 * Math.PI / 180;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Trunca coordenadas geográficas a un máximo de 3 decimales (~110m) para proteger la privacidad.
 */
export function truncateCoordinates(lat, lon, decimals = 3) {
  const factor = Math.pow(10, decimals);
  const tLat = (lat !== null && lat !== undefined && Number.isFinite(Number(lat)))
    ? Math.round(Number(lat) * factor) / factor
    : null;
  const tLon = (lon !== null && lon !== undefined && Number.isFinite(Number(lon)))
    ? Math.round(Number(lon) * factor) / factor
    : null;
  return { lat: tLat, lon: tLon };
}

/**
 * Determina el sufijo de cercanía según el origen y frescura de la ubicación:
 * - Modo GPS con antigüedad <= 48h: 'de ti'
 * - Modo ZONA (o GPS con antigüedad > 48h y <= 30d): 'de tu zona'
 * - Antigüedad > 30d o inválido: null (ubicación caducada)
 */
export function getDistanceSuffix(userLocation, now = Date.now()) {
  if (!userLocation || typeof userLocation !== 'object') return null;

  const mode = String(userLocation.modo || userLocation.mode || 'GPS').toUpperCase();
  const rawUpdatedAt = userLocation.actualizada_en || userLocation.updated_at || userLocation.ubicacion_actualizada_en;

  let ageMs = 0;
  if (rawUpdatedAt) {
    const updatedTime = new Date(rawUpdatedAt).getTime();
    if (Number.isFinite(updatedTime)) {
      ageMs = Math.max(0, (typeof now === 'number' ? now : new Date(now).getTime()) - updatedTime);
    } else {
      ageMs = Infinity;
    }
  }

  // Caducidad absoluta tras 30 días
  if (ageMs > MAX_LOCATION_VALIDITY_MS) {
    return null;
  }

  if (mode === 'ZONA') {
    return 'de tu zona';
  }

  if (mode === 'GPS') {
    if (ageMs <= FRESH_GPS_MAX_AGE_MS) {
      return 'de ti';
    }
    // GPS envejecido (> 48h pero <= 30d): degradación suave a 'de tu zona'
    return 'de tu zona';
  }

  return null;
}

/**
 * Formatea una distancia en km con su sufijo correspondiente.
 * Si la distancia redondeada es 0, expresa 'a menos de 1 km [sufijo]'.
 */
export function formatDistanceString(distKm, suffix) {
  if (distKm === null || distKm === undefined || !Number.isFinite(distKm) || !suffix) {
    return null;
  }
  const rounded = Math.round(distKm);
  if (rounded <= 0) {
    return `a menos de 1 km ${suffix}`;
  }
  return `${rounded} km ${suffix}`;
}

/**
 * Formateador integral de notificaciones sísmicas con personalización por distancia.
 *
 * Cumple estrictamente la jerarquía requerida:
 * 1) Con ubicación válida y activa:
 *    - Título: M3.5 · 42 km de ti (o M3.5 · 42 km de tu zona)
 *    - Cuerpo: M3.5 · 42 km de ti · 60 km al sureste de Soná (más profundidad si existe)
 * 2) Sin ubicación / caducada / denegada / desactivada:
 *    - Título: M3.5 · Nuevo sismo
 *    - Cuerpo: M3.5 · 60 km al sureste de Soná (más profundidad si existe)
 */
export function formatSeismicNotification({
  sismo = {},
  userLocation = null,
  now = Date.now(),
  options = {}
} = {}) {
  const rawMag = Number(sismo.magnitud);
  const magStr = Number.isFinite(rawMag) ? `M${rawMag.toFixed(1)}` : 'Sismo';

  const lugar = String(
    sismo.ubicacion_texto || sismo.ubicacion || sismo.lugar || sismo.region || 'Panamá'
  ).trim();

  const profKm = Number(sismo.profundidad_km ?? sismo.profundidad);
  const profStr = Number.isFinite(profKm) && profKm >= 0 ? `${Math.round(profKm)} km prof.` : null;

  // Evaluar personalización por distancia
  let personalizedDistStr = null;
  let distanceKm = null;
  let suffix = null;

  const isPersonalizationActive = userLocation &&
    userLocation.personalizacion_distancia_activa !== false &&
    userLocation.activa !== false;

  if (isPersonalizationActive) {
    const userLat = Number(userLocation.latitud ?? userLocation.lat);
    const userLon = Number(userLocation.longitud ?? userLocation.lon);
    const sismoLat = Number(sismo.latitud ?? sismo.lat);
    const sismoLon = Number(sismo.longitud ?? sismo.lon);

    suffix = getDistanceSuffix(userLocation, now);

    if (suffix && Number.isFinite(userLat) && Number.isFinite(userLon) &&
        Number.isFinite(sismoLat) && Number.isFinite(sismoLon)) {
      const d = haversineKm(userLat, userLon, sismoLat, sismoLon);
      if (d !== null && Number.isFinite(d)) {
        distanceKm = d;
        personalizedDistStr = formatDistanceString(d, suffix);
      }
    }
  }

  let title;
  let body;

  if (personalizedDistStr) {
    // FORMATO PERSONALIZADO:
    // Título: M3.5 · 42 km de ti
    title = `${magStr} · ${personalizedDistStr}`;

    // Cuerpo: M3.5 · 42 km de ti · 60 km al sureste de Soná [· 12 km prof.]
    const bodyParts = [magStr, personalizedDistStr, lugar];
    if (profStr && options.includeDepth !== false) {
      bodyParts.push(profStr);
    }
    body = bodyParts.join(' · ');
  } else {
    // FORMATO GENERAL (FALLBACK SEGURO):
    // Título: M3.5 · Nuevo sismo
    title = `${magStr} · Nuevo sismo`;

    // Cuerpo: M3.5 · 60 km al sureste de Soná [· 12 km prof.]
    const bodyParts = [magStr, lugar];
    if (profStr && options.includeDepth !== false) {
      bodyParts.push(profStr);
    }
    body = bodyParts.join(' · ');
  }

  return {
    title,
    body,
    distance_km: distanceKm,
    distance_formatted: personalizedDistStr,
    suffix,
    is_personalized: Boolean(personalizedDistStr),
    data: {
      source_uid: sismo.source_uid || '',
      magnitud: String(sismo.magnitud || ''),
      latitud: String(sismo.latitud || ''),
      longitud: String(sismo.longitud || ''),
      ubicacion: lugar,
      profundidad: String(sismo.profundidad_km ?? sismo.profundidad ?? '')
    }
  };
}

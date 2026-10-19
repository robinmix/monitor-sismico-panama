/**
 * SismoData Panamá — Utilidades Geodésicas
 * Cálculo de distancia ortodrómica sobre la superficie terrestre mediante la fórmula de Haversine.
 * Radio medio volumétrico terrestre según IUGG / WGS-84: R = 6371.0088 km
 */

const EARTH_RADIUS_KM = 6371.0088;

/**
 * Calcula la distancia en kilómetros entre dos coordenadas geográficas (latitud, longitud).
 * @param {number|string} lat1 Latitud punto 1 en grados decimales
 * @param {number|string} lon1 Longitud punto 1 en grados decimales
 * @param {number|string} lat2 Latitud punto 2 en grados decimales
 * @param {number|string} lon2 Longitud punto 2 en grados decimales
 * @returns {number|null} Distancia en kilómetros o null si los argumentos son inválidos
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (isNaN(nLat1) || isNaN(nLon1) || isNaN(nLat2) || isNaN(nLon2)) return null;

  // Validación de rangos lat [-90, 90] y lon [-180, 180]
  if (nLat1 < -90 || nLat1 > 90 || nLat2 < -90 || nLat2 > 90) return null;
  if (nLon1 < -180 || nLon1 > 180 || nLon2 < -180 || nLon2 > 180) return null;

  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(nLat2 - nLat1);
  const dLon = toRad(nLon2 - nLon1);

  const lat1Rad = toRad(nLat1);
  const lat2Rad = toRad(nLat2);

  const sinDLat2 = Math.sin(dLat / 2);
  const sinDLon2 = Math.sin(dLon / 2);

  const a = sinDLat2 * sinDLat2 +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
            sinDLon2 * sinDLon2;

  // Clampeo numérico para evitar errores de precisión de punto flotante fuera del dominio [0, 1]
  const clampedA = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));

  return EARTH_RADIUS_KM * c;
}

/**
 * Formatea una distancia en kilómetros con 1 decimal.
 * @param {number|null} km Distancia en km
 * @returns {string} Texto formateado ej. "12.4 km" o cadena vacía si es inválido
 */
function formatDistanceKm(km) {
  if (km == null || isNaN(km) || km < 0) return '';
  return `${Number(km).toFixed(1)} km`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EARTH_RADIUS_KM,
    haversineKm,
    formatDistanceKm
  };
}

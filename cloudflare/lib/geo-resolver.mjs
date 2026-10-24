/**
 * @fileoverview GeographicResolver ESM para Cloudflare Pages
 * Motor de resolución y enriquecimiento geográfico sin dependencias de Node.js
 */

import mascara from '../../lib/geo-data/panama-mascara.mjs';
import { provincias } from '../../lib/geo-data/panama-provincias.mjs';
import { distritos } from '../../lib/geo-data/panama-distritos.mjs';
import { corregimientos } from '../../lib/geo-data/panama-corregimientos.mjs';
import { lugares } from '../../lib/geo-data/panama-lugares-poblados.mjs';
import { maritimo } from '../../lib/geo-data/panama-maritimo.mjs';

const R_EARTH_KM = 6371.0088;

export function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInBBox(x, y, bbox) {
  return x >= bbox[0] && y >= bbox[1] && x <= bbox[2] && y <= bbox[3];
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function calculateBearing(epicenterLat, epicenterLon, refLat, refLon) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const y = Math.sin((epicenterLon - refLon) * toRad) * Math.cos(epicenterLat * toRad);
  const x = Math.cos(refLat * toRad) * Math.sin(epicenterLat * toRad) -
            Math.sin(refLat * toRad) * Math.cos(epicenterLat * toRad) * Math.cos((epicenterLon - refLon) * toRad);
  const brng = (Math.atan2(y, x) * toDeg + 360) % 360;
  const sectors = ['al N', 'al NE', 'al E', 'al SE', 'al S', 'al SO', 'al O', 'al NO'];
  const index = Math.round(brng / 45) % 8;
  return sectors[index];
}

export function resolveLocation(latInput, lonInput, igcDescription = '') {
  const lat = typeof latInput === 'number' ? latInput : parseFloat(latInput);
  const lon = typeof lonInput === 'number' ? lonInput : parseFloat(lonInput);

  const baseResult = {
    geo_tipo: 'NO_DETERMINADO',
    geo_pais: null,
    geo_provincia: null,
    geo_comarca: null,
    geo_distrito: null,
    geo_corregimiento: null,
    geo_zona_maritima: null,
    geo_poblado_ref: null,
    geo_distancia_km: null,
    geo_rumbo: null,
    geo_ubicacion_texto: igcDescription || 'Ubicación no determinada',
    geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
    geo_version: 'DPA-2025-v1',
    geo_calidad: 'NO_DETERMINADA'
  };

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    baseResult.geo_ubicacion_texto = 'Coordenadas no válidas';
    return baseResult;
  }

  if (lon < -85.5 || lon > -75.5 || lat < 4.0 || lat > 11.8) {
    baseResult.geo_tipo = 'FUERA_DE_COBERTURA';
    baseResult.geo_ubicacion_texto = 'Fuera del área de monitoreo de Panamá';
    return baseResult;
  }

  let onLand = false;
  let isIsland = false;

  for (const part of mascara.poligonos) {
    if (pointInBBox(lon, lat, part.bbox)) {
      if (pointInPolygon(lon, lat, part.coordinates)) {
        onLand = true;
        isIsland = (part.id !== 0);
        break;
      }
    }
  }

  let nearestPlace = null;
  let minDistance = Infinity;
  for (const l of lugares) {
    const dist = haversineKm(lat, lon, l.lat, l.lon);
    if (dist < minDistance) {
      minDistance = dist;
      nearestPlace = l;
    }
  }

  const distanciaKm = nearestPlace ? Number(minDistance.toFixed(1)) : null;
  const rumbo = nearestPlace ? calculateBearing(lat, lon, nearestPlace.lat, nearestPlace.lon) : null;

  const isCostaRicaBorder = (lon < -82.90 && lat >= 8.03 && lat <= 9.7) ||
                            (lon < -82.80 && lat >= 8.5 && lat <= 9.0 && !onLand);
  const isColombiaBorder = (lon > -77.30 && lat >= 7.0 && lat <= 8.8 && !onLand);

  if (!onLand) {
    if (isCostaRicaBorder) {
      return {
        geo_tipo: 'FRONTERIZO',
        geo_pais: 'Costa Rica',
        geo_provincia: 'Puntarenas (Costa Rica)',
        geo_comarca: null,
        geo_distrito: null,
        geo_corregimiento: null,
        geo_zona_maritima: null,
        geo_poblado_ref: nearestPlace ? nearestPlace.nombre : 'Paso Canoas',
        geo_distancia_km: distanciaKm,
        geo_rumbo: rumbo,
        geo_ubicacion_texto: `Costa Rica (Región Fronteriza · a ${distanciaKm} km ${rumbo} de ${nearestPlace ? nearestPlace.nombre : 'Paso Canoas'})`,
        geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
        geo_version: 'DPA-2025-v1',
        geo_calidad: 'ALTA'
      };
    }

    if (isColombiaBorder) {
      return {
        geo_tipo: 'FRONTERIZO',
        geo_pais: 'Colombia',
        geo_provincia: 'Chocó (Colombia)',
        geo_comarca: null,
        geo_distrito: null,
        geo_corregimiento: null,
        geo_zona_maritima: null,
        geo_poblado_ref: nearestPlace ? nearestPlace.nombre : 'Juradó',
        geo_distancia_km: distanciaKm,
        geo_rumbo: rumbo,
        geo_ubicacion_texto: `Colombia (Región Fronteriza · a ${distanciaKm} km ${rumbo} de ${nearestPlace ? nearestPlace.nombre : 'Juradó'})`,
        geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
        geo_version: 'DPA-2025-v1',
        geo_calidad: 'ALTA'
      };
    }

    let matchedMarine = null;
    for (const zm of maritimo) {
      if (pointInBBox(lon, lat, zm.bbox)) {
        matchedMarine = zm;
        break;
      }
    }
    const zonaMaritimaNombre = matchedMarine ? matchedMarine.nombre : (lat < 8.3 ? 'Océano Pacífico (Zona Económica Exclusiva)' : 'Mar Caribe (Zona Económica Exclusiva)');
    const refText = nearestPlace ? `a ${distanciaKm} km ${rumbo} de ${nearestPlace.nombre}` : 'en mar abierto';

    return {
      geo_tipo: 'MARITIMO',
      geo_pais: null,
      geo_provincia: null,
      geo_comarca: null,
      geo_distrito: null,
      geo_corregimiento: null,
      geo_zona_maritima: zonaMaritimaNombre,
      geo_poblado_ref: nearestPlace ? nearestPlace.nombre : null,
      geo_distancia_km: distanciaKm,
      geo_rumbo: rumbo,
      geo_ubicacion_texto: `${zonaMaritimaNombre} (${refText})`,
      geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
      geo_version: 'DPA-2025-v1',
      geo_calidad: 'ALTA'
    };
  }

  let matchedProv = null;
  for (const prov of provincias) {
    if (pointInBBox(lon, lat, prov.bbox)) {
      for (const poly of prov.coordinates) {
        if (pointInPolygon(lon, lat, poly)) {
          matchedProv = prov;
          break;
        }
      }
      if (matchedProv) break;
    }
  }

  let matchedDist = null;
  if (matchedProv) {
    for (const dist of distritos) {
      if (dist.provincia_id === matchedProv.id && pointInBBox(lon, lat, dist.bbox)) {
        for (const poly of dist.coordinates) {
          if (pointInPolygon(lon, lat, poly)) {
            matchedDist = dist;
            break;
          }
        }
        if (matchedDist) break;
      }
    }
  }

  let matchedCorr = null;
  if (matchedDist) {
    for (const corr of corregimientos) {
      if (corr.distrito_id === matchedDist.id && pointInBBox(lon, lat, corr.bbox)) {
        for (const poly of corr.coordinates) {
          if (pointInPolygon(lon, lat, poly)) {
            matchedCorr = corr;
            break;
          }
        }
        if (matchedCorr) break;
      }
    }
  }

  const provNombre = matchedProv ? matchedProv.nombre : (nearestPlace ? nearestPlace.provincia : 'Panamá');
  const distNombre = matchedDist ? matchedDist.nombre : (nearestPlace ? nearestPlace.distrito : null);
  const corrNombre = matchedCorr ? matchedCorr.nombre : null;
  const isComarca = matchedProv && matchedProv.tipo === 'COMARCA';

  let ubicacionTexto = '';
  if (corrNombre && distNombre) {
    ubicacionTexto = `${corrNombre}, ${distNombre} (${provNombre})`;
  } else if (distNombre) {
    ubicacionTexto = `${distNombre}, ${provNombre}`;
  } else {
    ubicacionTexto = provNombre;
  }

  if (nearestPlace && distanciaKm != null && distanciaKm > 0.5) {
    ubicacionTexto += ` · a ${distanciaKm} km ${rumbo} de ${nearestPlace.nombre}`;
  }

  return {
    geo_tipo: isIsland ? 'INSULAR' : 'TERRESTRE',
    geo_pais: 'Panamá',
    geo_provincia: provNombre,
    geo_comarca: isComarca ? provNombre : null,
    geo_distrito: distNombre,
    geo_corregimiento: corrNombre,
    geo_zona_maritima: null,
    geo_poblado_ref: nearestPlace ? nearestPlace.nombre : null,
    geo_distancia_km: distanciaKm,
    geo_rumbo: rumbo,
    geo_ubicacion_texto: ubicacionTexto,
    geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
    geo_version: 'DPA-2025-v1',
    geo_calidad: matchedCorr ? 'ALTA' : (matchedProv ? 'ESTIMADA' : 'LIMITROFE')
  };
}

export function enrichEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const geo = resolveLocation(event.latitud, event.longitud, event.ubicacion || event.region || '');
  return {
    ...event,
    geo_tipo: geo.geo_tipo,
    geo_pais: geo.geo_pais,
    geo_provincia: geo.geo_provincia,
    geo_comarca: geo.geo_comarca,
    geo_distrito: geo.geo_distrito,
    geo_corregimiento: geo.geo_corregimiento,
    geo_zona_maritima: geo.geo_zona_maritima,
    geo_poblado_ref: geo.geo_poblado_ref,
    geo_distancia_km: geo.geo_distancia_km,
    geo_rumbo: geo.geo_rumbo,
    geo_ubicacion_texto: geo.geo_ubicacion_texto,
    geo_fuente: geo.geo_fuente,
    geo_version: geo.geo_version,
    geo_calidad: geo.geo_calidad
  };
}

export function enrichEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(enrichEvent);
}

export const CARTOGRAPHY_METADATA = {
  fuente: 'Instituto Geográfico Nacional Tommy Guardia / ANATI / INEC / CONVEMAR',
  version: 'DPA-2025-v1',
  fecha: '2026-10-24',
  crs: 'WGS84 / EPSG:4326'
};

export default {
  resolveLocation,
  enrichEvent,
  enrichEvents,
  haversineKm,
  calculateBearing,
  CARTOGRAPHY_METADATA
};

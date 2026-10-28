/**
 * @fileoverview GeographicResolver para sismoPA
 * Motor de resolución y enriquecimiento geográfico de alta precisión
 * basado en la cartografía oficial de la República de Panamá (IGNTG / ANATI DPA-2025, INEC, CONVEMAR).
 *
 * Preserva intactos todos los datos originales del IGC-UP.
 */

'use strict';

const mascara = require('./geo-data/panama-mascara.js');
const { provincias } = require('./geo-data/panama-provincias.js');
const { distritos } = require('./geo-data/panama-distritos.js');
const { corregimientos } = require('./geo-data/panama-corregimientos.js');
const { lugares } = require('./geo-data/panama-lugares-poblados.js');
const { zonas: maritimo } = require('./geo-data/panama-maritimo.js');

const R_EARTH_KM = 6371.0088; // Constante geodésica oficial IUGG

/**
 * Pre-ordenamiento por área de caja envolvente (BBox) para resolución de enclaves:
 * Los distritos y corregimientos más pequeños (ej. San Miguelito dentro de Panamá,
 * Sambú dentro de Chepigana) se evalúan primero para evitar oclusiones topológicas.
 */
const sortedCorregimientos = [...corregimientos].sort((a, b) => {
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return areaA - areaB;
});

const sortedDistritos = [...distritos].sort((a, b) => {
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return areaA - areaB;
});

const sortedProvincias = [...provincias].sort((a, b) => {
  if (a.tipo === 'COMARCA' && b.tipo !== 'COMARCA') return -1;
  if (b.tipo === 'COMARCA' && a.tipo !== 'COMARCA') return 1;
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return areaA - areaB;
});

/**
 * Algoritmo Point-in-Polygon (Ray Casting) para coordenadas en grados decimales
 */
function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Comprobación rápida por caja envolvente (Bounding Box) [minX, minY, maxX, maxY]
 */
function pointInBBox(x, y, bbox) {
  return x >= bbox[0] && y >= bbox[1] && x <= bbox[2] && y <= bbox[3];
}

/**
 * Distancia ortodrómica geodésica mediante Haversine (km)
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Cálculo del rumbo cardinal relativo desde la referencia geográfica hacia el epicentro
 */
function calculateBearing(epicenterLat, epicenterLon, refLat, refLon) {
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

/**
 * Distancia mínima y rumbo desde la costa insular o continental más cercana
 */
function getNearestIslandCoast(lat, lon) {
  let minCoastDist = Infinity;
  let nearestPoly = null;
  let nearestPt = null;

  for (const poly of mascara.poligonos) {
    if (!poly.nombre || poly.id === 0 || poly.toponimia_verificada !== true) continue;
    const margin = 0.35; // ~38 km de margen para pre-filtrado por BBox
    if (lon >= poly.bbox[0] - margin && lon <= poly.bbox[2] + margin &&
        lat >= poly.bbox[1] - margin && lat <= poly.bbox[3] + margin) {
      for (const pt of poly.coordinates) {
        const d = haversineKm(lat, lon, pt[1], pt[0]);
        if (d < minCoastDist) {
          minCoastDist = d;
          nearestPoly = poly;
          nearestPt = pt;
        }
      }
    }
  }

  if (nearestPoly && minCoastDist <= 25) {
    const rumbo = calculateBearing(lat, lon, nearestPt[1], nearestPt[0]);
    return {
      island: nearestPoly.nombre,
      poly: nearestPoly,
      distanceKm: Number(minCoastDist.toFixed(1)),
      rumbo: rumbo,
      nearestPt: nearestPt
    };
  }
  return null;
}

/**
 * Resuelve la ubicación geográfica detallada a partir de coordenadas WGS84
 * @param {number|string} latInput Latitud
 * @param {number|string} lonInput Longitud
 * @param {string} [igcDescription] Descripción original del IGC (opcional)
 * @returns {Object} Clasificación geográfica estructurada
 */
function resolveLocation(latInput, lonInput, igcDescription = '') {
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
    geo_version: 'DPA-2025-v2',
    geo_calidad: 'NO_DETERMINADA'
  };

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    baseResult.geo_ubicacion_texto = 'Coordenadas no válidas';
    return baseResult;
  }

  // Bounding Box general de monitoreo sismoPA: lon [-85.5, -75.5], lat [4.0, 11.8]
  if (lon < -85.5 || lon > -75.5 || lat < 4.0 || lat > 11.8) {
    baseResult.geo_tipo = 'FUERA_DE_COBERTURA';
    baseResult.geo_ubicacion_texto = 'Fuera del área de monitoreo de Panamá';
    return baseResult;
  }

  // 1. Verificar si está en tierra (continental o insular)
  let onLand = false;
  let isIsland = false;
  let matchedIslandPoly = null;

  for (const part of mascara.poligonos) {
    if (pointInBBox(lon, lat, part.bbox)) {
      if (pointInPolygon(lon, lat, part.coordinates)) {
        onLand = true;
        isIsland = (part.id !== 0);
        if (isIsland) matchedIslandPoly = part;
        break;
      }
    }
  }

  // Comprobación de borde costero: si está dentro de un corregimiento o distrito terrestre, considerar onLand
  if (!onLand) {
    for (const c of sortedCorregimientos) {
      if (pointInBBox(lon, lat, c.bbox)) {
        for (const poly of c.coordinates) {
          if (pointInPolygon(lon, lat, poly)) {
            onLand = true;
            break;
          }
        }
        if (onLand) break;
      }
    }
  }

  // 2. Calcular la población / referencia más cercana
  let nearestPlace = null;
  let minDistance = Infinity;
  for (const l of lugares) {
    const dist = haversineKm(lat, lon, l.lat, l.lon);
    if (dist < minDistance) {
      minDistance = dist;
      nearestPlace = l;
    }
  }

  let distanciaKm = nearestPlace ? Number(minDistance.toFixed(1)) : null;
  let rumbo = nearestPlace ? calculateBearing(lat, lon, nearestPlace.lat, nearestPlace.lon) : null;

  // 3. Manejo de zonas fuera de tierra panameña: Marítimo o Frontera
  let isCostaRicaBorder = false;
  if (!onLand) {
    if (lat >= 8.0 && lat < 8.50) {
      isCostaRicaBorder = (lon < -82.87);
    } else if (lat >= 8.50 && lat < 8.65) {
      isCostaRicaBorder = (lon < -82.842);
    } else if (lat >= 8.65 && lat < 9.0) {
      isCostaRicaBorder = (lon < -82.88);
    } else if (lat >= 9.0 && lat <= 9.8) {
      isCostaRicaBorder = (lon < -82.60 && lat > 9.5) || (lon < -82.88);
    } else {
      isCostaRicaBorder = (lon < -82.90 && lat >= 8.03 && lat <= 9.7);
    }
  }

  const isColombiaBorder = (!onLand && lon > -77.30 && lat >= 7.0 && lat <= 8.8);

  if (!onLand) {
    if (isCostaRicaBorder) {
      const crRef = nearestPlace ? nearestPlace.nombre : 'Paso Canoas';
      return {
        geo_tipo: 'FRONTERIZO',
        geo_pais: 'Costa Rica',
        geo_provincia: 'Puntarenas (Costa Rica)',
        geo_comarca: null,
        geo_distrito: null,
        geo_corregimiento: null,
        geo_zona_maritima: null,
        geo_poblado_ref: crRef,
        geo_distancia_km: distanciaKm,
        geo_rumbo: rumbo,
        geo_ubicacion_texto: `Costa Rica (Región Fronteriza · a ${distanciaKm} km ${rumbo} de ${crRef})`,
        geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
        geo_version: 'DPA-2025-v2',
        geo_calidad: 'ALTA'
      };
    }

    if (isColombiaBorder) {
      const colRef = nearestPlace ? nearestPlace.nombre : 'Juradó';
      return {
        geo_tipo: 'FRONTERIZO',
        geo_pais: 'Colombia',
        geo_provincia: 'Chocó (Colombia)',
        geo_comarca: null,
        geo_distrito: null,
        geo_corregimiento: null,
        geo_zona_maritima: null,
        geo_poblado_ref: colRef,
        geo_distancia_km: distanciaKm,
        geo_rumbo: rumbo,
        geo_ubicacion_texto: `Colombia (Región Fronteriza · a ${distanciaKm} km ${rumbo} de ${colRef})`,
        geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
        geo_version: 'DPA-2025-v2',
        geo_calidad: 'ALTA'
      };
    }

    // Identificar zona marítima oficial (CONVEMAR)
    let matchedMarine = null;
    for (const zm of maritimo) {
      if (pointInBBox(lon, lat, zm.bbox)) {
        matchedMarine = zm;
        break;
      }
    }

    // Detección de proximidad insular costera (< 25 km) a islas con toponimia verificada
    const islandCoast = getNearestIslandCoast(lat, lon);
    let pobladoRef = nearestPlace ? nearestPlace.nombre : null;

    if (islandCoast) {
      if (!nearestPlace || islandCoast.distanceKm <= distanciaKm) {
        pobladoRef = islandCoast.island;
        distanciaKm = islandCoast.distanceKm;
        rumbo = islandCoast.rumbo;
      }
    }

    // Regla de distancia máxima para referencias marítimas públicas (<= 100 km)
    // En mar abierto a más de 100 km evitar asociar localidades terrestres distantes
    if (distanciaKm != null && distanciaKm > 100) {
      pobladoRef = null;
    }

    const defaultMar = lat < 8.9 ? 'Océano Pacífico (Zona Económica Exclusiva)' : 'Mar Caribe (Zona Económica Exclusiva)';
    const zonaMaritimaNombre = matchedMarine ? matchedMarine.nombre : defaultMar;
    const refText = pobladoRef ? `a ${distanciaKm} km ${rumbo} de ${pobladoRef}` : 'en mar abierto';

    return {
      geo_tipo: 'MARITIMO',
      geo_pais: null,
      geo_provincia: null,
      geo_comarca: null,
      geo_distrito: null,
      geo_corregimiento: null,
      geo_provincia_ref: matchedMarine && matchedMarine.provincia_ref ? matchedMarine.provincia_ref : (islandCoast && islandCoast.poly.provincia ? islandCoast.poly.provincia : null),
      geo_distrito_ref: matchedMarine && matchedMarine.distrito_ref ? matchedMarine.distrito_ref : (islandCoast && islandCoast.poly.distrito ? islandCoast.poly.distrito : null),
      geo_zona_maritima: zonaMaritimaNombre,
      geo_poblado_ref: pobladoRef,
      geo_distancia_km: distanciaKm,
      geo_rumbo: rumbo,
      geo_ubicacion_texto: `${zonaMaritimaNombre} (${refText})`,
      geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
      geo_version: 'DPA-2025-v2',
      geo_calidad: 'ALTA'
    };
  }

  // 4. Ubicación en tierra: Jerarquía Corregimiento -> Distrito -> Provincia (Enclave Precedence)
  let matchedCorr = null;
  for (const corr of sortedCorregimientos) {
    if (pointInBBox(lon, lat, corr.bbox)) {
      for (const poly of corr.coordinates) {
        if (pointInPolygon(lon, lat, poly)) {
          matchedCorr = corr;
          break;
        }
      }
      if (matchedCorr) break;
    }
  }

  let matchedDist = null;
  if (matchedCorr) {
    matchedDist = distritos.find(d => d.id === matchedCorr.distrito_id) || null;
  }
  if (!matchedDist) {
    for (const dist of sortedDistritos) {
      if (pointInBBox(lon, lat, dist.bbox)) {
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

  let matchedProv = null;
  if (matchedDist) {
    matchedProv = provincias.find(p => p.id === matchedDist.provincia_id) || null;
  }
  if (!matchedProv) {
    for (const prov of sortedProvincias) {
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
  }

  const provNombre = matchedProv ? matchedProv.nombre : (matchedCorr ? matchedCorr.provincia : (nearestPlace ? nearestPlace.provincia : 'Panamá'));
  const distNombre = matchedDist ? matchedDist.nombre : (matchedCorr ? matchedCorr.distrito : (nearestPlace ? nearestPlace.distrito : null));
  const corrNombre = matchedCorr ? matchedCorr.nombre : null;
  const isComarca = (matchedProv && matchedProv.tipo === 'COMARCA') || ['Emberá', 'Guna Yala', 'Ngöbe Buglé', 'Naso Tjër Di'].includes(provNombre);

  // Identificación del nombre insular si es territorio de isla con toponimia verificada
  let islandName = null;
  if (isIsland && matchedIslandPoly && matchedIslandPoly.nombre && matchedIslandPoly.toponimia_verificada === true) {
    islandName = matchedIslandPoly.nombre;
  }

  let pobladoRef = islandName || (nearestPlace ? nearestPlace.nombre : null);

  let ubicacionTexto = '';
  if (isIsland && islandName) {
    if (distNombre && provNombre) {
      ubicacionTexto = `${islandName}, ${distNombre} (${provNombre})`;
    } else {
      ubicacionTexto = `${islandName}, ${provNombre}`;
    }
  } else if (isIsland && !islandName) {
    // Islote menor o territorio insular sin toponimia oficial individualizada:
    // Conservar datos de jurisdicción política sin filtrar identificadores sintéticos
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
  } else if (corrNombre && distNombre) {
    ubicacionTexto = `${corrNombre}, ${distNombre} (${provNombre})`;
  } else if (distNombre) {
    ubicacionTexto = `${distNombre}, ${provNombre}`;
  } else {
    ubicacionTexto = provNombre;
  }

  if (nearestPlace && distanciaKm != null && distanciaKm > 0.5 && !isIsland) {
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
    geo_poblado_ref: pobladoRef,
    geo_distancia_km: distanciaKm,
    geo_rumbo: rumbo,
    geo_ubicacion_texto: ubicacionTexto,
    geo_fuente: 'IGNTG / ANATI / INEC / CONVEMAR',
    geo_version: 'DPA-2025-v2',
    geo_calidad: matchedCorr ? 'ALTA' : (matchedProv ? 'ESTIMADA' : 'LIMITROFE')
  };
}

/**
 * Enriquece un objeto sismo con los atributos calculados sin alterar campos originales
 * @param {Object} event Evento sísmico normalizado
 * @returns {Object} Evento enriquecido
 */
function enrichEvent(event) {
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

/**
 * Enriquecimiento en lote para arrays de sismos
 * @param {Array<Object>} events Lista de sismos
 * @returns {Array<Object>} Lista enriquecida
 */
function enrichEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(enrichEvent);
}

module.exports = {
  resolveLocation,
  enrichEvent,
  enrichEvents,
  haversineKm,
  calculateBearing,
  pointInPolygon,
  pointInBBox,
  CARTOGRAPHY_METADATA: {
    fuente: 'Instituto Geográfico Nacional Tommy Guardia / ANATI / INEC / CONVEMAR',
    version: 'DPA-2025-v2',
    fecha: '2026-10-28',
    crs: 'WGS84 / EPSG:4326'
  }
};

'use strict';

import { enrichEvent, enrichEvents, resolveLocation } from './geo-resolver.mjs';

/**
 * SISMODATA PANAMÁ — API DE CONSULTA HISTÓRICA
 * Función HTTP (Netlify): Consulta analítica y estadística de registros sísmicos en Supabase.
 * Endpoint: /.netlify/functions/historico-sismos
 */

import { createClient } from '@supabase/supabase-js';

const PANAMA_OFFSET_HOURS = -5;
const PANAMA_OFFSET_MS = PANAMA_OFFSET_HOURS * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000; // 60 segundos de caché en memoria de la instancia
const MAX_CACHE_ENTRIES = 100;

// Caché en memoria para optimizar ejecuciones repetidas dentro del ciclo de vida del contenedor
const memoryCache = new Map();

const HEADERS_BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
};

/**
 * Convierte componentes de fecha y hora local de Panamá a fecha UTC.
 */
function panamaToUtc(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - PANAMA_OFFSET_HOURS, minute, second, ms));
}

/**
 * Convierte un timestamp UTC a string de fecha local de Panamá 'YYYY-MM-DD'.
 */
function toPanamaLocalDateStr(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() + PANAMA_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convierte un timestamp UTC a string de mes local de Panamá 'YYYY-MM'.
 */
function toPanamaLocalMonthStr(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() + PANAMA_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Inicializa cliente Supabase en el servidor sin exponer credenciales.
 */
function getSupabaseClient(env = {}) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('Configuración incompleta: SUPABASE_URL o SUPABASE_SECRET_KEY no están definidas en el servidor.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/**
 * Valida y normaliza los parámetros de consulta recibidos.
 */
function parseAndValidateParams(rawParams = {}) {
  const params = {};
  for (const [k, v] of Object.entries(rawParams)) {
    if (v !== undefined && v !== null) {
      params[k.toLowerCase()] = String(v).trim();
    }
  }

  const errors = [];
  const filters = {
    anio: null,
    mes: null,
    desdeISO: null,
    hastaISO: null,
    region: null,
    estado: null,
    min_mag: null,
    max_mag: null,
    min_prof: null,
    max_prof: null,
    page: 1,
    limit: 50,
    order: 'desc',
    include_events: true
  };

  // 1. Paginación
  const rawPage = params.page || params.pagina;
  if (rawPage) {
    const pageNum = Number(rawPage);
    if (!Number.isInteger(pageNum) || pageNum < 1) {
      errors.push('El parámetro página (page/pagina) debe ser un entero mayor o igual a 1.');
    } else {
      filters.page = pageNum;
    }
  }

  const rawLimit = params.limit || params.limite;
  if (rawLimit) {
    const limitNum = Number(rawLimit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 500) {
      errors.push('El parámetro límite (limit/limite) debe ser un entero entre 1 y 500.');
    } else {
      filters.limit = limitNum;
    }
  }

  const rawOrder = (params.order || params.orden || 'desc').toLowerCase();
  if (rawOrder !== 'asc' && rawOrder !== 'desc') {
    errors.push('El parámetro orden (order/orden) debe ser "asc" o "desc".');
  } else {
    filters.order = rawOrder;
  }

  if (params.include_events === 'false' || params.eventos === 'false') {
    filters.include_events = false;
  }

  // 2. Filtros de Fecha: Año y Mes
  const rawAnio = params.anio || params.year;
  if (rawAnio) {
    const aNum = Number(rawAnio);
    if (!Number.isInteger(aNum) || aNum < 1900 || aNum > 2100) {
      errors.push('El parámetro año (anio/year) debe ser un número entero de 4 dígitos entre 1900 y 2100.');
    } else {
      filters.anio = aNum;
    }
  }

  const rawMes = params.mes || params.month;
  if (rawMes) {
    const mNum = Number(rawMes);
    if (!Number.isInteger(mNum) || mNum < 1 || mNum > 12) {
      errors.push('El parámetro mes (mes/month) debe ser un número entero entre 1 y 12.');
    } else {
      filters.mes = mNum;
    }
  }

  // Si se pide mes sin año, asumir año actual en Panamá
  if (filters.mes && !filters.anio) {
    filters.anio = new Date(Date.now() + PANAMA_OFFSET_MS).getUTCFullYear();
  }

  // 3. Rango de Fechas: Desde y Hasta
  const rawDesde = params.desde || params.from;
  const rawHasta = params.hasta || params.to;

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (rawDesde) {
    if (dateRegex.test(rawDesde)) {
      const [y, m, d] = rawDesde.split('-').map(Number);
      const testDate = new Date(Date.UTC(y, m - 1, d));
      if (testDate.getUTCFullYear() !== y || testDate.getUTCMonth() !== m - 1 || testDate.getUTCDate() !== d) {
        errors.push('El parámetro desde contiene una fecha inválida en el calendario.');
      } else {
        filters.desdeISO = panamaToUtc(y, m, d, 0, 0, 0, 0).toISOString();
      }
    } else {
      const parsed = new Date(rawDesde);
      if (isNaN(parsed.getTime())) {
        errors.push('El parámetro desde debe tener el formato YYYY-MM-DD o ISO 8601.');
      } else {
        filters.desdeISO = parsed.toISOString();
      }
    }
  }

  if (rawHasta) {
    if (dateRegex.test(rawHasta)) {
      const [y, m, d] = rawHasta.split('-').map(Number);
      const testDate = new Date(Date.UTC(y, m - 1, d));
      if (testDate.getUTCFullYear() !== y || testDate.getUTCMonth() !== m - 1 || testDate.getUTCDate() !== d) {
        errors.push('El parámetro hasta contiene una fecha inválida en el calendario.');
      } else {
        filters.hastaISO = panamaToUtc(y, m, d, 23, 59, 59, 999).toISOString();
      }
    } else {
      const parsed = new Date(rawHasta);
      if (isNaN(parsed.getTime())) {
        errors.push('El parámetro hasta debe tener el formato YYYY-MM-DD o ISO 8601.');
      } else {
        filters.hastaISO = parsed.toISOString();
      }
    }
  }

  if (filters.desdeISO && filters.hastaISO && filters.desdeISO > filters.hastaISO) {
    errors.push('La fecha inicial (desde) no puede ser posterior a la fecha final (hasta).');
  }

  // Si no se proporcionó desde/hasta pero sí anio/mes, derivar límites de fecha
  if (!filters.desdeISO && !filters.hastaISO) {
    if (filters.anio && filters.mes) {
      const daysInMonth = new Date(Date.UTC(filters.anio, filters.mes, 0)).getUTCDate();
      filters.desdeISO = panamaToUtc(filters.anio, filters.mes, 1, 0, 0, 0, 0).toISOString();
      filters.hastaISO = panamaToUtc(filters.anio, filters.mes, daysInMonth, 23, 59, 59, 999).toISOString();
    } else if (filters.anio) {
      filters.desdeISO = panamaToUtc(filters.anio, 1, 1, 0, 0, 0, 0).toISOString();
      filters.hastaISO = panamaToUtc(filters.anio, 12, 31, 23, 59, 59, 999).toISOString();
    }
  }

  // 4. Región y Estado
  if (params.region) {
    if (params.region.length > 100) {
      errors.push('El filtro de región excede el límite de 100 caracteres.');
    } else {
      filters.region = params.region;
    }
  }

  if (params.estado) {
    filters.estado = params.estado.toUpperCase();
  }

  // 5. Magnitud
  const rawMinMag = params.min_mag;
  if (rawMinMag !== undefined) {
    const num = Number(rawMinMag);
    if (isNaN(num) || num < 0 || num > 10) {
      errors.push('El parámetro min_mag debe ser un número entre 0 y 10.');
    } else {
      filters.min_mag = num;
    }
  }

  const rawMaxMag = params.max_mag;
  if (rawMaxMag !== undefined) {
    const num = Number(rawMaxMag);
    if (isNaN(num) || num < 0 || num > 10) {
      errors.push('El parámetro max_mag debe ser un número entre 0 y 10.');
    } else {
      filters.max_mag = num;
    }
  }

  if (filters.min_mag !== null && filters.max_mag !== null && filters.min_mag > filters.max_mag) {
    errors.push('La magnitud mínima (min_mag) no puede ser mayor que la magnitud máxima (max_mag).');
  }

  // 6. Profundidad
  const rawMinProf = params.min_prof;
  if (rawMinProf !== undefined) {
    const num = Number(rawMinProf);
    if (isNaN(num) || num < 0 || num > 1000) {
      errors.push('El parámetro min_prof debe ser un número no negativo en kilómetros.');
    } else {
      filters.min_prof = num;
    }
  }

  const rawMaxProf = params.max_prof;
  if (rawMaxProf !== undefined) {
    const num = Number(rawMaxProf);
    if (isNaN(num) || num < 0 || num > 1000) {
      errors.push('El parámetro max_prof debe ser un número no negativo en kilómetros.');
    } else {
      filters.max_prof = num;
    }
  }

  if (filters.min_prof !== null && filters.max_prof !== null && filters.min_prof > filters.max_prof) {
    errors.push('La profundidad mínima (min_prof) no puede ser mayor que la profundidad máxima (max_prof).');
  }

  return { isValid: errors.length === 0, errors, filters };
}

/**
 * Aplica los filtros validados a una consulta de Supabase.
 */
function applyFiltersToQuery(query, filters) {
  let q = query;
  if (filters.desdeISO) {
    q = q.gte('fecha_hora', filters.desdeISO);
  }
  if (filters.hastaISO) {
    q = q.lte('fecha_hora', filters.hastaISO);
  }
  if (filters.region) {
    q = q.ilike('region', `%${filters.region}%`);
  }
  if (filters.estado) {
    q = q.eq('estado', filters.estado);
  }
  if (filters.min_mag != null) {
    q = q.gte('magnitud', filters.min_mag);
  }
  if (filters.max_mag != null) {
    q = q.lte('magnitud', filters.max_mag);
  }
  if (filters.min_prof != null) {
    q = q.gte('profundidad_km', filters.min_prof);
  }
  if (filters.max_prof != null) {
    q = q.lte('profundidad_km', filters.max_prof);
  }
  return q;
}

/**
 * Calcula el resumen estadístico exhaustivo sobre todos los registros coincidentes.
 * Agrupación por magnitudes sin solapamientos:
 * - menor_3: M < 3.0
 * - entre_3_y_3_9: 3.0 <= M < 4.0
 * - entre_4_y_4_9: 4.0 <= M < 5.0
 * - mayor_igual_5: M >= 5.0
 */
function calculateStatistics(rows) {
  if (!rows || rows.length === 0) {
    return {
      total: 0,
      menor_3: 0,
      entre_3_y_3_9: 0,
      entre_4_y_4_9: 0,
      mayor_igual_5: 0,
      mag_max: null,
      mag_min: null,
      mag_promedio: null,
      prof_promedio: null,
      por_magnitud: {
        menor_3: 0,
        entre_3_y_3_9: 0,
        entre_4_y_4_9: 0,
        mayor_igual_5: 0
      },
      magnitud: {
        max: null,
        min: null,
        promedio: null
      },
      profundidad: {
        promedio_km: null,
        min_km: null,
        max_km: null
      },
      distribucion_mensual: {},
      distribucion_diaria: {},
      por_region: {}
    };
  }

  let countMenor3 = 0;
  let count3a39 = 0;
  let count4a49 = 0;
  let countMayorIgual5 = 0;

  let magSum = 0;
  let magCount = 0;
  let magMax = -Infinity;
  let magMin = Infinity;

  let profSum = 0;
  let profCount = 0;
  let profMax = -Infinity;
  let profMin = Infinity;

  const distribucionMensual = {};
  const distribucionDiaria = {};
  const regionCounts = {};

  for (const r of rows) {
    const mag = Number(r.magnitud);
    if (!isNaN(mag)) {
      magSum += mag;
      magCount++;
      if (mag > magMax) magMax = mag;
      if (mag < magMin) magMin = mag;

      if (mag < 3.0) {
        countMenor3++;
      } else if (mag < 4.0) {
        count3a39++;
      } else if (mag < 5.0) {
        count4a49++;
      } else {
        countMayorIgual5++;
      }
    }

    const rawProf = r.profundidad_km !== undefined ? r.profundidad_km : r.profundidad;
    const prof = Number(rawProf);
    if (!isNaN(prof) && prof >= 0) {
      profSum += prof;
      profCount++;
      if (prof > profMax) profMax = prof;
      if (prof < profMin) profMin = prof;
    }

    if (r.fecha_hora) {
      const mesStr = toPanamaLocalMonthStr(r.fecha_hora);
      if (mesStr) {
        distribucionMensual[mesStr] = (distribucionMensual[mesStr] || 0) + 1;
      }
      const diaStr = toPanamaLocalDateStr(r.fecha_hora);
      if (diaStr) {
        distribucionDiaria[diaStr] = (distribucionDiaria[diaStr] || 0) + 1;
      }
    }

    let regKey = (r.region || 'Sin especificar').trim();
    if (r.latitud != null && r.longitud != null && !isNaN(Number(r.latitud)) && !isNaN(Number(r.longitud))) {
      const geo = r.geo_provincia ? r : resolveLocation(r.latitud, r.longitud);
      if (geo.geo_tipo === 'MARITIMO') {
        regKey = geo.geo_zona_maritima ? 'Marítimo (' + geo.geo_zona_maritima + ')' : 'Marítimo (ZEE)';
      } else if (geo.geo_tipo === 'FRONTERIZO') {
        regKey = geo.geo_provincia || 'Región Fronteriza';
      } else if (geo.geo_provincia) {
        regKey = geo.geo_provincia;
      }
    }
    if (regKey) {
      regionCounts[regKey] = (regionCounts[regKey] || 0) + 1;
    }
  }

  // Ordenar regiones por frecuencia descendente
  const sortedRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1])
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

  // Ordenar distribuciones cronológicamente ascendente
  const sortedMensual = Object.keys(distribucionMensual).sort().reduce((acc, k) => {
    acc[k] = distribucionMensual[k];
    return acc;
  }, {});

  const sortedDiaria = Object.keys(distribucionDiaria).sort().reduce((acc, k) => {
    acc[k] = distribucionDiaria[k];
    return acc;
  }, {});

  const magPromedio = magCount > 0 ? Number((magSum / magCount).toFixed(2)) : null;
  const profPromedio = profCount > 0 ? Number((profSum / profCount).toFixed(2)) : null;
  const magMaxVal = magMax !== -Infinity ? Number(magMax.toFixed(1)) : null;
  const magMinVal = magMin !== Infinity ? Number(magMin.toFixed(1)) : null;
  const profMinVal = profMin !== Infinity ? Number(profMin.toFixed(1)) : null;
  const profMaxVal = profMax !== -Infinity ? Number(profMax.toFixed(1)) : null;

  return {
    total: rows.length,
    menor_3: countMenor3,
    entre_3_y_3_9: count3a39,
    entre_4_y_4_9: count4a49,
    mayor_igual_5: countMayorIgual5,
    mag_max: magMaxVal,
    mag_min: magMinVal,
    mag_promedio: magPromedio,
    prof_promedio: profPromedio,
    por_magnitud: {
      menor_3: countMenor3,
      entre_3_y_3_9: count3a39,
      entre_4_y_4_9: count4a49,
      mayor_igual_5: countMayorIgual5
    },
    magnitud: {
      max: magMaxVal,
      min: magMinVal,
      promedio: magPromedio
    },
    profundidad: {
      promedio_km: profPromedio,
      min_km: profMinVal,
      max_km: profMaxVal
    },
    distribucion_mensual: sortedMensual,
    distribucion_diaria: sortedDiaria,
    por_region: sortedRegions
  };
}

/**
 * Ejecuta la consulta analítica completa en Supabase.
 */
async function queryHistoricalSeismicData(filters, supabase) {
  // 1. Obtener conteo exacto de registros que coinciden con los filtros
  let countQuery = supabase
    .from('sismos')
    .select('*', { count: 'exact', head: true });
  countQuery = applyFiltersToQuery(countQuery, filters);

  const { count: totalCount, error: countErr } = await countQuery;
  if (countErr) {
    throw new Error(`Error consultando total en Supabase: ${countErr.message}`);
  }

  const total = totalCount || 0;

  // 2. Obtener proyección ligera de TODOS los registros coincidentes para estadísticas globales
  const CHUNK_SIZE = 1000;
  const statsRows = [];

  if (total > 0) {
    for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
      let statsQuery = supabase
        .from('sismos')
        .select('magnitud, profundidad_km, fecha_hora, region, latitud, longitud');
      statsQuery = applyFiltersToQuery(statsQuery, filters);
      statsQuery = statsQuery.range(offset, offset + CHUNK_SIZE - 1);

      const { data: chunk, error: statsErr } = await statsQuery;
      if (statsErr) {
        throw new Error(`Error obteniendo registros estadísticos en Supabase: ${statsErr.message}`);
      }
      if (chunk && chunk.length > 0) {
        statsRows.push(...chunk);
      }
      if (!chunk || chunk.length < CHUNK_SIZE) break;
    }
  }

  const estadisticas = calculateStatistics(statsRows);

  // 3. Paginación de registros completos
  let eventos = [];
  const totalPaginas = total > 0 ? Math.ceil(total / filters.limit) : 0;

  if (filters.include_events && total > 0 && filters.page <= totalPaginas) {
    const offset = (filters.page - 1) * filters.limit;
    let eventsQuery = supabase
      .from('sismos')
      .select('id, source_uid, source_event_id, fecha_hora, magnitud, profundidad_km, latitud, longitud, region, ubicacion, estado, fuente, primera_captura, ultima_verificacion, actualizado_en');
    eventsQuery = applyFiltersToQuery(eventsQuery, filters);
    eventsQuery = eventsQuery
      .order('fecha_hora', { ascending: filters.order === 'asc' })
      .range(offset, offset + filters.limit - 1);

    const { data: eventsData, error: eventsErr } = await eventsQuery;
    if (eventsErr) {
      throw new Error(`Error obteniendo eventos paginados en Supabase: ${eventsErr.message}`);
    }
    eventos = enrichEvents(eventsData || []);
  }

  return {
    filtros_aplicados: {
      anio: filters.anio,
      mes: filters.mes,
      desde: filters.desdeISO,
      hasta: filters.hastaISO,
      region: filters.region,
      estado: filters.estado,
      min_mag: filters.min_mag,
      max_mag: filters.max_mag,
      min_prof: filters.min_prof,
      max_prof: filters.max_prof,
      orden: filters.order
    },
    estadisticas,
    paginacion: {
      pagina_actual: filters.page,
      limite: filters.limit,
      total_registros: total,
      total_paginas: totalPaginas,
      tiene_siguiente: filters.page < totalPaginas,
      tiene_anterior: filters.page > 1
    },
    eventos
  };
}

/**
 * Handler principal HTTP de Netlify Function.
 */
const handler = async function(event, context, options = {}) {
  // Manejo de preflight CORS
  if (event && event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: HEADERS_BASE,
      body: ''
    };
  }

  // Permitir únicamente método GET
  if (event && event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Método no permitido. Este endpoint solo admite solicitudes GET u OPTIONS.'
      }, null, 2)
    };
  }

  const queryParams = (event && event.queryStringParameters) || {};

  // 1. Validación de parámetros de entrada
  const { isValid, errors, filters } = parseAndValidateParams(queryParams);
  if (!isValid) {
    return {
      statusCode: 400,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Parámetros de consulta inválidos.',
        detalles: errors
      }, null, 2)
    };
  }

  // 2. Caché en memoria para solicitudes idénticas
  const cacheKey = JSON.stringify(filters);
  const cached = memoryCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS) && !options.noCache) {
    return {
      statusCode: 200,
      headers: {
        ...HEADERS_BASE,
        'X-Cache': 'HIT'
      },
      body: JSON.stringify({
        ok: true,
        origen_datos: 'cache',
        consultado_en: new Date(cached.timestamp).toISOString(),
        ...cached.data
      }, null, 2)
    };
  }

  // 3. Ejecución de consulta en Supabase
  try {
    const supabase = options.supabase || getSupabaseClient(options.env);
    const result = await queryHistoricalSeismicData(filters, supabase);

    // Guardar en caché LRU básica
    if (memoryCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }
    memoryCache.set(cacheKey, { timestamp: Date.now(), data: result });

    return {
      statusCode: 200,
      headers: {
        ...HEADERS_BASE,
        'X-Cache': 'MISS'
      },
      body: JSON.stringify({
        ok: true,
        origen_datos: 'supabase',
        consultado_en: new Date().toISOString(),
        ...result
      }, null, 2)
    };
  } catch (err) {
    console.error(`[API Histórico Sismos] ERROR: ${err.message}`);
    return {
      statusCode: 500,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Ocurrió un error al consultar el historial sísmico. Por favor intente más tarde.',
        momento: new Date().toISOString()
      }, null, 2)
    };
  }
};

export { handler, parseAndValidateParams, calculateStatistics, applyFiltersToQuery, queryHistoricalSeismicData, panamaToUtc, toPanamaLocalDateStr, toPanamaLocalMonthStr, memoryCache };

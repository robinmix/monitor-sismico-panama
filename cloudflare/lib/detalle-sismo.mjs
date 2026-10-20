'use strict';

/**
 * SISMODATA PANAMÁ — CONSULTA DE DETALLE INDIVIDUAL DE SISMO
 * Función HTTP (Netlify): Recupera un evento sísmico específico desde Supabase
 * utilizando su identificador estable (source_uid, source_event_id o ID numérico).
 * Endpoint: /.netlify/functions/detalle-sismo?id=IDENTIFICADOR
 */

import { createClient } from '@supabase/supabase-js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos de caché para eventos individuales inmutables
const MAX_CACHE_ENTRIES = 200;
const memoryCache = new Map();

const HEADERS_BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400'
};

/**
 * Inicializa cliente Supabase en el servidor.
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
 * Valida y desinfecta el identificador del evento.
 */
function sanitizeIdentifier(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return null;
  // Permitir caracteres válidos para UIDs ISO, IGC y numéricos
  if (!/^[a-zA-Z0-9_\-\.:+%]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Handler HTTP principal.
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

  // Permitir únicamente GET
  if (event && event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Método no permitido. Solo se admite GET u OPTIONS.'
      }, null, 2)
    };
  }

  const queryParams = (event && event.queryStringParameters) || {};
  const rawId = queryParams.id || queryParams.uid || queryParams.source_uid;
  const cleanId = sanitizeIdentifier(rawId);

  if (!cleanId) {
    return {
      statusCode: 400,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Parámetro "id" requerido o con formato inválido.'
      }, null, 2)
    };
  }

  // Comprobar caché en memoria
  const cached = memoryCache.get(cleanId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS) && !options.noCache) {
    return {
      statusCode: 200,
      headers: { ...HEADERS_BASE, 'X-Cache': 'HIT' },
      body: JSON.stringify({
        ok: true,
        origen: 'cache',
        evento: cached.data
      }, null, 2)
    };
  }

  try {
    const supabase = options.supabase || getSupabaseClient(options.env);

    // Consulta priorizada: source_uid -> source_event_id -> id numérico
    let query = supabase
      .from('sismos')
      .select('id, source_uid, source_event_id, fecha_hora, magnitud, profundidad_km, latitud, longitud, region, ubicacion, estado, fuente, datos_originales, primera_captura, ultima_verificacion, actualizado_en');

    const isNumeric = /^\d+$/.test(cleanId);
    if (isNumeric) {
      query = query.or(`source_uid.eq.${cleanId},id.eq.${cleanId}`);
    } else {
      query = query.or(`source_uid.eq.${cleanId},source_event_id.eq.${cleanId}`);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new Error(`Error en consulta de base de datos: ${error.message}`);
    }

    if (!data) {
      return {
        statusCode: 404,
        headers: HEADERS_BASE,
        body: JSON.stringify({
          ok: false,
          error: 'Evento sísmico no encontrado en el archivo histórico.'
        }, null, 2)
      };
    }

    // Normalizar campos públicos
    const publicEvent = {
      id: data.id,
      source_uid: data.source_uid,
      source_event_id: data.source_event_id,
      fecha_hora: data.fecha_hora,
      timestamp: data.fecha_hora,
      magnitud: Number(data.magnitud),
      profundidad: Number(data.profundidad_km),
      profundidad_km: Number(data.profundidad_km),
      latitud: Number(data.latitud),
      longitud: Number(data.longitud),
      region: data.region,
      ubicacion: data.ubicacion,
      zona: data.datos_originales?.zona || data.ubicacion || data.region,
      localidad: data.datos_originales?.localidad || data.ubicacion || 'Sin localidad especificada',
      estado: data.estado,
      fuente: data.fuente || 'IGC-UP',
      detalle: data.datos_originales?.detalle || null,
      primera_captura: data.primera_captura,
      actualizado_en: data.actualizado_en
    };

    // Guardar en caché LRU
    if (memoryCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }
    memoryCache.set(cleanId, { timestamp: Date.now(), data: publicEvent });

    return {
      statusCode: 200,
      headers: { ...HEADERS_BASE, 'X-Cache': 'MISS' },
      body: JSON.stringify({
        ok: true,
        origen: 'supabase',
        evento: publicEvent
      }, null, 2)
    };
  } catch (err) {
    console.error(`[Detalle Sismo API] ERROR: ${err.message}`);
    return {
      statusCode: 500,
      headers: HEADERS_BASE,
      body: JSON.stringify({
        ok: false,
        error: 'Error interno consultando el detalle del evento.'
      }, null, 2)
    };
  }
};

export { handler, sanitizeIdentifier, memoryCache };

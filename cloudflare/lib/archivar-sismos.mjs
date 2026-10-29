'use strict';

/**
 * SISMODATA PANAMÁ — ARCHIVADO SÍSMICO HISTÓRICO
 * Scheduled Function (Netlify): Ingesta periódica cada 30 minutos (horario UTC).
 * Fuente exclusiva: Instituto de Geociencias, Universidad de Panamá (IGC-UP).
 * Destino: Supabase PostgreSQL (tabla public.sismos).
 */

import { createClient } from '@supabase/supabase-js';
import { requestSource, dateFromLocal, classifyRegion } from './sismos.mjs';
import { resolveLocation } from './geo-resolver.mjs';
import { sendWebPush } from './web-push.mjs';
import { formatSeismicNotification } from './distance-formatter.mjs';

const CRON_SCHEDULE = '*/30 * * * *';
const FUENTE_NOMBRE = 'IGC-UP';
const TIMEOUT_GLOBAL_MS = 25000; // Límite de seguridad interior a los 30s de Netlify
const DISTANCIA_UMBRAL_MISMO_EVENTO_KM = 35; // Distancia máxima para considerar soluciones del mismo sismo

/**
 * Distancia ortodrómica aproximada entre dos puntos en km (Haversine).
 */
function geoDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Genera un identificador de origen determinista y estable.
 * Para eventos estándar: igc_${timestamp}.
 * Para eventos simultáneos distantes (> 35 km) en el mismo segundo:
 * incorpora un cuadrante geográfico de 1 grado para diferenciarlos sin colisión.
 */
function generateSourceUid(timestamp, latitud, longitud, isDistantSimultaneous = false) {
  if (!isDistantSimultaneous) {
    return `igc_${timestamp}`;
  }
  const latQuad = Math.floor(latitud);
  const lonQuad = Math.floor(longitud);
  return `igc_${timestamp}_lat${latQuad}_lon${lonQuad}`;
}

/**
 * Normaliza y valida los eventos crudos del IGC-UP.
 * - Si coexisten filas del mismo evento en el mismo segundo (< 35 km, ej. PRELIMINAR y REVISADO),
 *   las consolida priorizando la solución revisada.
 * - Si coexisten dos sismos distantes (>= 35 km) en el mismo segundo, los conserva como
 *   eventos independientes y genera una incidencia de conciliación técnica.
 */
function normalizeEvents(rawEvents) {
  const valid = [];
  let descartados = 0;

  for (const item of rawEvents) {
    if (!item) {
      descartados++;
      continue;
    }

    const lat = Number(item.latitud);
    const lon = Number(item.longitud);
    const mag = Number(item.magnitud);
    const prof = Number(item.profundidad);
    const fecha = String(item.fecha || '').trim();
    const hora = String(item.hora || '').trim();
    const timestamp = item.timestamp || dateFromLocal(fecha, hora);
    const region = String(item.region || '').trim();

    // Validaciones estrictas de rangos geofísicos y temporales
    if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) {
      descartados++;
      continue;
    }
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
      descartados++;
      continue;
    }
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
      descartados++;
      continue;
    }
    if (!Number.isFinite(mag) || mag < -2.0 || mag > 10.0) {
      descartados++;
      continue;
    }
    if (!Number.isFinite(prof) || prof < 0) {
      descartados++;
      continue;
    }
    if (!region) {
      descartados++;
      continue;
    }

    const location = (item.zona && item.localidad)
      ? { zona: item.zona, localidad: item.localidad }
      : classifyRegion(region);

    const estado = String(item.estado || 'PRELIMINAR').toUpperCase().trim();

    valid.push({
      fecha,
      hora,
      timestamp,
      latitud: lat,
      longitud: lon,
      profundidad: prof,
      magnitud: mag,
      region,
      zona: location.zona,
      localidad: location.localidad,
      estado,
      detalle: item.detalle || null
    });
  }

  // Agrupar eventos por marca de tiempo exacta
  const byTimestamp = new Map();
  for (const ev of valid) {
    const list = byTimestamp.get(ev.timestamp) || [];
    list.push(ev);
    byTimestamp.set(ev.timestamp, list);
  }

  const normalized = [];

  for (const [timestamp, cluster] of byTimestamp.entries()) {
    if (cluster.length === 1) {
      const e = cluster[0];
      const uid = generateSourceUid(timestamp, e.latitud, e.longitud, false);
      normalized.push(buildNormalizedRecord(e, uid));
      continue;
    }

    // Si existen 2 o más filas con la misma marca de tiempo:
    // Agrupar por proximidad geográfica (< 35 km)
    const subgroups = [];
    for (const ev of cluster) {
      let matchedGroup = null;
      for (const group of subgroups) {
        const lead = group[0];
        if (geoDistanceKm(lead.latitud, lead.longitud, ev.latitud, ev.longitud) < DISTANCIA_UMBRAL_MISMO_EVENTO_KM) {
          matchedGroup = group;
          break;
        }
      }
      if (matchedGroup) {
        matchedGroup.push(ev);
      } else {
        subgroups.push([ev]);
      }
    }

    const hayEventosDistantes = subgroups.length > 1;

    for (const group of subgroups) {
      // Si hay varias filas en el mismo cluster local, consolidar:
      // Priorizar REVISADO sobre PRELIMINAR; si empatan en estado, mayor magnitud
      group.sort((a, b) => {
        const aRev = a.estado === 'REVISADO' ? 1 : 0;
        const bRev = b.estado === 'REVISADO' ? 1 : 0;
        if (aRev !== bRev) return bRev - aRev;
        return b.magnitud - a.magnitud;
      });

      const best = group[0];
      const uid = generateSourceUid(timestamp, best.latitud, best.longitud, hayEventosDistantes);

      let incidencia = null;
      if (hayEventosDistantes) {
        // Hallar distancia al otro evento simultáneo para documentar la incidencia
        const otroLead = subgroups.find(g => g !== group)[0];
        const distKm = Math.round(geoDistanceKm(best.latitud, best.longitud, otroLead.latitud, otroLead.longitud));
        incidencia = {
          tipo: 'SIMULTANEO_DISTANTE',
          descripcion: `Sismo simultáneo detectado a ${distKm}km de otro evento en el mismo segundo. Conservado como evento independiente sin sobrescritura.`,
          distancia_aprox_km: distKm,
          referencia_paralela: otroLead.region
        };
        console.warn(`[Archivado Sismos] INCIDENCIA DE CONCILIACIÓN: Sismos simultáneos detectados en timestamp ${timestamp} a ${distKm}km (${best.region} vs ${otroLead.region}). Preservados independientemente.`);
      }

      normalized.push(buildNormalizedRecord(best, uid, incidencia));
    }
  }

  return { normalized, descartados };
}

/**
 * Construye el objeto final para la tabla public.sismos
 */
function buildNormalizedRecord(ev, sourceUid, incidencia = null) {
  const safeTimeId = ev.hora.replace(/[^0-9A-Za-z]/g, '');
  const sourceEventId = `IGC-${ev.fecha.replace(/-/g, '')}-${safeTimeId}`;

  const datosOriginales = {
    estado_fuente: ev.estado,
    fecha_fuente: ev.fecha,
    hora_fuente: ev.hora,
    zona_horaria: 'America/Panama',
    profundidad_texto: `${ev.profundidad} km`,
    localidad: ev.localidad,
    zona: ev.zona,
    region_texto: ev.region,
    url_detalle: ev.detalle || null
  };

  if (incidencia) {
    datosOriginales.incidencia_conciliacion = incidencia;
  }

  return {
    source_uid: sourceUid,
    source_event_id: sourceEventId,
    fecha_hora: ev.timestamp,
    magnitud: Number(ev.magnitud.toFixed(1)),
    profundidad_km: Number(ev.profundidad),
    latitud: Number(ev.latitud.toFixed(5)),
    longitud: Number(ev.longitud.toFixed(5)),
    region: ev.zona || 'Sin clasificar',
    ubicacion: ev.region,
    estado: ev.estado,
    fuente: FUENTE_NOMBRE,
    datos_originales: datosOriginales
  };
}

/**
 * Inicializa el cliente Supabase usando exclusivamente credenciales del entorno del servidor.
 * La clave secreta se usa estrictamente para la conexión del servidor a la base de datos.
 */
function getSupabaseClient(env = {}) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Configuración incompleta: SUPABASE_URL o SUPABASE_SECRET_KEY no están definidas en las variables de entorno.');
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/**
 * Sincroniza los eventos normalizados con Supabase mediante operaciones idempotentes.
 * - Compara contra registros existentes por source_uid y fecha_hora.
 * - Si un evento existente a menos de 35 km tiene un source_uid previo, lo conserva
 *   asegurando que el identificador no cambie si la segunda fila desaparece en la fuente.
 * - Preserva primera_captura en actualizaciones y actualiza ultima_verificacion.
 */
async function syncEventsToSupabase(records, supabase, now = new Date()) {
  if (!records || !records.length) {
    return { nuevos: 0, actualizados: 0, verificados: 0, total: 0, subrequests: 0 };
  }
  let syncSubrequests = 0;

  const nowISO = now.toISOString();
  const sourceUids = records.map(r => r.source_uid);
  const fechasHoras = [...new Set(records.map(r => r.fecha_hora))];

  const existingMapByUid = new Map();
  const existingListByTime = new Map();

  // Consultar registros existentes en lotes de 200
  const CHUNK_QUERY = 200;
  for (let i = 0; i < sourceUids.length; i += CHUNK_QUERY) {
    const sliceUids = sourceUids.slice(i, i + CHUNK_QUERY);
    syncSubrequests++;
    const { data, error } = await supabase
      .from('sismos')
      .select('source_uid, fecha_hora, primera_captura, actualizado_en, magnitud, profundidad_km, latitud, longitud, estado')
      .in('source_uid', sliceUids);

    if (error) {
      throw new Error(`Fallo consultando registros por UID en Supabase: ${error.message}`);
    }
    if (data) {
      for (const row of data) {
        existingMapByUid.set(row.source_uid, row);
      }
    }
  }

  // Consultar también por fecha_hora para detectar conciliaciones de eventos que pudiesen haber tenido UID canónico
  for (let i = 0; i < fechasHoras.length; i += CHUNK_QUERY) {
    const sliceTimes = fechasHoras.slice(i, i + CHUNK_QUERY);
    syncSubrequests++;
    const { data, error } = await supabase
      .from('sismos')
      .select('source_uid, fecha_hora, primera_captura, actualizado_en, magnitud, profundidad_km, latitud, longitud, estado')
      .in('fecha_hora', sliceTimes);

    if (error) {
      throw new Error(`Fallo consultando registros por fecha_hora en Supabase: ${error.message}`);
    }
    if (data) {
      for (const row of data) {
        const list = existingListByTime.get(row.fecha_hora) || [];
        list.push(row);
        existingListByTime.set(row.fecha_hora, list);
      }
    }
  }

  const payloads = [];
  let nuevosCount = 0;
  const nuevosRecords = [];
  let actualizadosCount = 0;
  let verificadosCount = 0;

  for (const r of records) {
    let existing = existingMapByUid.get(r.source_uid);

    // Si no hubo coincidencia directa por source_uid, verificar si en la base de datos
    // ya existe un registro con la misma fecha_hora a menos de 35 km (mismo evento físico)
    if (!existing && existingListByTime.has(r.fecha_hora)) {
      const candidates = existingListByTime.get(r.fecha_hora);
      for (const cand of candidates) {
        if (geoDistanceKm(cand.latitud, cand.longitud, r.latitud, r.longitud) < DISTANCIA_UMBRAL_MISMO_EVENTO_KM) {
          existing = cand;
          // Adoptar el source_uid ya existente en la base de datos para no duplicar
          r.source_uid = cand.source_uid;
          break;
        }
      }
    }

    if (!existing) {
      // Evento nuevo
      r.primera_captura = nowISO;
      payloads.push({
        ...r,
        primera_captura: nowISO,
        actualizado_en: nowISO,
        ultima_verificacion: nowISO
      });
      nuevosCount++;
      nuevosRecords.push(r);
    } else {
      r.primera_captura = existing.primera_captura || nowISO;
      // Evento existente: evaluar si hubo revisión de magnitud, profundidad, estado o coordenadas
      const cambioMagnitud = Math.abs(Number(existing.magnitud) - Number(r.magnitud)) > 0.01;
      const cambioProfundidad = Math.abs(Number(existing.profundidad_km) - Number(r.profundidad_km)) > 0.1;
      const cambioEstado = String(existing.estado).toUpperCase() !== String(r.estado).toUpperCase();
      const cambioLat = Math.abs(Number(existing.latitud) - Number(r.latitud)) > 0.0001;
      const cambioLon = Math.abs(Number(existing.longitud) - Number(r.longitud)) > 0.0001;
      const fueModificado = cambioMagnitud || cambioProfundidad || cambioEstado || cambioLat || cambioLon;

      if (fueModificado) {
        payloads.push({
          ...r,
          primera_captura: existing.primera_captura || nowISO,
          actualizado_en: nowISO,
          ultima_verificacion: nowISO
        });
        actualizadosCount++;
      } else {
        payloads.push({
          ...r,
          primera_captura: existing.primera_captura || nowISO,
          actualizado_en: existing.actualizado_en || nowISO,
          ultima_verificacion: nowISO
        });
        verificadosCount++;
      }
    }
  }

  // Guardar en Supabase mediante UPSERT en lotes de 100
  const CHUNK_UPSERT = 100;
  for (let i = 0; i < payloads.length; i += CHUNK_UPSERT) {
    const chunk = payloads.slice(i, i + CHUNK_UPSERT);
    syncSubrequests++;
    const { error: upsertError } = await supabase
      .from('sismos')
      .upsert(chunk, { onConflict: 'source_uid' });

    if (upsertError) {
      console.error(`[Archivado Sismos] ERROR de almacenamiento en Supabase (lote ${Math.floor(i / CHUNK_UPSERT) + 1}): ${upsertError.message}`);
      throw new Error(`Fallo guardando lote en Supabase: ${upsertError.message}`);
    }
  }

  // Confirmar registro únicamente tras escritura exitosa en Supabase
  console.log(`[Archivado Sismos] Escritura confirmada en Supabase: ${payloads.length} registros procesados exitosamente.`);
  console.log(`[Archivado Sismos] Desglose confirmado: Registros nuevos: ${nuevosCount} | Registros actualizados: ${actualizadosCount} | Registros verificados sin modificaciones: ${verificadosCount}`);

  return {
    nuevos: nuevosCount,
    nuevosRecords,
    actualizados: actualizadosCount,
    verificados: verificadosCount,
    total: payloads.length,
    subrequests: syncSubrequests
  };
}

/**
 * Ejecuta el ciclo completo de archivado garantizando no exceder el límite de tiempo de Netlify.
 */
async function runArchival(options = {}) {
  const startTime = Date.now();
  const now = options.now || new Date();
  const nowISO = now.toISOString();

  console.log(`[Archivado Sismos] Inicio de archivado: ${nowISO}`);

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`Tiempo límite de ejecución superado (${TIMEOUT_GLOBAL_MS}ms)`)), TIMEOUT_GLOBAL_MS);
    if (timerId && typeof timerId.unref === 'function') timerId.unref();
  });

  const archivalPromise = (async () => {
    // 1. Obtener eventos de la fuente oficial IGC-UP
    const sourcePayload = options.sourcePayload || (options.env && options.env.sourcePayload) || await requestSource();
    if (!sourcePayload || !Array.isArray(sourcePayload.eventos) || sourcePayload.eventos.length === 0) {
      throw new Error('La fuente oficial IGC-UP no devolvió registros sísmicos.');
    }

    const rawEvents = sourcePayload.eventos;
    console.log(`[Archivado Sismos] Registros recibidos desde el IGC-UP: ${rawEvents.length}`);

    // 2. Normalización, consolidación de revisiones y asignación de UIDs
    const { normalized, descartados } = normalizeEvents(rawEvents);
    if (!normalized.length) {
      throw new Error('Ningún evento superó los criterios de validación geofísica.');
    }
    console.log(`[Archivado Sismos] Registros normalizados válidos: ${normalized.length} | Descartados: ${descartados}`);

    // 3. Inicializar Supabase y sincronizar
    const supabase = options.supabase || (options.env && options.env.supabaseClient) || getSupabaseClient(options.env);
    const syncResult = await syncEventsToSupabase(normalized, supabase, now);

    // 4. Notificar eventos recientes mediante Web Push (nuevos o pendientes de reintento)
    let pushResult = { enviados: 0, omitidos: 'SIN_EVENTOS_RECIENTES' };
    const MAX_DISCOVERY_AGE_MS = 45 * 60 * 1000;
    const MAX_ALERT_LIFECYCLE_MS = 90 * 60 * 1000;
    const MAX_PUSH_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
    const nowTime = now.getTime();

    const recentCandidates = (normalized || []).filter(e => {
      const ts = new Date(e.fecha_hora).getTime();
      if (!Number.isFinite(ts)) return false;
      const capTime = e.primera_captura ? new Date(e.primera_captura).getTime() : null;
      if (capTime && Number.isFinite(capTime)) {
        return (nowTime - capTime) <= MAX_ALERT_LIFECYCLE_MS;
      }
      const diff = nowTime - ts;
      return diff >= -MAX_PUSH_FUTURE_TOLERANCE_MS && diff <= MAX_DISCOVERY_AGE_MS;
    });

    if (recentCandidates.length > 0 && options.enablePush !== false) {
      try {
        const igcSubrequests = options.sourcePayload ? 0 : 1;
        const syncSubrequests = syncResult?.subrequests ?? 3;
        const archivalSubrequests = igcSubrequests + syncSubrequests;
        const SAFE_MAX_SUBREQUESTS = 40;
        const MIN_PUSH_SUBREQUESTS = 10;

        if (archivalSubrequests >= 30 || (SAFE_MAX_SUBREQUESTS - archivalSubrequests < MIN_PUSH_SUBREQUESTS)) {
          console.log(`[Archivado Sismos] Ingesta sísmica consumió ${archivalSubrequests} subrequests. Despacho push pospuesto para proteger la ingesta.`);
          pushResult = { enviados: 0, omitidos: 'PRESUPUESTO_INSUFICIENTE_POST_ARCHIVADO', archivalSubrequests };
        } else {
          pushResult = await dispatchPushNotifications(recentCandidates, supabase, options.env, now, {
            initialSubrequests: archivalSubrequests
          });
        }
      } catch (pushErr) {
        console.warn('[Archivado Sismos] Advertencia en despacho de notificaciones:', pushErr.message);
        pushResult = { error: pushErr.message };
      }
    } else if (options.enablePush !== false) {
      pushResult = { enviados: 0, omitidos: 'SIN_EVENTOS_RECIENTES' };
    }

    const durationMs = Date.now() - startTime;
    console.log(`[Archivado Sismos] Finalización y duración de la ejecución: completado en ${durationMs}ms`);

    return {
      ok: true,
      inicio: nowISO,
      duracion_ms: durationMs,
      recibidos: rawEvents.length,
      validos: normalized.length,
      descartados,
      nuevos: syncResult.nuevos,
      actualizados: syncResult.actualizados,
      verificados: syncResult.verificados,
      push: pushResult
    };
  })();

  try {
    return await Promise.race([archivalPromise, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Handler principal para Netlify Scheduled Functions.
 * Se ejecuta automáticamente mediante el cron planificado (cada 30 min) o mediante "Run now" desde el panel de Netlify.
 * La protección frente a peticiones públicas directas la gestiona la infraestructura de Netlify a nivel de enrutador.
 */
const rawHandler = async function(event, context, options = {}) {
  try {
    const result = await runArchival(options);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify(result, null, 2)
    };
  } catch (error) {
    console.error(`[Archivado Sismos] ERROR en ejecución de Scheduled Function: ${error.message}`);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({
        ok: false,
        error: error.message,
        momento: new Date().toISOString()
      }, null, 2)
    };
  }
};

/**
 * Anonimiza un endpoint Web Push para registros seguros sin filtrar tokens de dispositivos.
 */
function anonymizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return '[endpoint_anonimo]';
  try {
    const u = new URL(endpoint);
    const parts = u.pathname.split('/').filter(Boolean);
    const token = parts[parts.length - 1] || '';
    const masked = token.length > 8 ? token.slice(0, 4) + '...' + token.slice(-4) : '***';
    return u.origin + '/.../' + masked;
  } catch {
    return endpoint.length > 16 ? endpoint.slice(0, 8) + '...' + endpoint.slice(-4) : '[endpoint_protegido]';
  }
}

async function sha256Hex(str) {
  if (!str || typeof str !== 'string') return null;
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Calcula la fecha ISO hasta la cual debe pausarse una suscripción (cooldown / circuito abierto).
 * Prioriza la cabecera Retry-After del proveedor y aplica backoff progresivo ante fallos transitorios.
 */
function calculateRetryAfterDate(retryAfterHeader, failures, now = new Date()) {
  const nowMs = now.getTime();
  if (retryAfterHeader && typeof retryAfterHeader === 'string') {
    const trimmed = retryAfterHeader.trim();
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      const boundedSeconds = Math.min(Math.max(seconds, 10), 3600);
      return new Date(nowMs + boundedSeconds * 1000).toISOString();
    }
    const parsedDate = new Date(trimmed);
    if (Number.isFinite(parsedDate.getTime())) {
      const diffMs = parsedDate.getTime() - nowMs;
      if (diffMs > 0) {
        const boundedMs = Math.min(Math.max(diffMs, 10000), 3600 * 1000);
        return new Date(nowMs + boundedMs).toISOString();
      }
    }
  }

  // Backoff escalonado progresivo: 1 fallo -> 60s, 2 -> 120s, 3 -> 300s, 4 -> 900s, 5+ -> 1800s
  let cooldownSec = 60;
  if (failures === 2) cooldownSec = 120;
  else if (failures === 3) cooldownSec = 300;
  else if (failures === 4) cooldownSec = 900;
  else if (failures >= 5) cooldownSec = 1800;

  return new Date(nowMs + cooldownSec * 1000).toISOString();
}

/**
 * Distribuye notificaciones Web Push para sismos verdaderamente nuevos (máximo 30 min de antigüedad).
 * Protegido contra ráfagas (lote masivo > 3) y duplicados mediante notificaciones_enviadas.
 * Requiere explícitamente AUTO_PUSH_ENABLED=true para enviar notificaciones reales.
 */
async function dispatchPushNotifications(nuevosRecords, supabase, env = {}, now = new Date(), options = {}) {
  const autoPushEnabled = Boolean(env && (env.AUTO_PUSH_ENABLED === 'true' || env.AUTO_PUSH_ENABLED === true));
  if (!autoPushEnabled) {
    return { enviados: 0, omitidos: 'AUTO_PUSH_DISABLED' };
  }

  if (!supabase || !Array.isArray(nuevosRecords) || nuevosRecords.length === 0) {
    return { enviados: 0, motivo: 'SIN_EVENTOS_NUEVOS' };
  }

  const MAX_DISCOVERY_AGE_MS = 45 * 60 * 1000; // Descubrimiento dentro de 45 min de ocurrido
  const MAX_ALERT_LIFECYCLE_MS = 90 * 60 * 1000; // Vigencia de entrega de hasta 90 min desde primera_captura
  const MAX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  const nowTime = now.getTime();

  // 1. Filtrar eventos candidatos considerando fecha de origen y vigencia de entrega
  const recentEvents = nuevosRecords.filter(e => {
    const ts = new Date(e.fecha_hora).getTime();
    if (!Number.isFinite(ts)) return false;
    const capTime = e.primera_captura ? new Date(e.primera_captura).getTime() : null;
    if (capTime && Number.isFinite(capTime)) {
      return (nowTime - capTime) <= MAX_ALERT_LIFECYCLE_MS;
    }
    const diff = nowTime - ts;
    return diff >= -MAX_FUTURE_TOLERANCE_MS && diff <= MAX_DISCOVERY_AGE_MS;
  });

  if (!recentEvents.length) {
    return { enviados: 0, omitidosPorAntiguedad: nuevosRecords.length };
  }

  // 2. Comprobar / registrar hito persistente de activación de Web Push en Supabase
  let activationTimestamp = null;
  if (env && env.PUSH_ACTIVATED_AT) {
    const parsedTime = new Date(env.PUSH_ACTIVATED_AT).getTime();
    if (Number.isFinite(parsedTime)) {
      activationTimestamp = env.PUSH_ACTIVATED_AT;
    }
  }

  if (!activationTimestamp) {
    try {
      const { data: actRows } = await supabase
        .from('notificaciones_enviadas')
        .select('enviado_en')
        .eq('source_uid', '__SYSTEM_PUSH_ACTIVATION__')
        .eq('endpoint', '__SYSTEM__');

      if (actRows && actRows.length > 0 && actRows[0].enviado_en) {
        activationTimestamp = actRows[0].enviado_en;
      } else {
        const nowIso = now.toISOString();
        const { error: insErr } = await supabase
          .from('notificaciones_enviadas')
          .insert({
            source_uid: '__SYSTEM_PUSH_ACTIVATION__',
            endpoint: '__SYSTEM__',
            enviado_en: nowIso
          });

        if (!insErr) {
          activationTimestamp = nowIso;
        } else {
          const { data: afterRows } = await supabase
            .from('notificaciones_enviadas')
            .select('enviado_en')
            .eq('source_uid', '__SYSTEM_PUSH_ACTIVATION__')
            .eq('endpoint', '__SYSTEM__');
          activationTimestamp = (afterRows && afterRows[0]?.enviado_en) || nowIso;
        }
      }
    } catch (e) {
      console.warn('[Push] Advertencia comprobando activación persistente:', e.message);
    }
  }

  // Seguridad crítica: si la base de datos falla al persistir o leer el hito de activación,
  // se asume nowTime para impedir estrictamente que cualquier sismo previo sea notificado.
  const activationTime = activationTimestamp ? new Date(activationTimestamp).getTime() : nowTime;

  // 3. Filtrar eventos conocidos/archivados antes de la activación de Web Push (cero notificaciones históricas)
  // y aplicar política estricta de certidumbre temporal (Fase 6)
  const activeEvents = [];
  for (const e of recentEvents) {
    let capturedTime = e.primera_captura ? new Date(e.primera_captura).getTime() : null;

    if (!capturedTime || !Number.isFinite(capturedTime)) {
      try {
        const { data: sismoRows } = await supabase
          .from('sismos')
          .select('primera_captura')
          .eq('source_uid', e.source_uid);
        if (sismoRows && sismoRows[0] && sismoRows[0].primera_captura) {
          capturedTime = new Date(sismoRows[0].primera_captura).getTime();
          e.primera_captura = sismoRows[0].primera_captura;
        }
      } catch {}
    }

    const eventTs = new Date(e.fecha_hora).getTime();
    if (!Number.isFinite(eventTs)) {
      continue; // Descartar por timestamp geofísico inválido
    }

    // Si no tiene primera_captura en el objeto ni en la base de datos, anclar estrictamente
    // al timestamp geofísico del evento (eventTs). NUNCA sustituir por nowTime para impedir
    // que un sismo anterior a la activación sea disfrazado como nuevo.
    if (!capturedTime || !Number.isFinite(capturedTime)) {
      capturedTime = eventTs;
      e.primera_captura = new Date(eventTs).toISOString();
    }

    // Caducidad de entrega: si ya pasaron más de 90 min desde su detección, caducar
    if (nowTime - capturedTime > MAX_ALERT_LIFECYCLE_MS) {
      continue;
    }

    // Si el evento ocurrió o fue capturado en o antes del hito de activación, omitir estrictamente (cero históricos)
    if (activationTime > 0 && (capturedTime <= activationTime || eventTs <= activationTime)) {
      continue;
    }

    activeEvents.push(e);
  }

  if (!activeEvents.length) {
    return { enviados: 0, omitidosHistoricosPreActivacion: recentEvents.length };
  }

  // 4. Protección contra ráfagas anómalas / cold start / backfill masivo
  if (activeEvents.length > 6) {
    console.warn(`[Push] Despacho omitido por lote masivo (${activeEvents.length} eventos recientes). Protección contra ráfagas activa.`);
    return { enviados: 0, omitidosPorLoteMasivo: activeEvents.length };
  }

  // 5. Manejo de enjambres sísmicos ordenando por magnitud descendente (hasta 3 eventos activos)
  const sortedEvents = [...activeEvents].sort((a, b) => Number(b.magnitud || 0) - Number(a.magnitud || 0));
  const eligibleEvents = sortedEvents.slice(0, 3);

  // Comprobar clave pública VAPID en entorno
  if (!env || !env.VAPID_PUBLIC_KEY) {
    return { enviados: 0, motivo: 'VAPID_PUBLIC_KEY no configurada en el entorno' };
  }

  const currentVapidHash = await sha256Hex(env.VAPID_PUBLIC_KEY);
  if (!currentVapidHash) {
    return { enviados: 0, motivo: 'VAPID_PUBLIC_KEY inválida' };
  }

  // LÍMITES ESTRICTOS DE CLOUDFLARE WORKERS FREE (Techos máximos inquebrantables)
  const SAFE_MAX_SUBS_PER_CYCLE = 15;
  const SAFE_MAX_CONCURRENCY = 5;
  const SAFE_MAX_SUBREQUESTS = 40; // Preserva al menos 10 subrequests de margen bajo el límite de 50

  const rawMaxSubs = Math.floor(Number(env?.PUSH_MAX_SUBS_PER_CYCLE));
  const MAX_SUBS_PER_CYCLE = (Number.isFinite(rawMaxSubs) && rawMaxSubs > 0)
    ? Math.min(rawMaxSubs, SAFE_MAX_SUBS_PER_CYCLE)
    : SAFE_MAX_SUBS_PER_CYCLE;

  const rawConcurrency = Math.floor(Number(env?.PUSH_CONCURRENCY));
  const PUSH_CONCURRENCY = (Number.isFinite(rawConcurrency) && rawConcurrency > 0)
    ? Math.min(rawConcurrency, SAFE_MAX_CONCURRENCY)
    : SAFE_MAX_CONCURRENCY;

  const rawMaxSubreq = Math.floor(Number(env?.PUSH_MAX_SUBREQUESTS));
  const MAX_PUSH_SUBREQUESTS = (Number.isFinite(rawMaxSubreq) && rawMaxSubreq > 0)
    ? Math.min(rawMaxSubreq, SAFE_MAX_SUBREQUESTS)
    : SAFE_MAX_SUBREQUESTS;

  let pushSubrequestsCount = Math.max(0, Math.floor(Number(options?.initialSubrequests) || Number(env?.__INITIAL_SUBREQUESTS__) || 0));
  let totalIntentos = 0;
  let totalEnviados = 0;
  let hadAnySubscribersInDb = false;
  let hadAnyVapidCompatibleSubscribers = false;

  const activeEventsCount = eligibleEvents.length;

  for (let evIndex = 0; evIndex < eligibleEvents.length; evIndex++) {
    const ev = eligibleEvents[evIndex];

    if (totalIntentos >= MAX_SUBS_PER_CYCLE || pushSubrequestsCount >= MAX_PUSH_SUBREQUESTS) {
      console.log(`[Push] Presupuesto global alcanzado (intentos: ${totalIntentos}/${MAX_SUBS_PER_CYCLE}, subrequests: ${pushSubrequestsCount}/${MAX_PUSH_SUBREQUESTS}). Restante diferido al siguiente cron.`);
      break;
    }

    const remainingIntentos = MAX_SUBS_PER_CYCLE - totalIntentos;
    const eventsRemaining = activeEventsCount - evIndex;
    const quotaForEvent = Math.max(1, Math.min(remainingIntentos, Math.ceil(remainingIntentos / eventsRemaining)));

    // Consultar envíos previos, reservas en curso y cursor persistente
    pushSubrequestsCount++;
    let yaEnviados = [];
    let totalSentCount = 0;
    try {
      const { data, count } = await supabase
        .from('notificaciones_enviadas')
        .select('endpoint, estado, lease_expires_at, enviado_en', { count: 'exact' })
        .eq('source_uid', ev.source_uid);
      yaEnviados = data || [];
      totalSentCount = count !== null && count !== undefined ? count : yaEnviados.length;
    } catch {}

    const cursorRow = yaEnviados.find(r => r.endpoint === '__CURSOR__');
    let cursorCreatedAt = cursorRow ? cursorRow.enviado_en : null;
    let lastSeenCreatedAt = cursorCreatedAt;

    const endpointsNotificados = new Set();
    const abandonedEndpoints = [];

    for (const row of yaEnviados) {
      if (!row || !row.endpoint) continue;
      if (row.endpoint === '__CURSOR__') continue;
      const leaseExpiry = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
      const isEnProceso = row.estado === 'EN_PROCESO';

      if (isEnProceso && leaseExpiry > 0 && leaseExpiry <= nowTime) {
        abandonedEndpoints.push(row.endpoint);
      } else {
        endpointsNotificados.add(row.endpoint);
      }
    }

    // Reclamar reservas abandonadas (Worker anterior cayó o fue interrumpido)
    if (abandonedEndpoints.length > 0) {
      for (const abEndpoint of abandonedEndpoints) {
        if (pushSubrequestsCount >= MAX_PUSH_SUBREQUESTS) break;
        pushSubrequestsCount++;
        try {
          await supabase
            .from('notificaciones_enviadas')
            .delete()
            .eq('source_uid', ev.source_uid)
            .eq('endpoint', abEndpoint);
        } catch {}
      }
    }

    // Paginación por cursor y orden cronológico con soporte de timestamps idénticos y recuperación
    const PAGE_SIZE = 100;
    let pageSubs = [];
    const evCapturedTime = new Date(ev.primera_captura || ev.fecha_hora).getTime();
    let currentCursor = cursorCreatedAt;
    let strictGt = false;
    let reachedEnd = false;

    while (pageSubs.length < quotaForEvent) {
      if (pushSubrequestsCount + 4 >= MAX_PUSH_SUBREQUESTS) break;
      pushSubrequestsCount++;
      let batch = [];
      try {
        let pageQuery = supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth, vapid_key_hash, failures, created_at, retry_after, latitud, longitud, ubicacion_actualizada_en, ubicacion_modo, ubicacion_zona, personalizacion_distancia_activa');

        if (typeof pageQuery.order === 'function') {
          pageQuery = pageQuery.order('created_at', { ascending: true });
        }
        if (currentCursor) {
          if (strictGt && typeof pageQuery.gt === 'function') {
            pageQuery = pageQuery.gt('created_at', currentCursor);
          } else if (!strictGt && typeof pageQuery.gte === 'function') {
            pageQuery = pageQuery.gte('created_at', currentCursor);
          } else if (typeof pageQuery.gt === 'function') {
            pageQuery = pageQuery.gt('created_at', currentCursor);
          }
        }
        if (typeof pageQuery.limit === 'function') {
          pageQuery = pageQuery.limit(PAGE_SIZE);
        }

        const { data, error } = await pageQuery;
        if (error && (error.code === '42703' || error.message?.includes('retry_after'))) {
          let fallbackQuery = supabase
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth, vapid_key_hash, failures, created_at');
          if (typeof fallbackQuery.order === 'function') {
            fallbackQuery = fallbackQuery.order('created_at', { ascending: true });
          }
          if (currentCursor) {
            if (strictGt && typeof fallbackQuery.gt === 'function') {
              fallbackQuery = fallbackQuery.gt('created_at', currentCursor);
            } else if (!strictGt && typeof fallbackQuery.gte === 'function') {
              fallbackQuery = fallbackQuery.gte('created_at', currentCursor);
            } else if (typeof fallbackQuery.gt === 'function') {
              fallbackQuery = fallbackQuery.gt('created_at', currentCursor);
            }
          }
          if (typeof fallbackQuery.limit === 'function') {
            fallbackQuery = fallbackQuery.limit(PAGE_SIZE);
          }
          const fb = await fallbackQuery;
          batch = fb.data || [];
        } else {
          batch = data || [];
        }
      } catch {}

      if (!batch || batch.length === 0) {
        reachedEnd = true;
        break;
      }
      hadAnySubscribersInDb = true;
      if (batch.length < PAGE_SIZE) {
        reachedEnd = true;
      }

      for (const s of batch) {
        if (!s || !s.endpoint || !s.p256dh || !s.auth) continue;

        if (s.vapid_key_hash === currentVapidHash) {
          const inCooldown = (s.retry_after && nowTime < new Date(s.retry_after).getTime()) ||
                             (typeof s.failures === 'number' && s.failures >= 3);
          if (!inCooldown) {
            hadAnyVapidCompatibleSubscribers = true;
          }
        }

        // Si ya fue notificado o tiene reserva activa no expirada: omitir
        if (endpointsNotificados.has(s.endpoint)) continue;

        if (!s.vapid_key_hash || s.vapid_key_hash !== currentVapidHash) continue;
        if (s.retry_after) {
          const retryAfterTime = new Date(s.retry_after).getTime();
          if (Number.isFinite(retryAfterTime) && nowTime < retryAfterTime) continue;
        } else if (typeof s.failures === 'number' && s.failures >= 3) {
          continue;
        }
        if (s.created_at) {
          const subCreatedTime = new Date(s.created_at).getTime();
          if (Number.isFinite(subCreatedTime) && subCreatedTime > evCapturedTime + 15000) continue;
        }

        pageSubs.push(s);
        if (s.created_at) {
          lastSeenCreatedAt = s.created_at;
        }
        if (pageSubs.length >= quotaForEvent) break;
      }

      if (pageSubs.length >= quotaForEvent) {
        break;
      }

      if (!reachedEnd && batch.length === PAGE_SIZE) {
        const lastItem = batch[batch.length - 1];
        if (lastItem && lastItem.created_at) {
          if (lastItem.created_at === currentCursor) {
            strictGt = true;
          } else {
            currentCursor = lastItem.created_at;
            strictGt = false;
          }
        }
      } else {
        break;
      }
    }

    // Política de fin de lista: Si el cursor avanzó y no quedan elegibles al frente,
    // reiniciar cursor a null para barrer en el siguiente cron los suscriptores que salieron de cooldown o fallaron
    if (pageSubs.length === 0 && cursorCreatedAt !== null) {
      console.log(`[Push] Fin de cola alcanzado para sismo ${ev.source_uid}. Reiniciando cursor para barrido de reintentos.`);
      lastSeenCreatedAt = null;
      if (pushSubrequestsCount < MAX_PUSH_SUBREQUESTS) {
        pushSubrequestsCount++;
        try {
          await supabase.from('notificaciones_enviadas').upsert({
            source_uid: ev.source_uid,
            endpoint: '__CURSOR__',
            enviado_en: null,
            estado: 'CONFIRMADA'
          }, { onConflict: 'source_uid,endpoint' });
        } catch {}
      }

      // Si aún disponemos de presupuesto, intentar barrido inmediato desde el inicio
      if (pushSubrequestsCount + 6 < MAX_PUSH_SUBREQUESTS) {
        pushSubrequestsCount++;
        try {
          let sweepQuery = supabase
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth, vapid_key_hash, failures, created_at, retry_after, latitud, longitud, ubicacion_actualizada_en, ubicacion_modo, ubicacion_zona, personalizacion_distancia_activa');
          if (typeof sweepQuery.order === 'function') sweepQuery = sweepQuery.order('created_at', { ascending: true });
          if (typeof sweepQuery.limit === 'function') sweepQuery = sweepQuery.limit(PAGE_SIZE);
          const { data: sweepBatch } = await sweepQuery;
          if (sweepBatch) {
            for (const s of sweepBatch) {
              if (!s || !s.endpoint || !s.p256dh || !s.auth) continue;
              if (endpointsNotificados.has(s.endpoint)) continue;
              if (!s.vapid_key_hash || s.vapid_key_hash !== currentVapidHash) continue;
              if (s.retry_after) {
                const rTime = new Date(s.retry_after).getTime();
                if (Number.isFinite(rTime) && nowTime < rTime) continue;
              } else if (typeof s.failures === 'number' && s.failures >= 3) {
                continue;
              }
              if (s.created_at) {
                const cTime = new Date(s.created_at).getTime();
                if (Number.isFinite(cTime) && cTime > evCapturedTime + 15000) continue;
              }
              pageSubs.push(s);
              if (s.created_at) lastSeenCreatedAt = s.created_at;
              if (pageSubs.length >= quotaForEvent) break;
            }
          }
        } catch {}
      }
    }

    // Persistir el avance del cursor para este evento
    if (lastSeenCreatedAt !== undefined && lastSeenCreatedAt !== (cursorRow?.enviado_en) && pushSubrequestsCount < MAX_PUSH_SUBREQUESTS) {
      pushSubrequestsCount++;
      try {
        await supabase.from('notificaciones_enviadas').upsert({
          source_uid: ev.source_uid,
          endpoint: '__CURSOR__',
          enviado_en: lastSeenCreatedAt,
          estado: 'CONFIRMADA'
        }, { onConflict: 'source_uid,endpoint' });
      } catch {}
    }

    if (!pageSubs.length) continue;

    const subsToProcess = pageSubs.slice(0, quotaForEvent);

    // Resolver denominación geográfica oficial
    const geo = resolveLocation(ev.latitud, ev.longitud, ev.ubicacion || ev.region);
    const geoTexto = geo?.ubicacion_texto || ev.ubicacion || ev.region || 'Panamá';
    const magStr = Number(ev.magnitud).toFixed(1);
    const estadoStr = ev.estado && String(ev.estado).toUpperCase() === 'REVISADO' ? 'Revisado' : 'Preliminar';

    let horaPanama = '';
    try {
      const d = new Date(ev.fecha_hora);
      if (Number.isFinite(d.getTime())) {
        horaPanama = d.toLocaleTimeString('es-PA', {
          timeZone: 'America/Panama',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
      }
    } catch {}

    const bodyParts = [geoTexto];
    if (Number.isFinite(Number(ev.profundidad_km))) {
      bodyParts.push(`Prof. ${Math.round(Number(ev.profundidad_km))} km`);
    }
    if (horaPanama) {
      bodyParts.push(horaPanama);
    }
    if (estadoStr) {
      bodyParts.push(estadoStr);
    }

    const payload = {
      title: `sismoPA · Nuevo sismo M${magStr}`,
      body: bodyParts.join(' · '),
      url: `./#/sismo/${encodeURIComponent(ev.source_uid)}`,
      tag: `sismo-${ev.source_uid}`
    };

    // Despacho en lotes concurrentes con pre-reserva conservadora para el peor caso
    let chunkIndex = 0;
    while (chunkIndex < subsToProcess.length) {
      if (totalIntentos >= MAX_SUBS_PER_CYCLE || pushSubrequestsCount >= MAX_PUSH_SUBREQUESTS) {
        break;
      }

      // Pre-reservar presupuesto de subrequests en el peor caso razonable:
      // Cada suscriptor puede consumir: 1 reserva + 1 push + 2 limpieza/actualización errores = hasta 4 subrequests
      const remainingBudget = MAX_PUSH_SUBREQUESTS - pushSubrequestsCount;
      // Pre-reserva conservadora: acota según presupuesto disponible para la ruta estándar (2 subreqs/sub)
      // y cota dura garantizada de 4 operaciones por suscriptor en el peor caso de fallbacks (bajo límite 48):
      const maxSubsHappyPath = Math.max(0, Math.floor((remainingBudget - 1) / 2));
      const maxSubsWorstCase = Math.max(0, Math.floor((48 - pushSubrequestsCount) / 4));
      const maxSubsForRemainingBudget = Math.min(maxSubsHappyPath, maxSubsWorstCase);
      if (maxSubsForRemainingBudget <= 0) {
        console.log(`[Push] Presupuesto de subrequests reservado alcanzado (${pushSubrequestsCount}/${MAX_PUSH_SUBREQUESTS}). Suscriptores diferidos al siguiente cron.`);
        break;
      }

      const actualChunkSize = Math.min(PUSH_CONCURRENCY, maxSubsForRemainingBudget);
      const chunk = subsToProcess.slice(chunkIndex, chunkIndex + actualChunkSize);
      if (!chunk.length) break;
      chunkIndex += actualChunkSize;

      const successfulEndpoints = [];
      await Promise.allSettled(chunk.map(async (sub) => {
        if (pushSubrequestsCount >= MAX_PUSH_SUBREQUESTS) return;
        totalIntentos++;

        // 1. Reserva atómica con lease temporal (90s)
        const leaseExpiryIso = new Date(nowTime + 90000).toISOString();
        if (pushSubrequestsCount < 48) pushSubrequestsCount++;
        let reserveErr = null;
        try {
          const { error } = await supabase
            .from('notificaciones_enviadas')
            .insert({
              source_uid: ev.source_uid,
              endpoint: sub.endpoint,
              enviado_en: now.toISOString(),
              estado: 'EN_PROCESO',
              lease_expires_at: leaseExpiryIso,
              intentos: 1
            });
          reserveErr = error;
          if (reserveErr && (reserveErr.code === '42703' || reserveErr.message?.includes('estado'))) {
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              const { error: fbErr } = await supabase
                .from('notificaciones_enviadas')
                .insert({
                  source_uid: ev.source_uid,
                  endpoint: sub.endpoint,
                  enviado_en: now.toISOString()
                });
              reserveErr = fbErr;
            }
          }
        } catch (e) {
          reserveErr = e;
        }

        if (reserveErr) return;

        // 2. Envío Web Push
        try {
          if (pushSubrequestsCount < 48) pushSubrequestsCount++;
          const userLocation = (sub && sub.latitud !== null && sub.latitud !== undefined && sub.longitud !== null && sub.longitud !== undefined) ? {
            latitud: sub.latitud,
            longitud: sub.longitud,
            modo: sub.ubicacion_modo || 'GPS',
            ubicacion_actualizada_en: sub.ubicacion_actualizada_en,
            personalizacion_distancia_activa: sub.personalizacion_distancia_activa
          } : null;

          const notif = formatSeismicNotification({
            sismo: {
              source_uid: ev.source_uid,
              magnitud: ev.magnitud,
              latitud: ev.latitud,
              longitud: ev.longitud,
              ubicacion_texto: geoTexto,
              profundidad_km: ev.profundidad_km
            },
            userLocation,
            now
          });

          const subPayload = {
            title: notif.title,
            body: notif.body,
            url: `./#/sismo/${encodeURIComponent(ev.source_uid)}`,
            tag: `sismo-${ev.source_uid}`,
            data: {
              source_uid: ev.source_uid,
              magnitud: String(ev.magnitud || ''),
              latitud: String(ev.latitud || ''),
              longitud: String(ev.longitud || ''),
              ubicacion: geoTexto,
              profundidad: String(ev.profundidad_km || ''),
              url: `./#/sismo/${encodeURIComponent(ev.source_uid)}`
            }
          };

          const res = await sendWebPush(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            subPayload,
            env
          );

          if (res && res.ok) {
            totalEnviados++;
            successfulEndpoints.push(sub.endpoint);

            if ((sub.failures && sub.failures > 0) || sub.retry_after) {
              if (pushSubrequestsCount < 48) {
                pushSubrequestsCount++;
                try {
                  let { error: updErr } = await supabase
                    .from('push_subscriptions')
                    .update({ failures: 0, retry_after: null, last_failure_at: null })
                    .eq('endpoint', sub.endpoint);
                  if (updErr && (updErr.code === '42703' || updErr.message?.includes('retry_after'))) {
                    if (pushSubrequestsCount < 48) {
                      pushSubrequestsCount++;
                      await supabase.from('push_subscriptions').update({ failures: 0 }).eq('endpoint', sub.endpoint);
                    }
                  }
                } catch {}
              }
            }
          } else if (res && (res.status === 410 || res.status === 404 || res.expired)) {
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try { await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch {}
            }
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try { await supabase.from('notificaciones_enviadas').delete().eq('source_uid', ev.source_uid).eq('endpoint', sub.endpoint); } catch {}
            }
          } else if (res && (res.status === 401 || res.status === 403 || res.authError)) {
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try { await supabase.from('notificaciones_enviadas').delete().eq('source_uid', ev.source_uid).eq('endpoint', sub.endpoint); } catch {}
            }
            const nextFailures = (sub.failures || 0) + 1;
            const retryAfterIso = calculateRetryAfterDate(res?.retryAfter || '300', nextFailures, now);
            console.warn(`[Push] Advertencia de autenticación VAPID (HTTP ${res.status}) para ${anonymizeEndpoint(sub.endpoint)}. Suspensión temporal aplicada.`);
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try {
                let { error: updErr } = await supabase
                  .from('push_subscriptions')
                  .update({ failures: nextFailures, retry_after: retryAfterIso, last_failure_at: now.toISOString() })
                  .eq('endpoint', sub.endpoint);
                if (updErr && (updErr.code === '42703' || updErr.message?.includes('retry_after'))) {
                  if (pushSubrequestsCount < 48) {
                    pushSubrequestsCount++;
                    await supabase.from('push_subscriptions').update({ failures: nextFailures }).eq('endpoint', sub.endpoint);
                  }
                }
              } catch {}
            }
          } else {
            // Error transitorio (HTTP 429, 500, 502, 503, 504, etc.)
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try { await supabase.from('notificaciones_enviadas').delete().eq('source_uid', ev.source_uid).eq('endpoint', sub.endpoint); } catch {}
            }
            const nextFailures = (sub.failures || 0) + 1;
            const retryAfterIso = calculateRetryAfterDate(res?.retryAfter, nextFailures, now);
            if (pushSubrequestsCount < 48) {
              pushSubrequestsCount++;
              try {
                let { error: updErr } = await supabase
                  .from('push_subscriptions')
                  .update({ failures: nextFailures, retry_after: retryAfterIso, last_failure_at: now.toISOString() })
                  .eq('endpoint', sub.endpoint);
                if (updErr && (updErr.code === '42703' || updErr.message?.includes('retry_after'))) {
                  if (pushSubrequestsCount < 48) {
                    pushSubrequestsCount++;
                    await supabase.from('push_subscriptions').update({ failures: nextFailures }).eq('endpoint', sub.endpoint);
                  }
                }
              } catch {}
            }
          }
        } catch (err) {
          if (pushSubrequestsCount < 48) {
            pushSubrequestsCount++;
            try { await supabase.from('notificaciones_enviadas').delete().eq('source_uid', ev.source_uid).eq('endpoint', sub.endpoint); } catch {}
          }
          const nextFailures = (sub.failures || 0) + 1;
          const retryAfterIso = calculateRetryAfterDate(null, nextFailures, now);
          if (pushSubrequestsCount < 48) {
            pushSubrequestsCount++;
            try {
              let { error: updErr } = await supabase
                .from('push_subscriptions')
                .update({ failures: nextFailures, retry_after: retryAfterIso, last_failure_at: now.toISOString() })
                .eq('endpoint', sub.endpoint);
              if (updErr && (updErr.code === '42703' || updErr.message?.includes('retry_after'))) {
                if (pushSubrequestsCount < 48) {
                  pushSubrequestsCount++;
                  await supabase.from('push_subscriptions').update({ failures: nextFailures }).eq('endpoint', sub.endpoint);
                }
              }
            } catch {}
          }
          console.warn(`[Push] Error de red o timeout enviando a ${anonymizeEndpoint(sub.endpoint)}:`, err.message);
        }
      }));

      // Confirmar reservas exitosas del lote de forma agrupada (1 subrequest por lote)
      if (successfulEndpoints.length > 0) {
        if (pushSubrequestsCount < 48) {
          pushSubrequestsCount++;
          try {
            let { error: confErr } = await supabase
              .from('notificaciones_enviadas')
              .update({ estado: 'CONFIRMADA', lease_expires_at: null })
              .eq('source_uid', ev.source_uid)
              .in('endpoint', successfulEndpoints);
            if (confErr) {
              for (const ep of successfulEndpoints) {
                if (pushSubrequestsCount >= 48) break;
                pushSubrequestsCount++;
                try {
                  await supabase
                    .from('notificaciones_enviadas')
                    .update({ estado: 'CONFIRMADA', lease_expires_at: null })
                    .eq('source_uid', ev.source_uid)
                    .eq('endpoint', ep);
                } catch {}
              }
            }
          } catch {}
        }
      }
    }
  }

  const returnObj = {
    enviados: totalEnviados,
    intentos: totalIntentos,
    subrequests: pushSubrequestsCount,
    sismosNotificados: eligibleEvents.length
  };

  if (totalEnviados === 0 && totalIntentos === 0) {
    if (!hadAnySubscribersInDb) {
      returnObj.motivo = 'Sin suscripciones activas';
    } else if (!hadAnyVapidCompatibleSubscribers) {
      returnObj.motivo = 'Sin suscripciones compatibles con la clave VAPID actual';
    }
  }

  return returnObj;
}

export {
  rawHandler as handler,
  rawHandler,
  runArchival,
  normalizeEvents,
  buildNormalizedRecord,
  generateSourceUid,
  syncEventsToSupabase,
  dispatchPushNotifications,
  anonymizeEndpoint,
  calculateRetryAfterDate,
  sha256Hex,
  geoDistanceKm,
  CRON_SCHEDULE
};

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
import { sendFcmTopicMessage } from './fcm-dispatch.mjs';

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
    return { nuevos: 0, actualizados: 0, verificados: 0, total: 0 };
  }

  const nowISO = now.toISOString();
  const sourceUids = records.map(r => r.source_uid);
  const fechasHoras = [...new Set(records.map(r => r.fecha_hora))];

  const existingMapByUid = new Map();
  const existingListByTime = new Map();

  // Consultar registros existentes en lotes de 200
  const CHUNK_QUERY = 200;
  for (let i = 0; i < sourceUids.length; i += CHUNK_QUERY) {
    const sliceUids = sourceUids.slice(i, i + CHUNK_QUERY);
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
      payloads.push({
        ...r,
        primera_captura: nowISO,
        actualizado_en: nowISO,
        ultima_verificacion: nowISO
      });
      nuevosCount++;
      nuevosRecords.push(r);
    } else {
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
    total: payloads.length
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

    // 4. Notificar nuevos eventos mediante Web Push (si está habilitado)
    let pushResult = { enviados: 0, omitidos: 'SIN_EVENTOS_NUEVOS' };
    if (syncResult.nuevosRecords && syncResult.nuevosRecords.length > 0 && options.enablePush !== false) {
      try {
        pushResult = await dispatchPushNotifications(syncResult.nuevosRecords, supabase, options.env, now);
      } catch (pushErr) {
        console.warn('[Archivado Sismos] Advertencia en despacho de notificaciones:', pushErr.message);
        pushResult = { error: pushErr.message };
      }
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

async function sha256Hex(str) {
  if (!str || typeof str !== 'string') return null;
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Distribuye notificaciones Web Push para sismos verdaderamente nuevos (máximo 30 min de antigüedad).
 * Protegido contra ráfagas (lote masivo > 3) y duplicados mediante notificaciones_enviadas.
 * Requiere explícitamente AUTO_PUSH_ENABLED=true para enviar notificaciones reales.
 */
function filterEligibleSeismicEvents(nuevosRecords, now = new Date()) {
  if (!Array.isArray(nuevosRecords) || nuevosRecords.length === 0) {
    return { eligible: [], motivo: 'SIN_EVENTOS_NUEVOS' };
  }

  const MAX_AGE_MS = 45 * 60 * 1000; // 45 minutos (tolera demoras de revisión del IGC)
  const MAX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutos de tolerancia hacia el futuro
  const nowTime = now.getTime();

  // 1. Filtrar eventos por antigüedad real primero
  const recentEvents = nuevosRecords.filter(e => {
    const ts = new Date(e.fecha_hora).getTime();
    if (!Number.isFinite(ts)) return false;
    const diff = nowTime - ts;
    return diff >= -MAX_FUTURE_TOLERANCE_MS && diff <= MAX_AGE_MS;
  });

  if (!recentEvents.length) {
    return { eligible: [], omitidosPorAntiguedad: nuevosRecords.length };
  }

  // 2. Protección contra ráfagas anómalas / cold start / backfill masivo:
  // Si en la ventana reciente aparecen más de 6 eventos, se considera importación masiva y se omite.
  if (recentEvents.length > 6) {
    console.warn(`[Alertas] Despacho omitido por lote masivo (${recentEvents.length} eventos recientes). Protección contra ráfagas activa.`);
    return { eligible: [], omitidosPorLoteMasivo: recentEvents.length };
  }

  // 3. Manejo inteligente de enjambres sísmicos (1 a 6 eventos):
  // Ordenar por magnitud descendente y notificar los 3 más significativos para no saturar al usuario
  const sortedEvents = [...recentEvents].sort((a, b) => Number(b.magnitud || 0) - Number(a.magnitud || 0));
  const eligibleEvents = sortedEvents.slice(0, 3);
  return { eligible: eligibleEvents };
}

/**
 * Despacha notificaciones Web Push a suscriptores web elegibles.
 */
async function dispatchWebPushNotifications(eligibleEvents, supabase, env = {}, now = new Date()) {
  const autoPushEnabled = Boolean(env && (env.AUTO_PUSH_ENABLED === 'true' || env.AUTO_PUSH_ENABLED === true));
  if (!autoPushEnabled) {
    return { enviados: 0, omitidos: 'AUTO_PUSH_DISABLED' };
  }

  if (!supabase || !Array.isArray(eligibleEvents) || eligibleEvents.length === 0) {
    return { enviados: 0, motivo: 'SIN_EVENTOS_ELEGIBLES' };
  }

  // Obtener suscripciones activas
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, vapid_key_hash')
    .limit(500);

  if (subsErr || !subs || !subs.length) {
    return { enviados: 0, motivo: subsErr ? subsErr.message : 'Sin suscripciones activas' };
  }

  // Si existe VAPID_PUBLIC_KEY en env, filtrar suscripciones con hash VAPID coincidente (o nulo por retrocompatibilidad)
  let currentVapidHash = null;
  if (env.VAPID_PUBLIC_KEY) {
    currentVapidHash = await sha256Hex(env.VAPID_PUBLIC_KEY);
  }

  const validSubs = subs.filter(s => {
    if (currentVapidHash && s.vapid_key_hash && s.vapid_key_hash !== currentVapidHash) {
      return false;
    }
    return true;
  });

  if (!validSubs.length) {
    return { enviados: 0, motivo: 'Sin suscripciones compatibles con la clave VAPID actual' };
  }

  let totalEnviados = 0;

  for (const ev of eligibleEvents) {
    // Consultar envíos previos para este sismo para evitar notificaciones duplicadas
    const { data: yaEnviados } = await supabase
      .from('notificaciones_enviadas')
      .select('endpoint')
      .eq('source_uid', ev.source_uid);

    const endpointsNotificados = new Set((yaEnviados || []).map(r => r.endpoint));
    const subsPendientes = validSubs.filter(s => !endpointsNotificados.has(s.endpoint));

    if (!subsPendientes.length) continue;

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

    for (const sub of subsPendientes) {
      // Reserva atómica en notificaciones_enviadas para evitar condiciones de carrera por concurrencia
      const { error: reserveErr } = await supabase
        .from('notificaciones_enviadas')
        .insert({
          source_uid: ev.source_uid,
          endpoint: sub.endpoint,
          enviado_en: now.toISOString()
        });

      // Si falló por restricción única (otra instancia concurrente ya reservó o envió), omitir
      if (reserveErr) {
        continue;
      }

      try {
        const res = await sendWebPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          env
        );

        if (res && res.ok) {
          totalEnviados++;
        } else if (res && (res.expired || res.status === 401 || res.status === 403)) {
          // Suscripción inválida o expirada en el servicio Push: dar de baja automáticamente
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        } else {
          // Error transitorio del proveedor (ej. 500, 503): liberar reserva para reintento en el siguiente ciclo
          await supabase
            .from('notificaciones_enviadas')
            .delete()
            .eq('source_uid', ev.source_uid)
            .eq('endpoint', sub.endpoint);
        }
      } catch (err) {
        // En caso de fallo de conexión de red, liberar reserva para permitir reintento posterior
        await supabase
          .from('notificaciones_enviadas')
          .delete()
          .eq('source_uid', ev.source_uid)
          .eq('endpoint', sub.endpoint);
        console.warn(`[Push] Error enviando a ${sub.endpoint}:`, err.message);
      }
    }
  }

  return { enviados: totalEnviados, sismosNotificados: eligibleEvents.length };
}

/**
 * Despacha alertas sísmicas automáticas al topic oficial de Firebase FCM ('sismos_panama')
 * para usuarios de la APK nativa sismoPA.
 * Incluye reserva atómica distribuida en fcm_notificaciones_enviadas para evitar duplicados concurrentes.
 */
async function dispatchFcmTopicNotifications(eligibleEvents, supabase, env = {}, now = new Date()) {
  const killSwitch = Boolean(env && (env.FCM_KILL_SWITCH === 'true' || env.FCM_KILL_SWITCH === true));
  if (killSwitch) {
    console.warn('[FCM] Despacho detenido por corte de emergencia (FCM_KILL_SWITCH activo)');
    return { fcmEnviados: 0, omitidos: 'FCM_KILL_SWITCH_ACTIVE' };
  }

  const autoFcmEnabled = Boolean(env && (env.AUTO_FCM_ENABLED === 'true' || env.AUTO_FCM_ENABLED === true));
  if (!autoFcmEnabled) {
    return { fcmEnviados: 0, omitidos: 'AUTO_FCM_DISABLED' };
  }

  if (!supabase || !Array.isArray(eligibleEvents) || eligibleEvents.length === 0) {
    return { fcmEnviados: 0, motivo: 'SIN_EVENTOS_ELEGIBLES' };
  }

  let fcmServiceAccount = null;
  try {
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      fcmServiceAccount = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)
        : env.FIREBASE_SERVICE_ACCOUNT;
    } else if ((env.FIREBASE_PROJECT_ID || env.FIREBASE_CLIENT_EMAIL) && env.FIREBASE_PRIVATE_KEY) {
      fcmServiceAccount = {
        project_id: env.FIREBASE_PROJECT_ID || 'sismopa-notificaciones',
        client_email: env.FIREBASE_CLIENT_EMAIL,
        private_key: env.FIREBASE_PRIVATE_KEY
      };
    }
  } catch (parseErr) {
    console.warn('[FCM] Error parseando credenciales de Firebase en env:', parseErr.message);
  }

  if (!fcmServiceAccount || !fcmServiceAccount.client_email || !fcmServiceAccount.private_key) {
    console.warn('[FCM] Despacho omitido: Faltan credenciales válidas de Firebase Service Account');
    return { fcmEnviados: 0, omitidos: 'SIN_CREDENCIALES_FCM' };
  }

  const target = 'topic:sismos_panama';
  let fcmEnviados = 0;
  const LEASE_MS = 60 * 1000; // 60s lease de protección para ejecución concurrente
  const leaseExpiryISO = new Date(now.getTime() + LEASE_MS).toISOString();

  for (const ev of eligibleEvents) {
    // 1. Verificar registros existentes en fcm_notificaciones_enviadas
    const { data: existingRows } = await supabase
      .from('fcm_notificaciones_enviadas')
      .select('id, estado, lease_expires_at, intentos')
      .eq('source_uid', ev.source_uid)
      .eq('target', target)
      .limit(1);

    const existing = existingRows && existingRows[0];
    let leaseAcquired = false;

    if (existing) {
      if (existing.estado === 'CONFIRMADA') {
        // Notificación ya entregada previamente con éxito al topic
        continue;
      }
      if (existing.estado === 'RESERVADA') {
        const leaseEnd = existing.lease_expires_at ? new Date(existing.lease_expires_at).getTime() : 0;
        if (leaseEnd > now.getTime()) {
          // Otra instancia de Cloudflare Worker mantiene el lease activo
          continue;
        }
        // Lease expirado (worker colapsó o timeout). Intentar reclamar
        const { error: claimErr } = await supabase
          .from('fcm_notificaciones_enviadas')
          .update({
            estado: 'RESERVADA',
            lease_expires_at: leaseExpiryISO,
            intentos: (existing.intentos || 1) + 1
          })
          .eq('id', existing.id)
          .eq('estado', 'RESERVADA');

        if (!claimErr) {
          leaseAcquired = true;
        }
      } else if (existing.estado === 'FALLIDA') {
        if ((existing.intentos || 1) >= 3) {
          // Límite de reintentos alcanzado
          continue;
        }
        const { error: retryErr } = await supabase
          .from('fcm_notificaciones_enviadas')
          .update({
            estado: 'RESERVADA',
            lease_expires_at: leaseExpiryISO,
            intentos: (existing.intentos || 1) + 1
          })
          .eq('id', existing.id)
          .eq('estado', 'FALLIDA');

        if (!retryErr) {
          leaseAcquired = true;
        }
      }
    } else {
      // 2. Intentar reserva atómica con INSERT
      const { error: insertErr } = await supabase
        .from('fcm_notificaciones_enviadas')
        .insert({
          source_uid: ev.source_uid,
          target,
          enviado_en: now.toISOString(),
          estado: 'RESERVADA',
          lease_expires_at: leaseExpiryISO,
          intentos: 1
        });

      if (!insertErr) {
        leaseAcquired = true;
      }
    }

    if (!leaseAcquired) {
      continue;
    }

    // 3. Formatear payload FCM Data-Only oficial
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

    const fcmPayload = {
      source_uid: ev.source_uid,
      magnitud: magStr,
      lugar: geoTexto,
      profundidad: Number.isFinite(Number(ev.profundidad_km)) ? String(Math.round(Number(ev.profundidad_km))) : '',
      hora_local: horaPanama || ev.fecha_hora_texto || ev.fecha_hora,
      title: `sismoPA · Nuevo sismo M${magStr}`,
      body: bodyParts.join(' · '),
      url: `https://sismopa.pages.dev/?sismo=${encodeURIComponent(ev.source_uid)}`
    };

    try {
      const fcmRes = await sendFcmTopicMessage(
        fcmServiceAccount,
        'sismos_panama',
        fcmPayload,
        env.fetch || fetch
      );

      if (fcmRes && fcmRes.ok) {
        fcmEnviados++;
        await supabase
          .from('fcm_notificaciones_enviadas')
          .update({
            estado: 'CONFIRMADA',
            enviado_en: now.toISOString(),
            lease_expires_at: null
          })
          .eq('source_uid', ev.source_uid)
          .eq('target', target);
      } else {
        const isRetryable = fcmRes?.retryable !== false;
        await supabase
          .from('fcm_notificaciones_enviadas')
          .update({
            estado: 'FALLIDA',
            lease_expires_at: null,
            intentos: isRetryable ? (existing?.intentos || 1) : 99
          })
          .eq('source_uid', ev.source_uid)
          .eq('target', target);
        console.warn(`[FCM] Despacho fallido para ${ev.source_uid}: ${fcmRes?.error || 'Error desconocido'}`);
      }
    } catch (sendErr) {
      await supabase
        .from('fcm_notificaciones_enviadas')
        .update({
          estado: 'FALLIDA',
          lease_expires_at: null
        })
        .eq('source_uid', ev.source_uid)
        .eq('target', target);
      console.warn(`[FCM] Error de red despachando a topic para ${ev.source_uid}:`, sendErr.message);
    }
  }

  return { fcmEnviados, sismosNotificados: eligibleEvents.length };
}

/**
 * Orquestador principal de despacho de notificaciones automáticas (Web Push + Android FCM).
 * Preserva compatibilidad con la firma existente (nuevosRecords, supabase, env, now).
 */
async function dispatchPushNotifications(nuevosRecords, supabase, env = {}, now = new Date()) {
  const autoPushEnabled = Boolean(env && (env.AUTO_PUSH_ENABLED === 'true' || env.AUTO_PUSH_ENABLED === true));
  const autoFcmEnabled = Boolean(env && (env.AUTO_FCM_ENABLED === 'true' || env.AUTO_FCM_ENABLED === true));

  if (!autoPushEnabled && !autoFcmEnabled) {
    return { enviados: 0, fcmEnviados: 0, omitidos: 'AUTO_PUSH_DISABLED' };
  }

  if (!supabase || !Array.isArray(nuevosRecords) || nuevosRecords.length === 0) {
    return { enviados: 0, fcmEnviados: 0, motivo: 'SIN_EVENTOS_NUEVOS' };
  }

  const filterResult = filterEligibleSeismicEvents(nuevosRecords, now);
  if (filterResult.omitidosPorAntiguedad) {
    return { enviados: 0, fcmEnviados: 0, omitidosPorAntiguedad: filterResult.omitidosPorAntiguedad };
  }
  if (filterResult.omitidosPorLoteMasivo) {
    return { enviados: 0, fcmEnviados: 0, omitidosPorLoteMasivo: filterResult.omitidosPorLoteMasivo };
  }

  const eligibleEvents = filterResult.eligible || [];
  if (!eligibleEvents.length) {
    return { enviados: 0, fcmEnviados: 0, motivo: 'SIN_EVENTOS_ELEGIBLES' };
  }

  let webPushResult = { enviados: 0, omitidos: 'AUTO_PUSH_DISABLED' };
  if (autoPushEnabled) {
    webPushResult = await dispatchWebPushNotifications(eligibleEvents, supabase, env, now);
  }

  let fcmResult = { fcmEnviados: 0, omitidos: 'AUTO_FCM_DISABLED' };
  if (autoFcmEnabled) {
    fcmResult = await dispatchFcmTopicNotifications(eligibleEvents, supabase, env, now);
  }

  const res = {
    enviados: webPushResult.enviados || 0,
    fcmEnviados: fcmResult.fcmEnviados || 0,
    sismosNotificados: eligibleEvents.length,
    webPush: webPushResult,
    fcm: fcmResult
  };
  if (webPushResult.motivo && !res.enviados && !res.fcmEnviados) {
    res.motivo = webPushResult.motivo;
  }
  return res;
}

export {
  rawHandler as handler,
  rawHandler,
  runArchival,
  normalizeEvents,
  buildNormalizedRecord,
  generateSourceUid,
  syncEventsToSupabase,
  filterEligibleSeismicEvents,
  dispatchWebPushNotifications,
  dispatchFcmTopicNotifications,
  dispatchPushNotifications,
  sha256Hex,
  geoDistanceKm,
  CRON_SCHEDULE
};

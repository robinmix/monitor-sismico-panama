/**
 * Validador de entorno Fail-Closed: solo permite operaciones si el entorno
 * está explícitamente verificado y no presenta contradicciones.
 */
export function isExplicitProduction(env, request) {
  if (!env || typeof env !== 'object') return false;

  // 1. Detección de rama o indicador explícito de Preview / no-producción (Bloqueo prioritario)
  const branchName = env.CF_PAGES_BRANCH;
  if (typeof branchName === 'string' && branchName !== 'main') {
    return false; // Preview explícito por rama
  }

  // 2. Comprobación de host en solicitud si está presente (para evitar colisiones o spoofing)
  if (request && typeof request.headers?.get === 'function') {
    const host = request.headers.get('host') || '';
    if (host.endsWith('.sismopa.pages.dev') && host !== 'sismopa.pages.dev') {
      return false; // Host de Preview
    }
  }

  // 3. Comprobación de configuración explícita de Producción (Fail-Closed)
  const isProdBranch = (branchName === 'main');
  const isProdEnv = (env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production' || env.SISMOPA_ENV === 'production');

  // Si no hay ningún indicador positivo verificable -> AUSENTE o DESCONOCIDO -> Bloquear
  if (!isProdBranch && !isProdEnv) {
    return false;
  }

  // 4. Verificación de no contradicción: si coexisten variables, no deben contradecirse
  if (isProdBranch && env.ENVIRONMENT && env.ENVIRONMENT !== 'production') {
    return false; // Contradictorio
  }
  if (isProdBranch && env.SISMOPA_ENV && env.SISMOPA_ENV !== 'production') {
    return false; // Contradictorio
  }
  if (isProdEnv && branchName && branchName !== 'main') {
    return false; // Contradictorio
  }

  return true;
}

import { createClient } from '@supabase/supabase-js';
import { isValidPushEndpoint } from '../../cloudflare/lib/web-push.mjs';
import { truncateCoordinates } from '../../cloudflare/lib/distance-formatter.mjs';

function getSupabase(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sha256Hex(str) {
  if (!str || typeof str !== 'string') return null;
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function normalizeLocationMode(raw) {
  if (!raw || typeof raw !== 'string') return 'GPS';
  const upper = raw.trim().toUpperCase();
  if (upper === 'ZONA' || upper === 'PROVINCIA' || upper === 'MANUAL') return 'ZONA';
  if (upper === 'INACTIVO' || upper === 'NONE' || upper === 'OFF') return 'INACTIVO';
  return 'GPS';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  }

  // Protección Fail-Closed: rechazar ante entorno no verificado explícitamente como producción
  if (!isExplicitProduction(env, request)) {
    return Response.json({
      ok: false,
      error: 'Operación no permitida: el entorno actual no está verificado explícitamente como Producción.'
    }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return Response.json({ ok: false, error: 'Cuerpo de solicitud inválido' }, { status: 400 });
    }

    const { action = 'subscribe', subscription, endpoint, client_token, test_token, location } = body;
    const targetEndpoint = endpoint || subscription?.endpoint;

    if (!targetEndpoint || !isValidPushEndpoint(targetEndpoint)) {
      return Response.json({ ok: false, error: 'Proveedor de notificaciones no admitido o endpoint inválido' }, { status: 400 });
    }

    const supabase = getSupabase(env);
    if (!supabase) {
      return Response.json(
        { ok: false, error: 'Base de datos no configurada en el servidor (faltan credenciales Supabase)' },
        { status: 503 }
      );
    }

    // 1. Desuscripción voluntaria (Eliminación inmediata y autenticada)
    if (action === 'unsubscribe') {
      const authToken = client_token || test_token;
      const { data: subRows, error: fetchErr } = await supabase
        .from('push_subscriptions')
        .select('endpoint, client_token_hash, test_token_hash')
        .eq('endpoint', targetEndpoint)
        .limit(1);

      if (!fetchErr && subRows && subRows.length > 0) {
        const currentSub = subRows[0];
        if (currentSub.client_token_hash || currentSub.test_token_hash) {
          if (!authToken || typeof authToken !== 'string') {
            return Response.json({ ok: false, error: 'client_token requerido para desuscribir suscripción protegida' }, { status: 401 });
          }
          const tokenHash = await sha256Hex(authToken);
          const matchesAuth = (currentSub.client_token_hash && constantTimeEqual(currentSub.client_token_hash, tokenHash)) ||
                              (currentSub.test_token_hash && constantTimeEqual(currentSub.test_token_hash, tokenHash));
          if (!matchesAuth) {
            return Response.json({ ok: false, error: 'Token de autorización inválido para desuscribir' }, { status: 403 });
          }
        }
      }

      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', targetEndpoint);

      if (error && error.code !== '42P01') {
        console.warn('[Push] Error al desuscribir:', error.message);
      }
      return Response.json({ ok: true, desuscrito: true });
    }

    // 2. Actualización de ubicación para notificaciones por distancia
    if (action === 'update_location') {
      const authToken = client_token || test_token;
      if (!authToken || typeof authToken !== 'string') {
        return Response.json({ ok: false, error: 'client_token requerido para actualizar preferencias de ubicación' }, { status: 401 });
      }

      const tokenHash = await sha256Hex(authToken);

      // Verificar autorización contra client_token_hash o test_token_hash
      const { data: subRows, error: fetchErr } = await supabase
        .from('push_subscriptions')
        .select('endpoint, client_token_hash, test_token_hash')
        .eq('endpoint', targetEndpoint)
        .limit(1);

      if (fetchErr) {
        return Response.json({ ok: false, error: `Error en base de datos: ${fetchErr.message}` }, { status: 500 });
      }

      if (!subRows || subRows.length === 0) {
        return Response.json({ ok: false, error: 'Suscripción no encontrada' }, { status: 404 });
      }

      const currentSub = subRows[0];
      const matchesAuth = (currentSub.client_token_hash && constantTimeEqual(currentSub.client_token_hash, tokenHash)) ||
                          (currentSub.test_token_hash && constantTimeEqual(currentSub.test_token_hash, tokenHash));

      if (!matchesAuth) {
        return Response.json({ ok: false, error: 'Token de autorización inválido' }, { status: 403 });
      }

      // Validar y sanitizar parámetros de ubicación
      const rawLat = location?.latitud ?? location?.lat;
      const rawLon = location?.longitud ?? location?.lon;
      const rawMode = location?.modo || location?.mode || 'GPS';
      const canonicalMode = normalizeLocationMode(rawMode);
      const zoneName = location?.zona ? String(location.zona).slice(0, 64).trim() : null;
      const precisionM = Number(location?.precision_m);
      const isActiva = (location?.personalizacion_distancia_activa !== false && location?.activa !== false);

      const truncated = truncateCoordinates(rawLat, rawLon, 3);
      if (truncated.lat === null || truncated.lon === null) {
        return Response.json({ ok: false, error: 'Coordenadas latitud/longitud inválidas' }, { status: 400 });
      }

      const updatePayload = {
        latitud: truncated.lat,
        longitud: truncated.lon,
        ubicacion_modo: canonicalMode,
        ubicacion_zona: zoneName,
        ubicacion_precision_m: Number.isFinite(precisionM) ? Math.round(precisionM * 10) / 10 : null,
        ubicacion_actualizada_en: new Date().toISOString(),
        personalizacion_distancia_activa: isActiva,
        last_seen: new Date().toISOString()
      };

      const { error: updErr } = await supabase
        .from('push_subscriptions')
        .update(updatePayload)
        .eq('endpoint', targetEndpoint);

      if (updErr) {
        if (updErr.code === '42703' || updErr.message?.includes('latitud')) {
          return Response.json({
            ok: true,
            ubicacion_actualizada: false,
            advertencia: 'Ubicación recibida pero base de datos pendiente de migración en Supabase.'
          });
        }
        return Response.json({ ok: false, error: `Error actualizando ubicación: ${updErr.message}` }, { status: 500 });
      }

      return Response.json({
        ok: true,
        ubicacion_actualizada: true,
        modo: updatePayload.ubicacion_modo,
        personalizacion_activa: updatePayload.personalizacion_distancia_activa
      });
    }

    // 3. Eliminación voluntaria de datos de ubicación
    if (action === 'delete_location' || action === 'clear_location') {
      const authToken = client_token || test_token;
      if (!authToken || typeof authToken !== 'string') {
        return Response.json({ ok: false, error: 'client_token requerido para eliminar ubicación' }, { status: 401 });
      }

      const tokenHash = await sha256Hex(authToken);
      const { data: subRows, error: fetchErr } = await supabase
        .from('push_subscriptions')
        .select('endpoint, client_token_hash, test_token_hash')
        .eq('endpoint', targetEndpoint)
        .limit(1);

      if (fetchErr) {
        return Response.json({ ok: false, error: `Error en base de datos: ${fetchErr.message}` }, { status: 500 });
      }

      if (!subRows || subRows.length === 0) {
        return Response.json({ ok: false, error: 'Suscripción no encontrada' }, { status: 404 });
      }

      const currentSub = subRows[0];
      const matchesAuth = (currentSub.client_token_hash && constantTimeEqual(currentSub.client_token_hash, tokenHash)) ||
                          (currentSub.test_token_hash && constantTimeEqual(currentSub.test_token_hash, tokenHash));

      if (!matchesAuth) {
        return Response.json({ ok: false, error: 'Token de autorización inválido' }, { status: 403 });
      }

      const { error: clearErr } = await supabase
        .from('push_subscriptions')
        .update({
          latitud: null,
          longitud: null,
          ubicacion_modo: 'INACTIVO',
          ubicacion_zona: null,
          ubicacion_precision_m: null,
          ubicacion_actualizada_en: null,
          personalizacion_distancia_activa: false,
          last_seen: new Date().toISOString()
        })
        .eq('endpoint', targetEndpoint);

      if (clearErr && clearErr.code !== '42703') {
        return Response.json({ ok: false, error: `Error eliminando ubicación: ${clearErr.message}` }, { status: 500 });
      }

      return Response.json({ ok: true, ubicacion_eliminada: true });
    }

    // 4. Registro o renovación de suscripción Web Push (Con protección contra Takeover)
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!p256dh || !auth) {
      return Response.json({ ok: false, error: 'Claves criptográficas p256dh y auth requeridas' }, { status: 400 });
    }

    // Verificar si el endpoint ya existe para evitar sobrescrituras de credenciales no autorizadas
    const { data: existingRows } = await supabase
      .from('push_subscriptions')
      .select('endpoint, client_token_hash, test_token_hash')
      .eq('endpoint', targetEndpoint)
      .limit(1);

    const existingSub = existingRows && existingRows[0];
    let testToken = generateRandomToken();
    let testTokenHash = await sha256Hex(testToken);
    let clientToken = client_token || generateRandomToken();
    let clientTokenHash = await sha256Hex(clientToken);
    const vapidKeyHash = env.VAPID_PUBLIC_KEY ? await sha256Hex(env.VAPID_PUBLIC_KEY) : null;

    if (existingSub && (existingSub.client_token_hash || existingSub.test_token_hash)) {
      const callerToken = client_token || test_token;
      if (!callerToken || typeof callerToken !== 'string') {
        return Response.json({
          ok: false,
          error: 'Endpoint ya registrado. Se requiere client_token existente para renovar credenciales.'
        }, { status: 409 });
      }
      const callerTokenHash = await sha256Hex(callerToken);
      const isAuthorized = (existingSub.client_token_hash && constantTimeEqual(existingSub.client_token_hash, callerTokenHash)) ||
                           (existingSub.test_token_hash && constantTimeEqual(existingSub.test_token_hash, callerTokenHash));
      if (!isAuthorized) {
        return Response.json({
          ok: false,
          error: 'Token de autorización inválido para el endpoint existente.'
        }, { status: 403 });
      }
      if (!client_token) {
        clientToken = callerToken;
        clientTokenHash = callerTokenHash;
      }
    }

    const record = {
      endpoint: targetEndpoint,
      p256dh,
      auth,
      test_token_hash: testTokenHash,
      client_token_hash: clientTokenHash,
      failures: 0,
      last_seen: new Date().toISOString()
    };

    if (vapidKeyHash) {
      record.vapid_key_hash = vapidKeyHash;
    }

    // Si se enviaron parámetros de ubicación opcionales en el registro
    if (location && typeof location === 'object') {
      const rawLat = location.latitud ?? location.lat;
      const rawLon = location.longitud ?? location.lon;
      const truncated = truncateCoordinates(rawLat, rawLon, 3);
      if (truncated.lat !== null && truncated.lon !== null) {
        record.latitud = truncated.lat;
        record.longitud = truncated.lon;
        record.ubicacion_modo = normalizeLocationMode(location.modo || location.mode || 'GPS');
        record.ubicacion_zona = location.zona ? String(location.zona).slice(0, 64).trim() : null;
        record.ubicacion_precision_m = Number.isFinite(Number(location.precision_m))
          ? Math.round(Number(location.precision_m) * 10) / 10
          : null;
        record.ubicacion_actualizada_en = new Date().toISOString();
        record.personalizacion_distancia_activa = (location.activa !== false && location.personalizacion_distancia_activa !== false);
      }
    }

    let { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert(record, { onConflict: 'endpoint' });

    // Fallback defensivo ante columnas pendientes de migración en Supabase
    if (upsertErr && (upsertErr.code === '42703' ||
                      upsertErr.message?.includes('client_token_hash') ||
                      upsertErr.message?.includes('latitud') ||
                      upsertErr.message?.includes('test_token_hash') ||
                      upsertErr.message?.includes('vapid_key_hash') ||
                      upsertErr.message?.includes('failures'))) {
      delete record.latitud;
      delete record.longitud;
      delete record.ubicacion_modo;
      delete record.ubicacion_zona;
      delete record.ubicacion_precision_m;
      delete record.ubicacion_actualizada_en;
      delete record.personalizacion_distancia_activa;
      delete record.client_token_hash;
      delete record.test_token_hash;
      delete record.vapid_key_hash;
      delete record.failures;

      const fallbackResult = await supabase
        .from('push_subscriptions')
        .upsert(record, { onConflict: 'endpoint' });
      upsertErr = fallbackResult.error;
    }

    if (upsertErr) {
      if (upsertErr.code === '42P01') {
        return Response.json({ ok: false, error: 'Tabla push_subscriptions pendiente de migración en Supabase' }, { status: 503 });
      }
      throw new Error(`Error en base de datos: ${upsertErr.message}`);
    }

    return Response.json({
      ok: true,
      registrado: true,
      test_token: testToken,
      client_token: clientToken
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

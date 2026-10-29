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

import { sendWebPush, isValidPushEndpoint } from '../../cloudflare/lib/web-push.mjs';
import { createClient } from '@supabase/supabase-js';

function getSupabase(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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
    const endpoint = body?.endpoint;
    const testToken = body?.test_token;

    // 1. Validación estricta del endpoint (prevención de SSRF)
    if (!endpoint || !isValidPushEndpoint(endpoint)) {
      return Response.json({
        ok: false,
        error: 'Endpoint de notificación inválido o proveedor no admitido',
        diagnostico: { fase: 'AUTH_VALIDATION', codigo: 'SSRF_BLOCKED' }
      }, { status: 400 });
    }

    // 2. Comprobación de existencia de base de datos
    const supabase = getSupabase(env);
    if (!supabase) {
      return Response.json({
        ok: false,
        error: 'Servicio no configurado: faltan credenciales Supabase en el servidor',
        diagnostico: { fase: 'SERVER_CONFIG', codigo: 'SUPABASE_ENV_MISSING' }
      }, { status: 503 });
    }

    // 3. Obtener exclusivamente la suscripción registrada y autorizada en base de datos
    const { data: subData, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth, test_token_hash, last_test_at')
      .eq('endpoint', endpoint)
      .maybeSingle();

    if (subErr || !subData) {
      return Response.json({
        ok: false,
        error: 'Suscripción no encontrada en el servidor. Por favor reactiva las notificaciones en el dispositivo.',
        diagnostico: { fase: 'DB_LOOKUP', codigo: 'SUBSCRIPTION_NOT_FOUND' }
      }, { status: 404 });
    }

    // 4. Verificación de autorización criptográfica con token hash
    if (!testToken) {
      return Response.json({
        ok: false,
        error: 'Token de prueba requerido. Reactiva las notificaciones para obtener una credencial autorizada.',
        diagnostico: { fase: 'AUTH_VALIDATION', codigo: 'MISSING_TEST_TOKEN' }
      }, { status: 401 });
    }

    const providedTokenHash = await sha256Hex(testToken);
    if (!subData.test_token_hash || subData.test_token_hash !== providedTokenHash) {
      return Response.json({
        ok: false,
        error: 'Credencial de prueba no coincide o desactualizada. Pulsa «Reactivar notificaciones».',
        diagnostico: { fase: 'AUTH_VALIDATION', codigo: 'TOKEN_HASH_MISMATCH' }
      }, { status: 403 });
    }

    // 5. Control de frecuencia (Rate Limiting: máximo 1 prueba cada 30 segundos)
    if (subData.last_test_at) {
      const elapsed = Date.now() - new Date(subData.last_test_at).getTime();
      const minInterval = 30 * 1000;
      if (elapsed < minInterval) {
        const remainingSec = Math.ceil((minInterval - elapsed) / 1000);
        return Response.json({
          ok: false,
          error: `Límite de frecuencia: espera ${remainingSec} segundos antes de enviar otra prueba.`,
          diagnostico: { fase: 'RATE_LIMITING', codigo: 'COOLDOWN_ACTIVE', segundos_restantes: remainingSec }
        }, { status: 429 });
      }
    }

    // Actualizar marca de tiempo de prueba en Supabase
    try {
      await supabase
        .from('push_subscriptions')
        .update({ last_test_at: new Date().toISOString() })
        .eq('endpoint', endpoint);
    } catch (_) {}

    // 6. Preparar carga útil y enviar con el par VAPID seguro
    const subscription = {
      endpoint: subData.endpoint,
      keys: {
        p256dh: subData.p256dh,
        auth: subData.auth
      }
    };

    const testPayload = {
      title: 'sismoPA · Notificación de prueba',
      body: 'Canal Web Push activo y verificado en este dispositivo.',
      url: './#resumen',
      tag: 'sismopa-test'
    };

    const result = await sendWebPush(subscription, testPayload, env);

    // 7. Manejo seguro de suscripciones caducadas en el proveedor (410 Gone / 404)
    if (result.expired) {
      try {
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
      } catch (_) {}
      return Response.json({
        ok: false,
        error: 'La suscripción en el proveedor ha expirado (410 Gone). Reactiva las notificaciones en el dispositivo.',
        diagnostico: { fase: 'PHASE_14_PROVIDER_RESPONSE', codigo: 'SUBSCRIPTION_EXPIRED', status: result.status }
      }, { status: 410 });
    }

    if (!result.ok) {
      console.warn(`[PushTest] Rechazo de proveedor push | Status: ${result.status} | Detalle: ${result.providerDetail || 'N/A'}`);
      return Response.json({
        ok: false,
        error: `El proveedor push rechazó el mensaje (HTTP ${result.status}): ${result.providerDetail || 'Verifica la clave VAPID en Cloudflare.'}`,
        diagnostico: {
          fase: 'PHASE_14_PROVIDER_RESPONSE',
          codigo: 'PROVIDER_REJECTED',
          http_status: result.status,
          proveedor_detalle: result.providerDetail || 'Sin detalle del proveedor'
        }
      }, { status: 502 });
    }

    return Response.json({
      ok: true,
      status: result.status,
      mensaje: 'Notificación de prueba enviada con éxito al proveedor.'
    });
  } catch (err) {
    const phase = err.phase || 'INTERNAL_ERROR';
    const code = err.code || err.name || 'UNKNOWN_ERROR';
    const safeDetail = err.message || 'Error no especificado';

    // Registro seguro en Cloudflare Dashboard (sin secretos, tokens ni endpoints)
    console.error(`[PushTest] Error en fase: ${phase} | Código: ${code} | Detalle: ${err.name}: ${safeDetail}`);

    return Response.json({
      ok: false,
      error: `Fallo en el proceso de envío (${phase}: ${code})`,
      diagnostico: {
        fase: phase,
        codigo: code,
        tipo: err.name,
        mensaje: safeDetail
      }
    }, { status: 500 });
  }
}

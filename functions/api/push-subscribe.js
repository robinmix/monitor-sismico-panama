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

function generateRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
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
    if (!body) {
      return Response.json({ ok: false, error: 'Cuerpo de solicitud inválido' }, { status: 400 });
    }

    const { action = 'subscribe', subscription, endpoint } = body;
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

    if (action === 'unsubscribe') {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', targetEndpoint);

      if (error && error.code !== '42P01') {
        console.warn('[Push] Error al desuscribir:', error.message);
      }
      return Response.json({ ok: true, desuscrito: true });
    }

    // Registro o renovación de suscripción
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!p256dh || !auth) {
      return Response.json({ ok: false, error: 'Claves criptográficas p256dh y auth requeridas' }, { status: 400 });
    }

    // Generar credencial de prueba aleatoria de alta entropía (256 bits)
    const testToken = generateRandomToken();
    const testTokenHash = await sha256Hex(testToken);
    const vapidKeyHash = env.VAPID_PUBLIC_KEY ? await sha256Hex(env.VAPID_PUBLIC_KEY) : null;

    const record = {
      endpoint: targetEndpoint,
      p256dh,
      auth,
      test_token_hash: testTokenHash,
      failures: 0,
      last_seen: new Date().toISOString()
    };

    if (vapidKeyHash) {
      record.vapid_key_hash = vapidKeyHash;
    }

    let { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert(record, { onConflict: 'endpoint' });

    // Fallback de compatibilidad si las columnas de seguridad aún no han sido migradas en Supabase
    if (upsertErr && (upsertErr.code === '42703' || upsertErr.message?.includes('test_token_hash') || upsertErr.message?.includes('vapid_key_hash') || upsertErr.message?.includes('failures'))) {
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
      test_token: testToken
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

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

  try {
    const body = await request.json().catch(() => null);
    const endpoint = body?.endpoint;
    const testToken = body?.test_token;

    // 1. Validación estricta del endpoint (prevención de SSRF)
    if (!endpoint || !isValidPushEndpoint(endpoint)) {
      return Response.json({ ok: false, error: 'Endpoint de notificación inválido o proveedor no admitido' }, { status: 400 });
    }

    // 2. Comprobación de existencia de base de datos
    const supabase = getSupabase(env);
    if (!supabase) {
      return Response.json({ ok: false, error: 'Servicio no configurado: faltan credenciales Supabase' }, { status: 503 });
    }

    // 3. Obtener exclusivamente la suscripción registrada y autorizada en base de datos
    // Cero aceptación de claves o payloads arbitrarios enviados por el cliente
    const { data: subData, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth, test_token_hash, last_test_at')
      .eq('endpoint', endpoint)
      .maybeSingle();

    if (subErr || !subData) {
      return Response.json(
        { ok: false, error: 'Suscripción no encontrada en el servidor. Por favor reactiva las notificaciones en el dispositivo.' },
        { status: 404 }
      );
    }

    // 4. Verificación de autorización criptográfica con token hash (prevención de envío no autorizado por terceros)
    if (!testToken) {
      return Response.json(
        { ok: false, error: 'Token de prueba requerido. Reactiva las notificaciones para obtener una credencial autorizada.' },
        { status: 401 }
      );
    }

    const providedTokenHash = await sha256Hex(testToken);
    if (!subData.test_token_hash || subData.test_token_hash !== providedTokenHash) {
      return Response.json(
        { ok: false, error: 'Credencial de prueba no coincide o desactualizada. Pulsa «Reactivar notificaciones».' },
        { status: 403 }
      );
    }

    // 5. Control de frecuencia (Rate Limiting: máximo 1 prueba cada 30 segundos por suscripción)
    if (subData.last_test_at) {
      const elapsed = Date.now() - new Date(subData.last_test_at).getTime();
      const minInterval = 30 * 1000;
      if (elapsed < minInterval) {
        const remainingSec = Math.ceil((minInterval - elapsed) / 1000);
        return Response.json(
          { ok: false, error: `Límite de frecuencia: espera ${remainingSec} segundos antes de enviar otra prueba.` },
          { status: 429 }
        );
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

    // 7. Manejo seguro de suscripciones caducadas en el proveedor
    if (result.expired) {
      try {
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
      } catch (_) {}
      return Response.json(
        { ok: false, error: 'La suscripción en el proveedor ha expirado (410 Gone). Reactiva las notificaciones en el dispositivo.' },
        { status: 410 }
      );
    }

    if (!result.ok) {
      return Response.json(
        { ok: false, error: `El proveedor push rechazó el mensaje (código ${result.status}). Verifica las claves VAPID en Cloudflare.` },
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      status: result.status,
      mensaje: 'Notificación de prueba enviada con éxito al proveedor.'
    });
  } catch (err) {
    // No exponer datos sensibles ni claves privadas en el mensaje de error
    const safeMessage = err.message?.includes('VAPID') ? err.message : 'Error interno al procesar el envío de prueba';
    return Response.json({ ok: false, error: safeMessage }, { status: 500 });
  }
}

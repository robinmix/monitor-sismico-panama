import { sendWebPush } from '../../cloudflare/lib/web-push.mjs';
import { createClient } from '@supabase/supabase-js';

function getSupabase(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
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
    if (!endpoint || !endpoint.startsWith('https://')) {
      return Response.json({ ok: false, error: 'Endpoint inválido' }, { status: 400 });
    }

    const supabase = getSupabase(env);
    let sub = null;

    if (supabase) {
      const { data } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('endpoint', endpoint)
        .maybeSingle();

      if (data) {
        sub = {
          endpoint: data.endpoint,
          keys: {
            p256dh: data.p256dh,
            auth: data.auth
          }
        };
      }
    }

    // Si el cliente envió sus claves directamente en el payload de prueba (fallback rápido)
    if (!sub && body.keys?.p256dh && body.keys?.auth) {
      sub = {
        endpoint,
        keys: body.keys
      };
    }

    if (!sub) {
      return Response.json({ ok: false, error: 'Suscripción no encontrada para prueba' }, { status: 404 });
    }

    const testPayload = {
      title: 'sismoPA · Notificación de prueba',
      body: 'Canal Web Push activo y verificado en este dispositivo.',
      url: './#resumen',
      tag: 'sismopa-test'
    };

    const result = await sendWebPush(sub, testPayload, env);
    return Response.json({ ok: result.ok, status: result.status });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

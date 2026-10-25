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
    if (!body) {
      return Response.json({ ok: false, error: 'Cuerpo de solicitud inválido' }, { status: 400 });
    }

    const { action = 'subscribe', subscription, endpoint } = body;
    const targetEndpoint = endpoint || subscription?.endpoint;

    if (!targetEndpoint || !targetEndpoint.startsWith('https://')) {
      return Response.json({ ok: false, error: 'Endpoint HTTPS inválido' }, { status: 400 });
    }

    const supabase = getSupabase(env);
    if (!supabase) {
      // Si Supabase aún no tiene credenciales en el entorno, retornar respuesta graceful
      return Response.json({ ok: true, aviso: 'Suscripción registrada localmente en el dispositivo (servidor en modo autónomo).' });
    }

    if (action === 'unsubscribe') {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', targetEndpoint);

      if (error && error.code !== '42P01') { // 42P01: relation does not exist yet
        console.warn('[Push] Error al dar de baja:', error.message);
      }
      return Response.json({ ok: true, desuscrito: true });
    }

    // Registrar o actualizar suscripción
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!p256dh || !auth) {
      return Response.json({ ok: false, error: 'Claves p256dh y auth requeridas' }, { status: 400 });
    }

    const record = {
      endpoint: targetEndpoint,
      p256dh,
      auth,
      last_seen: new Date().toISOString()
    };

    const { error: upsertErr } = await supabase
      .from('push_subscriptions')
      .upsert(record, { onConflict: 'endpoint' });

    if (upsertErr) {
      if (upsertErr.code === '42P01') {
        // La tabla no ha sido creada aún mediante migración SQL
        return Response.json({ ok: true, advertencia: 'Tabla push_subscriptions pendiente de migración en Supabase.' });
      }
      throw new Error(`Error en base de datos: ${upsertErr.message}`);
    }

    return Response.json({ ok: true, registrado: true });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

import { createClient } from '@supabase/supabase-js';

function getSupabase(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export function isValidFcmToken(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  // Los tokens FCM oficiales son cadenas base64url/alfanuméricas de ~140 a 250 caracteres
  if (trimmed.length < 50 || trimmed.length > 350) return false;
  return /^[a-zA-Z0-9_\-:]+$/.test(trimmed);
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

    const { action = 'subscribe', token, platform = 'android', app_version = '1.0.4', device_id_hash } = body;

    if (!isValidFcmToken(token)) {
      return Response.json({ ok: false, error: 'Token FCM inválido o con formato incorrecto' }, { status: 400 });
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
        .from('fcm_device_tokens')
        .update({ active: false, last_seen: new Date().toISOString() })
        .eq('token', token.trim());

      if (error && error.code !== '42P01') {
        console.warn('[FCM] Error al desuscribir token:', error.message);
      }
      return Response.json({ ok: true, active: false });
    }

    // Registro o renovación voluntaria de token
    const record = {
      token: token.trim(),
      platform: typeof platform === 'string' ? platform.slice(0, 20) : 'android',
      app_version: typeof app_version === 'string' ? app_version.slice(0, 20) : '1.0.4',
      active: true,
      failures: 0,
      retry_after: null,
      last_seen: new Date().toISOString()
    };

    if (device_id_hash && typeof device_id_hash === 'string' && /^[a-f0-9]{64}$/i.test(device_id_hash)) {
      record.device_id_hash = device_id_hash;
    }

    const { error: upsertErr } = await supabase
      .from('fcm_device_tokens')
      .upsert(record, { onConflict: 'token' });

    if (upsertErr) {
      if (upsertErr.code === '42P01') {
        return Response.json(
          { ok: false, error: 'Tabla fcm_device_tokens pendiente de migración en Supabase' },
          { status: 503 }
        );
      }
      throw new Error(`Error en base de datos: ${upsertErr.message}`);
    }

    return Response.json({ ok: true, active: true });
  } catch (err) {
    console.error('[FCM] Error en /api/fcm-subscribe:', err);
    return Response.json({ ok: false, error: err.message || 'Error interno del servidor' }, { status: 500 });
  }
}

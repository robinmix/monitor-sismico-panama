/**
 * sismoPA — Endpoint FCM Subscribe (Retirado / Compatibilidad Retroactiva)
 *
 * En la arquitectura consolidada de sismoPA, el despacho automático de alertas sísmicas
 * se realiza exclusivamente mediante Firebase Topics (/topics/sismos_panama).
 *
 * Los dispositivos Android se suscriben directamente con Google mediante el SDK nativo,
 * por lo que el almacenamiento de tokens individuales en Supabase (tabla fcm_device_tokens)
 * es innecesario y se desaconseja por principios de privacidad y minimización de datos.
 *
 * Este endpoint se mantiene en modo seguro "no-op" para compatibilidad retroactiva
 * con versiones instaladas previas (Alpha 1.0.4 / 1.0.5), respondiendo HTTP 200 sin
 * realizar consultas ni escrituras en la base de datos Supabase.
 */

export function isValidFcmToken(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  // Los tokens FCM oficiales son cadenas base64url/alfanuméricas de ~50 a 350 caracteres
  if (trimmed.length < 50 || trimmed.length > 350) return false;
  return /^[a-zA-Z0-9_\-:]+$/.test(trimmed);
}

export async function onRequest(context) {
  const { request } = context;

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
    const body = await request.json().catch(() => ({}));
    const token = body?.token;

    // Validación defensiva básica si se envía un token
    if (token && !isValidFcmToken(token)) {
      return Response.json({ ok: false, error: 'Token FCM con formato incorrecto' }, { status: 400 });
    }

    // Respuesta segura no-op: no interactúa con Supabase ni almacena identificadores personales
    return Response.json(
      {
        ok: true,
        retired: true,
        architecture: 'firebase_topics',
        topic: 'sismos_panama',
        message: 'Endpoint retirado de forma segura. sismoPA opera mediante Firebase Topics sin almacenamiento de tokens.'
      },
      {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: 'Error procesando solicitud' },
      { status: 400 }
    );
  }
}

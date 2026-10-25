/**
 * Endpoint público para obtener la clave pública VAPID oficial activa.
 * Solo expone la clave pública (P-256 no comprimida en base64url).
 */

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405 });
  }

  const key = context.env?.VAPID_PUBLIC_KEY;
  if (!key) {
    return Response.json(
      { ok: false, error: 'El servicio de notificaciones está en proceso de configuración (VAPID no inicializado).' },
      { status: 503 }
    );
  }

  return Response.json(
    { ok: true, vapidPublicKey: key },
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=1800'
      }
    }
  );
}

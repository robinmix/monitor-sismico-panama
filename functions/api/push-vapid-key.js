import { DEFAULT_VAPID_KEYS } from '../../cloudflare/lib/web-push.mjs';

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

  const key = context.env?.VAPID_PUBLIC_KEY || DEFAULT_VAPID_KEYS.publicKey;
  return Response.json(
    { ok: true, vapidPublicKey: key },
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    }
  );
}

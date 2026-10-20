import { handler } from '../../cloudflare/lib/detalle-sismo.mjs';
import { eventoNetlify, respuestaPages } from '../../cloudflare/adaptador.mjs';

export async function onRequest(context) {
  if (!['GET', 'OPTIONS'].includes(context.request.method)) {
    return Response.json({ ok: false, error: 'Método no permitido' }, { status: 405, headers: { Allow: 'GET, OPTIONS' } });
  }
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }
  const resultado = await handler(eventoNetlify(context.request), {}, { env: context.env });
  return respuestaPages(resultado);
}
